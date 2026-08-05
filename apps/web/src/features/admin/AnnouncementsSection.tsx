import { useState } from "react";
import { Volume2 } from "lucide-react";
import {
  ANNOUNCEMENT_EVENTS,
  parseJourneyCode,
  renderAnnouncement,
  validateAnnouncementConfig,
  type AnnouncementConfig,
  type AnnouncementEvent,
} from "@qman/domain";
import { Card, CardHeader } from "../../components/ui/Card.js";
import { Button } from "../../components/ui/Button.js";
import { cn } from "../../components/ui/cn.js";
import type { ConfigStore } from "../../data/config-store.js";
import type { OperationsStore } from "../../data/operations-store.js";
import { inputClass, labelClass } from "../../data/useConfig.js";
import { Field, Toggle } from "./StationsSection.js";
import { DraftInput } from "./shared.js";

const EVENT_LABELS: Record<AnnouncementEvent, string> = {
  called: "Patient called",
  recalled: "Patient recalled",
  routed: "Patient routed onward",
  next_in_line: "Patient is next in line",
  completed: "Visit completed",
};

/**
 * Announcement configuration.
 *
 * The rendered text drives the spoken announcement, the patient's notification
 * and the audit entry alike (ADR-030), so this screen previews exactly what a
 * patient will hear and read. A template is unreadable as a string and obvious
 * as a sentence.
 */
export function AnnouncementsSection({
  store,
  operations,
}: {
  store: ConfigStore;
  operations: OperationsStore;
}) {
  const [draft, setDraft] = useState<AnnouncementConfig>(
    operations.announcementConfig,
  );
  const problems = validateAnnouncementConfig(draft);

  const apply = (change: Partial<AnnouncementConfig>) => {
    const next = { ...draft, ...change };
    setDraft(next);
    // Saved only when valid; the preview and problem list keep working either
    // way so an administrator can see what they are fixing.
    if (validateAnnouncementConfig(next).length === 0) {
      operations.setAnnouncementConfig(next);
    }
  };

  const preview = (event: AnnouncementEvent): string =>
    renderAnnouncement(draft, event, {
      ticket: "A-023",
      journeyCode: parseJourneyCode("QM-8F4K"),
      patientName: "Amara Okafor",
      stationName: "Consultation",
      room: "Room 2",
      hospitalName: store.config.profile.name,
      namePolicy: store.config.defaults.namePolicy,
    });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Announcements"
          subtitle="What patients hear in the waiting room and read on their phone."
          action={
            <Toggle
              label="Enabled"
              checked={draft.enabled}
              onChange={(enabled) => apply({ enabled })}
            />
          }
        />

        <div className="space-y-6 px-gutter pb-gutter">
          {problems.length > 0 && (
            <ul
              role="alert"
              className="space-y-1 rounded-md border border-error/40 bg-error-container/30 p-3"
            >
              {problems.map((problem, index) => (
                <li key={index} className="text-body-sm text-on-surface">
                  {problem}
                </li>
              ))}
            </ul>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Language" hint="Used by the speech voice, e.g. en-NG.">
              <DraftInput
                className={inputClass}
                value={draft.language}
                onCommit={(next) => apply({ language: next })}
              />
            </Field>
            <Field label="Chime" hint="Played before the announcement.">
              <select
                className={inputClass}
                value={draft.chime}
                onChange={(e) =>
                  apply({ chime: e.target.value as AnnouncementConfig["chime"] })
                }
              >
                <option value="none">No chime</option>
                <option value="soft">Soft</option>
                <option value="bell">Bell</option>
              </select>
            </Field>
            <Field
              label="Repeat"
              hint="Twice is common in a noisy hall."
            >
              <input
                type="number"
                min={1}
                max={3}
                className={inputClass}
                value={draft.repeat}
                onChange={(e) => apply({ repeat: Number(e.target.value) })}
              />
            </Field>
          </div>

          <section className="space-y-4">
            <h3 className="text-title-md font-semibold text-on-surface">
              Wording
            </h3>
            <p className="text-body-sm text-on-surface-variant">
              Tokens: <code className="font-mono">{"{ticket}"}</code>{" "}
              <code className="font-mono">{"{journey}"}</code>{" "}
              <code className="font-mono">{"{name}"}</code>{" "}
              <code className="font-mono">{"{station}"}</code>{" "}
              <code className="font-mono">{"{room}"}</code>. Names appear only
              where your privacy policy allows.
            </p>

            {ANNOUNCEMENT_EVENTS.map((event) => (
              <div key={event}>
                <Field label={EVENT_LABELS[event]}>
                  <DraftInput
                    className={cn(inputClass, "font-mono")}
                    value={draft.templates[event]}
                    onCommit={(next) =>
                      apply({
                        templates: {
                          ...draft.templates,
                          [event]: next,
                        },
                      })
                    }
                  />
                </Field>
                <p
                  aria-label={`${EVENT_LABELS[event]} preview`}
                  className="mt-1.5 flex items-start gap-2 rounded-md border border-outline-variant bg-surface-container-low p-3 text-body-sm text-on-surface"
                >
                  <Volume2
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-on-surface-variant"
                  />
                  “{preview(event)}”
                </p>
              </div>
            ))}
          </section>

          <div>
            <p className={labelClass}>Try it</p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              icon={<Volume2 className="size-4" />}
              onClick={() => {
                if (typeof window === "undefined") return;
                if (!("speechSynthesis" in window)) return;
                const utterance = new SpeechSynthesisUtterance(preview("called"));
                utterance.lang = draft.language;
                window.speechSynthesis.speak(utterance);
              }}
            >
              Speak sample announcement
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
