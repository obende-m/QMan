import { useEffect, useState, type FormEvent } from "react";
import { BellRing, CheckCircle2, Circle, Clock, MapPin, Search, Ticket, WifiOff } from "lucide-react";
import { PublicApi, poll, type PublicApiError, type TrackView } from "../../api/public-api.js";

export type TrackerCredential =
  | { readonly kind: "token"; readonly token: string }
  | { readonly kind: "code"; readonly branchId: string; readonly code: string };

export interface PublicTrackerProps {
  api: PublicApi;
  /** From the QR code (a token) or from the link printed for typing a code. */
  initial: TrackerCredential | null;
  /** The branch, when the page was opened from a branch link, for typing a code. */
  branchId: string | null;
  pollMillis?: number;
}

/**
 * The patient's own page.
 *
 * Mobile-first and calm. It answers, in order, the four questions a patient
 * has: what is my number, is it my turn, where do I go, and how long. Nothing
 * here identifies the patient — not even to themselves — because the screen
 * may be shown to someone else, and the patient knows who they are.
 */
export function PublicTracker({ api, initial, branchId, pollMillis = 10_000 }: PublicTrackerProps) {
  const [credential, setCredential] = useState<TrackerCredential | null>(initial);
  const [view, setView] = useState<TrackView | null>(null);
  const [error, setError] = useState<PublicApiError | null>(null);
  const [lastGood, setLastGood] = useState<Date | null>(null);
  const [code, setCode] = useState("");

  useEffect(() => {
    if (credential === null) return;
    setView(null);
    setError(null);
    const load = () =>
      credential.kind === "token"
        ? api.trackByToken(credential.token)
        : api.trackByCode(credential.branchId, credential.code);
    // A code lookup is rate limited (six a minute) and a token lookup is not,
    // so a typed code is followed at a pace that stays well inside the limit.
    const interval = credential.kind === "code" ? Math.max(pollMillis, 20_000) : pollMillis;
    return poll(load, interval, (result) => {
      if (result.ok) {
        setView(result.value);
        setLastGood(result.at);
        setError(null);
      } else {
        setError(result.error);
      }
    });
  }, [api, credential, pollMillis]);

  // Polling a code lookup counts against the rate limit, so a code is looked
  // up once by hand and then followed less often.
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (branchId === null || code.trim() === "") return;
    setCredential({ kind: "code", branchId, code: code.trim() });
  };

  const notFound = error !== null && (error.status === 404 || error.status === 400);
  const stale = lastGood !== null && error !== null && !notFound;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-4 px-4 py-6">
      <header className="px-1">
        <p className="font-mono text-label-caps uppercase tracking-widest text-on-surface-variant">
          {view?.hospital.name ?? "QMan"}
        </p>
        <h1 className="text-headline-lg-mobile font-semibold text-on-surface">Your visit</h1>
      </header>

      {(credential === null || (notFound && view === null)) && (
        <section className="glass rounded-2xl p-5">
          {notFound && (
            <p role="alert" className="mb-4 rounded-lg border border-warning/40 bg-warning-container/70 p-3 text-body-md text-on-warning-container">
              {credential?.kind === "token"
                ? "This tracking link is no longer active. Visits close a while after they finish."
                : "That code was not found. Check it against your ticket."}
            </p>
          )}
          {error?.status === 429 && (
            <p role="alert" className="mb-4 rounded-lg border border-warning/40 bg-warning-container/70 p-3 text-body-md text-on-warning-container">
              Too many attempts. Wait a minute and try again.
            </p>
          )}
          {branchId !== null ? (
            <form onSubmit={submit} className="space-y-3">
              <label className="block">
                <span className="field-label">Code from your ticket</span>
                <input
                  className="field font-mono text-title-md uppercase tracking-widest"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="QM-8F4K"
                  autoCapitalize="characters"
                  autoComplete="off"
                  inputMode="text"
                />
              </label>
              <button
                type="submit"
                className="flex h-12 w-full items-center justify-center gap-2 rounded-md bg-gradient-to-b from-primary-container to-primary font-semibold text-on-primary"
              >
                <Search aria-hidden="true" className="size-5" />
                Find my visit
              </button>
            </form>
          ) : (
            <p className="text-body-md text-on-surface-variant">
              Scan the QR code on your ticket to follow your visit here.
            </p>
          )}
        </section>
      )}

      {credential !== null && view === null && !notFound && error?.status !== 429 && (
        <p role="status" className="glass rounded-2xl p-5 text-body-md text-on-surface-variant">
          {error ? "Waiting for the hospital's system…" : "Loading your visit…"}
        </p>
      )}

      {view && <VisitView view={view} stale={stale} lastGood={lastGood} />}
    </main>
  );
}

function VisitView({ view, stale, lastGood }: { view: TrackView; stale: boolean; lastGood: Date | null }) {
  const current = view.current;
  const called = current?.status === "called";
  const inService = current?.status === "in_progress";
  const finished = view.status === "completed" || view.status === "cancelled" || view.status === "closed";

  return (
    <>
      {stale && (
        <p role="status" className="flex items-center gap-2 rounded-xl border border-warning/40 bg-warning-container/80 px-4 py-3 text-body-sm text-on-warning-container">
          <WifiOff aria-hidden="true" className="size-4" />
          Not updating{lastGood ? ` since ${lastGood.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}. If you hear your number, go now.
        </p>
      )}

      <section
        aria-live="polite"
        className={
          "rounded-2xl p-6 " +
          (called
            ? "bg-gradient-to-br from-primary to-primary-container text-on-primary shadow-[0_20px_40px_-16px_rgb(0_62_199/0.6)]"
            : "glass")
        }
      >
        {finished ? (
          <div className="flex items-start gap-3">
            <CheckCircle2 aria-hidden="true" className="size-7 shrink-0 text-tertiary" />
            <div>
              <p className="text-title-md font-semibold text-on-surface">
                {view.status === "cancelled" ? "This visit was cancelled" : "Your visit is complete"}
              </p>
              <p className="mt-1 text-body-md text-on-surface-variant">Thank you. You can close this page.</p>
            </div>
          </div>
        ) : current ? (
          <>
            <p className={"font-mono text-label-caps uppercase tracking-widest " + (called ? "text-on-primary/80" : "text-on-surface-variant")}>
              Your number
            </p>
            <p className="mt-1 flex items-center gap-3 font-mono text-[3.5rem] font-bold leading-none tracking-tight">
              <Ticket aria-hidden="true" className="size-8 opacity-70" />
              {current.ticket}
            </p>
            {called ? (
              <p className="mt-5 flex items-center gap-2 text-title-md font-semibold">
                <BellRing aria-hidden="true" className="size-6 motion-safe:animate-pulse-urgent" />
                It's your turn — please go to {current.room ?? current.stationName} now.
              </p>
            ) : inService ? (
              <p className="mt-5 text-title-md font-semibold text-on-surface">You are being seen at {current.stationName}.</p>
            ) : (
              <div className="mt-5 grid grid-cols-2 gap-3">
                <Fact label="Ahead of you" value={current.ahead === null ? "—" : String(current.ahead)} />
                <Fact
                  label="Estimated wait"
                  value={current.estimatedWaitMinutes === null ? "—" : `≈ ${current.estimatedWaitMinutes} min`}
                  icon={<Clock aria-hidden="true" className="size-4" />}
                />
              </div>
            )}
          </>
        ) : (
          <p className="text-title-md text-on-surface">You are checked in. Your first stop will appear here.</p>
        )}
      </section>

      {current && !finished && (
        <section className="glass flex items-center gap-3 rounded-2xl p-5">
          <MapPin aria-hidden="true" className="size-6 shrink-0 text-primary" />
          <div>
            <p className="text-body-sm text-on-surface-variant">Where to go</p>
            <p className="text-title-md font-semibold text-on-surface">
              {current.stationName}
              {current.room ? ` · ${current.room}` : ""}
            </p>
          </div>
        </section>
      )}

      {view.journey.length > 0 && (
        <section aria-label="Your journey" className="glass rounded-2xl p-5">
          <h2 className="mb-3 font-mono text-label-caps uppercase tracking-widest text-on-surface-variant">Your journey</h2>
          <ol className="space-y-3">
            {view.journey.map((step, index) => (
              <li key={`${step.name}-${index}`} className="flex items-center gap-3">
                {step.state === "done" ? (
                  <CheckCircle2 aria-hidden="true" className="size-5 text-tertiary" />
                ) : (
                  <Circle
                    aria-hidden="true"
                    className={"size-5 " + (step.state === "current" ? "fill-primary text-primary" : "text-outline")}
                  />
                )}
                <span
                  className={
                    "text-body-md " +
                    (step.state === "current" ? "font-semibold text-on-surface" : step.state === "done" ? "text-on-surface-variant line-through decoration-1" : "text-on-surface-variant")
                  }
                >
                  {step.name}
                  <span className="sr-only">
                    {step.state === "done" ? " (done)" : step.state === "current" ? " (now)" : " (later)"}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <p className="px-1 text-center text-body-sm text-on-surface-variant">
        Journey code <span className="font-mono font-semibold">{view.journeyCode}</span>
        {view.hospital.supportPhone ? ` · Help: ${view.hospital.supportPhone}` : ""}
      </p>
    </>
  );
}

function Fact({ label, value, icon }: { label: string; value: string; icon?: JSX.Element }) {
  return (
    <div className="rounded-xl border border-outline-variant/60 bg-surface-container-lowest/70 p-3">
      <p className="flex items-center gap-1.5 text-body-sm text-on-surface-variant">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-title-md font-semibold text-on-surface">{value}</p>
    </div>
  );
}
