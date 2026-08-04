/**
 * Domain errors carry a stable machine-readable `code` alongside the human
 * message. The API layer maps codes to HTTP statuses and the UI maps them to
 * copy; neither parses message strings.
 */
export class DomainError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/**
 * The requested action is not legal from the aggregate's current state.
 *
 * This is the error that enforces the SAD's "no shortcuts" rule: a visit cannot
 * jump from Queued to Completed without passing through the states between.
 */
export class IllegalTransitionError extends DomainError {
  constructor(
    readonly from: string,
    readonly action: string,
    hint?: string,
  ) {
    super(
      "VISIT_ILLEGAL_TRANSITION",
      `Cannot "${action}" a visit in state "${from}".${hint ? ` ${hint}` : ""}`,
      { from, action },
    );
  }
}

/** A rule of the domain was violated (not a state-machine problem). */
export class InvariantViolationError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
  }
}

/** Input failed validation before any domain rule could be applied. */
export class ValidationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION_FAILED", message, details);
  }
}
