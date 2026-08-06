import type { BranchId, UserId } from "../shared/ids.js";

/**
 * Sessions.
 *
 * Session management is in Version 1 for a specific operational reason: a
 * reception workstation left signed in overnight is a real and common risk, and
 * the only remedy without remote termination is walking to the machine. An
 * administrator needs to be able to end it from wherever they are.
 */

export type SessionEndReason =
  | "signed_out"
  | "expired"
  | "terminated_by_admin"
  | "password_changed";

export interface Session {
  readonly id: string;
  readonly userId: UserId;
  readonly branchId: BranchId | null;
  readonly providerId: string;
  readonly startedAt: Date;
  /** Advanced on activity; drives idle timeout. */
  lastActiveAt: Date;
  /** Populated when the session ends. */
  endedAt: Date | null;
  endReason: SessionEndReason | null;
  /** Human-readable device description, for the administration list. */
  readonly device: string;
  /** Coarse client hint. Never a full user-agent string in the UI. */
  readonly userAgent: string;
}

export interface SessionPolicy {
  /** Signed out after this long with no activity. */
  readonly idleTimeoutMillis: number;
  /**
   * Hard cap regardless of activity. A shared workstation that is never idle
   * because someone is always at it still gets signed out eventually.
   */
  readonly absoluteTimeoutMillis: number;
}

/**
 * Twelve hours idle, twenty-four absolute.
 *
 * Deliberately generous. A clinical shift runs eight to twelve hours, and a
 * doctor signed out mid-consultation because they spent forty minutes with a
 * patient is a system staff will work around — by disabling the timeout, or by
 * sharing a login that never locks. A timeout short enough to be a nuisance
 * produces worse security than one long enough to be tolerated.
 */
export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  idleTimeoutMillis: 12 * 60 * 60_000,
  absoluteTimeoutMillis: 24 * 60 * 60_000,
};

export type SessionStatus = "active" | "idle" | "expired" | "ended";

/**
 * The three timestamps a lifetime decision needs.
 *
 * Stated as its own type so that platform sessions — which have no branch, no
 * provider and no device — are judged by this same policy rather than by a
 * second copy of it that drifts. `Session` satisfies it structurally; nothing
 * else about either session shape is relevant to whether it has expired.
 */
export interface SessionLifetime {
  readonly startedAt: Date;
  readonly lastActiveAt: Date;
  readonly endedAt: Date | null;
}

export function sessionStatus(
  session: SessionLifetime,
  now: Date,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
): SessionStatus {
  if (session.endedAt !== null) return "ended";

  const idleFor = now.getTime() - session.lastActiveAt.getTime();
  const age = now.getTime() - session.startedAt.getTime();

  if (
    idleFor >= policy.idleTimeoutMillis ||
    age >= policy.absoluteTimeoutMillis
  ) {
    return "expired";
  }

  // "Idle" is advisory, shown to administrators looking for the workstation
  // nobody is at. It does not end the session.
  return idleFor >= 30 * 60_000 ? "idle" : "active";
}

export function isUsable(
  session: SessionLifetime,
  now: Date,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
): boolean {
  const status = sessionStatus(session, now, policy);
  return status === "active" || status === "idle";
}

export function touch(session: Session, now: Date): void {
  if (session.endedAt !== null) return;
  session.lastActiveAt = now;
}

export function endSession(
  session: Session,
  reason: SessionEndReason,
  now: Date,
): void {
  if (session.endedAt !== null) return;
  session.endedAt = now;
  session.endReason = reason;
}

export function idleForMillis(session: Session, now: Date): number {
  return Math.max(0, now.getTime() - session.lastActiveAt.getTime());
}

/**
 * Describes a browser in words an administrator can act on.
 *
 * A full user-agent string is unreadable and tells an administrator nothing
 * useful about which physical machine to walk to. "Chrome on Windows" plus the
 * sign-in time is what identifies the reception desk PC.
 */
export function describeDevice(userAgent: string): string {
  const ua = userAgent.toLowerCase();

  const browser = ua.includes("edg/")
    ? "Edge"
    : ua.includes("chrome/") && !ua.includes("chromium")
      ? "Chrome"
      : ua.includes("firefox/")
        ? "Firefox"
        : ua.includes("safari/") && !ua.includes("chrome/")
          ? "Safari"
          : "Browser";

  const platform = ua.includes("windows")
    ? "Windows"
    : ua.includes("android")
      ? "Android"
      : ua.includes("iphone") || ua.includes("ipad")
        ? "iOS"
        : ua.includes("mac os")
          ? "macOS"
          : ua.includes("linux")
            ? "Linux"
            : "Unknown device";

  return `${browser} on ${platform}`;
}
