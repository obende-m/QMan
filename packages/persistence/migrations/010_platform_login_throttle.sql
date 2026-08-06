-- Account lockout for platform administrators.
--
-- `login_throttle` is keyed (hospital_id, username_key) with a NOT NULL foreign
-- key, and a platform administrator has no hospital. There is no sentinel value
-- that would work: a nil UUID fails the foreign key, and one that did not would
-- put platform lockout state in a table that cascades when a hospital is
-- deleted.
--
-- Keyed by username alone, and otherwise identical — same rolling window of
-- failures, same lock, and rows created for usernames that do not exist so the
-- table cannot become an oracle for which platform accounts are real. That
-- matters more here than on the organization side: there are few of these
-- accounts and each one holds every platform permission.
--
-- The sliding-window IP rate limiter that sits in front of lockout is shared
-- code and needs nothing here.

CREATE TABLE platform_login_throttle (
    username_key text          PRIMARY KEY,
    failures     timestamptz[] NOT NULL DEFAULT '{}',
    locked_until timestamptz,
    updated_at   timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX platform_login_throttle_stale
    ON platform_login_throttle (updated_at);
