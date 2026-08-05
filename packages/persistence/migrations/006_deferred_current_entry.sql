-- The visit and its queue entry reference each other.
--
-- `visits.current_queue_entry_id` points at a queue entry, and every queue
-- entry points back at its visit. That is not an accident of modelling: a visit
-- needs to know where it currently is without scanning its entries, and an
-- entry is meaningless without the visit it belongs to.
--
-- Checked immediately, as it was, the pair cannot be written at all. Insert the
-- visit first and its pointer references an entry that does not exist yet;
-- insert the entry first and it references a visit that does not exist yet.
-- Admitting a patient — the one operation that creates both in the same breath —
-- fails on whichever half goes first.
--
-- Deferring the check moves it to COMMIT, by which time both rows are present.
-- The guarantee is unchanged: a transaction that ends with a visit pointing at
-- an entry that does not exist is still refused. What changes is that the two
-- rows no longer have to be valid in an order that does not exist.
--
-- This survived until now because saving a visit had only ever run against a
-- recording fake, which has no constraints to violate.

ALTER TABLE visits
    ALTER CONSTRAINT visits_current_entry_fk DEFERRABLE INITIALLY DEFERRED;
