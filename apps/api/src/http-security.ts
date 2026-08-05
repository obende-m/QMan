/**
 * Response headers, and cross-origin access.
 *
 * The API answers JSON and nothing else — it serves no markup, loads no
 * scripts, and is never framed. That makes its headers unusually easy to get
 * right: almost everything can be denied outright rather than narrowed.
 *
 * `Cache-Control: no-store` is the one that earns its place here rather than in
 * a checklist. Responses carry patient names, hospital numbers and phone
 * numbers, and the machines running QMan are shared: a reception desk PC used
 * by three people a day, a browser that caches to disk, a proxy on the
 * hospital's network that caches on their behalf. Without it, a patient list
 * fetched at 9am can be served from a cache to whoever sits down at 2pm.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

export interface SecurityHeaderOptions {
  /** Adds HSTS. Only meaningful over HTTPS, and harmful to promise without it. */
  readonly https: boolean;
}

export function securityHeaders(options: SecurityHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    // Nothing here is a document, so every fetch directive can be denied.
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    // A JSON body must never be interpreted as HTML or script.
    "X-Content-Type-Options": "nosniff",
    // frame-ancestors covers this on current browsers; kept for older ones.
    "X-Frame-Options": "DENY",
    // A URL here can contain a journey code. It has no business travelling to
    // another site in a Referer header.
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-site",
    // Patient data on shared machines behind shared proxies.
    "Cache-Control": "no-store",
  };

  if (options.https) {
    // Two years, subdomains included. Sent only when the deployment is already
    // on HTTPS: promising it otherwise locks users out of a working server.
    headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains";
  }

  return headers;
}

const ALLOWED_HEADERS = ["content-type", "x-csrf-token", "x-request-id"].join(", ");
const ALLOWED_METHODS = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"].join(", ");

/**
 * Applies CORS for a credentialed API.
 *
 * The origin is echoed from an allow-list, never answered with `*`. A wildcard
 * is not merely discouraged with credentials — browsers refuse the combination
 * — and the failure would be a sign-in that works everywhere except through a
 * browser.
 *
 * `Vary: Origin` is set whether or not the origin matched. Without it a cache
 * can serve one origin's allow header to another, which turns a correct
 * allow-list into an incorrect one at the caching layer.
 */
export function applyCors(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigins: readonly string[],
): void {
  void reply.header("Vary", "Origin");

  const origin = request.headers.origin;
  if (typeof origin !== "string" || !allowedOrigins.includes(origin)) return;

  void reply.header("Access-Control-Allow-Origin", origin);
  void reply.header("Access-Control-Allow-Credentials", "true");
}

/** Answers a preflight. Returns true when the request needs nothing further. */
export function handlePreflight(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigins: readonly string[],
): boolean {
  if (request.method !== "OPTIONS") return false;

  applyCors(request, reply, allowedOrigins);
  void reply
    .header("Access-Control-Allow-Methods", ALLOWED_METHODS)
    .header("Access-Control-Allow-Headers", ALLOWED_HEADERS)
    .header("Access-Control-Max-Age", "600")
    .status(204)
    .send();
  return true;
}
