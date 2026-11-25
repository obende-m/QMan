import { patientLabel } from "../../data/clinic-projections.js";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import type { Priority } from "@qman/domain";
import { Card } from "../../components/ui/Card.js";
import { JourneyCode } from "../../components/ui/JourneyCode.js";
import { StatusChip, priorityChip } from "../../components/ui/StatusChip.js";
import { Button } from "../../components/ui/Button.js";
import { cn } from "../../components/ui/cn.js";
import { formatDuration } from "../../data/useClinic.js";
import type { Visit } from "@qman/domain";
import { stationName } from "../../data/clinic-projections.js";
import { useConfig } from "../../data/useConfig.js";

/**
 * Priority Patients.
 *
 * The Recent Visits table is ordered by arrival, which means an urgent patient
 * who arrived before the most recent walk-ins can fall off it entirely. Rather
 * than compromise that list — "recent" should mean recent — clinical urgency
 * gets its own section that is never paged, filtered or sorted away.
 *
 * Emergency and High only. Including VIP would put a commercial courtesy tier in
 * a band a receptionist reads as "clinically urgent", which is exactly the
 * confusion ADR-006 exists to prevent.
 */
export interface PriorityPatientsProps {
  visits: readonly Visit[];
  now: Date;
  onOpen?: (visitId: string) => void;
}

/** Minutes waiting beyond which an urgent patient is visibly overdue. */
const SLA_MINUTES: Record<Extract<Priority, "emergency" | "high">, number> = {
  emergency: 10,
  high: 30,
};

export function PriorityPatients({
  visits,
  now,
  onOpen,
}: PriorityPatientsProps) {
  if (visits.length === 0) {
    return (
      <Card className="border-tertiary/30 bg-tertiary/5">
        <div className="flex items-center gap-3 px-gutter py-4">
          <ShieldCheck aria-hidden="true" className="size-5 text-tertiary" />
          <p className="text-body-md text-on-surface">
            No emergency or urgent patients waiting.
          </p>
        </div>
      </Card>
    );
  }

  const breaching = visits.filter((entry) => isBreaching(entry, now)).length;

  return (
    <Card className="overflow-hidden border-error/30">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-error/20 bg-error-container/40 px-gutter py-4">
        <div className="flex items-center gap-2">
          <TriangleAlert aria-hidden="true" className="size-5 text-error" />
          <h2 className="text-title-md font-semibold text-on-surface">
            Priority Patients
          </h2>
          <span className="rounded-full bg-error px-2 py-0.5 font-mono text-label-caps uppercase text-on-error">
            {visits.length}
          </span>
        </div>
        {breaching > 0 && (
          <p className="font-mono text-label-caps uppercase text-error">
            {breaching} past target wait
          </p>
        )}
      </header>

      <ul className="divide-y divide-outline-variant">
        {visits.map((entry) => (
          <PriorityRow
            key={entry.id}
            entry={entry}
            now={now}
            {...(onOpen ? { onOpen } : {})}
          />
        ))}
      </ul>
    </Card>
  );
}

function PriorityRow({
  entry,
  now,
  onOpen,
}: {
  entry: Visit;
  now: Date;
  onOpen?: (visitId: string) => void;
}) {
  const config = useConfig();
  const visit = entry;
  const chip = priorityChip(visit.priority);
  const waited = now.getTime() - visit.createdAt.getTime();
  const breached = isBreaching(entry, now);
  const stationId = visit.currentStationId;

  return (
    <li className="flex flex-wrap items-center gap-4 px-gutter py-4 transition-colors hover:bg-surface-container-low">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "h-10 w-1 shrink-0 rounded-full",
            visit.priority === "emergency" ? "bg-error" : "bg-warning",
          )}
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-body-md font-semibold text-on-surface">
              {patientLabel(visit)}
            </span>
            {chip && <StatusChip tone={chip.tone} label={chip.label} />}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <JourneyCode code={visit.journeyCode} />
            <span className="text-body-sm text-on-surface-variant">
              {stationId ? stationName(config.config, stationId) : "Not in a queue"}
            </span>
          </div>
        </div>
      </div>

      <div className="text-right">
        <p
          className={cn(
            "font-mono text-label-caps uppercase",
            breached ? "text-error" : "text-on-surface-variant",
          )}
        >
          Waiting
        </p>
        <p
          className={cn(
            "text-title-md font-semibold tabular-nums",
            breached ? "text-error" : "text-on-surface",
          )}
        >
          {formatDuration(waited)}
        </p>
      </div>

      {onOpen && (
        <Button variant="secondary" size="sm" onClick={() => onOpen(visit.id)}>
          Open
        </Button>
      )}
    </li>
  );
}

function isBreaching(entry: Visit, now: Date): boolean {
  const priority = entry.priority;
  if (priority !== "emergency" && priority !== "high") return false;
  const minutes = (now.getTime() - entry.createdAt.getTime()) / 60_000;
  return minutes > SLA_MINUTES[priority];
}
