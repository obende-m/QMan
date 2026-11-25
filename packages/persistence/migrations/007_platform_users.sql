-- Platform administrators.
--
-- QMan's own staff, who belong to no hospital. That is the entire reason this
-- is a table rather than a flag on `users`.
--
-- `users.hospital_id` is NOT NULL, and every tenant-scoped query in the system
-- relies on it being so. Relaxing it to accommodate an account with no hospital
-- would give every one of those queries a NULL case, and would turn a forgotten
-- `WHERE hospital_id = $1` from a query returning nothing into a query
-- returning everyone's data. A separate table keeps the constraint intact and
-- leaves no join from a platform administrator to a hospital's rows at all.
--
-- Usernames are globally unique here, not per-hospital: there is no hospital to
-- scope them to.

CREATE TABLE platform_users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username      text        NOT NULL,
    display_name  text        NOT NULL,
    -- scrypt, from the same passwords.ts the organization side uses. One
    -- implementation of password hashing, not two.
    password_hash text        NOT NULL,
    password_salt text        NOT NULL,
    role          text        NOT NULL DEFAULT 'super_admin',
    enabled       boolean     NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    -- A closed set, mirroring the domain's PLATFORM_ROLES. A role the
    -- application does not recognise must not be storable: it would resolve to
    -- an empty permission set at best, and to whatever a future release decides
    -- the string means at worst.
    CONSTRAINT platform_users_role_known CHECK (role IN ('super_admin'))
);

-- Case-insensitive, for the same reason as users_hospital_username_key: two
-- accounts differing only in capitalisation are a support call waiting to
-- happen. An expression index rather than a UNIQUE constraint, because a
-- constraint takes bare column names and cannot hold lower().
CREATE UNIQUE INDEX platform_users_username_key
    ON platform_users (lower(username));
