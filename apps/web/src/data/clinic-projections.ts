/**
 * Projections over the clinic's visits.
 *
 * Every function here takes the visits and the configuration and returns a
 * view. None of them decide anything: ordering, wait estimation, station health
 * and the clinic pulse are all `@qman/domain` functions, called with what they
 * need. This module is the wiring between "what the server said" and "what the
 * domain computes from it", and nothing else.
 *
 * That is the whole reason the API returns aggregate state rather than rendered
 * numbers. A screen that wanted a projection the API had not thought to expose
 * would otherwise grow its own version of it, and the hospital would have two
 * answers to "how long is the wait".
 *
 * Configuration is a parameter rather than a module-level import, so a
 * projection can be computed against any configuration — including in a test,
 * where the alternative is a global that every case has to reset.
 */
import {
  assessStation,
  buildWorklist,
  clinicPulse,
  estimateWaitMillis,
  longestWaitingPatient,
  positionOf as positionInQueue,
  rankBottlenecks,
  staffWorkloads,
  type ClinicPulse,
  type HospitalConfiguration,
  type LongestWaiting,
  type QueueItem,
  type StaffWorkload,
  type StationHealth,
  type StationId,
  type StationSla,
  type StationWorklist,
  type Visit,
  type VisitId,
} from "@qman/domain";

/**
 * Defaults for a station the configuration does not describe.
 *
 * Reached when a visit refers to a station that has since been disabled or
 * removed — the queue entry still exists and still has to be rendered. The
 * numbers are deliberately unremarkable: they keep a screen working rather than
 * asserting anything about a station nobody can look up.
 */
const FALLBACK_SLA: StationSla = { targetWaitMillis: 30 * 60_000, saturationPoint: 10 };
const FALLBACK_SERVICE_MILLIS = 10 * 60_000;

export function stationOf(configuration: HospitalConfiguration, stationId: StationId) {
  return configuration.stations.find((station) => station.id === stationId);
}

export function stationName(
  configuration: HospitalConfiguration,
  stationId: StationId,
): string {
  return stationOf(configuration, stationId)?.name ?? "Station";
}

export function stationRoom(
  configuration: HospitalConfiguration,
  stationId: StationId,
): string | null {
  return stationOf(configuration, stationId)?.room ?? null;
}

export function slaFor(
  configuration: HospitalConfiguration,
  stationId: StationId,
): StationSla {
  return stationOf(configuration, stationId)?.sla ?? FALLBACK_SLA;
}

export function staffingFor(
  configuration: HospitalConfiguration,
  stationId: StationId,
): number {
  return stationOf(configuration, stationId)?.staffing ?? 1;
}

export function serviceEstimateFor(
  configuration: HospitalConfiguration,
  stationId: StationId,
): number {
  return stationOf(configuration, stationId)?.serviceEstimateMillis ?? FALLBACK_SERVICE_MILLIS;
}

/** Every enabled station, for hospital-wide analytics. */
export function activeStationIds(configuration: HospitalConfiguration): StationId[] {
  return configuration.stations.filter((s) => s.enabled).map((s) => s.id);
}

/**
 * Flattens visits into the queue items a station's worklist is built from.
 *
 * One item per queue entry, not per visit: a patient who has been to the
 * laboratory and come back has two entries at two stations, and both belong in
 * their station's history.
 */
export function queueItemsFor(
  visits: readonly Visit[],
  stationId: StationId,
): QueueItem[] {
  const items: QueueItem[] = [];
  for (const visit of visits) {
    for (const entry of visit.queueEntries) {
      if (entry.stationId !== stationId) continue;
      items.push({
        visitId: visit.id,
        journeyCode: visit.journeyCode,
        patientName: visit.patient.name || `Ticket ${entry.queueLabel}`,
        priority: visit.priority,
        entry,
      });
    }
  }
  return items;
}

export function worklistFor(
  visits: readonly Visit[],
  stationId: StationId,
): StationWorklist {
  return buildWorklist(stationId, queueItemsFor(visits, stationId));
}

export function allWorklists(
  visits: readonly Visit[],
  configuration: HospitalConfiguration,
): StationWorklist[] {
  return activeStationIds(configuration).map((stationId) => worklistFor(visits, stationId));
}

export function stationHealth(
  visits: readonly Visit[],
  configuration: HospitalConfiguration,
  now: Date,
): StationHealth[] {
  return allWorklists(visits, configuration).map((worklist) =>
    assessStation(worklist, slaFor(configuration, worklist.stationId), now),
  );
}

export function bottlenecks(
  visits: readonly Visit[],
  configuration: HospitalConfiguration,
  now: Date,
): StationHealth[] {
  return rankBottlenecks(stationHealth(visits, configuration, now));
}

export function pulse(
  visits: readonly Visit[],
  configuration: HospitalConfiguration,
  now: Date,
): ClinicPulse {
  return clinicPulse(
    stationHealth(visits, configuration, now),
    allWorklists(visits, configuration),
  );
}

export function longestWaiting(
  visits: readonly Visit[],
  configuration: HospitalConfiguration,
  now: Date,
): LongestWaiting | null {
  return longestWaitingPatient(allWorklists(visits, configuration), now);
}

export function workloads(
  visits: readonly Visit[],
  configuration: HospitalConfiguration,
): StaffWorkload[] {
  return staffWorkloads(allWorklists(visits, configuration));
}

/**
 * A visit's live position in its station queue, 1-based.
 *
 * Derived on every read rather than stored. The ticket is fixed for the whole
 * stop; the position moves every time the queue does, and a stored position
 * would be wrong the instant anyone else was called.
 */
export function positionOf(visits: readonly Visit[], visitId: VisitId): number | null {
  const visit = visits.find((candidate) => candidate.id === visitId);
  const stationId = visit?.currentStationId;
  if (visit === undefined || !stationId) return null;
  return positionInQueue(visitId, worklistFor(visits, stationId).waiting);
}

export function estimatedWaitMillis(
  visits: readonly Visit[],
  configuration: HospitalConfiguration,
  visitId: VisitId,
): number | null {
  const visit = visits.find((candidate) => candidate.id === visitId);
  const stationId = visit?.currentStationId;
  const position = positionOf(visits, visitId);
  if (visit === undefined || !stationId || position === null) return null;

  return estimateWaitMillis({
    position,
    serversAvailable: staffingFor(configuration, stationId),
    observedServiceMillis: worklistFor(visits, stationId).averageServiceMillis,
    configuredServiceMillis: serviceEstimateFor(configuration, stationId),
  });
}

/** Estimated wait for whoever joins a station's queue next. */
export function estimatedWaitForNewArrival(
  visits: readonly Visit[],
  configuration: HospitalConfiguration,
  stationId: StationId,
): number {
  const worklist = worklistFor(visits, stationId);
  return estimateWaitMillis({
    position: worklist.counts.waiting + 1,
    serversAvailable: staffingFor(configuration, stationId),
    observedServiceMillis: worklist.averageServiceMillis,
    configuredServiceMillis: serviceEstimateFor(configuration, stationId),
  });
}

/**
 * Names for staff ids, from `GET /api/v1/staff`.
 *
 * Filled once after sign-in by the application. Until it is — or for a caller
 * without `reports.view`, who never receives it — a panel shows the id it was
 * given rather than an invented name: a made-up name on a staffing report is
 * worse than an identifier nobody has to interpret.
 */
const staffNames = new Map<string, string>();

export function setStaffDirectory(entries: ReadonlyArray<{ id: string; displayName: string }>): void {
  staffNames.clear();
  for (const entry of entries) staffNames.set(entry.id, entry.displayName);
}

export function staffLabel(userId: string | null): string {
  if (userId === null) return "Unassigned";
  return staffNames.get(userId) ?? userId;
}

/**
 * How a visit is named on a staff screen.
 *
 * The server withholds identity from callers without `visit.view_identity`
 * and sends an empty name. An empty name must never render as a blank row or
 * read as "this patient has no name", so the ticket stands in for it.
 */
export function patientLabel(visit: Visit): string {
  if (visit.patient.name.trim() !== "") return visit.patient.name;
  const ticket = visit.currentEntry?.queueLabel ?? visit.queueEntries.at(-1)?.queueLabel;
  return ticket ? `Ticket ${ticket}` : visit.journeyCode;
}

/** Whether identity was withheld from this caller, so screens can say so. */
export function identityWithheld(visit: Visit): boolean {
  return visit.patient.name.trim() === "";
}
