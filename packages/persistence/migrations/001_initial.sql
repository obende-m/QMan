-- QMan initial schema (PostgreSQL 14+)
--
-- Two principles run through this file.
--
-- 1. Store facts, derive views. Queue position, worklists, SLA status,
--    bottlenecks and every dashboard number are projections over the rows
--    below. None of them are stored, because a stored projection is a copy
--    that can disagree with the thing it copies — and the moment it does,
--    nobody knows which is right.
--
-- 2. Business events are records, not logs. `events` is a durable history of
--    what the hospital did, queryable on its own terms. This is not event
--    sourcing: visits and queue entries are ordinary rows and remain the
--    working state. The log runs alongside them as the narrative.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────── organisation

CREATE TABLE hospitals (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text        NOT NULL,
    code          text        NOT NULL UNIQUE,
    timezone      text        NOT NULL DEFAULT 'UTC',
    support_phone text,
    brand_color   text        NOT NULL DEFAULT '#003ec7',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    hospital_id uuid        NOT NULL REFERENCES hospitals (id) ON DELETE CASCADE,
    name        text        NOT NULL,
    code        text        NOT NULL,
    is_default  boolean     NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (hospital_id, code)
);

-- Exactly one default branch per hospital, enforced by the database rather
-- than by whichever code path happens to write last.
CREATE UNIQUE INDEX branches_one_default
    ON branches (hospital_id)
    WHERE is_default;

-- ────────────────────────────────────────────────────────── identity

CREATE TABLE roles (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    hospital_id uuid        NOT NULL REFERENCES hospitals (id) ON DELETE CASCADE,
    key         text        NOT NULL,
    name        text        NOT NULL,
    description text        NOT NULL DEFAULT '',
    -- Permission names are a closed set in the domain; stored as text[] so a
    -- role's grant is one row rather than a join table nobody reads.
    permissions text[]      NOT NULL DEFAULT '{}',
    is_system   boolean     NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (hospital_id, key)
);

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    hospital_id   uuid        NOT NULL REFERENCES hospitals (id) ON DELETE CASCADE,
    role_id       uuid        NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
    display_name  text        NOT NULL,
    username      text        NOT NULL,
    provider_id   text        NOT NULL DEFAULT 'local',
    -- Null for directory-backed accounts, which hold no password here.
    password_hash text,
    password_salt text,
    enabled       boolean     NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (hospital_id, lower(username))
);

-- Empty means every branch, so a single-site hospital configures nothing.
CREATE TABLE user_branches (
    user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    branch_id uuid NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, branch_id)
);

CREATE TABLE sessions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    branch_id     uuid REFERENCES branches (id) ON DELETE SET NULL,
    provider_id   text        NOT NULL,
    device        text        NOT NULL DEFAULT '',
    user_agent    text        NOT NULL DEFAULT '',
    started_at    timestamptz NOT NULL DEFAULT now(),
    last_active_at timestamptz NOT NULL DEFAULT now(),
    ended_at      timestamptz,
    end_reason    text
);

-- The administration screen only ever lists live sessions; a partial index
-- keeps that query cheap as ended sessions accumulate.
CREATE INDEX sessions_active
    ON sessions (user_id, last_active_at DESC)
    WHERE ended_at IS NULL;

-- ──────────────────────────────────────────────────────── configuration

CREATE TABLE stations (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id            uuid        NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
    name                 text        NOT NULL,
    code                 text        NOT NULL,
    room                 text,
    staffing             integer     NOT NULL DEFAULT 1 CHECK (staffing >= 1),
    service_estimate_ms  integer     NOT NULL CHECK (service_estimate_ms > 0),
    sla_target_wait_ms   integer     NOT NULL CHECK (sla_target_wait_ms > 0),
    sla_saturation_point integer     NOT NULL CHECK (sla_saturation_point >= 1),
    -- Queue numbering is a template plus a reset strategy; both are config.
    queue_template       text        NOT NULL,
    queue_reset          text        NOT NULL DEFAULT 'daily',
    queue_manual_epoch   text,
    is_public            boolean     NOT NULL DEFAULT true,
    enabled              boolean     NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (branch_id, code)
);

CREATE TABLE workflows (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id  uuid        NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
    name       text        NOT NULL,
    is_default boolean     NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX workflows_one_default
    ON workflows (branch_id)
    WHERE is_default;

CREATE TABLE workflow_stages (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id  uuid    NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
    station_id   uuid    NOT NULL REFERENCES stations (id) ON DELETE RESTRICT,
    sequence     integer NOT NULL,
    is_required  boolean NOT NULL DEFAULT true,
    allow_skip   boolean NOT NULL DEFAULT false,
    allow_repeat boolean NOT NULL DEFAULT false,
    -- Stations this stage may branch to, beyond the next in sequence.
    branches_to  uuid[]  NOT NULL DEFAULT '{}',
    UNIQUE (workflow_id, sequence),
    -- A station may appear once per workflow; revisits use allow_repeat.
    UNIQUE (workflow_id, station_id)
);

CREATE TABLE display_boards (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id          uuid        NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
    name               text        NOT NULL,
    station_ids        uuid[]      NOT NULL DEFAULT '{}',
    waiting_to_show    integer     NOT NULL DEFAULT 4 CHECK (waiting_to_show >= 1),
    name_policy        text        NOT NULL DEFAULT 'ticket_only',
    show_estimated_wait boolean    NOT NULL DEFAULT true,
    show_room          boolean     NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ticket_templates (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    hospital_id  uuid        NOT NULL REFERENCES hospitals (id) ON DELETE CASCADE,
    name         text        NOT NULL,
    paper        text        NOT NULL,
    -- Ordered [{element, condition}]; the shape is validated in the domain.
    elements     jsonb       NOT NULL DEFAULT '[]',
    instructions text        NOT NULL DEFAULT '',
    footer       text        NOT NULL DEFAULT '',
    name_policy  text        NOT NULL DEFAULT 'ticket_only',
    tracking_url text        NOT NULL DEFAULT '/track.html',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Settings that are genuinely singular per hospital: privacy default,
-- announcement templates, default ticket template.
CREATE TABLE hospital_settings (
    hospital_id uuid PRIMARY KEY REFERENCES hospitals (id) ON DELETE CASCADE,
    settings    jsonb       NOT NULL DEFAULT '{}',
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────── visits

CREATE TABLE visits (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       uuid        NOT NULL REFERENCES branches (id) ON DELETE RESTRICT,
    workflow_id     uuid        NOT NULL REFERENCES workflows (id) ON DELETE RESTRICT,
    journey_code    text        NOT NULL,
    -- The minimum patient reference. Clinical data stays in the HMS.
    patient_name    text        NOT NULL,
    hospital_number text,
    phone           text,
    status          text        NOT NULL,
    priority        text        NOT NULL DEFAULT 'normal',
    -- Denormalised pointer to the open queue entry. Not derived state: it is
    -- the aggregate's own record of where the visit is, and every read of a
    -- visit needs it.
    current_queue_entry_id uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,
    closed_at       timestamptz
);

-- Journey codes are unique among *active* visits only, which is what lets them
-- stay four characters and recycle daily.
CREATE UNIQUE INDEX visits_active_journey_code
    ON visits (branch_id, journey_code)
    WHERE closed_at IS NULL;

CREATE INDEX visits_branch_status ON visits (branch_id, status);
CREATE INDEX visits_created ON visits (branch_id, created_at DESC);
CREATE INDEX visits_hospital_number ON visits (hospital_number)
    WHERE hospital_number IS NOT NULL;

CREATE TABLE queue_entries (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    visit_id         uuid        NOT NULL REFERENCES visits (id) ON DELETE CASCADE,
    station_id       uuid        NOT NULL REFERENCES stations (id) ON DELETE RESTRICT,
    -- The ordinal the system allocates and sorts by.
    queue_number     integer     NOT NULL,
    -- The ticket as issued. Stored, never re-rendered: a patient holding a
    -- printed slip must still match the board after the format changes.
    queue_label      text        NOT NULL,
    -- The counting period this ordinal came from. Stored so a series can be
    -- rebuilt after a restore without re-deriving it from configuration that
    -- may since have changed — a wrong guess reissues a number a patient holds.
    queue_period     text        NOT NULL,
    status           text        NOT NULL,
    assigned_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
    queued_at        timestamptz NOT NULL DEFAULT now(),
    called_at        timestamptz,
    started_at       timestamptz,
    completed_at     timestamptz,
    call_attempts    integer     NOT NULL DEFAULT 0,
    skipped          boolean     NOT NULL DEFAULT false,
    skip_reason      text,
    sequence         integer     NOT NULL
);

-- The visit's legs, in order. Ordering is explicit rather than by timestamp,
-- because two legs can share a millisecond.
CREATE UNIQUE INDEX queue_entries_visit_sequence
    ON queue_entries (visit_id, sequence);

-- The query behind every station worklist.
CREATE INDEX queue_entries_open
    ON queue_entries (station_id, queued_at)
    WHERE status IN ('waiting', 'called', 'in_progress');

CREATE INDEX queue_entries_station_day
    ON queue_entries (station_id, queued_at DESC);

ALTER TABLE visits
    ADD CONSTRAINT visits_current_entry_fk
    FOREIGN KEY (current_queue_entry_id)
    REFERENCES queue_entries (id) ON DELETE SET NULL;

-- Per-station, per-period ticket allocation.
--
-- A row per counting period, incremented under a row lock. This is the piece
-- that cannot be done in the aggregate: two receptions admitting patients
-- simultaneously must not both be issued A-014.
-- Rebuilding a series after a restore reads the high-water mark per period.
CREATE INDEX queue_entries_series
    ON queue_entries (station_id, queue_period, queue_number DESC);

CREATE TABLE queue_number_sequences (
    station_id uuid    NOT NULL REFERENCES stations (id) ON DELETE CASCADE,
    period_key text    NOT NULL,
    last_value integer NOT NULL DEFAULT 0,
    PRIMARY KEY (station_id, period_key)
);

-- ─────────────────────────────────────────────────────────────── events

-- Business history. Every state change the hospital made, queryable on its own
-- terms and never deleted by ordinary operation.
CREATE TABLE events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    hospital_id uuid        NOT NULL REFERENCES hospitals (id) ON DELETE CASCADE,
    branch_id   uuid        NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
    -- Total order independent of wall clocks, which drift between machines.
    sequence    bigserial   NOT NULL,
    category    text        NOT NULL CHECK (category IN ('operational', 'administrative', 'security')),
    type        text        NOT NULL,
    visit_id    uuid REFERENCES visits (id) ON DELETE SET NULL,
    -- Journey Code for operational events, session id for administrative ones.
    -- Turns an investigation into one indexed query rather than a manual
    -- reconstruction across tables.
    correlation_id text,
    actor_id    uuid REFERENCES users (id) ON DELETE SET NULL,
    occurred_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    payload     jsonb       NOT NULL DEFAULT '{}',
    -- Rendered once, at write time, so the explorer needs no domain logic and
    -- so history reads as it did when it happened.
    summary     text        NOT NULL
);

CREATE UNIQUE INDEX events_sequence ON events (hospital_id, sequence);

-- The Activity Timeline: operational events, newest first.
CREATE INDEX events_operational
    ON events (branch_id, occurred_at DESC)
    WHERE category = 'operational';

-- The Audit Log: administrative and security events.
CREATE INDEX events_audit
    ON events (hospital_id, occurred_at DESC)
    WHERE category IN ('administrative', 'security');

-- "Everything that happened to this patient."
CREATE INDEX events_visit ON events (visit_id, sequence)
    WHERE visit_id IS NOT NULL;

-- "Everything that happened to QM-8F4K", and "everything done in one sitting".
CREATE INDEX events_correlation ON events (correlation_id, sequence)
    WHERE correlation_id IS NOT NULL;

-- "Everything this member of staff did."
CREATE INDEX events_actor ON events (actor_id, occurred_at DESC)
    WHERE actor_id IS NOT NULL;

-- Free-text search over the rendered summary, which is what the explorer's
-- search box actually queries.
CREATE INDEX events_summary_search
    ON events USING gin (to_tsvector('simple', summary));

-- ─────────────────────────────────────────────────── notification records

-- Delivery outcomes, feeding the Command Centre's channel health. Kept because
-- "did the patient get told" is a question worth answering after the fact.
CREATE TABLE notification_attempts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id   uuid        NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
    visit_id    uuid REFERENCES visits (id) ON DELETE SET NULL,
    channel     text        NOT NULL,
    recipient   text        NOT NULL CHECK (recipient IN ('patient', 'staff')),
    status      text        NOT NULL,
    error       text,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_attempts_recent
    ON notification_attempts (branch_id, occurred_at DESC);

COMMIT;
