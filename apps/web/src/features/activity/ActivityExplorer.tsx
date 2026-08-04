import { useMemo, useState } from "react";
import { History, Search, ShieldCheck, X } from "lucide-react";
import type { ActivityCategory, EventQuery } from "@qman/domain";
import { Card, CardHeader } from "../../components/ui/Card.js";
import { Button } from "../../components/ui/Button.js";
import { JourneyCode } from "../../components/ui/JourneyCode.js";
import { StatusChip } from "../../components/ui/StatusChip.js";
import { cn } from "../../components/ui/cn.js";
import { inputClass, labelClass } from "../../data/useConfig.js";
import { useOperations } from "../../data/useOperations.js";
import { useAuth } from "../../data/useAuth.js";
import type { AuditEntry, OperationsStore } from "../../data/operations-store.js";
import type { AuthStore } from "../../data/auth-store.js";
import { userName } from "../../data/demo-clinic.js";

/**
 * The Activity & Audit Explorer.
 *
 * Two histories, deliberately kept apart, because they answer different
 * questions for different people:
 *
 *  - **Activity** is operational. "Where has this patient been? When were they
 *    called? Who transferred them?" Read by a supervisor investigating a
 *    complaint or a receptionist tracing a lost patient.
 *  - **Audit** is administrative and security. "Who changed this SLA? Who
 *    signed in? Who ended that session?" Read by an administrator, or by
 *    whoever turns up asking how a setting came to be what it is.
 *
 * Merging them would produce a feed in which neither is findable — a hundred
 * patient calls burying the one configuration change that mattered.
 *
 * Both are searchable by **correlation**: a Journey Code pulls a patient's
 * whole visit together, and a session id pulls together everything one person
 * did in one sitting.
 */
export type ExplorerTab = "activity" | "audit";

export interface ActivityExplorerProps {
  operations?: OperationsStore;
  auth?: AuthStore;
  /** Opens straight onto one journey, e.g. from a visit row. */
  initialCorrelationId?: string;
}

export function ActivityExplorer({
  operations: injectedOps,
  auth: injectedAuth,
  initialCorrelationId,
}: ActivityExplorerProps = {}) {
  const ops = useOperations(injectedOps);
  const auth = useAuth(injectedAuth);
  const version = ops.getVersion();

  const [tab, setTab] = useState<ExplorerTab>("activity");
  const [search, setSearch] = useState("");
  const [correlationId, setCorrelationId] = useState(initialCorrelationId ?? "");

  const categories: readonly ActivityCategory[] =
    tab === "activity" ? ["operational"] : ["administrative", "security"];

  const entries = useMemo(() => {
    const query: EventQuery = {
      categories,
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(correlationId.trim() ? { correlationId: correlationId.trim() } : {}),
    };
    return ops.queryAudit(query);
  }, [ops, version, tab, search, correlationId]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-headline-lg-mobile font-semibold tracking-tight text-on-surface md:text-headline-lg">
          Activity & Audit
        </h1>
        <p className="mt-1 text-body-md text-on-surface-variant">
          What happened, when, and who did it.
        </p>
      </div>

      <div
        role="tablist"
        aria-label="History"
        className="flex flex-wrap gap-1 rounded-md border border-outline-variant bg-surface-container-low p-1"
      >
        <Tab
          selected={tab === "activity"}
          onSelect={() => setTab("activity")}
          icon={<History className="size-4" />}
          label="Activity Timeline"
          hint="Patient journeys"
        />
        <Tab
          selected={tab === "audit"}
          onSelect={() => setTab("audit")}
          icon={<ShieldCheck className="size-4" />}
          label="Audit Log"
          hint="Configuration and sign-ins"
        />
      </div>

      <Card>
        <div className="grid gap-4 px-gutter py-4 sm:grid-cols-2">
          <label className="block">
            <span className={labelClass}>Search</span>
            <span className="relative mt-1.5 block">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-outline"
              />
              <input
                className={cn(inputClass, "pl-9")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={
                  tab === "activity"
                    ? "e.g. Laboratory, skipped, routed"
                    : "e.g. SLA, display board, signed in"
                }
              />
            </span>
          </label>

          <label className="block">
            <span className={labelClass}>
              {tab === "activity" ? "Journey code" : "Session"}
            </span>
            <span className="relative mt-1.5 block">
              <input
                className={cn(inputClass, "font-mono uppercase")}
                value={correlationId}
                onChange={(e) => setCorrelationId(e.target.value)}
                placeholder={tab === "activity" ? "QM-8F4K" : "sess-1"}
              />
              {correlationId && (
                <button
                  type="button"
                  onClick={() => setCorrelationId("")}
                  aria-label="Clear correlation filter"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-on-surface-variant hover:bg-surface-container"
                >
                  <X className="size-4" />
                </button>
              )}
            </span>
            <span className="mt-1 block text-body-sm text-on-surface-variant">
              {tab === "activity"
                ? "Pulls a patient's whole visit together."
                : "Groups everything done in one sitting."}
            </span>
          </label>
        </div>
      </Card>

      {tab === "activity" ? (
        <ActivityTimeline
          entries={entries}
          onCorrelate={setCorrelationId}
          correlationId={correlationId}
        />
      ) : (
        <AuditLog entries={entries} auth={auth} onCorrelate={setCorrelationId} />
      )}
    </div>
  );
}

function Tab({
  selected,
  onSelect,
  icon,
  label,
  hint,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <button
      role="tab"
      type="button"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "flex flex-1 items-center gap-2 rounded px-4 py-2.5 text-left transition-colors",
        selected
          ? "bg-surface-container-lowest shadow-card"
          : "hover:bg-surface-container-high",
      )}
    >
      <span
        aria-hidden="true"
        className={selected ? "text-primary" : "text-on-surface-variant"}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span
          className={cn(
            "block truncate text-body-sm font-semibold",
            selected ? "text-primary" : "text-on-surface",
          )}
        >
          {label}
        </span>
        <span className="block truncate text-body-sm text-on-surface-variant">
          {hint}
        </span>
      </span>
    </button>
  );
}

/**
 * Operational history.
 *
 * When filtered to one Journey Code this becomes a patient's story in order —
 * which is the shape an investigation wants. Unfiltered it is a live feed,
 * newest first.
 */
function ActivityTimeline({
  entries,
  correlationId,
  onCorrelate,
}: {
  entries: readonly AuditEntry[];
  correlationId: string;
  onCorrelate: (id: string) => void;
}) {
  const focused = correlationId.trim().length > 0;
  // A single journey reads forwards; a general feed reads backwards.
  const ordered = focused ? [...entries].reverse() : entries;

  return (
    <Card>
      <CardHeader
        title={focused ? "This visit, in order" : "Recent activity"}
        subtitle={
          focused
            ? "Every step of the journey, oldest first."
            : "Newest first. Filter by journey code to follow one patient."
        }
        action={
          <span className="rounded-full bg-surface-container-high px-2.5 py-1 font-mono text-label-caps uppercase text-on-surface-variant">
            {entries.length} events
          </span>
        }
      />

      {ordered.length === 0 ? (
        <Empty
          message={
            focused
              ? "No activity for that journey code."
              : "No operational activity recorded yet."
          }
        />
      ) : (
        <ol className="divide-y divide-outline-variant border-t border-outline-variant">
          {ordered.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-center gap-3 px-gutter py-3"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body-md text-on-surface">
                  {entry.summary}
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-2">
                  {entry.correlationId && !focused && (
                    <button
                      type="button"
                      onClick={() => onCorrelate(entry.correlationId!)}
                      title="Show this whole journey"
                    >
                      <JourneyCode code={entry.correlationId} />
                    </button>
                  )}
                  <span className="font-mono text-label-caps uppercase text-on-surface-variant">
                    {entry.type.replace("visit.", "")}
                  </span>
                </span>
              </span>

              <span className="shrink-0 text-right">
                <span className="block text-body-sm text-on-surface-variant">
                  {entry.actorId ? userName(entry.actorId) : "System"}
                </span>
                <span className="block font-mono text-label-caps uppercase text-on-surface-variant">
                  {entry.occurredAt.toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/**
 * Administrative and security history.
 *
 * Tabular rather than a feed: the questions here are comparative — who changed
 * what, and when — and a table is what you scan for that.
 */
function AuditLog({
  entries,
  auth,
  onCorrelate,
}: {
  entries: readonly AuditEntry[];
  auth: AuthStore;
  onCorrelate: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader
        title="Audit log"
        subtitle="Configuration changes and sign-ins. Never deleted by ordinary use."
        action={
          <span className="rounded-full bg-surface-container-high px-2.5 py-1 font-mono text-label-caps uppercase text-on-surface-variant">
            {entries.length} records
          </span>
        }
      />

      {entries.length === 0 ? (
        <Empty message="No administrative activity recorded yet." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="border-y border-outline-variant bg-surface-container-low">
                {["When", "Who", "Action", "Type", "Session"].map((heading) => (
                  <th
                    key={heading}
                    scope="col"
                    className="px-gutter py-3 font-mono text-label-caps uppercase text-on-surface-variant"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={entry.id}
                  className="border-b border-outline-variant last:border-0 hover:bg-surface-container-low"
                >
                  <td className="whitespace-nowrap px-gutter py-3 text-body-sm text-on-surface-variant">
                    {entry.occurredAt.toLocaleString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      day: "2-digit",
                      month: "short",
                    })}
                  </td>
                  <td className="px-gutter py-3 text-body-sm text-on-surface">
                    {entry.actorId
                      ? (auth.account(entry.actorId)?.displayName ??
                        userName(entry.actorId))
                      : "—"}
                  </td>
                  <td className="px-gutter py-3 text-body-md text-on-surface">
                    {entry.summary}
                  </td>
                  <td className="px-gutter py-3">
                    <StatusChip
                      tone={
                        entry.category === "security" ? "waiting" : "neutral"
                      }
                      label={entry.category === "security" ? "Security" : "Config"}
                    />
                  </td>
                  <td className="px-gutter py-3">
                    {entry.correlationId ? (
                      <button
                        type="button"
                        onClick={() => onCorrelate(entry.correlationId!)}
                        title="Show everything from this session"
                        className="font-mono text-label-caps uppercase text-primary hover:underline"
                      >
                        {entry.correlationId}
                      </button>
                    ) : (
                      <span className="text-on-surface-variant">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Empty({ message }: { message: string }) {
  return (
    <p className="px-gutter pb-gutter pt-2 text-body-sm text-on-surface-variant">
      {message}
    </p>
  );
}
