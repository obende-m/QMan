import {
  renderAnnouncement,
  type AnnouncementConfig,
  type AnnouncementEvent,
  type StationId,
  type VisitEvent,
} from "@qman/domain";
import type { EventSubscriber } from "../data/event-bus.js";
import type { OperationsStore } from "../data/operations-store.js";
import type { ConfigStore } from "../data/config-store.js";
import { stationName, stationRoom } from "../data/clinic-projections.js";
import type { ChimePort, SpeechPort } from "./ports.js";

/**
 * The voice announcement subscriber.
 *
 * Runs only where a hospital wants sound — a display board in a waiting hall,
 * or a station terminal with a speaker. It is a subscriber rather than
 * something the queue engine calls, so a hospital that wants silence simply
 * does not register it, and a browser that cannot speak degrades to a recorded
 * `unsupported` outcome instead of an exception.
 *
 * Announcements are serialised through a queue. Two patients called seconds
 * apart at different stations must not have their announcements spoken over
 * each other — the result is unintelligible, which is worse than either alone.
 */
export interface AnnouncerOptions {
  readonly speech: SpeechPort;
  readonly chime: ChimePort;
  readonly operations: OperationsStore;
  readonly config: ConfigStore;
}

export class VoiceAnnouncer {
  #queue: Array<() => Promise<void>> = [];
  #draining = false;

  constructor(private readonly options: AnnouncerOptions) {}

  subscriber(): EventSubscriber {
    return {
      name: "voice-announcer",
      events: ["visit.called", "visit.routed", "visit.completed"],
      handle: (event) => {
        const config = this.options.operations.announcementConfig;
        if (!config.enabled) return;

        const announcementEvent = toAnnouncementEvent(event);
        if (!announcementEvent) return;

        const text = this.#render(config, announcementEvent, event);
        if (!text) return;

        this.#enqueue(config, text);
      },
    };
  }

  #render(
    config: AnnouncementConfig,
    announcementEvent: AnnouncementEvent,
    event: VisitEvent,
  ): string | null {
    const payload = event.payload as Record<string, unknown>;
    const stationId =
      (payload["stationId"] as StationId | undefined) ??
      (payload["toStationId"] as StationId | undefined);
    if (!stationId) return null;

    return renderAnnouncement(config, announcementEvent, {
      ticket: (payload["queueLabel"] as string) ?? "",
      journeyCode: (payload["journeyCode"] as never) ?? ("" as never),
      patientName: (payload["patientName"] as string) ?? "",
      stationName: stationName(this.options.config.config, stationId),
      room: stationRoom(this.options.config.config, stationId),
      hospitalName: this.options.config.config.profile.name,
      namePolicy: this.options.config.config.defaults.namePolicy,
    });
  }

  #enqueue(config: AnnouncementConfig, text: string): void {
    this.#queue.push(async () => {
      const attempt = {
        channel: "voice" as const,
        visitId: null,
        recipient: "patient" as const,
        occurredAt: new Date(),
      };

      if (!this.options.speech.supported) {
        this.options.operations.recordAttempt({
          ...attempt,
          status: "unsupported",
          error: "Speech synthesis unavailable on this device",
        });
        return;
      }

      try {
        await this.options.chime.play(config.chime);
        await this.options.speech.speak({
          text,
          language: config.language,
          voice: config.voice,
          repeat: config.repeat,
        });
        this.options.operations.recordAttempt({
          ...attempt,
          status: "delivered",
          error: null,
        });
      } catch (error) {
        this.options.operations.recordAttempt({
          ...attempt,
          status: "failed",
          error: error instanceof Error ? error.message : "Announcement failed",
        });
      }
    });

    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0) {
        const next = this.#queue.shift()!;
        await next();
      }
    } finally {
      this.#draining = false;
    }
  }

  /** Number of announcements still waiting to be spoken. */
  get pending(): number {
    return this.#queue.length;
  }
}

function toAnnouncementEvent(event: VisitEvent): AnnouncementEvent | null {
  switch (event.type) {
    case "visit.called":
      return (event.payload as { callAttempt: number }).callAttempt > 1
        ? "recalled"
        : "called";
    case "visit.routed":
      return "routed";
    case "visit.completed":
      return "completed";
    default:
      return null;
  }
}
