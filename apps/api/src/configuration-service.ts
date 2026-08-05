/**
 * Applying a configuration change.
 *
 * One path, used by every configuration endpoint, doing the same five things in
 * the same order inside one transaction: load the whole configuration, apply
 * the caller's change, validate the result, persist the entity that moved, and
 * record what happened.
 *
 * **Validation is the domain's, entirely.** `validateHospitalConfiguration`
 * decides whether a configuration is sound, and it is given the configuration
 * that *would* result rather than the change in isolation — because most of the
 * rules that matter are relationships between entities. A workflow stage
 * pointing at a station that was just disabled, a board showing a station that
 * is no longer public, a default ticket template that has been renamed away:
 * none of those are visible to a check that sees only the entity being edited.
 * There is no validation in this file and none in the handlers.
 *
 * **The transaction is what makes it safe.** The read that validation depends
 * on and the write it authorises happen under one unit of work, so two
 * administrators saving at the same moment cannot each validate against a
 * configuration the other is in the middle of replacing. A rejected change
 * writes nothing at all — not the entity, and not an audit entry.
 *
 * **Audit is part of the transaction, not a consequence of it.** An entry
 * written afterwards is an entry that can be missing when the process dies
 * between the two, and an audit trail with holes is worse than none because it
 * is trusted.
 */
import {
  hasBlockingProblems,
  validateHospitalConfiguration,
  type AdminEventType,
  type BranchId,
  type ConfigProblem,
  type HospitalConfiguration,
  type UserId,
} from "@qman/domain";
import {
  appendEvents,
  PostgresConfigurationRepository,
  type ConfigurationWriter,
  type Database,
  type NewEvent,
  type SqlExecutor,
} from "@qman/persistence";

export interface ChangeContext {
  readonly hospitalId: string;
  readonly actorId: UserId;
  /** Groups everything one administrator did in one sitting. */
  readonly sessionId: string;
  readonly requestId: string;
  readonly branchId: BranchId | null;
}

/**
 * What an audit entry needs to answer "who changed this, from what, to what".
 *
 * `before` and `after` are the values of the thing that moved, not the whole
 * configuration. An entry carrying the entire configuration twice is one nobody
 * reads, and reading it is the only reason it exists.
 */
export interface ChangeDescription {
  readonly type: AdminEventType;
  readonly summary: string;
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface ConfigurationChange {
  /** Produces the configuration that should result. Pure; no rules. */
  readonly apply: (current: HospitalConfiguration) => HospitalConfiguration;
  /** Writes the one entity that moved. */
  readonly persist: (
    tx: SqlExecutor,
    next: HospitalConfiguration,
    at: Date,
  ) => Promise<void>;
  /** Built from both configurations, so it can name what actually changed. */
  readonly describe: (
    before: HospitalConfiguration,
    after: HospitalConfiguration,
  ) => ChangeDescription;
}

export type ChangeResult =
  | {
      readonly ok: true;
      readonly configuration: HospitalConfiguration;
      /** Non-blocking problems. The change was saved; these are worth showing. */
      readonly warnings: readonly ConfigProblem[];
    }
  | { readonly ok: false; readonly problems: readonly ConfigProblem[] };

export interface ConfigurationServiceDependencies {
  readonly db: Database;
  readonly writer: ConfigurationWriter;
  readonly now: () => Date;
}

export class ConfigurationService {
  readonly #deps: ConfigurationServiceDependencies;

  constructor(deps: ConfigurationServiceDependencies) {
    this.#deps = deps;
  }

  async apply(context: ChangeContext, change: ConfigurationChange): Promise<ChangeResult> {
    const { db, writer, now } = this.#deps;
    void writer;

    return db.transaction(async (tx) => {
      // Read inside the transaction, so the configuration validated against is
      // the one being written over.
      const repository = new PostgresConfigurationRepository(tx);
      const before = await repository.load(context.hospitalId);

      if (before === null) {
        return {
          ok: false,
          problems: [
            {
              path: "hospital",
              message: "This server is configured for a hospital that does not exist.",
              severity: "error" as const,
            },
          ],
        };
      }

      const after = change.apply(before);
      const problems = validateHospitalConfiguration(after);

      if (hasBlockingProblems(problems)) {
        // Returning rather than throwing: a rejected change is an ordinary
        // answer, not a failure. Throwing would roll back identically but would
        // also be logged as a server fault, and burying real faults among
        // administrators mistyping an SLA is how alerting stops being read.
        return {
          ok: false,
          problems: problems.filter((problem) => problem.severity === "error"),
        };
      }

      const at = now();
      await change.persist(tx, after, at);
      await appendEvents(tx, [auditEntry(context, change.describe(before, after), at)]);

      return {
        ok: true,
        configuration: after,
        warnings: problems.filter((problem) => problem.severity === "warning"),
      };
    });
  }
}

/**
 * Correlated by session, not by Journey Code.
 *
 * Operational records correlate by the code printed on a patient's ticket.
 * Administrative ones have no patient; the useful grouping is the sitting —
 * signed in, changed three SLAs, signed out — which is what an investigation
 * into a configuration change actually follows.
 */
function auditEntry(
  context: ChangeContext,
  description: ChangeDescription,
  at: Date,
): NewEvent {
  return {
    hospitalId: context.hospitalId as NewEvent["hospitalId"],
    branchId: context.branchId as NewEvent["branchId"],
    category: "administrative",
    type: description.type,
    visitId: null,
    correlationId: context.sessionId,
    actorId: context.actorId,
    occurredAt: at,
    payload: {
      path: description.path,
      before: description.before,
      after: description.after,
      // Carried so a report from a user quoting an identifier reaches the
      // request that made the change, not just the change itself.
      requestId: context.requestId,
    },
    summary: description.summary,
  };
}
