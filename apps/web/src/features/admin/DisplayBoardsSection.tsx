import { useState } from "react";
import { ExternalLink, Plus } from "lucide-react";
import {
  PATIENT_NAME_POLICIES,
  describeNamePolicy,
  type ConfigProblem,
  type DisplayBoardConfig,
  type PatientNamePolicy,
  type StationId,
} from "@qman/domain";
import { Card, CardHeader } from "../../components/ui/Card.js";
import { Button } from "../../components/ui/Button.js";
import { cn } from "../../components/ui/cn.js";
import type { ConfigStore } from "../../data/config-store.js";
import { inputClass } from "../../data/useConfig.js";
import { Field, Toggle } from "./StationsSection.js";
import { ProblemList, SaveFeedback, useSaveFeedback , DraftInput} from "./shared.js";

export function DisplayBoardsSection({
  store,
  problems,
}: {
  store: ConfigStore;
  problems: readonly ConfigProblem[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    store.config.displayBoards[0]?.id ?? null,
  );
  const selected = selectedId ? store.board(selectedId) : undefined;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Display Boards"
          subtitle="Each waiting area gets its own board showing its own stations."
          action={
            <Button
              size="sm"
              icon={<Plus className="size-4" />}
              onClick={() => {
                const first = store.publicStations()[0];
                if (!first) return;
                // The server mints the identifier, so the new board is the one
                // that was not there before rather than one chosen here.
                const before = new Set(store.config.displayBoards.map((b) => b.id));
                void (async () => {
                  const result = await store.addBoard({
                    name: "New Board",
                    stationIds: [first.id],
                    waitingToShow: 4,
                    namePolicy: store.config.defaults.namePolicy,
                    showEstimatedWait: true,
                    showRoom: true,
                  });
                  if (!result.ok) return;
                  const created = store.config.displayBoards.find((b) => !before.has(b.id));
                  if (created) setSelectedId(created.id);
                })();
              }}
            >
              Add board
            </Button>
          }
        />
        <ul className="divide-y divide-outline-variant border-t border-outline-variant">
          {store.config.displayBoards.map((board) => (
            <li key={board.id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSelectedId(board.id)}
                className={cn(
                  "min-w-0 flex-1 px-gutter py-3 text-left transition-colors",
                  board.id === selectedId
                    ? "bg-surface-container-low"
                    : "hover:bg-surface-container-low",
                )}
              >
                <span className="block truncate text-body-md font-semibold text-on-surface">
                  {board.name}
                </span>
                <span className="font-mono text-label-caps uppercase text-on-surface-variant">
                  {board.stationIds.length} stations ·{" "}
                  {describeNamePolicy(board.namePolicy)}
                </span>
              </button>
              <a
                href={`/display.html?board=${board.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mr-4 flex items-center gap-1.5 rounded px-2 py-1 text-body-sm text-primary hover:bg-surface-container-high"
              >
                Open
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
            </li>
          ))}
        </ul>
      </Card>

      {selected && (
        <BoardEditor
          key={selected.id}
          store={store}
          board={selected}
          problems={problems}
        />
      )}
    </div>
  );
}

function BoardEditor({
  store,
  board,
  problems,
}: {
  store: ConfigStore;
  board: DisplayBoardConfig;
  problems: readonly ConfigProblem[];
}) {
  const { feedback, report } = useSaveFeedback();
  const save = (change: Partial<DisplayBoardConfig>) =>
    report(store.updateBoard(board.id, change));

  const mine = problems.filter((p) =>
    p.path.startsWith(`displayBoards.${board.id}`),
  );

  const toggleStation = (stationId: StationId, include: boolean) => {
    const next = include
      ? [...board.stationIds, stationId]
      : board.stationIds.filter((id) => id !== stationId);
    save({ stationIds: next });
  };

  return (
    <Card>
      <CardHeader title={board.name} subtitle="Boards update live as you edit." />
      <div className="space-y-6 px-gutter pb-gutter">
        <ProblemList problems={mine} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Board name">
            <DraftInput
                className={inputClass}
                value={board.name}
                onCommit={(next) => save({ name: next })}
              />
          </Field>
          <Field
            label="Waiting tickets to show"
            hint="Fewer on a small screen; more in a large atrium."
          >
            <input
              type="number"
              min={1}
              max={20}
              className={inputClass}
              value={board.waitingToShow}
              onChange={(e) => save({ waitingToShow: Number(e.target.value) })}
            />
          </Field>
        </div>

        <section>
          <h3 className="text-title-md font-semibold text-on-surface">
            Stations shown
          </h3>
          <p className="mt-1 text-body-sm text-on-surface-variant">
            Only stations marked as public can appear on a board.
          </p>
          <div className="mt-3 space-y-2">
            {store.activeStations().map((station) => (
              <Toggle
                key={station.id}
                label={station.name}
                {...(station.isPublic
                  ? {}
                  : { hint: "Internal station — cannot be shown publicly." })}
                checked={board.stationIds.includes(station.id)}
                onChange={(checked) => toggleStation(station.id, checked)}
              />
            ))}
          </div>
        </section>

        <section>
          <h3 className="text-title-md font-semibold text-on-surface">
            Privacy
          </h3>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field
              label="Patient names"
              hint="Ticket numbers alone are enough to call a patient forward."
            >
              <select
                className={inputClass}
                value={board.namePolicy}
                onChange={(e) =>
                  save({ namePolicy: e.target.value as PatientNamePolicy })
                }
              >
                {PATIENT_NAME_POLICIES.map((policy) => (
                  <option key={policy} value={policy}>
                    {describeNamePolicy(policy)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {board.namePolicy !== "ticket_only" && (
            <p className="mt-2 rounded-md border border-warning/40 bg-warning-container/30 p-3 text-body-sm text-on-surface">
              This board will show patient names in a public waiting area.
              Confirm this meets your hospital's privacy obligations.
            </p>
          )}
        </section>

        <section className="space-y-3">
          <Toggle
            label="Show estimated wait"
            checked={board.showEstimatedWait}
            onChange={(showEstimatedWait) => save({ showEstimatedWait })}
          />
          <Toggle
            label="Show room location"
            hint="Tells patients where to walk, not just when."
            checked={board.showRoom}
            onChange={(showRoom) => save({ showRoom })}
          />
        </section>

        <SaveFeedback feedback={feedback} />
      </div>
    </Card>
  );
}
