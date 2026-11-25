/**
 * The fixture builder itself.
 *
 * Worth testing directly: every other suite depends on it, so a fixture that
 * silently builds an empty clinic would turn nine failing suites into nine
 * passing ones that assert nothing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, STATION_IDS } from "./api-fixture.js";

describe("api fixture", () => {
  let restore: (() => void) | null = null;
  afterEach(() => restore?.());

  it("loads a hospital the domain considers valid", async () => {
    const fixture = await createFixture();
    restore = fixture.restore;

    expect(fixture.config.status).toBe("ready");
    expect(fixture.config.problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(fixture.config.config.stations).toHaveLength(5);
  });

  it("loads visits as rehydrated aggregates, not raw payloads", async () => {
    const fixture = await createFixture();
    restore = fixture.restore;

    expect(fixture.clinic.status).toBe("ready");
    expect(fixture.clinic.visits.length).toBeGreaterThan(0);
    // A rehydrated aggregate answers domain questions.
    const [first] = fixture.clinic.visits;
    expect(first!.journeyCode).toMatch(/^QM-/);
    expect(first!.queueEntries.length).toBeGreaterThan(0);
  });

  it("drives the real transport, so the wire format is exercised", async () => {
    const fixture = await createFixture();
    restore = fixture.restore;

    const paths = fixture.requests.map((r) => r.url);
    expect(paths.some((p) => p.endsWith("/api/v1/config"))).toBe(true);
    expect(paths.some((p) => p.includes("/visits"))).toBe(true);
  });

  it("builds worklists the projections agree with", async () => {
    const fixture = await createFixture();
    restore = fixture.restore;

    // Every queue entry in the fixture belongs to some station's worklist, so
    // the totals across stations must account for all of them.
    const total = fixture.config.activeStations().reduce((sum, s) => {
      const w = fixture.clinic.worklist(s.id);
      return (
        sum +
        w.counts.waiting +
        w.counts.skipped +
        w.counts.completedToday +
        (w.current ? 1 : 0)
      );
    }, 0);
    const entries = fixture.clinic.visits.reduce(
      (sum, visit) => sum + visit.queueEntries.length,
      0,
    );
    expect(total).toBe(entries);
    expect(entries).toBeGreaterThan(0);
  });

  it("signs a user in with the permissions a screen needs", async () => {
    const fixture = await createFixture();
    restore = fixture.restore;

    expect(fixture.auth.status).toBe("signed_in");
    expect(fixture.auth.can("queue.call")).toBe(true);
  });
});
