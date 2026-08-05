/**
 * Structured logging.
 *
 * Every line answers the same six questions — what happened, when, which
 * hospital, which branch, which user, which request — because those are the
 * questions asked when something has gone wrong in a clinic and the person
 * asking is on the phone. Prose logs answer them only when whoever wrote the
 * line happened to think of it.
 *
 * The request identifier is the thread through all of it. One identifier
 * appears on the access line, on any error, and on audit entries written while
 * handling that request, so "the receptionist says it failed around ten past
 * nine" becomes a single query rather than an afternoon.
 *
 * Quiet by default. Debug logging that is on in production is logging nobody
 * reads, filling a disk that a hospital's operations depend on.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * The context every line carries when it is known.
 *
 * All optional: a sign-in failure has no user, and a health check has no
 * hospital. Absent is honest; a placeholder would not be.
 */
export interface LogContext {
  readonly requestId?: string | undefined;
  readonly hospitalId?: string | undefined;
  readonly branchId?: string | null | undefined;
  readonly userId?: string | undefined;
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** A logger that carries this context on every line it writes. */
  child(context: LogContext): Logger;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly now?: () => Date;
  /** Where lines go. Injected so tests can read them and production can redirect. */
  readonly write?: (line: string) => void;
}

/**
 * Redacts values that should never reach a log file.
 *
 * Belt and braces: nothing here is supposed to be passed a password or a token
 * in the first place. But a log call is added in a hurry during an incident,
 * and the cost of the mistake — a credential written to a file that is copied,
 * shipped and retained far more freely than the database — is high enough to
 * defend against twice.
 */
const SECRET_KEYS = /^(password|token|secret|authorization|cookie|hash|salt)$/i;

function scrub(context: LogContext): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    safe[key] = SECRET_KEYS.test(key) ? "[redacted]" : value;
  }
  return safe;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = ORDER[options.level ?? "info"];
  const now = options.now ?? (() => new Date());
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  const make = (bound: LogContext): Logger => {
    const emit = (level: LogLevel, message: string, context: LogContext = {}): void => {
      if (ORDER[level] < threshold) return;
      write(
        JSON.stringify({
          at: now().toISOString(),
          level,
          message,
          ...scrub({ ...bound, ...context }),
        }),
      );
    };

    return {
      debug: (message, context) => emit("debug", message, context),
      info: (message, context) => emit("info", message, context),
      warn: (message, context) => emit("warn", message, context),
      error: (message, context) => emit("error", message, context),
      child: (context) => make({ ...bound, ...context }),
    };
  };

  return make({});
}

/** A logger that writes nowhere. For tests that are not about logging. */
export function silentLogger(): Logger {
  return createLogger({ write: () => {} });
}
