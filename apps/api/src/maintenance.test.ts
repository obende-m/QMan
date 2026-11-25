/**
 * Visit closure.
 *
 * The job is what retires tracking tokens and frees Journey Codes, so the
 * tests are about which visits it seals, how, and what it does when it races
 * a member of staff.
 */
import { describe, expect, it } from "vitest";
import {
  BranchId,
  StationId,
  UserId,
  Visit,
  WorkflowId,
  parseJourneyCode,
  type VisitId,
} from "@qman/domain";
import {
  ConcurrentModificationError,
  type ClosureCriteria,
  type NewEvent,
  type VisitRepository,
} from "@qman/persistence";
import { ABANDONED_REASON, closeVisits } from "./maintenance.js";
import { silentLogger } from "./logging.js";
import { HOSPITAL } from "./config-fixtures.js";

const NOW = new Date("2026-03-10T06:00:00Z");
let n = 0;
const deps = { clock: { now: () => NOW }, ids: { next: () => `id-${(n += 1)}` } };

function visit(state: "waiting" | "completed"): Visit {
  const v = Visit.create(
    {
      journeyCode: parseJourneyCode("QM-8F4K"),
      branchId: BranchId("branch"),
      workflowId: WorkflowId("wf"),
      patient: { name: "Amara Okafor", hospitalNumber: null, phone: null },
    },
    deps,
  );
  v.enqueue(StationId("s"), { ordinal: 1, label: "A-001", periodKey: "p" });
  if (state === "completed") {
    v.call(UserId("u"));
    v.complete({ actorId: UserId("u") });
  }
  v.pullEvents();
  return v;
}

function repository(candidates: Visit[], failing: Set<Visit> = new Set()) {
  const saved: Array<{ visit: Visit; events: readonly NewEvent[] }> = [];
  let criteria: ClosureCriteria | null = null;
  const repo = {
    async awaitingClosure(c: ClosureCriteria) {
      criteria = c;
      return candidates.map((v) => ({ hospitalId: HOSPITAL, visit: v }));
    },
    async save(v: Visit, events: readonly NewEvent[]) {
      if (failing.has(v)) throw new ConcurrentModificationError(v.id as VisitId);
      saved.push({ visit: v, events });
    },
  } as unknown as VisitRepository;
  return { repo, saved, criteria: () => criteria };
}

describe("visit closure", () => {
  it("seals a finished visit and records it under its own organization", async () => {
    const finished = visit("completed");
    const { repo, saved } = repository([finished]);
    const outcome = await closeVisits({
      visits: repo,
      logger: silentLogger(),
      now: () => NOW,
      policy: { closeAfterMinutes: 120, abandonAfterHours: 18 },
    });
    expect(outcome).toEqual({ closed: 1, abandoned: 0, conflicts: 0 });
    expect(finished.status).toBe("closed");
    expect(saved[0]!.events.map((e) => e.type)).toEqual(["visit.closed"]);
    expect(saved[0]!.events[0]!.hospitalId).toBe(HOSPITAL);
  });

  it("cancels an abandoned visit with a reason before closing it", async () => {
    const abandoned = visit("waiting");
    const { repo, saved } = repository([abandoned]);
    const outcome = await closeVisits({
      visits: repo,
      logger: silentLogger(),
      now: () => NOW,
      policy: { closeAfterMinutes: 120, abandonAfterHours: 18 },
    });
    expect(outcome.abandoned).toBe(1);
    const types = saved[0]!.events.map((e) => e.type);
    expect(types).toContain("visit.cancelled");
    expect(types.at(-1)).toBe("visit.closed");
    const cancelled = saved[0]!.events.find((e) => e.type === "visit.cancelled")!;
    expect(cancelled.payload["reason"]).toBe(ABANDONED_REASON);
  });

  it("asks for visits by the configured grace periods", async () => {
    const { repo, criteria } = repository([]);
    await closeVisits({
      visits: repo,
      logger: silentLogger(),
      now: () => NOW,
      policy: { closeAfterMinutes: 60, abandonAfterHours: 12 },
    });
    expect(criteria()!.finishedBefore).toEqual(new Date(NOW.getTime() - 60 * 60_000));
    expect(criteria()!.admittedBefore).toEqual(new Date(NOW.getTime() - 12 * 3_600_000));
  });

  it("loses cleanly to a member of staff acting on the same visit", async () => {
    const raced = visit("completed");
    const other = visit("completed");
    const { repo, saved } = repository([raced, other], new Set([raced]));
    const outcome = await closeVisits({
      visits: repo,
      logger: silentLogger(),
      now: () => NOW,
      policy: { closeAfterMinutes: 120, abandonAfterHours: 18 },
    });
    expect(outcome).toEqual({ closed: 1, abandoned: 0, conflicts: 1 });
    expect(saved).toHaveLength(1);
  });
});
