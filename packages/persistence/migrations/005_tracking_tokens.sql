-- Tracking tokens.
--
-- The patient tracking page needs a way to identify a visit to someone who has
-- no account and never will. Until now that was the Journey Code, and the
-- Journey Code is not strong enough to be a credential.
--
-- It cannot be. It is thirty symbols over six characters — around 810 million
-- combinations, but far fewer in practice because only codes issued today at
-- this branch resolve to anything. It is designed to be read aloud across a
-- reception desk, typed by someone holding a paper ticket, and recognised at a
-- glance. Every property that makes it good at that makes it guessable: it is
-- short, it excludes confusable characters, and it is printed in the open.
--
-- So it keeps its job — the human-readable handle staff and patients speak —
-- and a separate token takes on the job of proving which visit you are asking
-- about. The token is long and random, appears only inside the QR code, and is
-- never spoken, displayed on a board, or written on the ticket in words.
--
-- Only the hash is stored, for the same reason session tokens are hashed: a
-- backup that leaves the building is then a set of useless strings rather than
-- a working key to every patient's queue position.

ALTER TABLE visits
    ADD COLUMN tracking_token_hash text;

CREATE UNIQUE INDEX visits_tracking_token_key
    ON visits (tracking_token_hash)
    WHERE tracking_token_hash IS NOT NULL;

-- Manual Journey Code entry remains supported, and remains rate limited. This
-- is the lookup it uses: scoped to a branch and to visits that are still open,
-- so a code from last month resolves to nothing at all.
CREATE INDEX visits_open_journey_code
    ON visits (branch_id, journey_code)
    WHERE closed_at IS NULL;
