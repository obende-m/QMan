import { describe, expect, it } from "vitest";
import {
  generateJourneyCode,
  generateUniqueJourneyCode,
  isJourneyCode,
  normaliseJourneyCode,
  parseJourneyCode,
} from "./journey-code.js";
import { CyclingRandom } from "../testing/fixtures.js";
import { ValidationError } from "../shared/errors.js";

describe("journey code", () => {
  it("generates codes in the QM-XXXX shape", () => {
    const code = generateJourneyCode(new CyclingRandom([0, 1, 2, 3]));
    expect(code).toMatch(/^QM-[A-Z0-9]{4}$/);
  });

  it("never emits the ambiguous characters I, L, O, U, 0 or 1", () => {
    // Walk the whole alphabet by cycling every index.
    const indices = Array.from({ length: 60 }, (_, i) => i);
    const code = generateJourneyCode(new CyclingRandom(indices), 8);
    expect(code.slice(3)).not.toMatch(/[ILOU01]/);
  });

  it("accepts the many ways a patient might type their code", () => {
    const canonical = "QM-8F4K";
    for (const input of ["QM-8F4K", "qm-8f4k", "8F4K", "8f4k", " qm 8f4k "]) {
      expect(normaliseJourneyCode(input)).toBe(canonical);
    }
  });

  it("repairs the look-alike characters it deliberately never generates", () => {
    // A patient reading "QM-J7QN" off a ticket may type I, L or 1 for J,
    // and O or 0 for Q.
    expect(normaliseJourneyCode("QM-I7ON")).toBe("QM-J7QN");
    expect(normaliseJourneyCode("QM-L7 0N")).toBe("QM-J7QN");
    expect(normaliseJourneyCode("17on")).toBe("QM-J7QN");
  });

  it("rejects codes that are the wrong shape", () => {
    expect(isJourneyCode("QM-8F4K")).toBe(true);
    expect(isJourneyCode("8F4K")).toBe(false);
    expect(() => parseJourneyCode("!!")).toThrow(ValidationError);
    expect(() => parseJourneyCode("")).toThrow(ValidationError);
  });

  it("retries past a collision", async () => {
    // First candidate is taken, second is free.
    const taken = new Set(["QM-2222"]);
    const random = new CyclingRandom([0, 0, 0, 0, 1, 1, 1, 1]);
    const code = await generateUniqueJourneyCode(
      async (c) => taken.has(c),
      { random },
    );
    expect(code).toBe("QM-3333");
  });

  it("widens the code rather than failing when the space is saturated", async () => {
    const code = await generateUniqueJourneyCode(async () => true, {
      random: new CyclingRandom([0]),
      maxAttempts: 3,
    });
    expect(code).toBe("QM-22222");
  });
});
