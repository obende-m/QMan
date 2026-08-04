/**
 * Connection state for real-time surfaces.
 *
 * Every screen in QMan that claims to be live — the display board, a station
 * workspace, the patient tracker, the command centre — is making an assertion
 * about data it may no longer be receiving. A board that says "Live" while
 * rendering a queue that moved on ten minutes ago is not a cosmetic problem:
 * in a clinical setting, stale information presented as current is more
 * dangerous than no information at all, because it is acted upon.
 *
 * One model, shared by all of them, so the answer is consistent wherever a
 * patient or a member of staff happens to be looking.
 */

export const CONNECTION_STATES = [
  "connecting",
  "connected",
  "reconnecting",
  "stale",
  "offline",
] as const;

export type ConnectionState = (typeof CONNECTION_STATES)[number];

export interface ConnectionThresholds {
  /**
   * Beyond this without an update, the data is no longer trustworthy as
   * current. The screen keeps showing it — something is better than a blank
   * board — but stops claiming it is live.
   */
  readonly staleAfterMillis: number;
  /** Beyond this, treat the source as gone. */
  readonly offlineAfterMillis: number;
}

/**
 * Tuned to a 15-second source heartbeat, matching device health (ADR-029).
 *
 * Stale at 45 seconds tolerates two missed beats, so a momentary wi-fi stumble
 * in a hospital corridor does not make the board cry wolf — a board that warns
 * every few minutes is a board nobody reads.
 */
export const DEFAULT_CONNECTION_THRESHOLDS: ConnectionThresholds = {
  staleAfterMillis: 45_000,
  offlineAfterMillis: 180_000,
};

export interface ConnectionSnapshot {
  readonly state: ConnectionState;
  /** When the surface last heard from its data source. */
  readonly lastUpdatedAt: Date | null;
  /** How long ago that was. Zero when nothing has arrived yet. */
  readonly ageMillis: number;
  /** Whether what is on screen can be trusted as current. */
  readonly trustworthy: boolean;
}

export interface ConnectionInput {
  readonly lastUpdatedAt: Date | null;
  /**
   * True while the surface is actively trying to establish or re-establish a
   * connection. Distinguishes "trying" from "given up", which are different
   * things to tell a waiting room.
   */
  readonly attempting: boolean;
  readonly now: Date;
  readonly thresholds?: ConnectionThresholds;
}

export function assessConnection(input: ConnectionInput): ConnectionSnapshot {
  const thresholds = input.thresholds ?? DEFAULT_CONNECTION_THRESHOLDS;

  // Nothing has ever arrived: this is a first connection, not a failure.
  if (input.lastUpdatedAt === null) {
    return {
      state: input.attempting ? "connecting" : "offline",
      lastUpdatedAt: null,
      ageMillis: 0,
      trustworthy: false,
    };
  }

  const ageMillis = Math.max(
    0,
    input.now.getTime() - input.lastUpdatedAt.getTime(),
  );

  if (ageMillis >= thresholds.offlineAfterMillis) {
    return {
      state: input.attempting ? "reconnecting" : "offline",
      lastUpdatedAt: input.lastUpdatedAt,
      ageMillis,
      trustworthy: false,
    };
  }

  if (ageMillis >= thresholds.staleAfterMillis) {
    return {
      state: "stale",
      lastUpdatedAt: input.lastUpdatedAt,
      ageMillis,
      trustworthy: false,
    };
  }

  return {
    state: "connected",
    lastUpdatedAt: input.lastUpdatedAt,
    ageMillis,
    trustworthy: true,
  };
}

export type ConnectionTone = "healthy" | "warning" | "degraded" | "critical";

export interface ConnectionDescription {
  readonly label: string;
  readonly tone: ConnectionTone;
  /** Longer explanation, for surfaces with room for one. */
  readonly detail: string;
}

/**
 * Wording, deliberately plain.
 *
 * A display board is read by patients, not engineers, so it says "Data may be
 * outdated" rather than "stale" and "Connection lost" rather than "offline".
 * Every degraded state says what it means for the reader rather than what it
 * means for the system.
 */
export function describeConnection(
  snapshot: ConnectionSnapshot,
): ConnectionDescription {
  switch (snapshot.state) {
    case "connecting":
      return {
        label: "Connecting…",
        tone: "warning",
        detail: "Waiting for the first update.",
      };
    case "connected":
      return {
        label: "Live",
        tone: "healthy",
        detail: "Updating automatically.",
      };
    case "reconnecting":
      return {
        label: "Reconnecting…",
        tone: "degraded",
        detail: "Trying to restore the connection. Ask staff if unsure.",
      };
    case "stale":
      return {
        label: "Data may be outdated",
        tone: "warning",
        detail: "This screen has not updated recently.",
      };
    case "offline":
      return {
        label: "Connection lost",
        tone: "critical",
        detail: "This screen is not receiving updates. Please ask at reception.",
      };
  }
}

/** "2m 14s ago" — the phrasing a stale surface needs beside its status. */
export function formatFreshness(snapshot: ConnectionSnapshot): string {
  if (snapshot.lastUpdatedAt === null) return "No data yet";

  const seconds = Math.floor(snapshot.ageMillis / 1000);
  if (seconds < 5) return "Updated just now";
  if (seconds < 60) return `Updated ${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) {
    return `Updated ${minutes}m ${String(remainder).padStart(2, "0")}s ago`;
  }

  const hours = Math.floor(minutes / 60);
  return `Updated ${hours}h ${minutes % 60}m ago`;
}
