-- Visits refuse values the application cannot read back, carry a version for
-- optimistic locking, and can be found cheaply by the job that closes them.
--
-- 1. Priority and status are closed sets in the domain, and nothing in the
--    schema said so. The admission endpoint once stored whatever string it was
--    sent, and a single row with an unrecognised priority made the mapper throw
--    on every read of that branch: reception list, station worklists, display
--    boards and patient tracking all answered 500 together. The API now
--    validates, and these constraints make the database the last line rather
--    than a bystander.
--
--    Any row that already holds an unrecognised value is repaired before the
--    constraint is added, because a constraint that cannot be validated would
--    leave the branch exactly as unreadable as it is now. The repair is to the
--    least consequential reading — 'normal' — and each repaired visit gets an
--    audit record saying so, so the change is visible to an administrator
--    rather than silent.
--
-- 2. `version` makes concurrent writes detectable. Two workstations acting on
--    the same visit used to both load it, both apply their action, and both
--    upsert — the second silently erasing the first, including its queue entry
--    changes, while both audit events were kept. Every write now states the
--    version it read and fails when that is no longer current.
--
-- 3. The closure job looks for finished visits that are still open. Without an
--    index that is a scan of every visit the hospital has ever had.

INSERT INTO events (hospital_id, branch_id, category, type, visit_id,
                    correlation_id, actor_id, occurred_at, payload, summary)
SELECT b.hospital_id, v.branch_id, 'administrative', 'visit.priority_repaired',
       v.id, v.journey_code, NULL, now(),
       jsonb_build_object('from', v.priority, 'to', 'normal'),
       'Visit ' || v.journey_code || ' had an unrecognised priority and was reset to normal'
FROM visits v
JOIN branches b ON b.id = v.branch_id
WHERE v.priority NOT IN ('emergency', 'high', 'vip', 'normal');

UPDATE visits SET priority = 'normal'
WHERE priority NOT IN ('emergency', 'high', 'vip', 'normal');

ALTER TABLE visits
    ADD CONSTRAINT visits_priority_known
    CHECK (priority IN ('emergency', 'high', 'vip', 'normal'));

ALTER TABLE visits
    ADD CONSTRAINT visits_status_known
    CHECK (status IN ('created', 'queued', 'called', 'in_progress',
                      'completed', 'cancelled', 'closed'));

ALTER TABLE visits
    ADD COLUMN version integer NOT NULL DEFAULT 0;

CREATE INDEX visits_awaiting_closure
    ON visits (branch_id, status, created_at)
    WHERE closed_at IS NULL;
