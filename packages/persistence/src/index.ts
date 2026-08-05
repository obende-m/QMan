/**
 * @qman/persistence — the database layer.
 *
 * Conventional relational storage plus a durable business event log. Not event
 * sourcing: visits and queue entries are ordinary rows and remain the working
 * state, with the event log alongside them as history.
 *
 * Nothing derivable is stored. Queue position, worklists, SLA status,
 * bottlenecks and every dashboard figure are projections computed from these
 * rows, because a stored projection is a copy that can disagree with the thing
 * it copies.
 */
export * from "./rows.js";
export * from "./mappers.js";
export * from "./sql.js";
export * from "./pg.js";
export * from "./migrator.js";
export * from "./repositories.js";
export * from "./configuration.js";
export * from "./configuration-writer.js";
