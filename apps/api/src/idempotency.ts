/**
 * Making a retried request safe to repeat.
 *
 * The problem is specific and it is not hypothetical. A receptionist presses
 * Call; the request lands, the patient is called, and the response is lost on
 * the way back. The browser retries. To the aggregate a second call is a
 * *recall* — the attempt counter advances, the announcement plays again, and
 * the audit trail records something nobody did. Reception desks on wireless,
 * laptops that suspend mid-request and hospital networks generally make this an
 * ordinary Tuesday rather than an edge case.
 *
 * A client attaches `Idempotency-Key` to a state-changing request. The first
 * request carrying that key does the work and its response is stored; later
 * requests carrying the same key are answered from the store.
 *
 * The key is claimed with an insert that either wins or reports a winner, never
 * a read followed by a write — the window between those two is exactly the race
 * this exists to close.
 */
import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { tenantOf } from "./authorization.js";
import type { IdempotencyRepository } from "@qman/persistence";
import type { Logger } from "./logging.js";

export const IDEMPOTENCY_HEADER = "idempotency-key";

/** Long enough for a retry, short enough that the table does not become history. */
export const KEY_LIFETIME_MILLIS = 24 * 60 * 60_000;

export interface IdempotencyDependencies {
  readonly repository: IdempotencyRepository;
  readonly logger: Logger;
  readonly now: () => Date;
}

/**
 * Identifies the request a key was used for.
 *
 * Hashed rather than stored, because the body contains patient details and this
 * row outlives the request by a day. A digest answers the only question asked
 * of it — is this the same request — without keeping the data to answer it.
 */
export function fingerprint(method: string, url: string, body: unknown): string {
  const canonical = `${method} ${url} ${body === undefined ? "" : JSON.stringify(body)}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function readKey(request: FastifyRequest): string | null {
  const header = request.headers[IDEMPOTENCY_HEADER];
  const value = typeof header === "string" ? header.trim() : "";
  if (value === "" || value.length > 200) return null;
  return value;
}

export type Guarded =
  | { readonly proceed: true; readonly key: string | null }
  | { readonly proceed: false };

/**
 * Resolves what to do with a request that may be a retry.
 *
 * A request with no key proceeds unguarded. That is deliberate: making the
 * header mandatory would break every caller that does not know about it yet,
 * and reads have nothing to protect. The clients that matter — the ones firing
 * state changes from a reception desk — send one.
 */
export interface GuardOptions {
  /**
   * Answers a replay instead of sending the stored response verbatim.
   *
   * For a route whose real response cannot be stored. Admission is the case:
   * its response carries a tracking token, and storing that would put a
   * working credential in a table kept for a day. It stores only the visit id
   * and rebuilds the answer here.
   */
  readonly onReplay?: (statusCode: number, stored: unknown) => Promise<void>;
}

export async function guard(
  deps: IdempotencyDependencies,
  request: FastifyRequest,
  reply: FastifyReply,
  options: GuardOptions = {},
): Promise<Guarded> {
  const key = readKey(request);
  if (key === null) return { proceed: true, key: null };

  const hospitalId = tenantOf(request);
  const print = fingerprint(request.method, request.url, request.body);
  const claim = await deps.repository.claim(hospitalId, key, print, deps.now());

  switch (claim.outcome) {
    case "claimed":
      return { proceed: true, key };

    case "replay":
      deps.logger.info("idempotent replay", {
        requestId: request.requestId,
        hospitalId,
        path: request.url,
      });
      // The header lets a client tell that nothing new happened, which matters
      // when the two answers would otherwise be indistinguishable.
      void reply.header("Idempotent-Replay", "true");
      if (options.onReplay) {
        await options.onReplay(claim.statusCode, claim.response);
        return { proceed: false };
      }
      // The original response, verbatim.
      void reply.status(claim.statusCode).send(claim.response);
      return { proceed: false };

    case "in_flight":
      // 409 rather than waiting. The first request is still working; a client
      // that retries in a moment gets the stored answer, and holding this
      // connection open would tie up a connection on both ends to no purpose.
      deps.logger.warn("idempotent request still in flight", {
        requestId: request.requestId,
        hospitalId,
        path: request.url,
      });
      void reply.status(409).send({
        error: "That request is still being processed. Try again in a moment.",
      });
      return { proceed: false };

    case "mismatch":
      deps.logger.error("idempotency key reused for a different request", {
        requestId: request.requestId,
        hospitalId,
        path: request.url,
      });
      void reply.status(422).send({
        error: "That idempotency key was already used for a different request.",
      });
      return { proceed: false };
  }
}

/**
 * Records what a guarded request answered, so a retry can be given the same.
 *
 * Only successful outcomes are stored. A failure is released instead, because a
 * retry of something that failed should be allowed to actually run — storing a
 * 500 would make the failure permanent for the lifetime of the key, which is
 * the opposite of what a retry is for.
 *
 * A 409 from the aggregate is also released. It means the visit had moved on,
 * and by the time a client retries it may legitimately have moved again.
 */
export async function record(
  deps: IdempotencyDependencies,
  request: FastifyRequest,
  key: string | null,
  statusCode: number,
  payload: unknown,
): Promise<void> {
  if (key === null) return;

  const hospitalId = tenantOf(request);
  if (statusCode >= 500 || statusCode === 409) {
    await deps.repository.release(hospitalId, key);
    return;
  }

  await deps.repository.complete(hospitalId, key, statusCode, payload, deps.now());
}
