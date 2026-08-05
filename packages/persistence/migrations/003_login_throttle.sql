-- Login throttling.
--
-- Lockout counters held in process memory are lost on restart and are not
-- shared between instances, which weakens the control to "per process, until
-- the next deploy". An attacker who can provoke a restart — or who simply waits
-- for one — gets their five attempts back, and a second instance never knew
-- about the first one's count at all.
--
-- Keyed by hospital and username rather than by address. One clinic sits behind
-- one router, so locking on the address locks the whole reception desk because
-- one person mistyped. Rate limiting by address is a separate control that runs
-- in front of this one and does a different job.
--
-- There is deliberately no foreign key to users. Failures are recorded for
-- usernames that do not exist, because recording them only for real accounts
-- would make the table itself an oracle for which usernames are real — the
-- exact thing the uniform failure message exists to prevent.

CREATE TABLE login_throttle (
    hospital_id  uuid          NOT NULL REFERENCES hospitals (id) ON DELETE CASCADE,
    -- Lowercased, matching how usernames are compared everywhere else.
    username_key text          NOT NULL,
    -- The rolling window of recent failures. An array rather than a row per
    -- attempt: the window is small, bounded by policy, and always read whole.
    failures     timestamptz[] NOT NULL DEFAULT '{}',
    locked_until timestamptz,
    updated_at   timestamptz   NOT NULL DEFAULT now(),
    PRIMARY KEY (hospital_id, username_key)
);

-- Because usernames need not exist, an attacker spraying invented names can
-- grow this table without bound. Pruning is a maintenance task, and this is the
-- index it runs on.
CREATE INDEX login_throttle_stale
    ON login_throttle (updated_at);
