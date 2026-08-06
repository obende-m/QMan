-- Platform sessions.
--
-- A separate table rather than a `kind` column on `sessions`, and the
-- difference is not stylistic.
--
-- With one table and a discriminator, every lookup that forgot to filter on it
-- would accept a platform token where an organization token was expected, or
-- the reverse. The check would exist in code, in as many places as there are
-- lookups, and would be correct until one of them was written in a hurry.
--
-- With two tables the mistake cannot be made: the organization session lookup
-- queries `sessions`, a platform token is not in `sessions`, and no filter has
-- to be remembered for that to hold. The two cookie names (qman_session and
-- qman_platform_session) are the other half of the same property.
--
-- Everything else matches the organization side deliberately: opaque tokens,
-- SHA-256 hashes stored rather than the token, no expiry column because idle
-- and absolute timeouts are computed from the two timestamps.

CREATE TABLE platform_sessions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid        NOT NULL REFERENCES platform_users (id) ON DELETE CASCADE,
    token_hash     text,
    user_agent     text        NOT NULL DEFAULT '',
    started_at     timestamptz NOT NULL DEFAULT now(),
    last_active_at timestamptz NOT NULL DEFAULT now(),
    ended_at       timestamptz,
    end_reason     text
);

CREATE UNIQUE INDEX platform_sessions_token_hash_key
    ON platform_sessions (token_hash)
    WHERE token_hash IS NOT NULL;

CREATE INDEX platform_sessions_active
    ON platform_sessions (user_id, last_active_at DESC)
    WHERE ended_at IS NULL;
