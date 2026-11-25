/**
 * The two public surfaces' view of the API.
 *
 * Unauthenticated, read-only, and complete: a board or a tracker renders what
 * these return and nothing else. Neither may call a staff endpoint — they run
 * on a wall-mounted kiosk and a patient's phone, where no session exists, and
 * a staff request there is a 401 that used to leave both screens blank.
 *
 * Polling, deliberately. The public event stream is not built, and a board
 * that re-reads every few seconds is correct by construction: a missed event
 * cannot leave it wrong for longer than one interval.
 */
export interface BoardStationView {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly room: string | null;
  readonly serving: {
    readonly ticket: string;
    readonly status: string;
    readonly calledAt: string | null;
    readonly callAttempts: number;
    readonly name: string | null;
  } | null;
  readonly waiting: ReadonlyArray<{ readonly ticket: string; readonly position: number; readonly name: string | null }>;
  readonly waitingCount: number;
  readonly estimatedWaitMinutes: number | null;
}

export interface BoardView {
  readonly board: { readonly id: string; readonly name: string; readonly showRoom: boolean; readonly showEstimatedWait: boolean };
  readonly hospital: { readonly name: string; readonly brandColor: string };
  readonly stations: readonly BoardStationView[];
  readonly at: string;
}

export interface TrackView {
  readonly status: string;
  readonly journeyCode: string;
  readonly hospital: { readonly name: string; readonly supportPhone: string | null };
  readonly current: {
    readonly ticket: string;
    readonly status: string;
    readonly stationName: string;
    readonly room: string | null;
    readonly queuedAt: string;
    readonly calledAt: string | null;
    readonly position: number | null;
    readonly ahead: number | null;
    readonly estimatedWaitMinutes: number | null;
  } | null;
  readonly journey: ReadonlyArray<{ readonly name: string; readonly state: "done" | "current" | "upcoming" }>;
  readonly at: string;
}

export class PublicApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function read<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      // No credentials: these surfaces never act as anyone.
      credentials: "omit",
      cache: "no-store",
      headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
    });
  } catch {
    throw new PublicApiError(0, "Cannot reach the server.");
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new PublicApiError(response.status, typeof body?.["error"] === "string" ? body["error"] : "That request failed.");
  }
  return body as T;
}

export class PublicApi {
  constructor(private readonly baseUrl: string) {}

  board(boardId: string): Promise<BoardView> {
    return read<BoardView>(this.baseUrl, `/api/v1/public/boards/${encodeURIComponent(boardId)}`);
  }

  async trackByToken(token: string): Promise<TrackView> {
    const response = await read<{ track?: TrackView }>(
      this.baseUrl,
      `/api/v1/public/track/token/${encodeURIComponent(token)}`,
    );
    if (!response.track) throw new PublicApiError(503, "Tracking is not available.");
    return response.track;
  }

  async trackByCode(branchId: string, code: string): Promise<TrackView> {
    const response = await read<{ track?: TrackView }>(this.baseUrl, "/api/v1/public/track/code", {
      method: "POST",
      body: JSON.stringify({ branchId, code }),
    });
    if (!response.track) throw new PublicApiError(503, "Tracking is not available.");
    return response.track;
  }
}

/**
 * Polls a read, reporting each result and how fresh the last good one is.
 *
 * Backs off after failures so a server outage is not met by every board in
 * the hospital hammering it, and returns to the normal interval on the first
 * success. Stops when the returned function is called.
 */
export function poll<T>(
  load: () => Promise<T>,
  intervalMillis: number,
  onResult: (result: { ok: true; value: T; at: Date } | { ok: false; error: PublicApiError; failures: number }) => void,
): () => void {
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    try {
      const value = await load();
      if (stopped) return;
      failures = 0;
      onResult({ ok: true, value, at: new Date() });
    } catch (error) {
      if (stopped) return;
      failures += 1;
      onResult({
        ok: false,
        error: error instanceof PublicApiError ? error : new PublicApiError(0, "Cannot reach the server."),
        failures,
      });
    }
    if (stopped) return;
    const delay = failures === 0 ? intervalMillis : Math.min(intervalMillis * 2 ** failures, 60_000);
    timer = setTimeout(() => void tick(), delay);
  };

  void tick();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
