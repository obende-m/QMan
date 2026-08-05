import { describe, expect, it } from "vitest";
import { backoffMillis, EventStreamClient, type EventSourceLike } from "./stream.js";

class FakeSource implements EventSourceLike {
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    const event = { data: typeof data === "string" ? data : JSON.stringify(data) } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  heartbeat(): void {
    this.onmessage?.({ data: "" } as MessageEvent);
  }
}

function harness(startAt = new Date("2026-03-09T09:00:00Z")) {
  const sources: FakeSource[] = [];
  const timers: Array<{ run: () => void; delay: number }> = [];
  let clock = startAt;

  const client = new EventStreamClient({
    url: "https://api.qman.example/api/v1/stream",
    now: () => clock,
    open: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
    schedule: (run, delay) => {
      timers.push({ run, delay });
      return timers.length - 1;
    },
    cancel: () => {},
  });

  return {
    client,
    sources,
    timers,
    advance: (millis: number) => {
      clock = new Date(clock.getTime() + millis);
    },
    latest: () => sources[sources.length - 1]!,
  };
}

const called = {
  id: "e1",
  type: "visit.called",
  at: "2026-03-09T09:00:00Z",
  branchId: "branch-main",
  visitId: "v1",
  correlationId: "QM-8F4K",
  stationId: "station-consult",
  queueLabel: "A-023",
  summary: "QM-8F4K called",
};

describe("event stream client", () => {
  it("reports connecting before anything has arrived", () => {
    const { client } = harness();
    client.start();
    expect(client.snapshot().state).toBe("connecting");
    expect(client.snapshot().trustworthy).toBe(false);
  });

  it("delivers a named domain event to listeners", () => {
    const { client, latest } = harness();
    const received: unknown[] = [];
    client.onEvent((event) => received.push(event));
    client.start();

    latest().onopen?.(new Event("open"));
    latest().emit("visit.called", called);

    expect(received).toEqual([called]);
    expect(client.snapshot().state).toBe("connected");
  });

  /**
   * The reason the server sends a heartbeat at all. Without counting it, an
   * hour with no patients and a severed cable look identical to a board.
   */
  it("treats a heartbeat as evidence the source is alive", () => {
    const { client, latest, advance } = harness();
    client.start();
    latest().onopen?.(new Event("open"));

    latest().heartbeat();
    expect(client.snapshot().state).toBe("connected");

    advance(50_000);
    expect(client.snapshot().state).toBe("stale");

    latest().heartbeat();
    expect(client.snapshot().state).toBe("connected");
  });

  /**
   * A board that has quietly lost its connection keeps showing the last thing
   * it heard, and a waiting room reads that as current.
   */
  it("stops claiming to be live once the source goes quiet", () => {
    const { client, latest, advance } = harness();
    client.start();
    latest().onopen?.(new Event("open"));
    latest().emit("visit.called", called);

    expect(client.snapshot().trustworthy).toBe(true);

    advance(50_000);
    expect(client.snapshot().state).toBe("stale");
    expect(client.snapshot().trustworthy).toBe(false);

    advance(200_000);
    expect(client.snapshot().state).toBe("offline");
  });

  it("notifies connection listeners as the assessment changes", () => {
    const { client, latest } = harness();
    const states: string[] = [];
    client.onConnection((snapshot) => states.push(snapshot.state));

    client.start();
    latest().onopen?.(new Event("open"));
    latest().heartbeat();

    expect(states).toContain("connecting");
    expect(states).toContain("connected");
  });

  describe("reconnection", () => {
    it("reconnects after a failure", () => {
      const { client, latest, timers, sources } = harness();
      client.start();
      latest().onerror?.(new Event("error"));

      expect(sources[0]!.closed).toBe(true);
      expect(timers).toHaveLength(1);

      timers[0]!.run();
      expect(sources).toHaveLength(2);
    });

    /**
     * Between the stale and offline thresholds the domain reports `stale`
     * whether or not a reconnection is in progress: what matters to a waiting
     * room in that window is that the data is old, not that the client is busy.
     * Past the offline threshold the distinction becomes useful again —
     * "reconnecting" and "given up" are different things to tell a room.
     */
    it("says it is reconnecting rather than offline while still trying", () => {
      const { client, latest, advance } = harness();
      client.start();
      latest().onopen?.(new Event("open"));
      latest().heartbeat();

      advance(50_000);
      latest().onerror?.(new Event("error"));
      expect(client.snapshot().state).toBe("stale");

      advance(200_000);
      expect(client.snapshot().state).toBe("reconnecting");

      client.stop();
      expect(client.snapshot().state).toBe("offline");
    });

    /**
     * A waiting-room board has nobody to press refresh, so it must retry
     * forever — but a hospital-wide outage must not become every screen
     * hammering the server that is already struggling.
     */
    it("backs off, and caps the wait", () => {
      expect(backoffMillis(1)).toBe(1_000);
      expect(backoffMillis(2)).toBe(2_000);
      expect(backoffMillis(3)).toBe(4_000);
      expect(backoffMillis(10)).toBe(30_000);
      expect(backoffMillis(100)).toBe(30_000);
    });

    it("resets the backoff once a connection succeeds", () => {
      const { client, latest, timers } = harness();
      client.start();

      latest().onerror?.(new Event("error"));
      timers[0]!.run();
      latest().onopen?.(new Event("open"));
      latest().onerror?.(new Event("error"));

      expect(timers[1]!.delay).toBe(1_000);
    });

    it("stops trying once stopped, and reports offline", () => {
      const { client, latest, sources } = harness();
      client.start();
      client.stop();

      expect(sources[0]!.closed).toBe(true);
      expect(client.snapshot().state).toBe("offline");

      client.start();
      expect(sources).toHaveLength(1);
    });
  });

  /** A malformed frame is not worth dropping a working connection over. */
  it("survives an unparseable frame without losing the connection", () => {
    const { client, latest } = harness();
    const received: unknown[] = [];
    client.onEvent((event) => received.push(event));
    client.start();
    latest().onopen?.(new Event("open"));

    latest().emit("visit.called", "{not json");
    expect(received).toEqual([]);
    // The frame still counted as evidence the source is alive.
    expect(client.snapshot().state).toBe("connected");

    latest().emit("visit.called", called);
    expect(received).toEqual([called]);
  });
});
