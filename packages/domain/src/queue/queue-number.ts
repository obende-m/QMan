import { ValidationError } from "../shared/errors.js";
import type { JourneyCode } from "../journey/journey-code.js";

/**
 * Queue number configuration.
 *
 * A queue number is a patient's ticket *within one station*. It is not their
 * identity — the Journey Code is, and it never changes. When a visit is routed
 * onward it is issued a fresh ticket by the destination station, while the
 * Journey Code travels with it untouched.
 *
 * Rather than enumerate the formats a hospital might want (sequential, prefixed,
 * numeric-only, journey code) as separate cases, there is one template engine
 * and the named formats are presets compiled to templates. A hospital can then
 * invent a format nobody anticipated without a code change, which is the
 * standing requirement from the SAD.
 *
 * Tokens:
 *   {n}        the ordinal, unpadded            → 7
 *   {n:3}      the ordinal, zero-padded to 3    → 007
 *   {station}  the station's short code         → LAB
 *   {journey}  the visit's Journey Code         → QM-8F4K
 *   {yyyy} {mm} {dd}  date parts, for per-day schemes
 */
/**
 * When a station's ordinal restarts.
 *
 * Daily suits an outpatient clinic. Monthly suits a low-volume specialist unit
 * where "patient 7 this month" is more meaningful than "patient 1 today".
 * Manual exists because some units reset per session or per ward round, on a
 * cadence no calendar rule captures — those hospitals need a button, not a
 * cron expression.
 */
export type QueueResetStrategy =
  | "daily"
  | "weekly"
  | "monthly"
  | "never"
  | "manual";

export interface QueueNumberConfig {
  /** e.g. "A-{n:3}", "LAB-{n:3}", "{n:3}", "{journey}" */
  readonly template: string;
  /**
   * When the ordinal restarts. Daily is the norm — a hospital that never reset
   * would be calling ticket 41,208 by March.
   */
  readonly reset: QueueResetStrategy;
  /**
   * Bumped by an administrator to force a restart under the "manual" strategy.
   * Any change to this value starts a new series.
   */
  readonly manualEpoch?: string;
}

/**
 * The key identifying the current counting period.
 *
 * Allocation is scoped to `(station, periodKey)`, so a reset is not a scheduled
 * job that mutates a counter — it is simply a new key. Nothing has to run at
 * midnight, a missed job cannot corrupt a series, and yesterday's ordinals stay
 * queryable rather than being overwritten.
 */
export function resetPeriodKey(
  config: QueueNumberConfig,
  at: Date,
): string {
  switch (config.reset) {
    case "never":
      return "all";
    case "manual":
      return `manual:${config.manualEpoch ?? "initial"}`;
    case "daily":
      return isoDate(at);
    case "monthly":
      return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}`;
    case "weekly":
      return isoWeek(at);
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * ISO-8601 week key, e.g. "2026-W11".
 *
 * Uses the ISO definition (weeks start Monday; week 1 contains the first
 * Thursday) rather than a naive day-of-year division, so the week does not
 * change meaning across a year boundary.
 */
function isoWeek(date: Date): string {
  const target = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  // Shift to the Thursday of this week: ISO weeks are numbered by their Thursday.
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);

  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);

  const week =
    1 +
    Math.round(
      (target.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000),
    );

  return `${target.getUTCFullYear()}-W${pad2(week)}`;
}

export const QUEUE_NUMBER_PRESETS = {
  /** A-001, A-002 — the classic station letter series. */
  sequential: (prefix: string): QueueNumberConfig => ({
    template: `${prefix}-{n:3}`,
    reset: "daily",
  }),
  /** LAB-001 — uses the station's own code, so one config suits every station. */
  departmentPrefix: (): QueueNumberConfig => ({
    template: "{station}-{n:3}",
    reset: "daily",
  }),
  /** 001, 002 — numeric only. */
  numeric: (): QueueNumberConfig => ({
    template: "{n:3}",
    reset: "daily",
  }),
  /**
   * QM-8F4K — the station calls patients by Journey Code instead of issuing a
   * ticket. Useful for stations with no waiting area of their own, and for
   * clinics that want a single identifier everywhere.
   */
  journeyCode: (): QueueNumberConfig => ({
    template: "{journey}",
    reset: "never",
  }),
} as const;

export interface QueueNumberContext {
  /** 1-based position in the station's series for the current reset period. */
  readonly ordinal: number;
  readonly stationCode: string;
  readonly journeyCode: JourneyCode;
  readonly issuedAt: Date;
}

const TOKEN = /\{(\w+)(?::(\d+))?\}/g;

/**
 * Renders a ticket label.
 *
 * The result is stored on the queue entry, not recomputed on read. A patient
 * holding a paper slip that says "A-001" must still match the board after an
 * administrator changes the format at lunchtime, and yesterday's audit trail
 * must not silently re-render under today's configuration.
 */
export function formatQueueNumber(
  config: QueueNumberConfig,
  context: QueueNumberContext,
): string {
  return config.template.replace(TOKEN, (match, name: string, pad?: string) => {
    const width = pad ? Number.parseInt(pad, 10) : 0;
    switch (name) {
      case "n":
        return String(context.ordinal).padStart(width, "0");
      case "station":
        return context.stationCode;
      case "journey":
        return context.journeyCode;
      case "yyyy":
        return String(context.issuedAt.getFullYear());
      case "mm":
        return String(context.issuedAt.getMonth() + 1).padStart(2, "0");
      case "dd":
        return String(context.issuedAt.getDate()).padStart(2, "0");
      default:
        // An unknown token is a configuration mistake. Leaving it verbatim
        // makes it visible on the board rather than silently producing a
        // plausible-looking wrong ticket.
        return match;
    }
  });
}

/**
 * Validates a template at configuration time, so an administrator learns about
 * a mistake when they save rather than when a patient is at the desk.
 * Returns human-readable problems; empty means valid.
 */
export function validateQueueNumberConfig(config: QueueNumberConfig): string[] {
  const problems: string[] = [];
  const template = config.template.trim();

  if (template.length === 0) {
    problems.push("A queue number template cannot be empty.");
    return problems;
  }

  const known = new Set(["n", "station", "journey", "yyyy", "mm", "dd"]);
  const seen = new Set<string>();
  for (const match of template.matchAll(TOKEN)) {
    const name = match[1]!;
    seen.add(name);
    if (!known.has(name)) {
      problems.push(
        `"{${name}}" is not a known token. Available: ${[...known]
          .map((t) => `{${t}}`)
          .join(", ")}.`,
      );
    }
  }

  // A template with no varying token issues the same label to every patient,
  // which is worse than useless at a station calling names aloud.
  if (!seen.has("n") && !seen.has("journey")) {
    problems.push(
      "A template must include {n} or {journey}, otherwise every patient receives the same queue number.",
    );
  }

  return problems;
}

/** Convenience: validate and throw, for callers that cannot handle a list. */
export function assertQueueNumberConfig(config: QueueNumberConfig): void {
  const problems = validateQueueNumberConfig(config);
  if (problems.length > 0) {
    throw new ValidationError(problems.join(" "), { template: config.template });
  }
}

/**
 * A ticket issued to a visit at a station: the ordinal the system sorts and
 * allocates by, and the label a human reads.
 */
export interface QueueTicket {
  readonly ordinal: number;
  readonly label: string;
  /**
   * The counting period this ordinal belongs to.
   *
   * Stored with the queue entry so the series can be rebuilt after a restore.
   * Without it, recovery has to guess which period an old entry belonged to by
   * re-deriving it from the current configuration — which may since have
   * changed, and a wrong guess reissues a number somebody is holding.
   */
  readonly periodKey: string;
}

export function issueTicket(
  config: QueueNumberConfig,
  context: QueueNumberContext,
): QueueTicket {
  return {
    ordinal: context.ordinal,
    label: formatQueueNumber(config, context),
    periodKey: resetPeriodKey(config, context.issuedAt),
  };
}

/**
 * Ticket allocation after a restore.
 *
 * **A ticket number, once issued to a patient, is never reissued.**
 *
 * A point-in-time restore rewinds the allocator but not the waiting room. Roll
 * back to 13:55 after A-042 was printed at 13:58, and the allocator will hand
 * A-042 to the next patient while the first is still holding theirs. Two people
 * then legitimately possess the same ticket, which is impossible to explain at
 * a reception desk and destroys trust in every number on the board.
 *
 * Recovery therefore advances each series past the highest ordinal *known to
 * have been issued* — from the restored queue entries, and from any paper
 * tickets handed out during the outage.
 */
export interface SeriesRecovery {
  readonly stationId: string;
  readonly periodKey: string;
  /** Highest ordinal recorded in the restored data for this series. */
  readonly highestRecorded: number;
  /**
   * Highest ordinal issued on paper while the system was down, if any. Known
   * only to the staff who wrote the tickets, so it is supplied by them.
   */
  readonly highestOnPaper?: number;
}

/**
 * The value a series must resume from.
 *
 * Deliberately returns the *next safe ordinal* rather than the high-water mark,
 * so a caller cannot accidentally set the counter to a number that is still in
 * someone's hand.
 */
export function recoveredOrdinal(recovery: SeriesRecovery): number {
  return (
    Math.max(recovery.highestRecorded, recovery.highestOnPaper ?? 0, 0) + 1
  );
}

/**
 * Whether recovery needs a human before the station reopens.
 *
 * If paper tickets were issued during the outage, only the staff who wrote them
 * know how far the series actually ran. Reopening on the restored data alone
 * would reissue every number written on paper.
 */
export function needsReconciliation(recovery: SeriesRecovery): boolean {
  return recovery.highestOnPaper === undefined;
}

/**
 * Port for ordinal allocation.
 *
 * Handing out "the next number" is the one part of ticketing that cannot live
 * in the aggregate: it is a contended, per-station sequence, and two receptions
 * admitting patients simultaneously must not both receive A-014. In production
 * this is a transactional sequence in the database; the domain only declares
 * the shape it needs.
 */
export interface OrdinalAllocator {
  /** The next ordinal for a station within a counting period. */
  next(stationId: string, periodKey: string): number;
  /**
   * Advances a series so the next issued ordinal is at least `atLeast`.
   * Never moves a series backwards — that is the whole point.
   */
  advanceTo(stationId: string, periodKey: string, atLeast: number): void;
}

/**
 * Reference in-memory allocator, for development and tests.
 *
 * Correct for a single process and deliberately not for more than one — the
 * production implementation must make this atomic.
 */
export function createInMemoryAllocator(): OrdinalAllocator & {
  /** Current value without consuming one; for assertions and dashboards. */
  peek(stationId: string, periodKey: string): number;
} {
  const counters = new Map<string, number>();
  const key = (stationId: string, periodKey: string) =>
    `${stationId}::${periodKey}`;

  return {
    next(stationId, periodKey) {
      const k = key(stationId, periodKey);
      const value = (counters.get(k) ?? 0) + 1;
      counters.set(k, value);
      return value;
    },
    advanceTo(stationId, periodKey, atLeast) {
      const k = key(stationId, periodKey);
      // `Math.max` rather than assignment: a recovery that ran twice, or with a
      // stale figure, must never wind a series back.
      counters.set(k, Math.max(counters.get(k) ?? 0, atLeast - 1));
    },
    peek(stationId, periodKey) {
      return counters.get(key(stationId, periodKey)) ?? 0;
    },
  };
}
