import { useState } from "react";
import { Plus } from "lucide-react";
import {
  QUEUE_NUMBER_PRESETS,
  StationId,
  formatQueueNumber,
  parseJourneyCode,
  resetPeriodKey,
  type ConfigProblem,
  type QueueResetStrategy,
  type StationConfig,
} from "@qman/domain";
import { Card, CardHeader } from "../../components/ui/Card.js";
import { Button } from "../../components/ui/Button.js";
import { StatusChip } from "../../components/ui/StatusChip.js";
import { cn } from "../../components/ui/cn.js";
import type { ConfigStore } from "../../data/config-store.js";
import { inputClass, labelClass } from "../../data/useConfig.js";
import { ProblemList, SaveFeedback, useSaveFeedback } from "./shared.js";

const RESET_OPTIONS: ReadonlyArray<{ value: QueueResetStrategy; label: string }> = [
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "never", label: "Never" },
  { value: "manual", label: "Manual only" },
];

const TEMPLATE_PRESETS: ReadonlyArray<{ label: string; template: string }> = [
  { label: "Letter series (A-001)", template: "A-{n:3}" },
  { label: "Department prefix (LAB-001)", template: "{station}-{n:3}" },
  { label: "Numeric only (001)", template: "{n:3}" },
  { label: "Journey code (QM-8F4K)", template: "{journey}" },
  { label: "Dated (LAB/20260309/0083)", template: "{station}/{yyyy}{mm}{dd}/{n:4}" },
];

export function StationsSection({
  store,
  problems,
}: {
  store: ConfigStore;
  problems: readonly ConfigProblem[];
}) {
  const [selectedId, setSelectedId] = useState<StationId | null>(
    store.config.stations[0]?.id ?? null,
  );
  const selected = selectedId ? store.station(selectedId) : undefined;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Stations"
          subtitle="Every operational point a visit can stop at."
          action={
            <Button
              size="sm"
              icon={<Plus className="size-4" />}
              onClick={() => {
                const id = StationId(`st-new-${Date.now()}`);
                const result = store.addStation(newStation(id));
                if (result.ok) setSelectedId(id);
              }}
            >
              Add station
            </Button>
          }
        />
        <ul className="divide-y divide-outline-variant border-t border-outline-variant">
          {store.config.stations.map((station) => (
            <li key={station.id}>
              <button
                type="button"
                onClick={() => setSelectedId(station.id)}
                aria-current={station.id === selectedId ? "true" : undefined}
                className={cn(
                  "flex w-full flex-wrap items-center gap-3 px-gutter py-3 text-left transition-colors",
                  station.id === selectedId
                    ? "bg-surface-container-low"
                    : "hover:bg-surface-container-low",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-md font-semibold text-on-surface">
                    {station.name}
                  </span>
                  <span className="font-mono text-label-caps uppercase text-on-surface-variant">
                    {station.code} · {preview(station, 7)}
                  </span>
                </span>
                {!station.enabled && (
                  <StatusChip tone="neutral" label="Disabled" />
                )}
                {!station.isPublic && (
                  <StatusChip tone="neutral" label="Internal" />
                )}
              </button>
            </li>
          ))}
        </ul>
      </Card>

      {selected && (
        <StationEditor
          key={selected.id}
          store={store}
          station={selected}
          problems={problems}
        />
      )}
    </div>
  );
}

function newStation(id: StationId): StationConfig {
  return {
    id,
    name: "New Station",
    code: "NEW",
    room: null,
    staffing: 1,
    serviceEstimateMillis: 10 * 60_000,
    sla: { targetWaitMillis: 20 * 60_000, saturationPoint: 10 },
    queueNumber: QUEUE_NUMBER_PRESETS.departmentPrefix(),
    isPublic: true,
    enabled: true,
  };
}

/** Renders what a real ticket from this station would look like. */
function preview(station: StationConfig, ordinal: number): string {
  return formatQueueNumber(station.queueNumber, {
    ordinal,
    stationCode: station.code || "QM",
    journeyCode: parseJourneyCode("QM-8F4K"),
    issuedAt: new Date(),
  });
}

function StationEditor({
  store,
  station,
  problems,
}: {
  store: ConfigStore;
  station: StationConfig;
  problems: readonly ConfigProblem[];
}) {
  const { feedback, report } = useSaveFeedback();

  const save = (change: Partial<StationConfig>) =>
    report(store.updateStation(station.id, change));

  const mine = problems.filter((p) => p.path.startsWith(`stations.${station.id}`));

  return (
    <Card>
      <CardHeader
        title={station.name}
        subtitle="Changes apply immediately to every screen showing this station."
      />

      <div className="space-y-6 px-gutter pb-gutter">
        <ProblemList problems={mine} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input
              className={inputClass}
              value={station.name}
              onChange={(e) => save({ name: e.target.value })}
            />
          </Field>
          <Field
            label="Short code"
            hint="Used by the {station} token in queue numbers."
          >
            <input
              className={inputClass}
              value={station.code}
              onChange={(e) => save({ code: e.target.value.toUpperCase() })}
            />
          </Field>
          <Field label="Room" hint="Shown to patients so they know where to go.">
            <input
              className={inputClass}
              value={station.room ?? ""}
              placeholder="e.g. Room 12"
              onChange={(e) => save({ room: e.target.value || null })}
            />
          </Field>
          <Field label="Staff on station" hint="Sizes the wait estimate.">
            <input
              type="number"
              min={1}
              className={inputClass}
              value={station.staffing}
              onChange={(e) => save({ staffing: Number(e.target.value) })}
            />
          </Field>
        </div>

        {/* Queue numbering, with a live preview. A template string means
            nothing to an administrator; "A-007" is unambiguous. */}
        <section>
          <h3 className="text-title-md font-semibold text-on-surface">
            Queue numbering
          </h3>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Format">
              <select
                className={inputClass}
                value={
                  TEMPLATE_PRESETS.find(
                    (p) => p.template === station.queueNumber.template,
                  )?.template ?? "custom"
                }
                onChange={(e) => {
                  if (e.target.value === "custom") return;
                  save({
                    queueNumber: {
                      ...station.queueNumber,
                      template: e.target.value,
                    },
                  });
                }}
              >
                {TEMPLATE_PRESETS.map((preset) => (
                  <option key={preset.template} value={preset.template}>
                    {preset.label}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
            </Field>

            <Field
              label="Template"
              hint="Tokens: {n} {n:3} {station} {journey} {yyyy} {mm} {dd}"
            >
              <input
                className={cn(inputClass, "font-mono")}
                value={station.queueNumber.template}
                onChange={(e) =>
                  save({
                    queueNumber: {
                      ...station.queueNumber,
                      template: e.target.value,
                    },
                  })
                }
              />
            </Field>

            <Field label="Restart numbering">
              <select
                className={inputClass}
                value={station.queueNumber.reset}
                onChange={(e) =>
                  save({
                    queueNumber: {
                      ...station.queueNumber,
                      reset: e.target.value as QueueResetStrategy,
                    },
                  })
                }
              >
                {RESET_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>

            <div className="rounded-md border border-outline-variant bg-surface-container-low p-3">
              <p className={labelClass}>Preview</p>
              <p
                aria-label="Ticket preview"
                className="mt-1 font-mono text-headline-lg font-bold text-primary"
              >
                {preview(station, 7)}
              </p>
              <p className="mt-1 text-body-sm text-on-surface-variant">
                Current series:{" "}
                <span className="font-mono">
                  {resetPeriodKey(station.queueNumber, new Date())}
                </span>
              </p>
            </div>
          </div>
        </section>

        <section>
          <h3 className="text-title-md font-semibold text-on-surface">
            Service level
          </h3>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field
              label="Wait target (minutes)"
              hint="Beyond this, the station is flagged on the manager dashboard."
            >
              <input
                type="number"
                min={1}
                className={inputClass}
                value={Math.round(station.sla.targetWaitMillis / 60_000)}
                onChange={(e) =>
                  save({
                    sla: {
                      ...station.sla,
                      targetWaitMillis: Number(e.target.value) * 60_000,
                    },
                  })
                }
              />
            </Field>
            <Field
              label="Saturation point"
              hint="Queue depth at which this station is considered full."
            >
              <input
                type="number"
                min={1}
                className={inputClass}
                value={station.sla.saturationPoint}
                onChange={(e) =>
                  save({
                    sla: {
                      ...station.sla,
                      saturationPoint: Number(e.target.value),
                    },
                  })
                }
              />
            </Field>
            <Field label="Expected service time (minutes)">
              <input
                type="number"
                min={1}
                className={inputClass}
                value={Math.round(station.serviceEstimateMillis / 60_000)}
                onChange={(e) =>
                  save({
                    serviceEstimateMillis: Number(e.target.value) * 60_000,
                  })
                }
              />
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <Toggle
            label="Enabled"
            hint="Disabled stations accept no new patients."
            checked={station.enabled}
            onChange={(enabled) => save({ enabled })}
          />
          <Toggle
            label="May appear on public display boards"
            hint="Internal queues such as Reception should stay off waiting-room screens."
            checked={station.isPublic}
            onChange={(isPublic) => save({ isPublic })}
          />
        </section>

        <SaveFeedback feedback={feedback} />
      </div>
    </Card>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      <span className="mt-1.5 block">{children}</span>
      {hint && (
        <span className="mt-1 block text-body-sm text-on-surface-variant">
          {hint}
        </span>
      )}
    </label>
  );
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 size-4 rounded border-outline-variant text-primary focus:ring-primary"
      />
      <span className="min-w-0">
        <span className="block text-body-md text-on-surface">{label}</span>
        {hint && (
          <span className="block text-body-sm text-on-surface-variant">
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}
