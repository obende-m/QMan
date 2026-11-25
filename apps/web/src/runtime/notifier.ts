import {
  renderAnnouncement,
  type StationId,
  type VisitEvent,
  type VisitId,
} from "@qman/domain";
import type { OperationsStore } from "../data/operations-store.js";
import type { ConfigStore } from "../data/config-store.js";
import { stationName, stationRoom } from "../data/clinic-projections.js";
import type { StreamEventLike } from "../data/operations-store.js";
import type { NotificationPort } from "./ports.js";

/**
 * Browser notifications.
 *
 * Two audiences with opposite needs, served by the same subscriber shape:
 *
 * **Staff** need to know work arrived at *their* station while they are looking
 * at something else. Filtered to one station, low urgency, collapsible.
 *
 * **Patients** need to know it is their turn while their phone is in a pocket.
 * Filtered to one visit, and marked `requireInteraction` so the notification
 * stays on screen — a patient who glances down thirty seconds late must still
 * see it, which is the entire point of not making them watch the board.
 *
 * Every attempt records its outcome, so the Command Centre's delivery panel
 * reflects what actually happened rather than what was intended. A channel that
 * silently never fires shows as queued attempts that never became delivered.
 */
export interface NotifierOptions {
  readonly notifications: NotificationPort;
  readonly operations: OperationsStore;
  readonly config: ConfigStore;
}

export class Notifier {
  constructor(private readonly options: NotifierOptions) {}

  get permission() {
    return this.options.notifications.permission();
  }

  async requestPermission(): Promise<ReturnType<NotificationPort["permission"]>> {
    return this.options.notifications.requestPermission();
  }

  /**
   * Staff notifications for one station.
   *
   * Fires when work *arrives*, not on every event: a queue entry opening is
   * news, a stage completing is not. Anything more would train staff to
   * dismiss without reading.
   */
  /**
   * Staff notifications, from the server's event stream.
   *
   * The same path OperationsStore takes: the browser produces no domain events
   * any more, so this reads the staff projection — type, station, ticket and a
   * summary rendered once at write time.
   *
   * The projection carries no priority, so the "urgent patient waiting"
   * variant cannot be distinguished here. It is one notification rather than
   * two, which is the honest reading of what the wire says.
   */
  attachToStream(
    stream: { onEvent: (listener: (event: StreamEventLike) => void) => () => void },
    stationId: StationId,
  ): () => void {
    return stream.onEvent((event) => {
      if (event.type !== "visit.queued") return;
      if (event.stationId !== stationId) return;

      void this.#deliver({
        title: "New patient in your queue",
        body: `${event.queueLabel ?? ""} joined ${stationName(
          this.options.config.config,
          stationId,
        )}.`.trim(),
        tag: `queue-${stationId}`,
        requireInteraction: false,
        visitId: event.visitId as VisitId | null,
        recipient: "staff",
      });
    });
  }

  /**
   * Patient notifications for one visit, from the same stream.
   *
   * Uses the announcement template so what a patient reads on their phone
   * matches what is said aloud in the room (ADR-030). The wire carries no
   * patient name, so `{name}` renders empty whatever the policy says.
   */
  attachPatientToStream(
    stream: { onEvent: (listener: (event: StreamEventLike) => void) => () => void },
    visitId: VisitId,
  ): () => void {
    return stream.onEvent((event) => {
      if (event.visitId !== visitId) return;

      const announcementEvent =
        event.type === "visit.called"
          ? "called"
          : event.type === "visit.routed"
            ? "routed"
            : event.type === "visit.completed"
              ? "completed"
              : null;
      if (announcementEvent === null) return;

      const stationId = (event.stationId ?? "") as StationId;
      const body = renderAnnouncement(
        this.options.operations.announcementConfig,
        announcementEvent,
        {
          ticket: event.queueLabel ?? "",
          journeyCode: (event.correlationId ?? "") as never,
          patientName: "",
          stationName: stationName(this.options.config.config, stationId),
          room: stationRoom(this.options.config.config, stationId),
          hospitalName: this.options.config.config.profile.name,
          namePolicy: "ticket_only",
        },
      );

      const isTurn = event.type === "visit.called";
      void this.#deliver({
        title: isTurn ? "It's your turn" : "Your visit has moved on",
        // One tag per visit: a recall replaces the previous notification
        // rather than stacking a second one.
        tag: `visit-${visitId}`,
        body,
        requireInteraction: isTurn,
        visitId,
        recipient: "patient",
      });
    });
  }

  async #deliver(input: {
    title: string;
    body: string;
    tag: string;
    requireInteraction: boolean;
    visitId: VisitId | null;
    recipient: "staff" | "patient";
  }): Promise<void> {
    const base = {
      channel: "browser" as const,
      visitId: input.visitId,
      recipient: input.recipient,
      occurredAt: new Date(),
    };

    if (!this.options.notifications.supported) {
      this.options.operations.recordAttempt({
        ...base,
        status: "unsupported",
        error: "This browser cannot show notifications",
      });
      return;
    }

    const permission = this.options.notifications.permission();
    if (permission !== "granted") {
      // Declined permission is a choice, not a fault — recorded distinctly so
      // it never counts against channel health (ADR-029).
      this.options.operations.recordAttempt({
        ...base,
        status: "denied",
        error: null,
      });
      return;
    }

    try {
      await this.options.notifications.show({
        title: input.title,
        body: input.body,
        tag: input.tag,
        requireInteraction: input.requireInteraction,
      });
      this.options.operations.recordAttempt({
        ...base,
        status: "delivered",
        error: null,
      });
    } catch (error) {
      this.options.operations.recordAttempt({
        ...base,
        status: "failed",
        error: error instanceof Error ? error.message : "Delivery failed",
      });
    }
  }
}

function titleFor(event: VisitEvent): string {
  switch (event.type) {
    case "visit.routed":
      return "Your visit has moved on";
    case "visit.completed":
      return "Your visit is complete";
    default:
      return "Update on your visit";
  }
}
