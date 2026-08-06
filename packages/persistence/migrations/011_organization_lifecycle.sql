-- Organization lifecycle.
--
-- The only change this release makes to an existing table, and it only adds
-- columns. Every hospital that exists becomes 'active', which is what it
-- already effectively was, so the migration changes no behaviour on its own.
--
-- Suspension is reversible and destroys nothing. No rows are deleted, no
-- configuration is touched, no visit history is trimmed. What changes is that
-- the organization's staff cannot sign in and its public surfaces stop serving
-- — including display boards, because a suspension nobody standing in the
-- building can observe is not a suspension.
--
-- `hospitals.code` already exists and is globally UNIQUE, which is what makes
-- it usable as the login selector without a schema change. It stays editable:
-- it is a selector, not identity. `hospitals.id` is the tenant identifier
-- everywhere and nothing here changes that.

ALTER TABLE hospitals
    ADD COLUMN status           text NOT NULL DEFAULT 'active',
    ADD COLUMN suspended_at     timestamptz,
    ADD COLUMN suspended_reason text;

-- A status the application does not recognise must not be storable. The failure
-- mode being avoided is a typo that is neither 'active' nor 'suspended' and so
-- satisfies neither an activity check nor a suspension check, leaving an
-- organization in a state no code path handles.
ALTER TABLE hospitals
    ADD CONSTRAINT hospitals_status_known
    CHECK (status IN ('active', 'suspended'));

-- Partial: the platform's organization list is filtered by status, and
-- suspended organizations are the rare case worth indexing.
CREATE INDEX hospitals_suspended
    ON hospitals (suspended_at DESC)
    WHERE status = 'suspended';
