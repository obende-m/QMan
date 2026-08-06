import { useCallback, useEffect, useMemo } from "react";
import {
  ArrowRight,
  CircleCheck,
  Megaphone,
  PlayCircle,
  SkipForward,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import type { StationId } from "@qman/domain";
import { Card, CardHeader } from "../../components/ui/Card.js";
import { ActionButton, Button } from "../../components/ui/Button.js";
import { JourneyCode } from "../../components/ui/JourneyCode.js";
import { JourneyTimeline } from "../../components/ui/JourneyTimeline.js";
import {
  StatusChip,
  priorityChip,
  queueStatusChip,
} from "../../components/ui/StatusChip.js";
import { useAnnouncer } from "../../components/ui/Announcer.js";
import { cn } from "../../components/ui/cn.js";
import type { UserId } from "@qman/domain";
import type { ActionResult, ClinicStore } from "../../data/clinic-store.js";
import { useAuth } from "../../data/useAuth.js";
import { stationName as stationNameFor } from "../../data/clinic-projections.js";
import { useConfig } from "../../data/useConfig.js";
import { journeySteps } from "../../data/journey-steps.js";
import {
  formatDuration,
  formatStopwatch,
  useClinic,
  useNow,
} from "../../data/useClinic.js";
import { profileFor } from "./station-profiles.js";

/**
 * The Station Workspace.
 *
 * One component powers Consultation, Vitals, Laboratory, Radiology, Pharmacy
 * and any station an administrator creates tomorrow. It knows nothing about
 * what any of them do: the queue comes from the domain's worklist projection,
 * the onward destinations come from the workflow's routing engine, and the only
 * station-specific thing is vocabulary, which comes from a profile that is
 * allowed to be missing.
 *
 * This is the SAD's guiding principle made literal — adding Dialysis is a row
 * in a workflow, not a screen.
 */
export interface StationWorkspaceProps {
  stationId: StationId;
  store?: ClinicStore;
}

export function StationWorkspace({
  stationId,
  store: injected,
}: StationWorkspaceProps) {
  const clinic = useClinic(injected);
  const config = useConfig();
  const auth = useAuth();
  const actor = (auth.currentUser()?.id ?? "") as UserId;
  const workflow = config.defaultWorkflow();
  const now = useNow(1000);
  const version = clinic.getVersion();
  const { announce } = useAnnouncer();
  const profile = profileFor(config.station(stationId)?.code ?? "");

  const worklist = useMemo(
    () => clinic.worklist(stationId),
    [clinic, stationId, version],
  );
  const destinations = useMemo(
    () => clinic.destinationsFrom(stationId),
    [clinic, stationId],
  );

  const current = worklist.current;
  const currentVisit = current ? clinic.find(current.visitId) : undefined;

  const run = useCallback(
    async (pending: Promise<ActionResult>, success: string) => {
      const result = await pending;
      announce(result.ok ? success : result.message, result.ok ? "success" : "error");
    },
    [announce],
  );

  const callNext = useCallback(() => {
    const [next] = clinic.worklist(stationId).waiting;
    void run(
      clinic.callNext(stationId, actor),
      next ? `Called ${next.patientName}.` : "Called next patient.",
    );
  }, [actor, clinic, stationId, run]);

  const startService = useCallback(() => {
    if (!current) return;
    void run(
      clinic.startService(current.visitId, actor),
      `Started with ${current.patientName}.`,
    );
  }, [clinic, current, run]);

  const recall = useCallback(() => {
    if (!current) return;
    void run(
      clinic.recall(current.visitId, actor),
      `Recalled ${current.patientName}.`,
    );
  }, [clinic, current, run]);

  const skip = useCallback(() => {
    if (!current) return;
    void run(
      clinic.skip(current.visitId, "Not present", actor),
      `${current.patientName} skipped — they keep their place in the queue.`,
    );
  }, [clinic, current, run]);

  const routeTo = useCallback(
    (to: StationId | undefined) => {
      if (!current) return;
      if (to === undefined) return;
      const label = stationNameFor(config.config, to);
      void run(
        clinic.route(current.visitId, to, actor),
        `${current.patientName} sent to ${label}.`,
      );
    },
    [clinic, current, run],
  );

  const complete = useCallback(() => {
    if (!current) return;
    void run(
      clinic.complete(current.visitId, actor),
      `${current.patientName}'s visit is complete.`,
    );
  }, [clinic, current, run]);

  /**
   * Keyboard shortcuts. A station sees dozens of patients an hour and the mouse
   * is the slowest part of the loop; these are the difference between software
   * staff tolerate and software they rely on.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }

      const actions: Record<string, () => void> = {
        n: callNext,
        s: startService,
        r: recall,
        k: skip,
        c: complete,
      };
      const action = actions[event.key.toLowerCase()];
      if (action) {
        event.preventDefault();
        action();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [callNext, startService, recall, skip, complete]);

  const name = stationNameFor(config.config, stationId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-headline-lg-mobile font-semibold tracking-tight text-on-surface md:text-headline-lg">
            <span aria-hidden="true" className="text-on-surface-variant">
              {profile.icon}
            </span>
            {name}
          </h1>
          <p className="mt-1 text-body-md text-on-surface-variant">
            {worklist.counts.waiting} waiting ·{" "}
            {worklist.counts.completedToday} completed today
            {worklist.averageWaitMillis !== null && (
              <> · avg wait {formatDuration(worklist.averageWaitMillis)}</>
            )}
          </p>
        </div>
        <Button
          size="lg"
          icon={<Megaphone className="size-5" />}
          onClick={callNext}
          disabled={worklist.counts.waiting === 0 || current !== null}
        >
          Call Next
          <kbd className="ml-1 rounded bg-on-primary/20 px-1.5 py-0.5 font-mono text-label-caps">
            N
          </kbd>
        </Button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          {current && currentVisit ? (
            <Card className="overflow-hidden border-l-4 border-l-primary">
              <div className="p-gutter">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip
                        {...queueStatusChip(current.entry.status)}
                      />
                      {priorityChip(current.priority) && (
                        <StatusChip {...priorityChip(current.priority)!} />
                      )}
                    </div>
                    <h2 className="mt-3 truncate text-headline-lg font-bold tracking-tight text-on-surface">
                      {current.patientName}
                    </h2>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="flex items-center gap-1.5 text-body-sm text-on-surface-variant">
                        Journey code
                        <JourneyCode code={current.journeyCode} />
                      </span>
                      {/* The station queue number is a different thing from the
                          journey code, and both are shown so staff can call the
                          number aloud while the code identifies the visit. */}
                      <span className="flex items-center gap-1.5 text-body-sm text-on-surface-variant">
                        Queue number
                        <span className="font-mono text-body-sm font-semibold text-on-surface">
                          {current.entry.queueLabel}
                        </span>
                      </span>
                    </div>
                  </div>

                  <div className="text-right">
                    <p className="font-mono text-label-caps uppercase text-on-surface-variant">
                      {profile.timerLabel}
                    </p>
                    <p
                      className={cn(
                        "text-display-lg font-bold tabular-nums",
                        current.entry.startedAt ? "text-tertiary" : "text-warning",
                      )}
                    >
                      {formatStopwatch(
                        now.getTime() -
                          (current.entry.startedAt ??
                            current.entry.calledAt ??
                            current.entry.queuedAt).getTime(),
                      )}
                    </p>
                  </div>
                </div>

                <div className="mt-6 flex flex-wrap gap-3 border-t border-outline-variant pt-6">
                  {!current.entry.startedAt && (
                    <ActionButton
                      icon={<PlayCircle className="size-5" />}
                      label={profile.startLabel}
                      onClick={startService}
                    />
                  )}
                  <ActionButton
                    icon={<CircleCheck className="size-5" />}
                    label="Complete"
                    onClick={complete}
                  />
                  <ActionButton
                    icon={<Megaphone className="size-5" />}
                    label="Recall"
                    onClick={recall}
                  />
                  <ActionButton
                    icon={<SkipForward className="size-5" />}
                    label="Skip"
                    onClick={skip}
                  />
                </div>

                {/* Destinations come from the workflow, never from a hardcoded
                    list — which is why a new station needs no change here. */}
                <div className="mt-6 border-t border-outline-variant pt-6">
                  <p className="font-mono text-label-caps uppercase text-on-surface-variant">
                    Send to
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {destinations.options.map((option) => (
                      <Button
                        key={option.stationId}
                        variant={option.isNextInSequence ? "primary" : "secondary"}
                        icon={<ArrowRight className="size-4" />}
                        onClick={() => routeTo(option.stationId)}
                      >
                        {stationNameFor(config.config, option.stationId) ?? "Next station"}
                      </Button>
                    ))}
                    {destinations.options.length === 0 && (
                      <p className="text-body-sm text-on-surface-variant">
                        This is the final stage of the workflow. Complete the
                        visit to discharge the patient.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </Card>
          ) : (
            <EmptyStation
              hasWaiting={worklist.counts.waiting > 0}
              onCallNext={callNext}
            />
          )}

          {currentVisit && (
            <Card>
              <CardHeader
                title="Journey"
                subtitle="Where this visit has been, and what remains."
              />
              <div className="px-gutter pb-gutter">
                {workflow && (
                  <JourneyTimeline
                    steps={journeySteps(currentVisit, workflow, config.config)}
                  />
                )}
              </div>
              {/* QMan does not own medical records — the PRD is explicit that
                  clinical data stays in the HMS. The workspace leaves a slot for
                  it rather than inventing a copy. */}
              <div className="mx-gutter mb-gutter rounded-md border border-dashed border-outline-variant p-4">
                <p className="font-mono text-label-caps uppercase text-on-surface-variant">
                  Clinical context
                </p>
                <p className="mt-1 text-body-sm text-on-surface-variant">
                  Vitals, reason for visit and history are served from your HMS.
                  Connect an integration to show them here.
                </p>
              </div>
            </Card>
          )}
        </div>

        <StationQueue
          waiting={worklist.waiting}
          skippedCount={worklist.counts.skipped}
          now={now}
        />
      </div>

      <ShortcutLegend />
    </div>
  );
}

function StationQueue({
  waiting,
  skippedCount,
  now,
}: {
  waiting: ReturnType<ClinicStore["waitingAt"]>;
  skippedCount: number;
  now: Date;
}) {
  return (
    <Card className="self-start">
      <CardHeader
        title="Waiting Queue"
        {...(skippedCount > 0
          ? { subtitle: `${skippedCount} previously skipped` }
          : {})}
        action={
          <span className="rounded-full bg-surface-container-high px-2.5 py-1 font-mono text-label-caps uppercase text-on-surface-variant">
            {waiting.length} {waiting.length === 1 ? "patient" : "patients"}
          </span>
        }
      />

      {waiting.length === 0 ? (
        <p className="px-gutter pb-gutter text-body-sm text-on-surface-variant">
          Nobody is waiting at this station.
        </p>
      ) : (
        <ol className="divide-y divide-outline-variant border-t border-outline-variant">
          {waiting.map((item, index) => {
            const priority = priorityChip(item.priority);
            const urgent = item.priority === "emergency";
            return (
              <li
                key={item.entry.id}
                className={cn(
                  "flex items-center gap-3 px-gutter py-3",
                  urgent && "border-l-4 border-l-error bg-error-container/30",
                )}
              >
                <span
                  aria-hidden="true"
                  className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-container-high font-mono text-label-caps text-on-surface-variant"
                >
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-body-md font-semibold text-on-surface">
                      {item.patientName}
                    </span>
                    {priority && <StatusChip {...priority} />}
                    {item.entry.skipped && (
                      <StatusChip tone="neutral" label="Skipped" />
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <span className="font-mono text-label-caps uppercase text-on-surface-variant">
                      {item.entry.queueLabel}
                    </span>
                    <JourneyCode code={item.journeyCode} />
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-mono text-label-caps uppercase text-on-surface-variant">
                    Wait
                  </p>
                  <p className="text-body-md font-semibold tabular-nums text-on-surface">
                    {formatDuration(
                      now.getTime() - item.entry.queuedAt.getTime(),
                    )}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

function EmptyStation({
  hasWaiting,
  onCallNext,
}: {
  hasWaiting: boolean;
  onCallNext: () => void;
}) {
  return (
    <Card>
      <div className="flex flex-col items-center gap-3 px-gutter py-12 text-center">
        <span
          aria-hidden="true"
          className="grid size-12 place-items-center rounded-full bg-surface-container-high text-on-surface-variant"
        >
          <UserRound className="size-6" />
        </span>
        <h2 className="text-title-md font-semibold text-on-surface">
          {hasWaiting ? "Nobody called yet" : "Station is clear"}
        </h2>
        <p className="max-w-sm text-body-sm text-on-surface-variant">
          {hasWaiting
            ? "Call the next patient to begin."
            : "No patients are waiting. New arrivals appear here automatically."}
        </p>
        {hasWaiting && (
          <Button
            icon={<Megaphone className="size-4" />}
            onClick={onCallNext}
            className="mt-2"
          >
            Call Next
          </Button>
        )}
      </div>
    </Card>
  );
}

function ShortcutLegend() {
  const shortcuts: Array<[string, string]> = [
    ["N", "Call next"],
    ["S", "Start"],
    ["C", "Complete"],
    ["R", "Recall"],
    ["K", "Skip"],
    ["E", "Escalate"],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-outline-variant bg-surface-container-low px-4 py-3">
      <span className="font-mono text-label-caps uppercase text-on-surface-variant">
        Shortcuts
      </span>
      {shortcuts.map(([key, label]) => (
        <span key={key} className="flex items-center gap-1.5">
          <kbd className="rounded border border-outline-variant bg-surface-container-lowest px-1.5 py-0.5 font-mono text-label-caps text-on-surface">
            {key}
          </kbd>
          <span className="text-body-sm text-on-surface-variant">{label}</span>
        </span>
      ))}
    </div>
  );
}
