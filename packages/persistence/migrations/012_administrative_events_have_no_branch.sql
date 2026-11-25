-- Administrative events belong to a hospital, not to a branch.
--
-- `events.branch_id` was NOT NULL, which is right for the operational events
-- the column was designed for: a patient is called at a station, in a branch.
-- It is wrong for the administrative ones. Renaming a hospital, adding a ticket
-- template or changing a role happens to the organization as a whole, and the
-- code has always said so — `ChangeContext.branchId` is typed `BranchId | null`
-- and is filled from the session, which is null for an administrator who is not
-- pinned to one branch. Which is every administrator a new organization starts
-- with, since an empty user_branches means "every branch".
--
-- The consequence was total: any configuration write by such an administrator
-- failed on this constraint and surfaced as a 500. It survived every test
-- because the configuration suites use an in-memory event repository, and the
-- constraint only exists in SQL. The same shape of gap as the one that put an
-- expression inside a UNIQUE table constraint in 001.
--
-- Relaxing a NOT NULL is non-destructive: every existing row already has a
-- branch and keeps it. The two partial indexes are unaffected — the operational
-- one covers `category = 'operational'`, whose rows still always carry a
-- branch, and the audit one is keyed on hospital_id, which is where
-- administrative events were always meant to be read from.

ALTER TABLE events
    ALTER COLUMN branch_id DROP NOT NULL;

-- What replaces the constraint, narrowed to the case it was actually protecting.
-- An operational event without a branch would be a queue event nobody could
-- attribute to a waiting room, and that is still forbidden.
ALTER TABLE events
    ADD CONSTRAINT events_operational_have_a_branch
    CHECK (category <> 'operational' OR branch_id IS NOT NULL);
