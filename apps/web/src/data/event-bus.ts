import type { VisitEvent, VisitEventType } from "@qman/domain";

/**
 * The event bus.
 *
 * `VisitCalled` has to update the display board, push the patient's tracker,
 * fire a browser notification, speak an announcement, write an audit entry and
 * move the analytics. Wiring those into the calling code would put six
 * concerns inside one action and make each one impossible to change alone.
 *
 * Subscribers instead declare which events they care about and are handed them
 * after the fact. Adding WhatsApp delivery later is a new subscriber, not an
 * edit to the queue engine — which is the property the SAD is describing when
 * it calls events the backbone.
 *
 * When the API lands this is the same shape, fed by a websocket rather than by
 * the local store, so subscribers do not change at all.
 */

export interface EventSubscriber {
  /** Identifies the subscriber in the command centre and in logs. */
  readonly name: string;
  /** Event types this subscriber wants. Omit for all of them. */
  readonly events?: readonly VisitEventType[];
  handle(event: VisitEvent): void;
}

export class EventBus {
  #subscribers: EventSubscriber[] = [];
  #failures = new Map<string, number>();

  subscribe(subscriber: EventSubscriber): () => void {
    this.#subscribers.push(subscriber);
    return () => {
      this.#subscribers = this.#subscribers.filter((s) => s !== subscriber);
    };
  }

  publish(events: readonly VisitEvent[]): void {
    for (const event of events) {
      for (const subscriber of this.#subscribers) {
        if (subscriber.events && !subscriber.events.includes(event.type)) {
          continue;
        }
        try {
          subscriber.handle(event);
        } catch (error) {
          // A subscriber that throws must not stop the others, and must never
          // roll back the clinical action that produced the event. A patient
          // has already been called; a failed announcement cannot un-call them.
          this.#failures.set(
            subscriber.name,
            (this.#failures.get(subscriber.name) ?? 0) + 1,
          );
          console.error(
            `[qman] subscriber "${subscriber.name}" failed handling ${event.type}`,
            error,
          );
        }
      }
    }
  }

  /** Subscriber failure counts, surfaced in the command centre. */
  get failures(): ReadonlyMap<string, number> {
    return this.#failures;
  }

  get subscriberNames(): string[] {
    return this.#subscribers.map((s) => s.name);
  }
}
