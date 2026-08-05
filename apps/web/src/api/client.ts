/**
 * The HTTP client.
 *
 * One place that knows how to reach the API, so the rules that make a request
 * safe are applied by construction rather than remembered at each call site.
 *
 * Three of those rules matter enough to state.
 *
 * **Credentials travel as cookies, and the CSRF token is echoed from the cookie
 * the server set.** The session cookie is HttpOnly and unreadable here, which is
 * the point; the CSRF cookie is deliberately readable so this can copy it into
 * a header. A cross-site page can cause the cookie to be sent but cannot read
 * it, so it cannot produce the header.
 *
 * **State-changing requests carry an idempotency key.** A reception desk on
 * wireless loses responses, and a retry that the server cannot recognise turns
 * a call into a recall — the patient is announced twice and the audit trail
 * records something nobody did. The key is generated per logical action, not
 * per attempt, so a retry carries the same one.
 *
 * **A failed request produces a typed error, never a thrown string.** The
 * difference between "your session ended", "you may not do that" and "someone
 * else acted first" changes what a receptionist should do next, and collapsing
 * them into one message would make the screen unhelpful in exactly the moments
 * it matters.
 */

export type ApiFailure =
  | "offline"
  | "unauthenticated"
  | "forbidden"
  | "conflict"
  | "not_found"
  | "rate_limited"
  | "server";

export class ApiError extends Error {
  constructor(
    readonly failure: ApiFailure,
    message: string,
    readonly status: number,
    /** Present when the server named one, so a UI can say which. */
    readonly permission?: string,
    /** Correlates a report with the server's log. */
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Whether trying the same request again could plausibly succeed. */
  get retryable(): boolean {
    return this.failure === "offline" || this.failure === "server";
  }
}

const CSRF_COOKIE = "qman_csrf";
const SAFE_METHODS = new Set(["GET", "HEAD"]);

function readCsrfToken(source: string): string | null {
  for (const part of source.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === CSRF_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function failureFor(status: number): ApiFailure {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  return "server";
}

export interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  /**
   * Reused across retries of one logical action, so the server can recognise
   * the second attempt as the same intent rather than a new one.
   */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export interface ApiClientOptions {
  /** Where the API lives. Empty for a same-origin deployment. */
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Injected so tests need no document. */
  readonly readCookies?: () => string;
  readonly newKey?: () => string;
}

/**
 * Generates an idempotency key.
 *
 * `crypto.randomUUID` where it exists. The fallback is not a security boundary:
 * the key only has to be unique among one client's in-flight actions, and a
 * collision would at worst replay that client's own response to itself.
 */
function defaultKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export class ApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #readCookies: () => string;
  readonly #newKey: () => string;

  constructor(options: ApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#readCookies =
      options.readCookies ??
      (() => (typeof document === "undefined" ? "" : document.cookie));
    this.#newKey = options.newKey ?? defaultKey;
  }

  /** A key to reuse across retries of one action. */
  newIdempotencyKey(): string {
    return this.#newKey();
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = (options.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = { Accept: "application/json" };

    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    if (!SAFE_METHODS.has(method)) {
      const csrf = readCsrfToken(this.#readCookies());
      // Sent when present. Absent before the first sign-in, which is the one
      // unsafe request the server does not require a token for.
      if (csrf !== null) headers["X-CSRF-Token"] = csrf;
      headers["Idempotency-Key"] = options.idempotencyKey ?? this.#newKey();
    }

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        // Without this the session cookie is not sent cross-origin, and every
        // request is anonymous while appearing correct in every other respect.
        credentials: "include",
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch {
      // A network failure is not a server error. The distinction is what lets
      // a surface say "you are offline" rather than "something went wrong",
      // and keep showing what it already has.
      throw new ApiError("offline", "Cannot reach the server.", 0);
    }

    if (response.status === 204) return undefined as T;

    const payload = await this.#readBody(response);

    if (!response.ok) {
      const body = payload as Record<string, unknown> | null;
      throw new ApiError(
        failureFor(response.status),
        typeof body?.["error"] === "string" ? body["error"] : "That request failed.",
        response.status,
        typeof body?.["permission"] === "string" ? body["permission"] : undefined,
        typeof body?.["requestId"] === "string" ? body["requestId"] : undefined,
      );
    }

    return payload as T;
  }

  get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, signal ? { signal } : {});
  }

  post<T>(path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      ...(body === undefined ? {} : { body }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
  }

  /**
   * A body that is not JSON is a proxy error page or a gateway timeout, not an
   * API response. Parsing it as JSON would throw something unrecognisable.
   */
  async #readBody(response: Response): Promise<unknown> {
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) {
      if (response.ok) return null;
      throw new ApiError(
        failureFor(response.status),
        "The server returned an unexpected response.",
        response.status,
      );
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new ApiError("server", "The server returned an unreadable response.", response.status);
    }
  }
}
