/**
 * @qman/domain — the engine shared by all three QMan products:
 * the Operations Platform, the Patient Experience, and Operations Intelligence.
 *
 * This package has no dependencies. No HTTP, no database, no framework, no
 * clock, no randomness. Everything it needs from the outside world arrives
 * through a port (Clock, IdGenerator, RandomSource, EventPublisher), which is
 * what lets the entire patient-flow rulebook be tested in milliseconds.
 */

export * from "./shared/ids.js";
export * from "./shared/clock.js";
export * from "./shared/errors.js";

export * from "./events/domain-event.js";
export * from "./events/visit-events.js";
export * from "./events/event-record.js";

export * from "./journey/journey-code.js";

export * from "./workflow/workflow.js";
export * from "./workflow/routing.js";

export * from "./visit/priority.js";
export * from "./visit/visit-status.js";
export * from "./visit/queue-entry.js";
export * from "./visit/visit.js";
export * from "./visit/visit-wire.js";

export * from "./queue/station-queue.js";
export * from "./queue/queue-number.js";

export * from "./privacy/patient-name.js";
export * from "./analytics/operations.js";

export * from "./configuration/hospital-config.js";
export * from "./configuration/rbac.js";

export * from "./telemetry/operational-health.js";
export * from "./telemetry/connection.js";
export * from "./announcements/announcement.js";
export * from "./printing/ticket-template.js";

export * from "./identity/identity.js";
export * from "./identity/password.js";
export * from "./identity/session.js";
