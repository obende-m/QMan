/**
 * Time is an injected dependency, never an ambient one.
 *
 * Every operational metric QMan sells — waiting time, service time, bottleneck
 * detection — is a subtraction of two timestamps. Domain code that calls
 * `new Date()` directly cannot be tested deterministically, so the domain takes
 * a Clock instead.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Test double: advances only when explicitly told to. */
export class FixedClock implements Clock {
  #current: Date;

  constructor(start: Date = new Date("2026-01-01T08:00:00.000Z")) {
    this.#current = start;
  }

  now(): Date {
    return new Date(this.#current);
  }

  /** Advance the clock and return the new time. */
  advance(millis: number): Date {
    this.#current = new Date(this.#current.getTime() + millis);
    return this.now();
  }

  advanceMinutes(minutes: number): Date {
    return this.advance(minutes * 60_000);
  }

  set(instant: Date): void {
    this.#current = new Date(instant);
  }
}
