/**
 * Retry safety.
 *
 * The scenario throughout is the real one: a request that reached the server
 * and did its work, whose response was lost on the way back. The client cannot
 * tell that from a request that never arrived, so it retries — and the system
 * has to tell them apart on its behalf.
 */
import { describe, expect, it } from "vitest";
import { FakeDatabase, PostgresIdempotencyRepository } from "@qman/persistence";
import { fingerprint, KEY_LIFETIME_MILLIS } from "./idempotency.js";

const HOSPITAL = "11111111-1111-1111-1111-111111111111";
const AT = new Date("2026-03-09T09:00:00Z");

describe("idempotency claims", () => {
  /**
   * DO NOTHING, not DO UPDATE. Losing the race must not overwrite the winner's
   * row, and the empty result is the signal that someone else got there first.
   */
  it("claims a key with an insert that cannot overwrite a winner", async () => {
    const db = new FakeDatabase().willReturn([{ key: "k1" }]);
    const repository = new PostgresIdempotencyRepository(db);

    const claim = await repository.claim(HOSPITAL, "k1", "print", AT);

    expect(claim.outcome).toBe("claimed");
    const [statement] = db.matching("INSERT INTO idempotency_keys");
    expect(statement!.sql).toContain("ON CONFLICT (hospital_id, key) DO NOTHING");
    expect(statement!.sql).toContain("RETURNING key");
  });

  it("replays the stored response when the key has already completed", async () => {
    const db = new FakeDatabase()
      .willReturn([]) // the insert lost
      .willReturn([
        { fingerprint: "print", status_code: 200, response: { visit: { id: "v1" } } },
      ]);

    const claim = await new PostgresIdempotencyRepository(db).claim(
      HOSPITAL,
      "k1",
      "print",
      AT,
    );

    expect(claim).toEqual({
      outcome: "replay",
      statusCode: 200,
      response: { visit: { id: "v1" } },
    });
  });

  /** Two retries arriving together must not both do the work. */
  it("reports a claim still in flight", async () => {
    const db = new FakeDatabase()
      .willReturn([])
      .willReturn([{ fingerprint: "print", status_code: null, response: null }]);

    const claim = await new PostgresIdempotencyRepository(db).claim(
      HOSPITAL,
      "k1",
      "print",
      AT,
    );
    expect(claim.outcome).toBe("in_flight");
  });

  /**
   * The same key on a genuinely different request is a client bug. Answering
   * with the first response would tell the caller an action succeeded that was
   * never attempted.
   */
  it("refuses a key reused for a different request", async () => {
    const db = new FakeDatabase()
      .willReturn([])
      .willReturn([{ fingerprint: "a-different-request", status_code: 200, response: {} }]);

    const claim = await new PostgresIdempotencyRepository(db).claim(
      HOSPITAL,
      "k1",
      "print",
      AT,
    );
    expect(claim.outcome).toBe("mismatch");
  });

  /** Pruned or released between the insert and the read. Retrying is the safe reading. */
  it("treats a vanished row as in flight rather than assuming success", async () => {
    const db = new FakeDatabase().willReturn([]).willReturn([]);
    const claim = await new PostgresIdempotencyRepository(db).claim(
      HOSPITAL,
      "k1",
      "print",
      AT,
    );
    expect(claim.outcome).toBe("in_flight");
  });

  /**
   * A completed row is the stored answer. Deleting it would let the work run
   * twice, which is the whole thing being prevented.
   */
  it("releases only an unfinished claim", async () => {
    const db = new FakeDatabase();
    await new PostgresIdempotencyRepository(db).release(HOSPITAL, "k1");
    expect(db.matching("DELETE FROM idempotency_keys")[0]!.sql).toContain(
      "status_code IS NULL",
    );
  });

  it("scopes every operation to one hospital", async () => {
    const db = new FakeDatabase().willReturn([{ key: "k1" }]);
    const repository = new PostgresIdempotencyRepository(db);
    await repository.claim(HOSPITAL, "k1", "print", AT);
    await repository.complete(HOSPITAL, "k1", 200, {}, AT);
    await repository.release(HOSPITAL, "k1");

    for (const statement of db.statements) {
      if (statement.sql.includes("idempotency_keys")) {
        expect(statement.params[0]).toBe(HOSPITAL);
      }
    }
  });
});

describe("request fingerprints", () => {
  it("matches a genuine retry of the same request", () => {
    expect(fingerprint("POST", "/api/v1/visits/v1/call", { note: "x" })).toBe(
      fingerprint("POST", "/api/v1/visits/v1/call", { note: "x" }),
    );
  });

  it("differs when the path, method or body differ", () => {
    const base = fingerprint("POST", "/api/v1/visits/v1/call", {});
    expect(fingerprint("POST", "/api/v1/visits/v2/call", {})).not.toBe(base);
    expect(fingerprint("POST", "/api/v1/visits/v1/skip", {})).not.toBe(base);
    expect(fingerprint("DELETE", "/api/v1/visits/v1/call", {})).not.toBe(base);
    expect(fingerprint("POST", "/api/v1/visits/v1/call", { note: "x" })).not.toBe(base);
  });

  /**
   * The row outlives the request by a day and the body carries patient
   * details. A digest answers the only question asked of it without keeping
   * the data to answer it.
   */
  it("does not carry the request body forward", () => {
    const print = fingerprint("POST", "/api/v1/visits/v1/call", {
      patientName: "Amara Okafor",
      phone: "+2348012345678",
    });
    expect(print).not.toContain("Amara");
    expect(print).not.toContain("2348012345678");
    expect(print).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps keys long enough to cover a retry, not long enough to be history", () => {
    expect(KEY_LIFETIME_MILLIS).toBe(24 * 60 * 60_000);
  });
});
