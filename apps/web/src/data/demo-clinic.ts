import {
  QUEUE_NUMBER_PRESETS,
  StationId,
  UserId,
  Visit,
  buildWorklist,
  createInMemoryAllocator,
  cryptoRandomSource,
  generateJourneyCode,
  issueTicket,
  resetPeriodKey,
  type IdGenerator,
  type JourneyCode,
  type QueueItem,
  type QueueTicket,
  type StationSla,
  type StationWorklist,
  type Workflow,
} from "@qman/domain";
import { STATION_IDS, configStore, type ConfigStore } from "./config-store.js";

/**
 * A running clinic, built by driving the real domain engine.
 *
 * Every visit is produced by calling `Visit.create`, `enqueue`, `call`,
 * `startService` and `routeTo` against the actual aggregate — no hand-written
 * fixtures — so an illegal transition fails here rather than being papered over
 * by convenient mock JSON.
 *
 * Station names, rooms, SLAs and queue-number formats are read from the
 * configuration store rather than baked in, so an administrator changing a
 * station in the portal changes it everywhere immediately.
 */

let counter = 0;
const ids: IdGenerator = {
  next: () => {
    counter += 1;
    return `demo-${counter}`;
  },
};

/**
 * A clock the seed can wind back.
 *
 * Without it every queue entry is stamped "now", every wait computes to zero,
 * and the entire analytics stack — SLA breaches, longest wait, average service
 * time, bottlenecks — has nothing to measure. Backdating the aggregate's own
 * timestamps is what makes the seeded clinic look like a clinic that has been
 * running since eight o'clock rather than one that opened this instant.
 *
 * This is exactly the reason time is an injected dependency (ADR-002).
 */
class SeedClock {
  #current = new Date();

  now(): Date {
    return new Date(this.#current);
  }

  set(instant: Date): void {
    this.#current = new Date(instant);
  }

  advanceMinutes(minutes: number): void {
    this.#current = new Date(this.#current.getTime() + minutes * 60_000);
  }
}

const seedClock = new SeedClock();
const deps = { clock: seedClock, ids };

export { BRANCH } from "./config-store.js";
export const STATIONS = STATION_IDS;

// ------------------------------------------------------------ config readers

export function stationName(stationId: StationId): string {
  return configStore.stationName(stationId);
}

export function stationRoom(stationId: StationId): string | null {
  return configStore.station(stationId)?.room ?? null;
}

export function stationCode(stationId: StationId): string {
  return configStore.station(stationId)?.code ?? "QM";
}

export function stationStaffing(stationId: StationId): number {
  return configStore.station(stationId)?.staffing ?? 1;
}

export function stationServiceEstimate(stationId: StationId): number {
  return configStore.station(stationId)?.serviceEstimateMillis ?? 10 * 60_000;
}

export function slaFor(stationId: StationId): StationSla {
  return (
    configStore.station(stationId)?.sla ?? {
      targetWaitMillis: 30 * 60_000,
      saturationPoint: 10,
    }
  );
}

export function saturationFor(stationId: StationId): number {
  return slaFor(stationId).saturationPoint;
}

export function currentWorkflow(): Workflow {
  return configStore.defaultWorkflow();
}

/** Every enabled station, for hospital-wide analytics. */
export function allStations(): StationId[] {
  return configStore.activeStations().map((s) => s.id);
}

/** Stations a workspace can be opened for. */
export function workspaceStations(): StationId[] {
  return configStore.workspaceStations().map((s) => s.id);
}

/** Stations shown on the reception dashboard's live queue strip. */
export function receptionStations(): StationId[] {
  return configStore
    .activeStations()
    .filter((s) => s.id !== STATIONS.reception && s.isPublic)
    .map((s) => s.id)
    .slice(0, 3);
}

/** Staff directory, so dashboards can name people not ids. */
export const USERS: Record<string, { name: string; role: string }> = {
  "user-reception": { name: "Ifeoma Balogun", role: "Receptionist" },
  "user-nurse": { name: "RN Smith", role: "Nurse" },
  "user-doctor": { name: "Dr Adams", role: "Physician" },
  "user-lab": { name: "Chidi Obi", role: "Lab Scientist" },
};

export function userName(userId: string): string {
  return USERS[userId]?.name ?? "Unassigned";
}

// ------------------------------------------------------------ ticket issuing

/**
 * Ticket allocation for the demo clinic.
 *
 * Exposed so recovery can advance a series: a ticket number, once issued to a
 * patient, is never reissued (see `recoveredOrdinal`).
 */
export const allocator = createInMemoryAllocator();

/**
 * Issues the next ticket for a station, in that station's own format and from
 * that station's own series for the current reset period.
 */
export function issueTicketFor(
  stationId: StationId,
  journeyCode: JourneyCode,
  issuedAt: Date = new Date(),
  config: ConfigStore = configStore,
): QueueTicket {
  const station = config.station(stationId);
  const numbering = station?.queueNumber ?? QUEUE_NUMBER_PRESETS.numeric();

  // Allocation is scoped to the reset period, so the series restarts on its own
  // when the period rolls over — no midnight job to miss.
  const periodKey = resetPeriodKey(numbering, issuedAt);

  return issueTicket(numbering, {
    ordinal: allocator.next(stationId, periodKey),
    stationCode: station?.code ?? "QM",
    journeyCode,
    issuedAt,
  });
}

// ------------------------------------------------------------------ the seed

const NURSE = UserId("user-nurse");
const DOCTOR = UserId("user-doctor");
const RECEPTIONIST = UserId("user-reception");

interface Scripted {
  name: string;
  hospitalNumber: string;
  priority?: "emergency" | "high" | "vip" | "normal";
  path: StationId[];
  at: "waiting" | "called" | "serving" | "done";
  arrivedMinutesAgo: number;
}

const SCRIPT: Scripted[] = [
  { name: "Sarah Jenkins", hospitalNumber: "HN-40128", path: [STATIONS.reception, STATIONS.vitals], at: "waiting", arrivedMinutesAgo: 34 },
  { name: "Michael Chang", hospitalNumber: "HN-40129", path: [STATIONS.reception, STATIONS.vitals, STATIONS.consultation], at: "serving", arrivedMinutesAgo: 52, priority: "high" },
  { name: "Elena Rodriguez", hospitalNumber: "HN-40130", path: [STATIONS.reception, STATIONS.vitals, STATIONS.consultation, STATIONS.pharmacy], at: "done", arrivedMinutesAgo: 96 },
  { name: "Adaeze Nwosu", hospitalNumber: "HN-40131", path: [STATIONS.reception, STATIONS.vitals], at: "waiting", arrivedMinutesAgo: 21 },
  { name: "Tunde Bakare", hospitalNumber: "HN-40132", path: [STATIONS.reception, STATIONS.vitals, STATIONS.consultation], at: "waiting", arrivedMinutesAgo: 47, priority: "emergency" },
  { name: "Grace Mensah", hospitalNumber: "HN-40133", path: [STATIONS.reception, STATIONS.vitals, STATIONS.consultation, STATIONS.laboratory], at: "waiting", arrivedMinutesAgo: 63 },
  { name: "Robert Palmer", hospitalNumber: "HN-40134", path: [STATIONS.reception, STATIONS.vitals, STATIONS.consultation, STATIONS.laboratory], at: "called", arrivedMinutesAgo: 71 },
  { name: "Emma Watson", hospitalNumber: "HN-40135", path: [STATIONS.reception, STATIONS.vitals, STATIONS.consultation], at: "waiting", arrivedMinutesAgo: 29 },
  { name: "David Miller", hospitalNumber: "HN-40136", path: [STATIONS.reception], at: "waiting", arrivedMinutesAgo: 4 },
  { name: "Fatima Bello", hospitalNumber: "HN-40137", path: [STATIONS.reception, STATIONS.vitals], at: "waiting", arrivedMinutesAgo: 12, priority: "vip" },
  { name: "Kwame Asante", hospitalNumber: "HN-40138", path: [STATIONS.reception, STATIONS.vitals, STATIONS.consultation, STATIONS.pharmacy], at: "waiting", arrivedMinutesAgo: 88 },
  { name: "Ngozi Eze", hospitalNumber: "HN-40139", path: [STATIONS.reception, STATIONS.vitals], at: "waiting", arrivedMinutesAgo: 17 },
];

export interface DemoVisit {
  visit: Visit;
  arrivedAt: Date;
}

export function seedVisits(config: ConfigStore = configStore): DemoVisit[] {
  const workflow = config.defaultWorkflow();

  const now = Date.now();

  return SCRIPT.map((scripted) => {
    const arrivedAt = new Date(now - scripted.arrivedMinutesAgo * 60_000);

    // Spend part of the elapsed time on the legs already completed and leave
    // the remainder as the patient's current wait, so queue depths and wait
    // times are internally consistent.
    const legs = scripted.path.length - 1;
    const minutesPerLeg = 7;
    const spent = Math.min(
      legs * minutesPerLeg,
      Math.max(0, scripted.arrivedMinutesAgo - 1),
    );
    const perLeg = legs > 0 ? spent / legs : 0;

    seedClock.set(arrivedAt);

    const visit = Visit.create(
      {
        journeyCode: generateJourneyCode(cryptoRandomSource),
        branchId: config.config.branches[0]!.id,
        workflowId: workflow.id,
        patient: {
          name: scripted.name,
          hospitalNumber: scripted.hospitalNumber,
          phone: null,
        },
        ...(scripted.priority ? { priority: scripted.priority } : {}),
      },
      deps,
      { actorId: RECEPTIONIST },
    );

    const [first, ...rest] = scripted.path;
    visit.enqueue(
      first!,
      issueTicketFor(first!, visit.journeyCode, seedClock.now(), config),
      { actorId: RECEPTIONIST },
    );

    for (const stationId of rest) {
      // Waiting, then seen, then moved on.
      seedClock.advanceMinutes(perLeg * 0.6);
      visit.call(NURSE);
      visit.startService(NURSE);
      seedClock.advanceMinutes(perLeg * 0.4);
      visit.routeTo(
        stationId,
        issueTicketFor(stationId, visit.journeyCode, seedClock.now(), config),
        { actorId: NURSE },
      );
    }

    if (scripted.at === "called") {
      seedClock.set(new Date(now - 2 * 60_000));
      visit.call(DOCTOR);
    } else if (scripted.at === "serving") {
      seedClock.set(new Date(now - 6 * 60_000));
      visit.call(DOCTOR);
      visit.startService(DOCTOR);
    } else if (scripted.at === "done") {
      seedClock.set(new Date(now - 3 * 60_000));
      visit.call(DOCTOR);
      visit.startService(DOCTOR);
      seedClock.advanceMinutes(2);
      visit.complete({ actorId: DOCTOR });
    }

    visit.pullEvents();
    // Hand the clock back so live actions are stamped with the real time.
    seedClock.set(new Date());

    return { visit, arrivedAt };
  });
}

// ------------------------------------------------------------- projections

export function queueItemsFor(
  visits: readonly DemoVisit[],
  stationId: StationId,
): QueueItem[] {
  const items: QueueItem[] = [];
  for (const { visit } of visits) {
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

export function worklistFor(
  visits: readonly DemoVisit[],
  stationId: StationId,
): StationWorklist {
  return buildWorklist(stationId, queueItemsFor(visits, stationId));
}
