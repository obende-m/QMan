import { useEffect, useMemo } from "react";
import { displayPatientName, type StationId, type StationWorklist } from "@qman/domain";
import { cn } from "../../components/ui/cn.js";
import {
  ConnectionStatus,
  useConnectionMonitor,
} from "../../components/ui/ConnectionStatus.js";
import { formatDuration, useClinic, useNow } from "../../data/useClinic.js";
import type { ClinicStore } from "../../data/clinic-store.js";
import { stationName, stationRoom } from "../../data/clinic-projections.js";
import {
  operationsStore,
  type OperationsStore,
} from "../../data/operations-store.js";
import type { DisplayBoardConfig } from "../../data/display-boards.js";

/**
 * The public Display Board.
 *
 * Read-only, and designed for a wall-mounted screen read from across a waiting
 * room rather than a desk. Three consequences follow, and they drive most of
 * the styling decisions here:
 *
 *  - Type is very large and the palette is fixed dark. A bright screen in a
 *    dim waiting room is unpleasant to sit under for an hour, and a board is
 *    the one surface in QMan that never follows the viewer's theme because
 *    nobody "views" it — it is furniture.
 *  - Tickets are the unit of communication, not names. A patient looks for
 *    "A-004", and putting names on a public screen is an avoidable privacy
 *    exposure. Names are opt-in per board.
 *  - Every station appears at once, so a patient can see the whole clinic
 *    rather than waiting for a carousel to come back round to their station.
 *
 * It subscribes to the same store as every staff screen, so it is live by
 * construction — no polling and nothing to refresh.
 */
export interface DisplayBoardProps {
  config: DisplayBoardConfig;
  store?: ClinicStore;
  operations?: OperationsStore;
}

export function DisplayBoard({
  config,
  store: injected,
  operations: injectedOps,
}: DisplayBoardProps) {
  const clinic = useClinic(injected);
  const ops = injectedOps ?? operationsStore;
  const now = useNow(1000);
  const version = clinic.getVersion();

  /**
   * Freshness is tracked against the clinic's own heartbeat, not against the
   * render loop — a board that re-renders its clock every second would
   * otherwise report itself healthy forever while showing a frozen queue.
   */
  const connection = useConnectionMonitor({ signal: clinic.heartbeat });

  /**
   * The board reports that it is alive.
   *
   * Devices push rather than being polled: a screen behind a hospital firewall
   * is usually not addressable, and the thing a manager needs to know is
   * whether the screen is *rendering*, which only the screen itself can say.
   */
  useEffect(() => {
    const beat = () =>
      ops.heartbeat({
        deviceId: config.id,
        kind: "display_board",
        name: config.name,
        branchId: BRANCH,
      });

    beat();
    const timer = setInterval(beat, 15_000);
    return () => clearInterval(timer);
  }, [ops, config.id, config.name]);

  const stations = useMemo(
    () =>
      config.stationIds.map((stationId) => ({
        stationId,
        worklist: clinic.worklist(stationId),
      })),
    [clinic, config.stationIds, version],
  );

  return (
    // The board commits to a single dark look rather than inheriting the app
    // theme, so `dark` is forced on this subtree.
    <div className="dark min-h-screen bg-background text-on-background">
      <div className="mx-auto flex min-h-screen max-w-[1920px] flex-col gap-8 p-8">
        <header className="flex flex-wrap items-baseline justify-between gap-4 border-b border-outline-variant pb-6">
          <div>
            <h1 className="text-display-lg font-bold tracking-tight text-on-surface">
              {config.name}
            </h1>
            <p className="mt-1 font-mono text-label-caps uppercase tracking-widest text-on-surface-variant">
              Now serving
            </p>
          </div>
          <div className="text-right">
            <p
              className="text-display-lg font-bold tabular-nums text-on-surface"
              aria-label="Current time"
            >
              {now.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
            {/* Never an unconditional "Live". A board that keeps claiming to be
                current while its source has gone quiet is worse than one that
                admits it, because a waiting room acts on it. */}
            <ConnectionStatus snapshot={connection} size="board" />
          </div>
        </header>

        <div
          className={cn(
            "grid flex-1 gap-6",
            stations.length === 1
              ? "grid-cols-1"
              : stations.length === 2
                ? "grid-cols-1 lg:grid-cols-2"
                : "grid-cols-1 md:grid-cols-2 xl:grid-cols-3",
          )}
        >
          {stations.map(({ stationId, worklist }) => (
            <StationPanel
              key={stationId}
              stationId={stationId}
              worklist={worklist}
              config={config}
              estimatedWaitMillis={clinic.estimatedWaitForNewArrival(stationId)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function StationPanel({
  stationId,
  worklist,
  config,
  estimatedWaitMillis,
}: {
  stationId: StationId;
  worklist: StationWorklist;
  config: DisplayBoardConfig;
  estimatedWaitMillis: number;
}) {
  const serving = worklist.current;
  const waiting = worklist.waiting.slice(0, config.waitingToShow);
  const overflow = worklist.waiting.length - waiting.length;
  const servingName = serving
    ? displayPatientName(serving.patientName, config.namePolicy)
    : null;

  return (
    <section
      aria-label={`${stationName(config.config, stationId)} queue`}
      className="flex flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface-container-low"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-outline-variant bg-surface-container px-6 py-4">
        <h2 className="text-headline-lg font-semibold tracking-tight text-on-surface">
          {stationName(config.config, stationId)}
        </h2>
        {config.showRoom && stationRoom(config.config, stationId) && (
          <p className="font-mono text-label-caps uppercase tracking-widest text-on-surface-variant">
            {stationRoom(config.config, stationId)}
          </p>
        )}
      </div>

      {/* The serving ticket is visually separated from the queue: its own
          panel, its own colour, and by far the largest type on the board. */}
      <div className="border-b border-outline-variant bg-primary/10 px-6 py-6">
        <p className="flex items-center gap-2 font-mono text-label-caps uppercase tracking-widest text-tertiary">
          <span
            aria-hidden="true"
            className={cn(
              "size-2.5 rounded-full",
              serving ? "bg-tertiary" : "bg-outline",
            )}
          />
          Now serving
        </p>
        {serving ? (
          <>
            <p className="mt-2 font-mono text-[4rem] font-bold leading-none tracking-tight text-primary">
              {serving.entry.queueLabel}
            </p>
            {servingName && (
              <p className="mt-2 truncate text-title-md text-on-surface-variant">
                {servingName}
              </p>
            )}
          </>
        ) : (
          <p className="mt-2 text-[4rem] font-bold leading-none text-outline">
            —
          </p>
        )}
      </div>

      <div className="flex-1 px-6 py-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <p className="font-mono text-label-caps uppercase tracking-widest text-on-surface-variant">
            Waiting
          </p>
          {config.showEstimatedWait && worklist.counts.waiting > 0 && (
            <p className="font-mono text-label-caps uppercase text-on-surface-variant">
              New arrivals ≈ {formatDuration(estimatedWaitMillis)}
            </p>
          )}
        </div>

        {waiting.length === 0 ? (
          <p className="mt-3 text-title-md text-outline">No one waiting</p>
        ) : (
          <ol className="mt-3 space-y-2">
            {waiting.map((item, index) => {
              const name = displayPatientName(
                item.patientName,
                config.namePolicy,
              );
              return (
                <li
                  key={item.entry.id}
                  className={cn(
                    "flex items-baseline gap-3 rounded-md px-3 py-2",
                    item.priority === "emergency"
                      ? "bg-error/20"
                      : "bg-surface-container",
                  )}
                >
                  {/* Position, not ticket. The ticket is fixed for the stop;
                      this number moves every time the queue does. */}
                  <span
                    aria-label={`Position ${index + 1}`}
                    className="w-7 shrink-0 font-mono text-label-caps text-on-surface-variant"
                  >
                    {index + 1}
                  </span>
                  <span className="font-mono text-headline-lg font-semibold tabular-nums text-on-surface">
                    {item.entry.queueLabel}
                  </span>
                  {name && (
                    <span className="ml-auto truncate text-body-md text-on-surface-variant">
                      {name}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {overflow > 0 && (
          <p className="mt-3 font-mono text-label-caps uppercase text-on-surface-variant">
            +{overflow} more waiting
          </p>
        )}
      </div>
    </section>
  );
}
