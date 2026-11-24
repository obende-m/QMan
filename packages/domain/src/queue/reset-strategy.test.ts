import { describe, expect, it } from "vitest";
import {
  createInMemoryAllocator,
  resetPeriodKey,
  type QueueNumberConfig,
} from "./queue-number.js";

const config = (
  reset: QueueNumberConfig["reset"],
  manualEpoch?: string,
): QueueNumberConfig => ({
  template: "A-{n:3}",
  reset,
  ...(manualEpoch === undefined ? {} : { manualEpoch }),
});

describe("reset strategies", () => {
  it("gives each day its own series", () => {
    const monday = new Date(2026, 2, 9, 8, 0);
    const tuesday = new Date(2026, 2, 10, 8, 0);
    expect(resetPeriodKey(config("daily"), monday)).toBe("2026-03-09");
    expect(resetPeriodKey(config("daily"), monday)).toBe(
      resetPeriodKey(config("daily"), new Date(2026, 2, 9, 23, 59)),
    );
    expect(resetPeriodKey(config("daily"), tuesday)).not.toBe(
      resetPeriodKey(config("daily"), monday),
    );
  });

  it("groups a whole ISO week together", () => {
    // Monday 9 March and Sunday 15 March 2026 are the same ISO week.
    const monday = new Date(2026, 2, 9);
    const sunday = new Date(2026, 2, 15);
    const nextMonday = new Date(2026, 2, 16);

    expect(resetPeriodKey(config("weekly"), monday)).toBe(
      resetPeriodKey(config("weekly"), sunday),
    );
    expect(resetPeriodKey(config("weekly"), nextMonday)).not.toBe(
      resetPeriodKey(config("weekly"), monday),
    );
    expect(resetPeriodKey(config("weekly"), monday)).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("uses ISO week numbering across a year boundary", () => {
    // 31 December 2025 is a Wednesday, so it belongs to ISO week 1 of 2026 —
    // a naive day-of-year division would call it week 53 of 2025.
    expect(resetPeriodKey(config("weekly"), new Date(2025, 11, 31))).toBe(
      "2026-W01",
    );
    expect(resetPeriodKey(config("weekly"), new Date(2026, 0, 1))).toBe(
      "2026-W01",
    );
  });

  it("groups a calendar month", () => {
    expect(resetPeriodKey(config("monthly"), new Date(2026, 2, 1))).toBe(
      "2026-03",
    );
    expect(resetPeriodKey(config("monthly"), new Date(2026, 2, 31))).toBe(
      "2026-03",
    );
    expect(resetPeriodKey(config("monthly"), new Date(2026, 3, 1))).toBe(
      "2026-04",
    );
  });

  it("never changes period when configured never to reset", () => {
    expect(resetPeriodKey(config("never"), new Date(2026, 0, 1))).toBe(
      resetPeriodKey(config("never"), new Date(2027, 6, 19)),
    );
  });

  it("starts a new series only when an administrator bumps the epoch", () => {
    const before = config("manual", "session-1");
    const after = config("manual", "session-2");
    const anyDay = new Date(2026, 2, 9);

    expect(resetPeriodKey(before, anyDay)).toBe(
      resetPeriodKey(before, new Date(2026, 8, 30)),
    );
    expect(resetPeriodKey(after, anyDay)).not.toBe(
      resetPeriodKey(before, anyDay),
    );
  });
});

describe("ordinal allocation", () => {
  /**
   * The point of keying allocation by period rather than resetting a counter:
   * nothing has to run at midnight, so a missed job cannot corrupt a series and
   * yesterday's ordinals stay queryable.
   */
  it("restarts numbering when the period rolls over, with no scheduled job", () => {
    const allocator = createInMemoryAllocator();
    const daily = config("daily");
    const monday = new Date(2026, 2, 9, 9, 0);
    const tuesday = new Date(2026, 2, 10, 9, 0);

    const mondayKey = resetPeriodKey(daily, monday);
    expect(allocator.next("st-lab", mondayKey)).toBe(1);
    expect(allocator.next("st-lab", mondayKey)).toBe(2);
    expect(allocator.next("st-lab", mondayKey)).toBe(3);

    const tuesdayKey = resetPeriodKey(daily, tuesday);
    expect(allocator.next("st-lab", tuesdayKey)).toBe(1);

    // Monday's series is untouched and still resumable.
    expect(allocator.peek("st-lab", mondayKey)).toBe(3);
  });

  it("keeps each station's series independent", () => {
    const allocator = createInMemoryAllocator();
    const key = resetPeriodKey(config("daily"), new Date(2026, 2, 9));

    expect(allocator.next("st-consultation", key)).toBe(1);
    expect(allocator.next("st-laboratory", key)).toBe(1);
    expect(allocator.next("st-consultation", key)).toBe(2);
    expect(allocator.next("st-laboratory", key)).toBe(2);
  });

  it("keeps counting across days when reset is never", () => {
    const allocator = createInMemoryAllocator();
    const never = config("never");
    const day1 = resetPeriodKey(never, new Date(2026, 2, 9));
    const day2 = resetPeriodKey(never, new Date(2026, 2, 10));

    expect(allocator.next("st-lab", day1)).toBe(1);
    expect(allocator.next("st-lab", day2)).toBe(2);
  });
});

describe("reset periods in the hospital's time zone", () => {
  it("restarts a daily series at the hospital's midnight, not the server's", () => {
    // 23:30 UTC on 9 March is already 00:30 on 10 March in Lagos (UTC+1).
    const late = new Date(Date.UTC(2026, 2, 9, 23, 30));
    expect(resetPeriodKey(config("daily"), late, "Africa/Lagos")).toBe("2026-03-10");
    expect(resetPeriodKey(config("daily"), late, "UTC")).toBe("2026-03-09");
  });

  it("keeps working when the configured zone is unknown", () => {
    expect(resetPeriodKey(config("daily"), new Date(2026, 2, 9, 12), "Not/AZone")).toBe("2026-03-09");
  });
});
