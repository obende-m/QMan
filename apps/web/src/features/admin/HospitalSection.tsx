import {
  PATIENT_NAME_POLICIES,
  describeNamePolicy,
  type ConfigProblem,
  type PatientNamePolicy,
} from "@qman/domain";
import { Card, CardHeader } from "../../components/ui/Card.js";
import { StatusChip } from "../../components/ui/StatusChip.js";
import type { ConfigStore } from "../../data/config-store.js";
import { inputClass } from "../../data/useConfig.js";
import { Field } from "./StationsSection.js";
import { ProblemList, SaveFeedback, useSaveFeedback , DraftInput} from "./shared.js";

export function HospitalSection({
  store,
  problems,
}: {
  store: ConfigStore;
  problems: readonly ConfigProblem[];
}) {
  const { feedback, report } = useSaveFeedback();
  const profile = store.config.profile;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Hospital profile" />
        <div className="space-y-4 px-gutter pb-gutter">
          <ProblemList problems={problems.filter((p) => p.path.startsWith("profile"))} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <DraftInput
                className={inputClass}
                value={profile.name}
                onCommit={(next) => report(store.updateProfile({ name: next }))}
              />
            </Field>
            <Field label="Code">
              <DraftInput
                className={inputClass}
                value={profile.code}
                onCommit={(next) => report(store.updateProfile({ code: next.toUpperCase() }))}
              />
            </Field>
            <Field label="Timezone" hint="Determines when daily queue series roll over.">
              <DraftInput
                className={inputClass}
                value={profile.timezone}
                onCommit={(next) => report(store.updateProfile({ timezone: next }))}
              />
            </Field>
            <Field label="Support phone" hint="Shown to patients who need help.">
              <DraftInput
                className={inputClass}
                value={profile.supportPhone ?? ""}
                onCommit={(next) => report(store.updateProfile({ supportPhone: next || null }))}
              />
            </Field>
            <Field label="Brand colour" hint="Applied to patient-facing surfaces.">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Brand colour"
                  value={profile.brandColor}
                  onChange={(e) =>
                    report(store.updateProfile({ brandColor: e.target.value }))
                  }
                  className="size-10 shrink-0 cursor-pointer rounded border border-outline-variant bg-transparent"
                />
                <DraftInput
                className={inputClass}
                value={profile.brandColor}
                onCommit={(next) => report(store.updateProfile({ brandColor: next }))}
              />
              </div>
            </Field>
          </div>

          <SaveFeedback feedback={feedback} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Privacy"
          subtitle="How much of a patient's name may appear on any surface."
        />
        <div className="space-y-3 px-gutter pb-gutter">
          <Field
            label="Default name policy"
            hint="Display boards may override this. Notifications and printed tickets will inherit it."
          >
            <select
              className={inputClass}
              value={store.config.defaults.namePolicy}
              onChange={(e) =>
                report(
                  store.setDefaultNamePolicy(e.target.value as PatientNamePolicy),
                )
              }
            >
              {PATIENT_NAME_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {describeNamePolicy(policy)}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-body-sm text-on-surface-variant">
            QMan holds only the minimum patient information needed to run a
            visit. Medical records, results and billing stay in your HMS.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader title="Branches" subtitle="Sites operating under this hospital." />
        <ul className="divide-y divide-outline-variant border-t border-outline-variant">
          {store.config.branches.map((branch) => (
            <li
              key={branch.id}
              className="flex items-center gap-3 px-gutter py-3"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body-md font-semibold text-on-surface">
                  {branch.name}
                </span>
                <span className="font-mono text-label-caps uppercase text-on-surface-variant">
                  {branch.code}
                </span>
              </span>
              {branch.isDefault && <StatusChip tone="in-progress" label="Default" />}
            </li>
          ))}
        </ul>
        <p className="px-gutter pb-gutter text-body-sm text-on-surface-variant">
          Multi-branch configuration needs persistence to be meaningful — each
          branch carries its own stations, workflows and boards.
        </p>
      </Card>
    </div>
  );
}
