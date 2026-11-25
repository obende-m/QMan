import { useEffect, useRef, useState } from "react";
import { Clock, MapPin, WifiOff } from "lucide-react";
import { PublicApi, poll, type BoardStationView, type BoardView, type PublicApiError } from "../../api/public-api.js";

/** Seconds of silence after which the board stops claiming to be current. */
const STALE_AFTER_MILLIS = 30_000;

export interface PublicBoardProps {
  api: PublicApi;
  boardId: string;
  /** Called with a ticket each time a new one is called, for the announcer. */
  onCalled?: (ticket: string, station: string, room: string | null) => void;
  pollMillis?: number;
}

/**
 * The waiting-room display.
 *
 * Built for a screen read from across a room by people who are anxious and
 * waiting: very large ticket numbers, the station and room spelled out, the
 * patient currently being called set apart, and nothing that moves unless it
 * means something. It never shows a Journey Code and shows a name only when the
 * hospital's board policy explicitly allows one.
 *
 * When the server stops answering it says so, keeps showing the last known
 * queue, and dims it — a waiting room that sees a frozen board as current acts
 * on it.
 */
export function PublicBoard({ api, boardId, onCalled, pollMillis = 4_000 }: PublicBoardProps) {
  const [view, setView] = useState<BoardView | null>(null);
  const [lastGood, setLastGood] = useState<Date | null>(null);
  const [error, setError] = useState<PublicApiError | null>(null);
  const [now, setNow] = useState(() => new Date());
  const announced = useRef(new Map<string, string>());

  useEffect(
    () =>
      poll(() => api.board(boardId), pollMillis, (result) => {
        if (result.ok) {
          setView(result.value);
          setLastGood(result.at);
          setError(null);
        } else {
          setError(result.error);
        }
      }),
    [api, boardId, pollMillis],
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 5_000);
    return () => clearInterval(timer);
  }, []);

  // Announce each newly called ticket once, and again on a recall.
  useEffect(() => {
    if (!view || !onCalled) return;
    for (const station of view.stations) {
      const serving = station.serving;
      if (!serving || serving.status !== "called") continue;
      const marker = `${serving.ticket}:${serving.callAttempts}`;
      if (announced.current.get(station.id) !== marker) {
        const first = !announced.current.has(station.id);
        announced.current.set(station.id, marker);
        // Not on first sight: a board switched on mid-morning must not
        // announce everyone currently being called.
        if (first) continue;
        onCalled(serving.ticket, station.name, station.room);
      }
    }
  }, [view, onCalled]);

  if (view === null) {
    return (
      <main className="grid min-h-screen place-items-center p-10 text-center">
        <div className="glass rounded-2xl px-10 py-8">
          {error && error.status === 404 ? (
            <>
              <p className="text-headline-lg text-on-surface">This screen is not configured.</p>
              <p className="mt-2 text-body-md text-on-surface-variant">
                No display board matches this link. Check the board address in the Administration portal.
              </p>
            </>
          ) : (
            <p role="status" className="text-headline-lg text-on-surface-variant">
              {error ? "Waiting for the server…" : "Connecting…"}
            </p>
          )}
        </div>
      </main>
    );
  }

  const stale = lastGood === null || now.getTime() - lastGood.getTime() > STALE_AFTER_MILLIS;

  return (
    <main className="flex min-h-screen flex-col gap-6 p-6 lg:p-10">
      <header className="glass flex flex-wrap items-center gap-4 rounded-2xl px-8 py-5">
        <div className="min-w-0">
          <p className="font-mono text-label-caps uppercase tracking-widest text-on-surface-variant">
            {view.hospital.name}
          </p>
          <h1 className="truncate text-[clamp(1.75rem,3vw,2.75rem)] font-bold tracking-tight text-on-surface">
            {view.board.name}
          </h1>
        </div>
        <div className="ml-auto flex items-center gap-4">
          {stale && (
            <span
              role="status"
              className="flex items-center gap-2 rounded-full border border-warning/40 bg-warning-container px-4 py-2 text-body-md font-semibold text-on-warning-container"
            >
              <WifiOff aria-hidden="true" className="size-5" />
              Not updating
              {lastGood ? ` · last update ${lastGood.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
            </span>
          )}
          <time className="font-mono text-[clamp(1.5rem,2.5vw,2.25rem)] font-semibold tabular-nums text-on-surface">
            {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
        </div>
      </header>

      {view.stations.length === 0 ? (
        <div className="glass grid flex-1 place-items-center rounded-2xl p-10 text-headline-lg text-on-surface-variant">
          No stations are assigned to this board.
        </div>
      ) : (
        <div
          className={
            "grid flex-1 gap-6 transition-opacity " +
            (stale ? "opacity-60 " : "") +
            (view.stations.length === 1
              ? "grid-cols-1"
              : view.stations.length === 2
                ? "lg:grid-cols-2"
                : "md:grid-cols-2 2xl:grid-cols-3")
          }
        >
          {view.stations.map((station) => (
            <StationPanel key={station.id} station={station} showWait={view.board.showEstimatedWait} />
          ))}
        </div>
      )}
    </main>
  );
}

function StationPanel({ station, showWait }: { station: BoardStationView; showWait: boolean }) {
  const serving = station.serving;
  const called = serving?.status === "called";
  return (
    <section aria-label={station.name} className="glass flex flex-col overflow-hidden rounded-2xl">
      <header className="flex items-center gap-3 border-b border-outline-variant/50 px-6 py-4">
        <h2 className="text-[clamp(1.25rem,2vw,1.75rem)] font-semibold text-on-surface">{station.name}</h2>
        {station.room && (
          <span className="ml-auto flex items-center gap-1.5 text-body-md font-semibold text-on-surface-variant">
            <MapPin aria-hidden="true" className="size-5" />
            {station.room}
          </span>
        )}
      </header>

      <div
        className={
          "px-6 py-6 " +
          (called
            ? "bg-gradient-to-br from-primary/15 to-primary/5"
            : "")
        }
      >
        <p className="font-mono text-label-caps uppercase tracking-widest text-on-surface-variant">
          {!station.enabled ? "Closed" : serving ? (called ? "Now calling" : "Now serving") : "Now serving"}
        </p>
        {serving ? (
          <p
            className={
              "mt-1 font-mono text-[clamp(3.5rem,8vw,6.5rem)] font-bold leading-none tracking-tight " +
              (called ? "text-primary" : "text-on-surface")
            }
          >
            {serving.ticket}
          </p>
        ) : (
          <p className="mt-2 text-[clamp(1.5rem,2.5vw,2rem)] text-on-surface-variant">
            {station.enabled ? "Please wait to be called" : "Not taking patients"}
          </p>
        )}
        {serving?.name && <p className="mt-2 text-title-md text-on-surface">{serving.name}</p>}
        {called && station.room && (
          <p className="mt-3 text-title-md font-semibold text-primary">Please go to {station.room}</p>
        )}
      </div>

      <div className="flex-1 border-t border-outline-variant/50 px-6 py-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="font-mono text-label-caps uppercase tracking-widest text-on-surface-variant">Next</h3>
          {showWait && station.estimatedWaitMinutes !== null && station.enabled && (
            <span className="flex items-center gap-1.5 text-body-md text-on-surface-variant">
              <Clock aria-hidden="true" className="size-4" />
              New arrivals ≈ {station.estimatedWaitMinutes} min
            </span>
          )}
        </div>
        {station.waiting.length === 0 ? (
          <p className="text-title-md text-on-surface-variant">Nobody waiting</p>
        ) : (
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {station.waiting.map((item) => (
              <li
                key={item.ticket}
                className="rounded-xl border border-outline-variant/60 bg-surface-container-lowest/70 px-3 py-2 text-center"
              >
                <span className="sr-only">Position {item.position}: </span>
                <span className="font-mono text-[clamp(1.25rem,2vw,1.75rem)] font-semibold text-on-surface">{item.ticket}</span>
                {item.name && <span className="block truncate text-body-sm text-on-surface-variant">{item.name}</span>}
              </li>
            ))}
          </ol>
        )}
        {station.waitingCount > station.waiting.length && (
          <p className="mt-3 text-body-md text-on-surface-variant">
            and {station.waitingCount - station.waiting.length} more waiting
          </p>
        )}
      </div>
    </section>
  );
}
