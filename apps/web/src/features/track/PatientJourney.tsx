import { useMemo, useState } from "react";
import {
  ArrowRight,
  CircleCheck,
  DoorOpen,
  Hourglass,
  Search,
  TriangleAlert,
  Users,
} from "lucide-react";
import { formatFreshness } from "@qman/domain";
import { JourneyCode } from "../../components/ui/JourneyCode.js";
import {
  ConnectionStatus,
  useConnectionMonitor,
} from "../../components/ui/ConnectionStatus.js";
import { JourneyTimeline } from "../../components/ui/JourneyTimeline.js";
import { Button } from "../../components/ui/Button.js";
import { cn } from "../../components/ui/cn.js";
import type { ClinicStore } from "../../data/clinic-store.js";
import { stationName, stationRoom } from "../../data/clinic-projections.js";
import { useConfig } from "../../data/useConfig.js";
import { journeySteps } from "../../data/journey-steps.js";
import { formatDuration, useClinic, useNow } from "../../data/useClinic.js";
import type { EventBus } from "../../data/event-bus.js";
import type { Notifier } from "../../runtime/notifier.js";
import { PatientAlerts } from "./PatientAlerts.js";

/**
 * Patient Journey Tracking.
 *
 * The patient-facing half of the product, and the one that decides whether
 * QMan feels like infrastructure or like a service. Every design choice here
 * answers the same question a patient is actually asking, which is not "what
 * is my queue number" but "how much longer, and should I stay in my seat".
 *
 * So the screen leads with position and remaining wait rather than with the
 * ticket, states the room so they know where to walk, and shows what happens
 * after this stage so the journey has a visible end. It is read on a phone
 * held one-handed in a waiting room, so the layout is single-column and the
 * numbers are large.
 *
 * No login. The Journey Code is the credential, entered or arrived at by QR.
 */
export interface PatientJourneyProps {
  store?: ClinicStore;
  /** Pre-fills the lookup, as a QR scan would. */
  initialCode?: string;
  /** Supplied by the tracker app; omitted in tests that do not need alerts. */
  alerts?: { notifier: Notifier; bus: EventBus };
}

export function PatientJourney({
  store: injected,
  initialCode,
  alerts,
}: PatientJourneyProps) {
  const clinic = useClinic(injected);
  const config = useConfig();
  const workflow = config.defaultWorkflow();
  const now = useNow(1000);
  const version = clinic.getVersion();
  const connection = useConnectionMonitor({ signal: clinic.heartbeat });

  const [input, setInput] = useState(initialCode ?? "");
  const [submitted, setSubmitted] = useState(initialCode ?? "");

  const found = useMemo(
    () => (submitted ? clinic.findByJourneyCode(submitted) : undefined),
    [clinic, submitted, version],
  );

  if (!found) {
    return (
      <Lookup
        value={input}
        onChange={setInput}
        onSubmit={() => setSubmitted(input)}
        notFound={submitted.length > 0}
      />
    );
  }

  const visit = found;
  const entry = visit.currentEntry;
  const stationId = visit.currentStationId;
  const position = clinic.positionOf(visit.id);
  const ahead = clinic.aheadOf(visit.id);
  const estimate = clinic.estimatedWaitMillis(visit.id);
  const beingServed = entry?.status === "called" || entry?.status === "in_progress";
  const finished = visit.status === "completed" || visit.status === "closed";

  return (
    <main className="mx-auto min-h-screen w-full max-w-lg bg-background px-5 py-8">
      {/* The code is the patient's identity for the whole visit and the thing
          staff will ask them to read out, so it stays prominent even though it
          is not the most actionable number on the screen. */}
      <header className="text-center">
        <p className="font-mono text-label-caps uppercase tracking-widest text-on-surface-variant">
          Journey code
        </p>
        <JourneyCode code={visit.journeyCode} size="hero" className="mt-1 block" />
        <p className="mt-2 text-body-md text-on-surface-variant">
          {visit.patient.name}
        </p>
      </header>

      <section
        aria-label="Current status"
        className={cn(
          "mt-6 rounded-xl border p-5 text-center",
          finished
            ? "border-tertiary/40 bg-tertiary/10"
            : beingServed
              ? "border-primary/40 bg-primary/10"
              : "border-warning/40 bg-warning-container/40",
        )}
      >
        {finished ? (
          <>
            <CircleCheck aria-hidden="true" className="mx-auto size-8 text-tertiary" />
            <p className="mt-2 text-title-md font-semibold text-on-surface">
              Your visit is complete
            </p>
            <p className="mt-1 text-body-sm text-on-surface-variant">
              Thank you. You may now leave.
            </p>
          </>
        ) : beingServed ? (
          <>
            <ArrowRight aria-hidden="true" className="mx-auto size-8 text-primary" />
            <p className="mt-2 text-headline-lg font-bold tracking-tight text-primary">
              It's your turn
            </p>
            <p className="mt-1 text-body-md text-on-surface">
              Please go to {stationName(config.config, stationId!)}
              {stationRoom(config.config, stationId!) ? ` — ${stationRoom(config.config, stationId!)}` : ""}.
            </p>
          </>
        ) : (
          <>
            <Hourglass aria-hidden="true" className="mx-auto size-7 text-warning" />
            <p className="mt-2 text-title-md font-semibold text-on-surface">
              Waiting for {stationName(config.config, stationId!)}
            </p>
            {ahead !== null && (
              <p className="mt-1 text-body-md text-on-surface-variant">
                {ahead === 0
                  ? "You are next in line."
                  : `${ahead} ${ahead === 1 ? "person" : "people"} ahead of you.`}
              </p>
            )}
          </>
        )}
      </section>

      {/*
       * The numbers below are the ones a patient acts on — they decide whether
       * to stay in their seat on the strength of "#2, ~15 mins". If this page
       * has stopped receiving updates, saying so beside the status badge is not
       * enough; the figures themselves have to carry the doubt.
       */}
      {!finished && !connection.trustworthy && (
        <p
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-container/40 p-3 text-body-sm text-on-surface"
        >
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-warning"
          />
          <span>
            <strong className="font-semibold">
              These numbers may be out of date.
            </strong>{" "}
            {formatFreshness(connection)}. Please check the waiting-room screen
            or ask at reception.
          </span>
        </p>
      )}

      {!finished && (
        <section
          aria-label="Your position"
          className={cn(
            "mt-4 grid grid-cols-2 gap-3",
            // Visibly de-emphasised while untrustworthy, so the figures do not
            // read as confidently as they do when they are current.
            !connection.trustworthy && "opacity-60",
          )}
        >
          <Metric
            icon={<Users className="size-4" />}
            label="Your position"
            /* Position is derived live, so it counts down as the queue moves. */
            value={beingServed ? "Now" : position !== null ? `#${position}` : "—"}
          />
          <Metric
            icon={<Hourglass className="size-4" />}
            label="Estimated wait"
            value={
              beingServed
                ? "Now"
                : estimate !== null
                  ? `~${formatDuration(estimate)}`
                  : "—"
            }
          />
          <Metric
            icon={<Search className="size-4" />}
            label="Your ticket"
            /* Fixed for this station, unlike position. */
            value={entry?.queueLabel ?? "—"}
            mono
          />
          <Metric
            icon={<DoorOpen className="size-4" />}
            label="Go to"
            value={(stationId && stationRoom(config.config, stationId)) ?? "—"}
          />
        </section>
      )}

      {alerts && !finished && (
        <PatientAlerts
          visitId={visit.id}
          notifier={alerts.notifier}
          bus={alerts.bus}
        />
      )}

      <section aria-label="Journey history" className="mt-8">
        <h2 className="text-title-md font-semibold text-on-surface">
          Your journey
        </h2>
        <div className="mt-4">
          {workflow && (
            <JourneyTimeline steps={journeySteps(visit, workflow, config.config)} />
          )}
        </div>
      </section>

      <footer className="mt-8 flex items-center justify-between gap-4 border-t border-outline-variant pt-4">
        {/* Previously an unconditional "Updates automatically", which was a
            claim this page could not always honour. */}
        <ConnectionStatus
          snapshot={connection}
          alwaysShowFreshness
          className="text-left"
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSubmitted("");
            setInput("");
          }}
        >
          Track another
        </Button>
      </footer>
    </main>
  );
}

function Metric({
  icon,
  label,
  value,
  mono = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4">
      <p className="flex items-center gap-1.5 font-mono text-label-caps uppercase text-on-surface-variant">
        <span aria-hidden="true">{icon}</span>
        {label}
      </p>
      <p
        className={cn(
          "mt-1 truncate text-title-md font-semibold text-on-surface",
          mono && "font-mono",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function Lookup({
  value,
  onChange,
  onSubmit,
  notFound,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  notFound: boolean;
}) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-8">
      <h1 className="text-headline-lg font-bold tracking-tight text-on-surface">
        Track your visit
      </h1>
      <p className="mt-2 text-body-md text-on-surface-variant">
        Enter the journey code from your ticket, or scan its QR code. No account
        needed.
      </p>

      <form
        className="mt-6"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label
          htmlFor="journey-code"
          className="font-mono text-label-caps uppercase text-on-surface-variant"
        >
          Journey code
        </label>
        <input
          id="journey-code"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          placeholder="QM-8F4K"
          aria-describedby={notFound ? "journey-code-error" : undefined}
          className={cn(
            "mt-2 w-full rounded-md border bg-surface-container-lowest px-4 py-3",
            "text-center font-mono text-headline-lg uppercase tracking-widest text-on-surface",
            "focus:outline-none focus:ring-2 focus:ring-primary",
            notFound ? "border-error" : "border-outline-variant",
          )}
        />
        {notFound && (
          <p
            id="journey-code-error"
            role="alert"
            className="mt-2 text-body-sm text-error"
          >
            We couldn't find that code. Check it against your ticket, or ask at
            reception.
          </p>
        )}
        <Button type="submit" size="lg" className="mt-4 w-full">
          Track my visit
        </Button>
      </form>
    </main>
  );
}
