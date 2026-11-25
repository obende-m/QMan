-- Accounts that administrators can manage from inside the product.
--
-- Until now an organization had exactly the administrator provisioning gave it,
-- and no way to add a receptionist, withdraw access from someone who left, or
-- reset a forgotten password without a support engineer and a SQL prompt.
--
-- 1. `password_change_required` marks a password that someone other than its
--    holder knows: one generated at provisioning, or by an administrator's
--    reset. The holder is made to replace it before doing anything else, so a
--    temporary password read over the phone does not quietly become permanent.
--
-- 2. `password_changed_at` and `last_sign_in_at` answer the two questions an
--    administrator reviewing an account asks first. Neither is security
--    critical on its own; both are expensive to reconstruct from the event log.
--
-- 3. Session listing is per organization, through `users`. The partial index
--    on live sessions already exists; this one serves the join from the other
--    side, so listing one hospital's sessions does not scan everyone's.

ALTER TABLE users
    ADD COLUMN password_change_required boolean NOT NULL DEFAULT false,
    ADD COLUMN password_changed_at      timestamptz,
    ADD COLUMN last_sign_in_at          timestamptz;

CREATE INDEX users_hospital ON users (hospital_id);

CREATE INDEX sessions_live_by_user
    ON sessions (user_id)
    WHERE ended_at IS NULL;
