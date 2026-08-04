import { ValidationError } from "../shared/errors.js";

/**
 * Journey Codes are read aloud across a noisy waiting room, typed by patients on
 * phone keyboards, and printed on thermal tickets. The alphabet therefore
 * excludes characters that collide under those conditions:
 *
 *   I / 1 / L   look alike in most sans-serif faces
 *   O / 0       look alike, and are the classic mis-typed pair
 *   U           is dropped so no short code can spell common profanity
 *               (V is kept; removing the vowel makes real words unlikely)
 *
 * What remains is 30 symbols: digits 2-9 plus 22 letters. At the default length
 * of 4 that is 810,000 codes — far beyond a branch's daily visit count, so
 * collisions are rare and are handled by retry rather than by lengthening the
 * code and hurting readability.
 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export const JOURNEY_CODE_PREFIX = "QM";
export const DEFAULT_JOURNEY_CODE_LENGTH = 4;

const PATTERN = new RegExp(`^${JOURNEY_CODE_PREFIX}-[${ALPHABET}]{3,8}$`);

export type JourneyCode = string & { readonly __journeyCode: unique symbol };

/** Source of randomness, injected so tests can make codes deterministic. */
export interface RandomSource {
  /** Returns an integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
}

export const cryptoRandomSource: RandomSource = {
  nextInt(maxExclusive: number): number {
    // Rejection sampling keeps the distribution uniform. A plain `% n` would
    // bias toward low indices whenever n does not divide 2^32.
    const limit = Math.floor(0xffffffff / maxExclusive) * maxExclusive;
    const buffer = new Uint32Array(1);
    let value: number;
    do {
      globalThis.crypto.getRandomValues(buffer);
      value = buffer[0]!;
    } while (value >= limit);
    return value % maxExclusive;
  },
};

/**
 * Normalises patient input before lookup: patients type "qm 8f4k", "8f4k" or
 * "QM-8F4K" and all three must resolve to the same visit.
 *
 * It also repairs the confusions the alphabet was designed around. Because
 * I, L, 1, O and 0 can never appear in a generated code, seeing one is proof of
 * a mis-read, and the character it was mis-read from is unambiguous:
 * I/L/1 are only ever a mis-read J, and O/0 are only ever a mis-read Q.
 */
export function normaliseJourneyCode(input: string): string {
  const body = input
    .toUpperCase()
    .replace(/[\s\-_]/g, "")
    .replace(/^QM/, "")
    .replace(/[IL1]/g, "J")
    .replace(/[O0]/g, "Q");

  return `${JOURNEY_CODE_PREFIX}-${body}`;
}

export function isJourneyCode(value: string): value is JourneyCode {
  return PATTERN.test(value);
}

export function parseJourneyCode(input: string): JourneyCode {
  const candidate = normaliseJourneyCode(input);
  if (!isJourneyCode(candidate)) {
    throw new ValidationError(`"${input}" is not a valid journey code.`, {
      input,
    });
  }
  return candidate;
}

export function generateJourneyCode(
  random: RandomSource = cryptoRandomSource,
  length: number = DEFAULT_JOURNEY_CODE_LENGTH,
): JourneyCode {
  if (length < 3 || length > 8) {
    throw new ValidationError("Journey code length must be between 3 and 8.", {
      length,
    });
  }
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += ALPHABET[random.nextInt(ALPHABET.length)]!;
  }
  return `${JOURNEY_CODE_PREFIX}-${code}` as JourneyCode;
}

/**
 * Generates a code that is not already taken, retrying on collision.
 *
 * Uniqueness is scoped by the caller's `isTaken` predicate — in practice
 * "active visits in this branch" rather than "all visits ever", so codes can be
 * recycled across days and stay short.
 */
export async function generateUniqueJourneyCode(
  isTaken: (code: JourneyCode) => Promise<boolean>,
  options: {
    random?: RandomSource;
    length?: number;
    maxAttempts?: number;
  } = {},
): Promise<JourneyCode> {
  const {
    random = cryptoRandomSource,
    length = DEFAULT_JOURNEY_CODE_LENGTH,
    maxAttempts = 10,
  } = options;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateJourneyCode(random, length);
    if (!(await isTaken(candidate))) {
      return candidate;
    }
  }

  // Exhausting 10 attempts means the active-code space is saturated. Widening
  // the code is the correct escape hatch — refusing to admit the patient is not.
  return generateJourneyCode(random, length + 1);
}
