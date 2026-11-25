/**
 * What the two public surfaces are shown, computed on the server.
 *
 * The display board and the patient tracker are opened by people with no
 * account, so they cannot read the staff configuration or the staff visit
 * list. They used to try — both entry points loaded `/api/v1/config` and the
 * branch's visits, which answer 401 without a staff session — and so worked
 * only on a machine where someone happened to be signed in.
 *
 * These projections are therefore complete: a board or tracker renders them
 * without any other request. They are also closed: each field is chosen here,
 * from scratch, so nothing the staff projection carries can reach a waiting
 * room by accident.
 *
 * - No Journey Code on a board. It opens a patient's tracking page.
 * - No visit or queue-entry ids anywhere. They correlate a person across
 *   stations for anyone collecting them.
 * - A name only where the board's configured policy shows one, and only in
 *   the form that policy allows.
 */
import {
  buildWorklist,
  displayPatientName,
  estimateWaitMillis,
  type DisplayBoardConfig,
  type HospitalConfiguration,
  type QueueItem,
  type StationConfig,
  type StationId,
  type Visit,
} from "@qman/domain";

function itemsAt(visits: readonly Visit[], stationId: StationId): QueueItem[] {
  const items: QueueItem[] = [];
  for (const visit of visits) {
    for (const entry of visit.queueEntries) {
      if (entry.stationId !== stationId) continue;
      items.push({
        visitId: visit.id,
        journeyCode: visit.journeyCode,
        patientName: visit.patient.name,
        priority: visit.priority,
        entry,
      });
    }
  }
  return items;
}

function minutes(millis: number): number {
  return Math.max(0, Math.round(millis / 60_000));
}

function waitFor(station: StationConfig, position: number, observed: number | null): number {
  return minutes(
    estimateWaitMillis({
      position,
      serversAvailable: station.staffing,
      observedServiceMillis: observed,
      configuredServiceMillis: station.serviceEstimateMillis,
    }),
  );
}

export function boardSnapshot(
  configuration: HospitalConfiguration,
  board: DisplayBoardConfig,
  visits: readonly Visit[],
  at: Date,
): Record<string, unknown> {
  const stations = board.stationIds
    .map((id) => configuration.stations.find((s) => s.id === id))
    .filter((s): s is StationConfig => s !== undefined && s.isPublic);

  const name = (item: QueueItem): string | null => displayPatientName(item.patientName, board.namePolicy);

  return {
    board: {
      id: board.id,
      name: board.name,
      showRoom: board.showRoom,
      showEstimatedWait: board.showEstimatedWait,
      namePolicy: board.namePolicy,
    },
    hospital: {
      name: configuration.profile.name,
      brandColor: configuration.profile.brandColor,
    },
    stations: stations.map((station) => {
      const worklist = buildWorklist(station.id, itemsAt(visits, station.id), { now: at });
      const serving = worklist.current;
      return {
        id: station.id,
        name: station.name,
        enabled: station.enabled,
        room: board.showRoom ? station.room : null,
        serving: serving
          ? {
              ticket: serving.entry.queueLabel,
              status: serving.entry.status,
              calledAt: serving.entry.calledAt?.toISOString() ?? null,
              callAttempts: serving.entry.callAttempts,
              name: name(serving),
            }
          : null,
        waiting: worklist.waiting.slice(0, board.waitingToShow).map((item, index) => ({
          ticket: item.entry.queueLabel,
          position: index + 1,
          name: name(item),
        })),
        waitingCount: worklist.counts.waiting,
        estimatedWaitMinutes: board.showEstimatedWait
          ? waitFor(station, worklist.counts.waiting + 1, worklist.averageServiceMillis)
          : null,
      };
    }),
    at: at.toISOString(),
  };
}

/**
 * One patient's view of their own visit.
 *
 * `visitsAtStation` are the open visits at the patient's current station in
 * the same branch, which is what their position is counted among. The
 * patient's own name is not included: the page may be on a phone held up to a
 * friend, and the patient knows who they are.
 */
export function trackSnapshot(
  configuration: HospitalConfiguration,
  visit: Visit,
  visitsAtStation: readonly Visit[],
  at: Date,
): Record<string, unknown> {
  const entry = visit.currentEntry;
  const station = entry ? configuration.stations.find((s) => s.id === entry.stationId) : undefined;
  const workflow = configuration.workflows.find((w) => w.id === visit.workflowId);

  let position: number | null = null;
  let estimatedWaitMinutes: number | null = null;
  if (entry && station && entry.status === "waiting") {
    const worklist = buildWorklist(station.id, itemsAt(visitsAtStation, station.id), { now: at });
    const index = worklist.waiting.findIndex((item) => item.visitId === visit.id);
    if (index !== -1) {
      position = index + 1;
      estimatedWaitMinutes = waitFor(station, position, worklist.averageServiceMillis);
    }
  }

  const stages = workflow ? [...workflow.stages].sort((a, b) => a.sequence - b.sequence) : [];
  return {
    status: visit.status,
    journeyCode: visit.journeyCode,
    hospital: { name: configuration.profile.name, supportPhone: configuration.profile.supportPhone },
    current: entry
      ? {
          ticket: entry.queueLabel,
          status: entry.status,
          stationName: station?.name ?? "Station",
          room: station?.room ?? null,
          queuedAt: entry.queuedAt.toISOString(),
          calledAt: entry.calledAt?.toISOString() ?? null,
          position,
          ahead: position === null ? null : position - 1,
          estimatedWaitMinutes,
        }
      : null,
    journey: stages.map((stage) => {
      const stageStation = configuration.stations.find((s) => s.id === stage.stationId);
      const visited = visit.queueEntries.some(
        (e) => e.stationId === stage.stationId && e.status === "completed",
      );
      return {
        name: stageStation?.name ?? "Station",
        state: entry?.stationId === stage.stationId ? "current" : visited ? "done" : "upcoming",
      };
    }),
    at: at.toISOString(),
  };
}
