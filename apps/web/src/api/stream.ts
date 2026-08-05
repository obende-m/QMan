/**
 * The event stream client.
 *
 * Connects to the server's SSE endpoint and reports two things: the events that
 * arrive, and how much the screen showing them can be trusted.
 *
 * The second is not decoration. A display board that has silently lost its
 * connection keeps showing the last thing it heard, and a waiting room reads
 * that as current — patients wait for a number that was called twenty minutes
 * ago. The connection model already in the domain distinguishes connected,
 * connecting, reconnecting, stale and offline, and this feeds it: every
 * message, including the server's heartbeat, is evidence the source is alive.
 *
 * Reconnection backs off. A board that has lost the server retries forever,
 * because a waiting-room screen has nobody to press refresh — but retrying
 * every 200ms against a server that is down turns one outage into two.
 */
import {
  assessConnection,
  DEFAULT_CONNECTION_THRESHOLDS,
  type ConnectionSnapshot,
  type ConnectionThresholds,
} from "@qman/domain";

export interface StreamEvent {
  readonly id: string;
  readonly type: string;
  readonly at: string;
  readonly branchId: string;
  readonly visitId: string | null;
  readonly correlationId: string | null;
  readonly stationId: string | null;
  readonly queueLabel: string | null;
  readonly summary: string;
}

/** The browser interface this needs, so tests need no EventSource. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
  onerror: ((this: unknown, event: Event) => void) | null;
  onopen: ((this: unknown, event: Event) => void) | null;
  onmessage: ((this: unknown, event: MessageEvent) => void) | null;
}

export interface StreamOptions {
  readonly url: string;
  readonly open?: (url: string) => EventSourceLike;
  readonly now?: () => Date;
  readonly thresholds?: ConnectionThresholds;
  /** Scheduling is injected so tests advance time rather than wait for it. */
  readonly schedule?: (run: () => void, delayMillis: number) => number;
  readonly cancel?: (handle: number) => void;
}

/**
 * How long to wait before reconnecting, by consecutive failure count.
 *
 * Capped at thirty seconds. A waiting-room board must keep trying — nobody is
 * standing beside it to reload — but a hospital-wide outage would otherwise put
 * every screen into a tight retry loop against the server that is already
 * struggling.
 */
export function backoffMillis(failures: number): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.max(0, failures - 1));
  return base;
}

export type StreamListener = (event: StreamEvent) => void;
export type ConnectionListener = (snapshot: ConnectionSnapshot) => void;

export class EventStreamClient {
  readonly #options: Required<Pick<StreamOptions, "url">> & StreamOptions;
  readonly #now: () => Date;
  readonly #open: (url: string) => EventSourceLike;
  readonly #schedule: (run: () => void, delayMillis: number) => number;
  readonly #cancel: (handle: number) => void;

  readonly #events = new Set<StreamListener>();
  readonly #connections = new Set<ConnectionListener>();

  #source: EventSourceLike | null = null;
  #lastMessageAt: Date | null = null;
  #attempting = true;
  #failures = 0;
  #retry: number | null = null;
  #stopped = false;

  constructor(options: StreamOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#open =
      options.open ?? ((url) => new EventSource(url, { withCredentials: true }) as EventSourceLike);
    this.#schedule =
      options.schedule ?? ((run, delay) => globalThis.setTimeout(run, delay) as unknown as number);
    this.#cancel = options.cancel ?? ((handle) => globalThis.clearTimeout(handle));
  }

  onEvent(listener: StreamListener): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  onConnection(listener: ConnectionListener): () => void {
    this.#connections.add(listener);
    listener(this.snapshot());
    return () => this.#connections.delete(listener);
  }

  /**
   * The current assessment.
   *
   * Computed on demand rather than stored, so a surface asking after five
   * minutes of silence gets the truth rather than the last thing that was
   * pushed to it.
   */
  snapshot(): ConnectionSnapshot {
    return assessConnection({
      lastUpdatedAt: this.#lastMessageAt,
      attempting: this.#attempting,
      now: this.#now(),
      ...(this.#options.thresholds
        ? { thresholds: this.#options.thresholds }
        : { thresholds: DEFAULT_CONNECTION_THRESHOLDS }),
    });
  }

  start(): void {
    if (this.#stopped || this.#source !== null) return;
    this.#attempting = true;
    this.#announce();

    const source = this.#open(this.#options.url);
    this.#source = source;

    source.onopen = () => {
      this.#failures = 0;
      this.#attempting = false;
      // An open connection is not yet evidence of a live source — the server
      // sends a heartbeat immediately, and that is what marks it fresh.
      this.#announce();
    };

    source.onmessage = (event) => this.#received(event);

    // A named event arrives as its own type, not as `message`.
    source.addEventListener("visit.called", (event) => this.#received(event));
    for (const type of [
      "visit.created",
      "visit.queued",
      "visit.service_started",
      "visit.skipped",
      "visit.stage_completed",
      "visit.routed",
      "visit.completed",
      "visit.cancelled",
      "visit.closed",
      "visit.priority_changed",
    ]) {
      source.addEventListener(type, (event) => this.#received(event));
    }

    source.onerror = () => {
      this.#failures += 1;
      this.#attempting = true;
      this.#teardown();
      this.#announce();
      this.#retry = this.#schedule(() => {
        this.#retry = null;
        this.start();
      }, backoffMillis(this.#failures));
    };
  }

  stop(): void {
    this.#stopped = true;
    this.#attempting = false;
    if (this.#retry !== null) {
      this.#cancel(this.#retry);
      this.#retry = null;
    }
    this.#teardown();
    this.#announce();
  }

  /**
   * Every message is evidence the source is alive, including a heartbeat that
   * carries no data. Without that, a quiet clinic and a severed cable would be
   * indistinguishable — which is the whole reason the server sends one.
   */
  #received(event: MessageEvent): void {
    this.#lastMessageAt = this.#now();
    this.#attempting = false;
    this.#announce();

    const raw = typeof event.data === "string" ? event.data.trim() : "";
    if (raw === "") return;

    let parsed: StreamEvent;
    try {
      parsed = JSON.parse(raw) as StreamEvent;
    } catch {
      // A malformed frame is not worth dropping the connection over; the next
      // one is very likely fine, and the freshness signal above still counted.
      return;
    }

    for (const listener of [...this.#events]) listener(parsed);
  }

  #teardown(): void {
    if (this.#source === null) return;
    this.#source.onopen = null;
    this.#source.onmessage = null;
    this.#source.onerror = null;
    this.#source.close();
    this.#source = null;
  }

  #announce(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.#connections]) listener(snapshot);
  }
}
