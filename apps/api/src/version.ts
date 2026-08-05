/**
 * The API version prefix.
 *
 * Fixed before any client exists, because it cannot be added afterwards without
 * breaking every one of them. A hospital does not update its display board
 * because a supplier changed a URL, and the three surfaces here will not always
 * be deployed together — a laboratory screen left running for six weeks is
 * ordinary, not an edge case.
 *
 * What v1 promises: a path here will not change meaning, lose a response field,
 * or gain a required request field. Adding an optional field or a new endpoint
 * is not a breaking change and does not need v2.
 *
 * `/api/health` is deliberately outside this. It is an operations endpoint for
 * load balancers and monitoring, not part of the contract clients depend on,
 * and versioning it would mean a monitoring check that breaks on an upgrade.
 */
export const V1 = "/api/v1";
