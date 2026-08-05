/**
 * Server-Sent Events.
 *
 * The server publishes domain events; clients update their projections from
 * them. Not WebSockets: nothing here needs a client-to-server channel, and SSE
 * reconnects on its own, survives a proxy that only understands HTTP, and costs
 * one ordinary GET. A hospital's network equipment has opinions about upgrade
 * handshakes and none at all about a long-lived response.
 *
 * Three properties matter for the surfaces that consume this.
 *
 * **Events carry the branch they belong to**, and a subscriber receives only
 * its own. A display board in the laboratory showing consultation tickets is
 * not a cosmetic error; the waiting room acts on it.
 *
 * **A heartbeat is sent even when nothing happens.** The connection model built
 * for the display board distinguishes "connected and quiet" from "connected in
 * name only", and it can only do that if silence is itself informative. Without
 * a heartbeat, an hour with no patients and a severed cable look identical.
 *
 * **Every event carries an id**, so a client reconnecting sends
 * `Last-Event-ID` and the server can tell whether the gap is one it can fill.
 */
import type { EventRecord } from "@qman/domain";

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

  publish(event: PublishedEvent): void {
    const chunk = formatEvent(event);
    for (const subscriber of [...this.#subscribers]) {
      if (subscriber.branchId !== null && subscriber.branchId !== event.branchId) continue;
      this.#write(subscriber, chunk);
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

/**
 * What a client is told about an event.
 *
 * Patient identity is deliberately absent. The stream feeds display boards and
 * waiting-room screens as well as staff workstations, and a surface that
 * receives a name can render it whatever the privacy policy says. Sending only
 * the ticket, the station and the journey code means the wire itself cannot
 * leak a name — the policy is enforced by what is transmitted rather than by
 * every consumer remembering to check.
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
      // The Journey Code for operational events, the session for the rest.
      // Already on the record, so a client can group without a second query.
      correlationId: record.correlationId,
      // Lifted out of the payload because every consumer wants it and none
      // should have to know the shape of each event type to find it.
      stationId: (record.payload["stationId"] as string | undefined) ?? null,
      queueLabel: (record.payload["queueLabel"] as string | undefined) ?? null,
      summary: record.summary,
    },
  };
}
