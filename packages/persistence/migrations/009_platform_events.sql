-- The platform audit log.
--
-- `events.hospital_id` is NOT NULL and platform actions have no hospital —
-- creating one is precisely the action that happens before any hospital exists
-- to scope it to. So the platform gets its own log, mirroring the shape of
-- `events`: monotonic sequence, type, rendered summary, jsonb payload.
--
-- Two deletion rules are load-bearing.
--
-- `target_hospital_id` is nullable and ON DELETE SET NULL, not CASCADE. "Who
-- suspended Freshsprings, when, and why" must survive Freshsprings. A cascade
-- here would erase the audit trail of exactly the actions most worth auditing,
-- at exactly the moment someone would come looking for it — the name is kept in
-- the payload for that reason, so the record still reads after the row is gone.
--
-- `actor_id` is ON DELETE SET NULL for the same reason: a departed
-- administrator's actions remain in the log.

CREATE TABLE platform_events (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence           bigserial   NOT NULL,
    type               text        NOT NULL,
    actor_id           uuid REFERENCES platform_users (id) ON DELETE SET NULL,
    target_hospital_id uuid REFERENCES hospitals (id) ON DELETE SET NULL,
    -- The request id, so a platform action joins to the server log the same way
    -- an organization event does.
    correlation_id     text,
    occurred_at        timestamptz NOT NULL,
    recorded_at        timestamptz NOT NULL DEFAULT now(),
    payload            jsonb       NOT NULL DEFAULT '{}',
    -- Rendered at write time, so history reads as it did when it happened even
    -- after the organization it refers to has been renamed or removed.
    summary            text        NOT NULL
);

CREATE UNIQUE INDEX platform_events_sequence ON platform_events (sequence);

CREATE INDEX platform_events_recent
    ON platform_events (occurred_at DESC);

-- "Everything that has ever been done to this organization", which is the
-- question asked during a support call.
CREATE INDEX platform_events_by_target
    ON platform_events (target_hospital_id, occurred_at DESC)
    WHERE target_hospital_id IS NOT NULL;
