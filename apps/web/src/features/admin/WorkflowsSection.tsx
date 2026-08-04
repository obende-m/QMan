import { ArrowDown, ArrowUp } from "lucide-react";
import {
  orderedStages,
  routeOptions,
  type ConfigProblem,
  type StationId,
  type Workflow,
  type WorkflowStage,
} from "@qman/domain";
import { Card, CardHeader } from "../../components/ui/Card.js";
import { Button } from "../../components/ui/Button.js";
import { StatusChip } from "../../components/ui/StatusChip.js";
import type { ConfigStore } from "../../data/config-store.js";
import { Toggle } from "./StationsSection.js";
import { ProblemList, SaveFeedback, useSaveFeedback } from "./shared.js";

/**
 * Workflow configuration.
 *
 * Presented as an ordered list with per-stage rules rather than a node-and-edge
 * canvas. A hospital administrator describes a journey as "reception, then
 * vitals, then the doctor" — a sequence — and the exceptions as branches off it.
 * A graph editor asks them to think in a vocabulary they do not use.
 */
export function WorkflowsSection({
  store,
  problems,
}: {
  store: ConfigStore;
  problems: readonly ConfigProblem[];
}) {
  return (
    <div className="space-y-6">
      {store.config.workflows.map((workflow) => (
        <WorkflowEditor
          key={workflow.id}
          store={store}
          workflow={workflow}
          problems={problems}
        />
      ))}
    </div>
  );
}

function WorkflowEditor({
  store,
  workflow,
  problems,
}: {
  store: ConfigStore;
  workflow: Workflow;
  problems: readonly ConfigProblem[];
}) {
  const { feedback, report } = useSaveFeedback();
  const stages = orderedStages(workflow);
  const mine = problems.filter((p) => p.path.startsWith(`workflows.${workflow.id}`));

  const saveStages = (next: WorkflowStage[]) =>
    report(
      store.updateWorkflow(workflow.id, {
        stages: next.map((stage, index) => ({ ...stage, sequence: index + 1 })),
      }),
    );

  const move = (index: number, delta: number) => {
    const next = [...stages];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    saveStages(next);
  };

  const updateStage = (stageId: string, change: Partial<WorkflowStage>) =>
    saveStages(
      stages.map((stage) =>
        stage.id === stageId ? { ...stage, ...change } : stage,
      ),
    );

  return (
    <Card>
      <CardHeader
        title={workflow.name}
        subtitle="The order patients move through, and the detours allowed."
        action={
          workflow.isDefault ? <StatusChip tone="in-progress" label="Default" /> : undefined
        }
      />

      <div className="space-y-4 px-gutter pb-gutter">
        <ProblemList problems={mine} />

        <ol className="space-y-3">
          {stages.map((stage, index) => {
            const station = store.station(stage.stationId);
            const permitted = routeOptions(workflow, stage.stationId);
            return (
              <li
                key={stage.id}
                className="rounded-md border border-outline-variant bg-surface-container-low p-4"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-container-high font-mono text-label-caps text-on-surface-variant"
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-body-md font-semibold text-on-surface">
                    {station?.name ?? "Unknown station"}
                  </span>
                  {!station && (
                    <StatusChip tone="urgent" label="Station missing" />
                  )}
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Move ${station?.name ?? "stage"} earlier`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Move ${station?.name ?? "stage"} later`}
                      disabled={index === stages.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown className="size-4" />
                    </Button>
                  </div>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <Toggle
                    label="Required"
                    checked={stage.isRequired}
                    onChange={(isRequired) =>
                      updateStage(stage.id, { isRequired })
                    }
                  />
                  <Toggle
                    label="May be skipped"
                    checked={stage.allowSkip}
                    onChange={(allowSkip) => updateStage(stage.id, { allowSkip })}
                  />
                  <Toggle
                    label="May be revisited"
                    checked={stage.allowRepeat}
                    onChange={(allowRepeat) =>
                      updateStage(stage.id, { allowRepeat })
                    }
                  />
                </div>

                {/* Branches, shown as the routing engine will actually offer
                    them — so an administrator sees the consequence of the
                    rule, not the rule. */}
                <div className="mt-3">
                  <p className="font-mono text-label-caps uppercase text-on-surface-variant">
                    Can send to
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {permitted.length === 0 ? (
                      <span className="text-body-sm text-on-surface-variant">
                        Nowhere — this is the final stage.
                      </span>
                    ) : (
                      permitted.map((option) => (
                        <StatusChip
                          key={option.stationId}
                          tone={option.isNextInSequence ? "in-progress" : "neutral"}
                          label={store.stationName(option.stationId)}
                        />
                      ))
                    )}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {store
                      .activeStations()
                      .filter((s) => s.id !== stage.stationId)
                      .map((candidate) => {
                        const active = stage.branchesTo.includes(candidate.id);
                        return (
                          <button
                            key={candidate.id}
                            type="button"
                            onClick={() =>
                              updateStage(stage.id, {
                                branchesTo: active
                                  ? stage.branchesTo.filter(
                                      (id) => id !== candidate.id,
                                    )
                                  : [...stage.branchesTo, candidate.id as StationId],
                              })
                            }
                            className={
                              active
                                ? "rounded border border-primary bg-primary/10 px-2 py-1 text-body-sm text-primary"
                                : "rounded border border-outline-variant px-2 py-1 text-body-sm text-on-surface-variant hover:bg-surface-container-high"
                            }
                          >
                            {active ? "− " : "+ "}
                            {candidate.name}
                          </button>
                        );
                      })}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        <SaveFeedback feedback={feedback} />
      </div>
    </Card>
  );
}
