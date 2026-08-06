/**
 * Server-Sent Events.
 *
 * The server publishes domain events; clients update their projections from
 * them. Not WebSockets: nothing here needs a client-to-server channel, and SSE
 * reconnects on its own, survives a proxy that only understands HTTP, and costs
 * one ordinary GET. A hospital's network equipment has opinions about upgrade
 * handshakes and none at all about a long-lived response.
 *
 * **Audience is part of the subscription, not of the payload.**
 *
 * The display board and the staff workstation are separate trust domains. A
 * board hangs unattended in a waiting room where anyone can read it and, given
 * a browser, anyone can open its endpoint directly. It must therefore receive
 * only what is already visible in that room: a ticket, a station, a status, a
 * time.
 *
 * That could have been done by filtering at each call site, which is the design
 * where one forgotten field becomes a disclosure. Instead the fan-out itself
 * renders a different payload per audience, and a public subscriber has no path
 * to the staff projection at all. Adding a field to the staff view cannot leak
 * it to a board, because the board's payload is built from a separate function
 * that never sees the record's summary or correlation id.
 *
 * Two properties carry over from before. A subscriber receives only its own
 * branch's events, because a laboratory board showing consultation tickets is
 * something the waiting room acts on. And a heartbeat is sent even when nothing
 * happens, so that silence is informative rather than ambiguous.
 */
import type { EventRecord } from "@qman/domain";

/**
 * Who is listening, and therefore what they may be told.
 *
 * `staff` is an authenticated workstation. `public` is a display board: no
 * session, no identity, and no expectation of privacy for anyone who can see
 * the screen.
 */
export type Audience = "staff" | "public";

/**
 * How often a comment is sent on an idle connection.
 *
 * Below the 45-second threshold at which a surface calls itself stale, so a
 * quiet clinic never looks like a broken one. Also short enough to keep
 * intermediaries from closing an idle response, which they do at around a
 * minute.
 */
export const HEARTBEAT_MILLIS = 20_000;

export interface StreamSubscriber {
  readonly branchId: string | null;
  readonly audience: Audience;
  send(chunk: string): void;
}

export interface PublishedEvent {
  readonly id: string;
  readonly type: string;
  readonly branchId: string;
  readonly payload: unknown;
}

/**
 * Formats one event in the wire format.
 *
 * Data is written as a single JSON line. The format is newline-delimited, so a
 * payload containing a newline would otherwise be read as two events — and the
 * second one as a truncated fragment.
 */
export function formatEvent(event: PublishedEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

export function formatHeartbeat(at: Date): string {
  // A comment line. Ignored by EventSource, but it is traffic, which is what
  // keeps intermediaries from treating the connection as abandoned.
  return `: heartbeat ${at.toISOString()}\n\n`;
}

/**
 * What a staff workstation is told.
 *
 * Still no patient name — the wire never carries one, whatever the audience,
 * because the privacy policy decides what a *screen* renders and the transport
 * should not be the thing that makes a violation possible. The Journey Code is
 * here because a workstation legitimately needs to correlate a patient's
 * progress across stations, and staff are authenticated and accountable.
 */
export function describeEvent(record: EventRecord): PublishedEvent {
  return {
    id: record.id,
    type: record.type,
    branchId: record.branchId,
    payload: {
      id: record.id,
      type: record.type,
      at: record.occurredAt.toISOString(),
      branchId: record.branchId,
      visitId: record.visitId,
      actorId: record.actorId,
      correlationId: record.correlationId,
      stationId: (record.payload["stationId"] as string | undefined) ?? null,
      queueLabel: (record.payload["queueLabel"] as string | undefined) ?? null,
      summary: record.summary,
    },
  };
}

/**
 * What a display board is told.
 *
 * Built from scratch rather than by removing fields from the staff projection,
 * so a field added there cannot arrive here by omission. Three exclusions are
 * deliberate and worth naming:
 *
 * **No Journey Code.** It is printed on the patient's ticket and is the key to
 * their tracking page. A board that displayed or transmitted it would turn a
 * photograph of a waiting-room screen into a set of other people's lookup keys.
 * It reaches the wire as `correlationId` and inside `summary`, which is why
 * neither is copied here.
 *
 * **No visit id.** An internal identifier is not information a waiting room
 * needs, and it correlates a person across stations for anyone collecting them.
 *
 * **No summary.** It is prose containing the Journey Code.
 */
export function describeBoardEvent(record: EventRecord): PublishedEvent {
  return {
    id: record.id,
    type: record.type,
    branchId: record.branchId,
    payload: {
      id: record.id,
      type: record.type,
      at: record.occurredAt.toISOString(),
      branchId: record.branchId,
      stationId: (record.payload["stationId"] as string | undefined) ?? null,
      // The ticket, which is called aloud and printed on paper anyway.
      queueLabel: (record.payload["queueLabel"] as string | undefined) ?? null,
      status: (record.payload["status"] as string | undefined) ?? null,
    },
  };
}

/**
 * Fans events out to connected clients.
 *
 * A subscriber that throws while being written to is removed rather than
 * allowed to interrupt the loop. One client whose socket has gone must not stop
 * the display board in the next room from being told a patient was called.
 */
export class EventStream {
  readonly #subscribers = new Set<StreamSubscriber>();

  subscribe(subscriber: StreamSubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  get size(): number {
    return this.#subscribers.size;
  }

  /**
   * Takes the record, not a rendered payload.
   *
   * The rendering happens per subscriber, which is what makes the audience rule
   * impossible to bypass: a caller cannot hand this a staff payload and have it
   * delivered to a board, because callers do not produce payloads at all.
   */
  publish(record: EventRecord): void {
    let staffChunk: string | null = null;
    let boardChunk: string | null = null;

    for (const subscriber of [...this.#subscribers]) {
      if (subscriber.branchId !== null && subscriber.branchId !== record.branchId) continue;

      if (subscriber.audience === "public") {
        boardChunk ??= formatEvent(describeBoardEvent(record));
        this.#write(subscriber, boardChunk);
      } else {
        staffChunk ??= formatEvent(describeEvent(record));
        this.#write(subscriber, staffChunk);
      }
    }
  }

  heartbeat(at: Date): void {
    const chunk = formatHeartbeat(at);
    for (const subscriber of [...this.#subscribers]) {
      this.#write(subscriber, chunk);
    }
  }

  #write(subscriber: StreamSubscriber, chunk: string): void {
    try {
      subscriber.send(chunk);
    } catch {
      this.#subscribers.delete(subscriber);
    }
  }
}
