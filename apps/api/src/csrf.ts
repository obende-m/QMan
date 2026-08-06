/**
 * Cross-site request forgery.
 *
 * A session cookie is attached by the browser to any request reaching this
 * origin, including one started by a page the hospital does not control. The
 * cookie is `SameSite=Lax`, which already withholds it from cross-site POSTs
 * and is the single most effective control here — but it is one control,
 * enforced by the browser, and browsers on the machines a hospital actually
 * owns are not always current. So there are two more, and a request must pass
 * both.
 *
 * **Origin.** Unsafe requests must come from an origin the deployment knows.
 * Browsers set `Origin` on exactly these requests and scripts cannot forge it.
 *
 * **A token the attacker cannot read.** Issued in a cookie that is deliberately
 * *not* HttpOnly, so the application's own JavaScript can read it and echo it
 * in a header. A cross-site page can cause the cookie to be sent but cannot
 * read its value, so it cannot produce the matching header. This is the
 * double-submit pattern, and it holds precisely because reading another
 * origin's cookie is what the same-origin policy forbids.
 *
 * Safe methods are exempt. GET and HEAD must not change anything, so a forged
 * one has nothing to forge.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { SESSION_COOKIE } from "./authorization.js";
import { PLATFORM_SESSION_COOKIE } from "./platform-authorization.js";

export const CSRF_COOKIE = "qman_csrf";
export const CSRF_HEADER = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function issueCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export type CsrfVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "origin" | "missing_token" | "token_mismatch" };

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/**
 * Checks the origin of an unsafe request.
 *
 * `Origin` is preferred; `Referer` is the fallback for the few clients that
 * omit it. A request with neither is refused rather than allowed: on a modern
 * browser an unsafe request always carries one, so its absence means the caller
 * is not the browser this endpoint is for.
 */
export function checkOrigin(
  request: FastifyRequest,
  allowed: readonly string[],
): boolean {
  const origin = request.headers.origin;
  if (typeof origin === "string" && origin !== "") {
    return allowed.includes(origin);
  }

  const referer = request.headers.referer;
  if (typeof referer === "string" && referer !== "") {
    try {
      return allowed.includes(new URL(referer).origin);
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * The token is required once a session exists, and not before.
 *
 * Sign-in cannot present a token, because the token is issued with the session
 * it protects and a browser arriving at a login form has neither. Requiring one
 * there would not be strict — it would make signing in impossible.
 *
 * That leaves login guarded by the origin check alone, which is the right
 * weight for it. Login CSRF forces a victim's browser to sign in as the
 * attacker; it cannot read the victim's data or act as them, and the origin
 * check already refuses it. Every request that can act on a hospital's data
 * carries a session, and therefore carries a token.
 */
export function verifyCsrf(
  request: FastifyRequest,
  allowedOrigins: readonly string[],
): CsrfVerdict {
  if (SAFE_METHODS.has(request.method)) return { ok: true };

  if (!checkOrigin(request, allowedOrigins)) {
    return { ok: false, reason: "origin" };
  }

  /*
   * Only a cookie-authenticated request needs the double-submit check. A
   * request carrying no session is not acting as anybody, so there is nothing
   * for a forged one to abuse.
   *
   * Both session cookies count. The platform portal authenticates with
   * `qman_platform_session`, and checking only the organization cookie here
   * would have left every platform state-changing route — create an
   * organization, suspend one, reset an administrator — protected by the Origin
   * header alone.
   */
  const authenticated =
    readCookie(request, SESSION_COOKIE) !== null ||
    readCookie(request, PLATFORM_SESSION_COOKIE) !== null;
  if (!authenticated) return { ok: true };

  const cookie = readCookie(request, CSRF_COOKIE);
  const header = request.headers[CSRF_HEADER];
  const presented = typeof header === "string" ? header : null;

  if (cookie === null || presented === null || cookie === "" || presented === "") {
    return { ok: false, reason: "missing_token" };
  }

  return equal(cookie, presented) ? { ok: true } : { ok: false, reason: "token_mismatch" };
}
