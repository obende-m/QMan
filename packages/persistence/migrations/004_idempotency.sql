-- Idempotency.
--
-- A receptionist presses Call. The request reaches the server, the patient is
-- called, and the response is lost to a dropped connection. The browser retries.
--
-- Without this table the retry is indistinguishable from a deliberate second
-- press, and the aggregate treats a second call as a recall: the call attempt
-- counter advances, the announcement plays again, and the audit trail records
-- something that never happened. On a hospital's network — where a wireless
-- reception desk drops packets and a laptop suspends mid-request — this is not
-- an unlikely case.
--
-- So a client may attach a key to a state-changing request. The first request
-- carrying that key does the work and its response is stored; any later request
-- carrying the same key is answered from the store without doing the work
-- again.
--
-- The fingerprint exists to catch a different mistake: the same key reused for a
-- genuinely different request. That is a client bug, and answering it with the
-- first request's response would be worse than refusing it — the caller would
-- believe an action succeeded that was never attempted.

CREATE TABLE idempotency_keys (
    hospital_id  uuid        NOT NULL REFERENCES hospitals (id) ON DELETE CASCADE,
    key          text        NOT NULL,
    -- Method, path and body. Distinguishes a retry from a reused key.
    fingerprint  text        NOT NULL,
    -- Null until the first request finishes. A row with no response is a
    -- request still in flight, which is how two concurrent retries are told
    -- apart from a retry of something already answered.
    status_code  integer,
    response     jsonb,
    claimed_at   timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    PRIMARY KEY (hospital_id, key)
);

-- Keys are worth keeping only as long as a client might retry. Pruning runs on
-- this index; without it the table grows for the life of the deployment.
CREATE INDEX idempotency_keys_claimed
    ON idempotency_keys (claimed_at);
