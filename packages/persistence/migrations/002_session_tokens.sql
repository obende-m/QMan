-- Session tokens.
--
-- Sessions existed as rows from the beginning, but nothing bound a row to the
-- browser holding it. This adds that binding, and it stores a hash rather than
-- the token itself.
--
-- The distinction matters at exactly one moment, and it is the moment that
-- counts: when a copy of the database leaves the building. A nightly backup, a
-- restored snapshot on a developer laptop, a disk handed to a supplier — any of
-- those, holding raw tokens, is a set of working logins for every member of
-- staff currently signed in. Holding hashes, it is a set of useless strings.
-- The server compares hashes, so nothing is lost by never storing the original.
--
-- No expiry column. Idle and absolute timeouts are computed from started_at and
-- last_active_at against the session policy, and storing a third value derived
-- from the other two invites the day they disagree.

ALTER TABLE sessions
    ADD COLUMN token_hash text;

-- Partial, because directory-backed sessions created before this migration have
-- no token and must not collide with each other on NULL.
CREATE UNIQUE INDEX sessions_token_hash_key
    ON sessions (token_hash)
    WHERE token_hash IS NOT NULL;

-- Every authenticated request resolves a token to a live session, so this is
-- the hottest lookup in the system. Restricted to sessions still open, which is
-- the only kind worth finding.
CREATE INDEX sessions_open
    ON sessions (token_hash)
    WHERE ended_at IS NULL AND token_hash IS NOT NULL;
