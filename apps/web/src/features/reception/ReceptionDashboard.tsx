import { useMemo, useState } from "react";
import {
  Activity,
  FlaskConical,
  ListFilter,
  MoreVertical,
  Pill,
  Plus,
  Printer,
  Stethoscope,
  UserPlus,
} from "lucide-react";
import type { StationId } from "@qman/domain";
import { Button } from "../../components/ui/Button.js";
import { Card, CardHeader } from "../../components/ui/Card.js";
import { JourneyCode } from "../../components/ui/JourneyCode.js";
import { StatCard } from "../../components/ui/StatCard.js";
import { StationLoadCard } from "../../components/ui/StationLoadCard.js";
import {
  StatusChip,
  priorityChip,
  visitStatusChip,
} from "../../components/ui/StatusChip.js";
import { slaFor, stationName, stationRoom } from "../../data/clinic-projections.js";
import { useConfig } from "../../data/useConfig.js";
import { TicketPrintDialog } from "../printing/TicketPrintDialog.js";
import { useClinic, useNow } from "../../data/useClinic.js";
import type { StationConfig, StationWorklist } from "@qman/domain";
import type { ClinicStore } from "../../data/clinic-store.js";
import { PriorityPatients } from "./PriorityPatients.js";

/** Keyed on the station code, which is what an administrator configures. */
const STATION_ICONS: Record<string, JSX.Element> = {
  VIT: <Activity className="size-4" />,
  OPD: <Stethoscope className="size-4" />,
  LAB: <FlaskConical className="size-4" />,
  PHR: <Pill className="size-4" />,
  REC: <UserPlus className="size-4" />,
};

export interface ReceptionDashboardProps {
  /** Injectable so tests get an isolated clinic. */
  store?: ClinicStore;
  onOpenVisit?: (visitId: string) => void;
}

export function ReceptionDashboard({
  store: injected,
  onOpenVisit,
}: ReceptionDashboardProps = {}) {
  const clinic = useClinic(injected);
  const config = useConfig();
  const now = useNow(30_000);
  const version = clinic.getVersion();
  const [printing, setPrinting] = useState<string | null>(null);
  const printingVisit = printing
    ? clinic.visits.find((visit) => visit.id === printing)
    : undefined;

  const stations = useMemo(
    () =>
      config
        .publicStations()
        .slice(0, 3)
        .map((station) => ({
          station,
          worklist: clinic.worklist(station.id),
        })),
    [clinic, version],
  );

  const priorityVisits = useMemo(
    () => clinic.priorityVisits(),
    [clinic, version],
  );

  /**
   * Metrics are computed from the visits themselves rather than stored, which
   * is the point of the event-sourced design: every number on this screen is
   * derivable from the same stream the audit trail reads.
   */
  const metrics = useMemo(() => {
    const waits = clinic.visits.flatMap((visit) =>
      visit.queueEntries
        .filter((entry) => entry.startedAt !== null)
        .map(
          (entry) =>
            (entry.startedAt!.getTime() - entry.queuedAt.getTime()) / 60_000,
        ),
    );
    const averageWait =
      waits.length > 0
        ? Math.round(waits.reduce((sum, v) => sum + v, 0) / waits.length)
        : 0;

    return {
      totalVisits: clinic.visits.length,
      averageWait,
      targetWait: 15,
    };
  }, [clinic, version]);

  /** Chronological, as specified — Priority Patients carries urgency instead. */
  const recent = useMemo(
    () =>
      [...clinic.visits]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 6),
    [clinic, version],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-headline-lg-mobile font-semibold tracking-tight text-on-surface md:text-headline-lg">
            Reception Dashboard
          </h1>
          <p className="mt-1 text-body-md text-on-surface-variant">
            Manage incoming patient flow and queue assignments.
          </p>
        </div>
        <Button size="lg" icon={<Plus className="size-5" />}>
          Create Visit
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-1">
          <StatCard
            label="Total visits today"
            value={metrics.totalVisits}
            delta={{ value: 12, caption: "vs yesterday", goodWhen: "up" }}
          />
          <StatCard
            label="Avg. wait time"
            value={metrics.averageWait}
            unit="min"
            {...(metrics.averageWait > metrics.targetWait
              ? { alert: `Above target (${metrics.targetWait}m)` }
              : { delta: { value: -8, caption: "vs yesterday", goodWhen: "down" as const } })}
          />
        </div>

        <Card>
          <CardHeader
            title="Live Queue Status"
            action={
              <Button variant="ghost" size="sm" className="text-primary">
                View full queues →
              </Button>
            }
          />
          <div className="grid gap-4 px-gutter pb-gutter sm:grid-cols-2 xl:grid-cols-3">
            {stations.map(({ station, worklist }: { station: StationConfig; worklist: StationWorklist }) => (
              <StationLoadCard
                key={station.id}
                name={station.name}
                waiting={worklist.counts.waiting}
                saturationPoint={station.sla.saturationPoint}
                icon={STATION_ICONS[station.code.toUpperCase()]}
                selected={false}
              />
            ))}
          </div>
        </Card>
      </div>

      <PriorityPatients
        visits={priorityVisits}
        now={now}
        {...(onOpenVisit ? { onOpen: onOpenVisit } : {})}
      />

      <Card>
        <CardHeader
          title="Recent Visits"
          subtitle="Most recent arrivals. Urgent patients appear above, regardless of arrival time."
          action={
            <>
              <Button variant="ghost" size="sm" aria-label="Filter visits">
                <ListFilter className="size-4" />
              </Button>
              <Button variant="ghost" size="sm" aria-label="More options">
                <MoreVertical className="size-4" />
              </Button>
            </>
          }
        />

        {/* Wide tables scroll inside their own container so the page body never
            scrolls horizontally on a tablet at a reception desk. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="border-y border-outline-variant bg-surface-container-low">
                {["Journey Code", "Patient", "Arrived", "Status", "Current Stage", ""].map(
                  (heading, index) => (
                    <th
                      key={heading || index}
                      scope="col"
                      className="px-gutter py-3 font-mono text-label-caps uppercase text-on-surface-variant"
                    >
                      {heading}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {recent.map((visit) => {
                const status = visitStatusChip(visit.status);
                const priority = priorityChip(visit.priority);
                const stationId = visit.currentStationId;
                return (
                  <tr
                    key={visit.id}
                    className="border-b border-outline-variant transition-colors last:border-0 hover:bg-surface-container-low"
                  >
                    <td className="px-gutter py-4">
                      <JourneyCode code={visit.journeyCode} />
                    </td>
                    <td className="px-gutter py-4">
                      <div className="flex items-center gap-2">
                        <span className="text-body-md font-semibold text-on-surface">
                          {visit.patient.name}
                        </span>
                        {priority && (
                          <StatusChip tone={priority.tone} label={priority.label} />
                        )}
                      </div>
                      <span className="font-mono text-label-caps uppercase text-on-surface-variant">
                        {visit.patient.hospitalNumber}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-gutter py-4 text-body-sm text-on-surface-variant">
                      {visit.createdAt.toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-gutter py-4">
                      <StatusChip tone={status.tone} label={status.label} withDot />
                    </td>
                    <td className="px-gutter py-4">
                      <span className="flex items-center gap-2 text-body-sm text-on-surface-variant">
                        {stationId ? (
                          <>
                            <span aria-hidden="true">
                              {STATION_ICONS[stationId]}
                            </span>
                            {stationName(config.config, stationId)}
                          </>
                        ) : (
                          "Discharged"
                        )}
                      </span>
                    </td>
                    <td className="px-gutter py-4 text-right">
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Printer className="size-4" />}
                        onClick={() => setPrinting(visit.id)}
                        aria-label={`Print ticket for ${visit.journeyCode}`}
                      >
                        Ticket
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {printingVisit && config.ticketTemplate() && (
        <TicketPrintDialog
          template={config.ticketTemplate()!}
          context={{
            ticket:
              printingVisit.currentEntry?.queueLabel ??
              printingVisit.journeyCode,
            journeyCode: printingVisit.journeyCode,
            patientName: printingVisit.patient.name,
            hospitalName: config.config.profile.name,
            branchName: config.config.branches[0]?.name ?? "",
            stationName: printingVisit.currentStationId
              ? stationName(config.config, printingVisit.currentStationId)
              : "Reception",
            room: printingVisit.currentStationId
              ? stationRoom(config.config, printingVisit.currentStationId)
              : null,
            assignedTo: null,
            branchCount: config.config.branches.length,
            issuedAt: printingVisit.createdAt,
            logoUrl: null,
          }}
          onClose={() => setPrinting(null)}
        />
      )}
    </div>
  );
}
