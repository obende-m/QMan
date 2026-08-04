import { describe, expect, it } from "vitest";
import {
  createInMemoryAllocator,
  needsReconciliation,
  recoveredOrdinal,
} from "./queue-number.js";

/**
 * The rule: **a ticket number, once issued to a patient, is never reissued.**
 *
 * A point-in-time restore rewinds the allocator but not the waiting room. Roll
 * back to 13:55 after A-042 was printed at 13:58, and without this the next
 * patient is handed A-042 while the first is still holding theirs. Two people
 * then legitimately possess the same ticket — impossible to explain at a
 * reception desk, and it destroys trust in every number on the board.
 */
describe("ticket series recovery", () => {
  it("resumes past the highest ticket the restore knows about", () => {
    expect(
      recoveredOrdinal({
        stationId: "st-consultation",
        periodKey: "2026-03-09",
        highestRecorded: 41,
      }),
    ).toBe(42);
  });

  it("never reissues a number handed out on paper during the outage", () => {
    // The database was restored to 13:55 knowing about A-038; reception kept
    // working on paper up to A-046.
    expect(
      recoveredOrdinal({
        stationId: "st-consultation",
        periodKey: "2026-03-09",
        highestRecorded: 38,
        highestOnPaper: 46,
      }),
    ).toBe(47);
  });

  it("takes whichever source ran further", () => {
    // Paper behind the database: the database still wins.
    expect(
      recoveredOrdinal({
        stationId: "st-lab",
        periodKey: "2026-03-09",
        highestRecorded: 50,
        highestOnPaper: 12,
      }),
    ).toBe(51);
  });

  it("starts at one for a series that never ran", () => {
    expect(
      recoveredOrdinal({
        stationId: "st-lab",
        periodKey: "2026-03-10",
        highestRecorded: 0,
      }),
    ).toBe(1);
  });

  /**
   * Only the staff who wrote paper tickets know how far the series actually
   * ran. Reopening on the restored data alone would reissue every one of them.
   */
  it("requires a human when paper tickets are unaccounted for", () => {
    expect(
      needsReconciliation({
        stationId: "st-consultation",
        periodKey: "2026-03-09",
        highestRecorded: 38,
      }),
    ).toBe(true);

    expect(
      needsReconciliation({
        stationId: "st-consultation",
        periodKey: "2026-03-09",
        highestRecorded: 38,
        // Explicitly zero: staff confirmed none were issued. Different from
        // "nobody has checked".
        highestOnPaper: 0,
      }),
    ).toBe(false);
  });
});

describe("allocator recovery", () => {
  it("advances a rewound series so the next ticket is safe", () => {
    const allocator = createInMemoryAllocator();
    const period = "2026-03-09";

    // Before the outage the series reached 42.
    for (let i = 0; i < 42; i += 1) allocator.next("st-consultation", period);
    expect(allocator.peek("st-consultation", period)).toBe(42);

    // A restore rewinds it — simulated by a fresh allocator.
    const restored = createInMemoryAllocator();
    expect(restored.next("st-consultation", period)).toBe(1); // the collision

    // Recovery advances past everything known to have been issued.
    const recovered = createInMemoryAllocator();
    recovered.advanceTo(
      "st-consultation",
      period,
      recoveredOrdinal({
        stationId: "st-consultation",
        periodKey: period,
        highestRecorded: 42,
      }),
    );
    expect(recovered.next("st-consultation", period)).toBe(43);
  });

  /**
   * Recovery run twice, or run with a stale figure, must never wind a series
   * backwards — that is the one thing it exists to prevent.
   */
  it("is idempotent and never moves a series backwards", () => {
    const allocator = createInMemoryAllocator();
    const period = "2026-03-09";

    allocator.advanceTo("st-lab", period, 60);
    allocator.advanceTo("st-lab", period, 60);
    allocator.advanceTo("st-lab", period, 10);

    expect(allocator.next("st-lab", period)).toBe(60);
  });

  it("keeps each station and period independent", () => {
    const allocator = createInMemoryAllocator();

    allocator.advanceTo("st-consultation", "2026-03-09", 43);

    // A different station is untouched.
    expect(allocator.next("st-lab", "2026-03-09")).toBe(1);
    // So is the same station on a different day.
    expect(allocator.next("st-consultation", "2026-03-10")).toBe(1);
    expect(allocator.next("st-consultation", "2026-03-09")).toBe(43);
  });

  it("does not disturb a series that is already ahead", () => {
    const allocator = createInMemoryAllocator();
    for (let i = 0; i < 100; i += 1) allocator.next("st-lab", "2026-03-09");

    allocator.advanceTo("st-lab", "2026-03-09", 50);
    expect(allocator.next("st-lab", "2026-03-09")).toBe(101);
  });
});
