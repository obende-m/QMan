import {
  DEFAULT_ANNOUNCEMENT_CONFIG,
  StationId,
  UserId,
  assessPresence,
  channelHealth,
  matchesQuery,
  categoryOf,
  renderAnnouncement,
  type JourneyCode,
  unhealthyDevices,
  unstaffedStations,
  type ActivityCategory,
  type AdminEventType,
  type EventQuery,
  type SecurityEventType,
  type AnnouncementConfig,
  type AnnouncementEvent,
  type ChannelHealth,
  type DeviceHeartbeat,
  type DeviceHealth,
  type NotificationAttempt,
  type NotificationChannel,
  type StaffActivity,
  type StaffPresence,
  type VisitEvent,
} from "@qman/domain";
import type { HospitalConfiguration } from "@qman/domain";
import type { ConfigStore } from "./config-store.js";
import { stores } from "./runtime-stores.js";
import { stationName, stationRoom } from "./clinic-projections.js";
import type { EventBus, EventSubscriber } from "./event-bus.js";

/** The slice of a stream event this store reads. */
export interface StreamEventLike {
  readonly type: string;
  readonly at: string;
  readonly visitId: string | null;
  readonly actorId: string | null;
  readonly correlationId: string | null;
  readonly stationId: string | null;
  readonly queueLabel: string | null;
  readonly summary: string;
}

/**
 * Operational telemetry for QMan itself.
 *
 * Fed entirely by subscribing to the event stream and by devices checking in.
 * It holds only what has a direct patient consequence — whether the waiting-room
 * screen is alive, whether notifications are landing, whether anyone is working
 * a queue. Deliberately not infrastructure monitoring: QMan reports on patient
 * flow, not on servers.
 */

export interface AnnouncementRecord {
  readonly id: string;
  readonly event: AnnouncementEvent;
  readonly text: string;
  readonly stationId: StationId;
  readonly occurredAt: Date;
  readonly spoken: boolean;
}

/**
 * A recorded event, in the shape the explorer reads.
 *
 * Mirrors `EventRecord` from the domain so that swapping the in-memory log for
 * the database repository changes nothing above this file.
 */
export interface AuditEntry {
  readonly id: string;
  readonly category: ActivityCategory;
  readonly type: string;
  readonly summary: string;
  readonly actorId: UserId | null;
  readonly visitId: string | null;
  /** Journey Code for operational events, session id for administrative ones. */
  readonly correlationId: string | null;
  readonly occurredAt: Date;
}

export class OperationsStore {
  #heartbeats = new Map<string, DeviceHeartbeat>();
  #attempts: NotificationAttempt[] = [];
  #activity = new Map<UserId, StaffActivity>();
  #announcements: AnnouncementRecord[] = [];
  #audit: AuditEntry[] = [];
  #announcementConfig: AnnouncementConfig = DEFAULT_ANNOUNCEMENT_CONFIG;
  #sequence = 0;
  #version = 0;
  #listeners = new Set<() => void>();

  constructor(private readonly config: ConfigStore = stores.config) {}

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getVersion = (): number => this.#version;

  get announcementConfig(): AnnouncementConfig {
    return this.#announcementConfig;
  }

  setAnnouncementConfig(config: AnnouncementConfig): void {
    this.#announcementConfig = config;
    this.#commit();
  }

  // ------------------------------------------------------------- device health

  /**
   * A device reporting that it is alive. Devices push; the server never polls,
   * because a screen behind a hospital firewall is usually not addressable.
   */
  heartbeat(device: Omit<DeviceHeartbeat, "lastSeenAt">, at: Date = new Date()): void {
    this.#heartbeats.set(device.deviceId, { ...device, lastSeenAt: at });
    this.#commit();
  }

  get devices(): DeviceHeartbeat[] {
    return [...this.#heartbeats.values()];
  }

  unhealthyDevices(now: Date): DeviceHealth[] {
    return unhealthyDevices(this.devices, now);
  }

  // ------------------------------------------------------ notification health

  recordAttempt(attempt: Omit<NotificationAttempt, "id">): void {
    this.#attempts = [
      { ...attempt, id: `att-${(this.#sequence += 1)}` },
      ...this.#attempts,
    ].slice(0, 500);
    this.#commit();
  }

  get attempts(): readonly NotificationAttempt[] {
    return this.#attempts;
  }

  channelHealth(now: Date): ChannelHealth[] {
    return channelHealth(this.#attempts, now);
  }

  // -------------------------------------------------------------- staff presence

  /** Presence is inferred from real actions, never from an open tab. */
  recordActivity(userId: UserId, stationId: StationId | null, at: Date = new Date()): void {
    this.#activity.set(userId, { userId, stationId, lastActionAt: at });
    this.#commit();
  }

  presence(now: Date): StaffPresence[] {
    return [...this.#activity.values()].map((activity) =>
      assessPresence(activity, now),
    );
  }

  unstaffedStations(stationsWithWaiting: readonly StationId[], now: Date): StationId[] {
    return unstaffedStations({
      stationsWithWaiting,
      presence: this.presence(now),
    });
  }

  // -------------------------------------------------------------- announcements

  get announcements(): readonly AnnouncementRecord[] {
    return this.#announcements;
  }

  get audit(): readonly AuditEntry[] {
    return this.#audit;
  }

  #record(entry: AnnouncementRecord): void {
    this.#announcements = [entry, ...this.#announcements].slice(0, 100);
  }

  #log(entry: Omit<AuditEntry, "id">): void {
    this.#audit = [
      { ...entry, id: `audit-${(this.#sequence += 1)}` },
      ...this.#audit,
    ].slice(0, 500);
  }

  /**
   * Records an administrative action — a configuration change.
   *
   * Called by the configuration store on every successful write, so "who
   * changed this SLA" is answerable without anyone having remembered to log it
   * at the call site.
   */
  recordAdminEvent(input: {
    type: AdminEventType;
    summary: string;
    actorId: UserId | null;
    correlationId: string | null;
    at?: Date;
  }): void {
    this.#log({
      category: "administrative",
      type: input.type,
      summary: input.summary,
      actorId: input.actorId,
      visitId: null,
      correlationId: input.correlationId,
      occurredAt: input.at ?? new Date(),
    });
    this.#commit();
  }

  /** Records a sign-in, sign-out, lockout or session termination. */
  recordSecurityEvent(input: {
    type: SecurityEventType;
    summary: string;
    actorId: UserId | null;
    correlationId: string | null;
    at?: Date;
  }): void {
    this.#log({
      category: "security",
      type: input.type,
      summary: input.summary,
      actorId: input.actorId,
      visitId: null,
      correlationId: input.correlationId,
      occurredAt: input.at ?? new Date(),
    });
    this.#commit();
  }

  /** Applies an `EventQuery` to the in-memory log, exactly as SQL would. */
  queryAudit(query: EventQuery): AuditEntry[] {
    return this.#audit.filter((entry) =>
      matchesQuery(
        {
          id: entry.id,
          sequence: 0,
          hospitalId: "" as never,
          branchId: "" as never,
          category: entry.category,
          type: entry.type,
          visitId: entry.visitId,
          correlationId: entry.correlationId,
          actorId: entry.actorId,
          occurredAt: entry.occurredAt,
          recordedAt: entry.occurredAt,
          payload: {},
          summary: entry.summary,
        },
        // `before` pages by sequence, which the in-memory log does not carry.
        stripPaging(query),
      ),
    );
  }

  #commit(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }

  // ------------------------------------------------------------- subscribers

  /**
   * Registers every operational subscriber on a bus.
   *
   * Each is a separate object with a single responsibility, so a failure in one
   * cannot take out the others — a broken announcement must not stop the audit
   * trail recording that the patient was called.
   */
  /**
   * Feeds the store from the server's event stream.
   *
   * The browser no longer produces domain events — the server does, and what
   * arrives is the staff projection: type, time, station, ticket, actor and a
   * summary already rendered at write time.
   *
   * That projection is enough for everything here except one thing, and the
   * difference is deliberate. The audit trail records what the server said
   * rather than re-deriving it, which is the point of rendering the summary
   * once. Announcements need the ticket and the station, both present.
   * Presence needs the actor, which the staff projection carries.
   *
   * There is one translation, here, and nothing downstream knows the transport
   * changed.
   */
  attachToStream(stream: {
    onEvent: (listener: (event: StreamEventLike) => void) => () => void;
  }): () => void {
    return stream.onEvent((event) => this.ingest(event));
  }

  /**
   * Loads the events already recorded, through the same translation.
   *
   * History and live traffic are the same events at different ages, so they go
   * through one interpretation. A second reader would be a second opinion
   * about what an event means, and the two would disagree the first time
   * either changed.
   */
  ingestHistory(events: readonly StreamEventLike[]): void {
    for (const event of events) this.ingest(event);
  }

  ingest(event: StreamEventLike): void {
    {
      const at = new Date(event.at);

      this.#log({
        // The domain decides which timeline an event belongs to. Hardcoding
        // "operational" here filed every configuration change under activity
        // and left the audit log empty.
        category: categoryOf(event.type),
        type: event.type,
        summary: event.summary,
        actorId: (event.actorId as UserId | null) ?? null,
        visitId: event.visitId,
        correlationId: event.correlationId,
        occurredAt: at,
      });

      if (event.actorId !== null && event.stationId !== null) {
        this.recordActivity(event.actorId as UserId, event.stationId as StationId, at);
      }

      if (event.type === "visit.called" && event.queueLabel !== null) {
        const stationId = (event.stationId ?? "") as StationId;
        this.#record({
          id: `ann-${(this.#sequence += 1)}`,
          event: "called",
          stationId,
          // Rendered from the hospital's own announcement template, not from
          // the audit summary: the two say different things to different
          // audiences, and a waiting room hears this one.
          text: renderAnnouncement(this.#announcementConfig, "called", {
            ticket: event.queueLabel,
            journeyCode: (event.correlationId ?? "") as JourneyCode,
            // The wire carries no patient name, by design. The template's
            // {name} token therefore renders empty here whatever the policy
            // says, which is the safe direction for something spoken aloud.
            patientName: "",
            stationName: stationName(this.config.config, stationId),
            room: stationRoom(this.config.config, stationId),
            hospitalName: this.config.config.profile.name,
            namePolicy: "ticket_only",
          }),
          occurredAt: at,
          spoken: false,
        });
      }
    }
  }

  attachTo(bus: EventBus): () => void {
    const unsubscribes = [
      bus.subscribe(this.#auditSubscriber()),
      bus.subscribe(this.#announcementSubscriber()),
      bus.subscribe(this.#notificationSubscriber()),
      bus.subscribe(this.#presenceSubscriber()),
    ];
    return () => unsubscribes.forEach((off) => off());
  }

  /**
   * The audit trail. Subscribes to everything and records without judgement —
   * ADR-005's guarantee is only worth anything if something writes it down.
   */
  #auditSubscriber(): EventSubscriber {
    return {
      name: "audit-log",
      handle: (event) => {
        this.#log({
          category: "operational",
          type: event.type,
          summary: summarise(event, this.config.config),
          actorId: event.actorId,
          visitId: event.visitId,
          // Carried on the event itself, so correlation survives a restart, a
          // late subscription, or events arriving from another process.
          correlationId: event.journeyCode,
          occurredAt: event.occurredAt,
        });
        this.#commit();
      },
    };
  }

  #announcementSubscriber(): EventSubscriber {
    return {
      name: "announcements",
      events: ["visit.called", "visit.routed", "visit.completed"],
      handle: (event) => {
        if (!this.#announcementConfig.enabled) return;

        const announcementEvent = toAnnouncementEvent(event);
        if (!announcementEvent) return;

        const context = this.#contextFor(event);
        if (!context) return;

        this.#record({
          id: `ann-${(this.#sequence += 1)}`,
          event: announcementEvent,
          text: renderAnnouncement(
            this.#announcementConfig,
            announcementEvent,
            context.announcement,
          ),
          stationId: context.stationId,
          occurredAt: event.occurredAt,
          // Speech synthesis is wired at the presentation layer; the record is
          // created either way so the command centre can show what *should*
          // have been said even where audio is unavailable.
          spoken: false,
        });
        this.#commit();
      },
    };
  }

  /**
   * Records notification intent and outcome.
   *
   * The dispatcher that actually delivers lives in the browser layer (it needs
   * the Notification API). This subscriber records that an attempt was owed,
   * so a channel that silently never fires is visible as `queued` attempts that
   * never became `delivered` — the failure mode that is otherwise invisible.
   */
  #notificationSubscriber(): EventSubscriber {
    return {
      name: "notifications",
      events: ["visit.called", "visit.routed", "visit.queued"],
      handle: (event) => {
        const recipient = event.type === "visit.queued" ? "staff" : "patient";
        this.recordAttempt({
          channel: "browser",
          status: "queued",
          visitId: event.visitId,
          recipient,
          occurredAt: event.occurredAt,
          error: null,
        });
      },
    };
  }

  /** Any action by a staff member is evidence they are at their post. */
  #presenceSubscriber(): EventSubscriber {
    return {
      name: "presence",
      handle: (event) => {
        if (!event.actorId) return;
        const stationId = stationOf(event);
        this.recordActivity(event.actorId, stationId, event.occurredAt);
      },
    };
  }

  #contextFor(event: VisitEvent):
    | { stationId: StationId; announcement: Parameters<typeof renderAnnouncement>[2] }
    | null {
    const stationId = stationOf(event);
    if (!stationId) return null;

    const payload = event.payload as Record<string, unknown>;
    const ticket =
      typeof payload["queueLabel"] === "string"
        ? (payload["queueLabel"] as string)
        : "";

    return {
      stationId,
      announcement: {
        ticket,
        journeyCode: (payload["journeyCode"] as never) ?? ("" as never),
        patientName: (payload["patientName"] as string) ?? "",
        stationName: stationName(this.config.config, stationId),
        room: stationRoom(this.config.config, stationId),
        hospitalName: this.config.config.profile.name,
        namePolicy: this.config.config.defaults.namePolicy,
      },
    };
  }
}

/** Drops `before`, which pages by a sequence the in-memory log does not keep. */
function stripPaging(query: EventQuery): EventQuery {
  const { before: _ignored, ...rest } = query;
  return rest;
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

function stationOf(event: VisitEvent): StationId | null {
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload["stationId"] === "string") {
    return payload["stationId"] as StationId;
  }
  if (typeof payload["toStationId"] === "string") {
    return payload["toStationId"] as StationId;
  }
  return null;
}

function summarise(
  event: VisitEvent,
  configuration: HospitalConfiguration,
): string {
  const payload = event.payload as Record<string, unknown>;
  const ticket = (payload["queueLabel"] as string) ?? "";

  switch (event.type) {
    case "visit.created":
      return `Visit created (${payload["journeyCode"]})`;
    case "visit.queued":
      return `Queued at ${stationName(configuration, payload["stationId"] as StationId)}${
        ticket ? ` as ${ticket}` : ""
      }`;
    case "visit.called":
      return `Called at ${stationName(configuration, payload["stationId"] as StationId)}`;
    case "visit.service_started":
      return `Service started at ${stationName(configuration, payload["stationId"] as StationId)}`;
    case "visit.skipped":
      return `Skipped at ${stationName(configuration, payload["stationId"] as StationId)}`;
    case "visit.stage_completed":
      return `Stage completed at ${stationName(configuration, payload["stationId"] as StationId)}`;
    case "visit.routed":
      return `Routed ${stationName(configuration, 
        payload["fromStationId"] as StationId,
      )} → ${stationName(configuration, payload["toStationId"] as StationId)}`;
    case "visit.completed":
      return "Visit completed";
    case "visit.cancelled":
      return "Visit cancelled";
    case "visit.closed":
      return "Visit closed";
    case "visit.priority_changed":
      return `Priority ${payload["from"]} → ${payload["to"]}`;
  }
}

export const operationsStore = new OperationsStore();
export const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  browser: "Browser",
  voice: "Voice",
  sms: "SMS",
  whatsapp: "WhatsApp",
  email: "Email",
};
