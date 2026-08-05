import { useState } from "react";
import { Star } from "lucide-react";
import {
  PAPER_SIZES,
  PAPER_SPECS,
  TICKET_ELEMENTS,
  TICKET_ELEMENT_LABELS,
  CONDITION_LABELS,
  ELEMENT_CONDITIONS,
  defaultConditionFor,
  parseJourneyCode,
  type ConfigProblem,
  type ElementCondition,
  type PaperSize,
  type TicketElement,
  type TicketTemplate,
} from "@qman/domain";
import { Card, CardHeader } from "../../components/ui/Card.js";
import { Button } from "../../components/ui/Button.js";
import { StatusChip } from "../../components/ui/StatusChip.js";
import { cn } from "../../components/ui/cn.js";
import type { ConfigStore } from "../../data/config-store.js";
import { inputClass } from "../../data/useConfig.js";
import { Field, Toggle } from "./StationsSection.js";
import { ProblemList, SaveFeedback, useSaveFeedback , DraftInput} from "./shared.js";
import { PrintableTicket } from "../printing/PrintableTicket.js";

/**
 * Ticket template configuration.
 *
 * Shows the actual ticket beside the controls, at true paper width. A ticket is
 * the one artefact a patient carries out of the building, and whether it works
 * is a question about physical layout — how much fits on a 58 mm roll, whether
 * the number is readable at arm's length — that no list of checkboxes can
 * answer.
 */
export function TicketsSection({
  store,
  problems,
}: {
  store: ConfigStore;
  problems: readonly ConfigProblem[];
}) {
  const [selectedId, setSelectedId] = useState(
    store.config.ticketTemplates[0]?.id ?? "",
  );
  const selected = store.config.ticketTemplates.find((t) => t.id === selectedId);
  const { feedback, report } = useSaveFeedback();

  const save = (change: Partial<TicketTemplate>) => {
    if (!selected) return;
    report(store.updateTicketTemplate(selected.id, change));
  };

  const toggleElement = (element: TicketElement, include: boolean) => {
    if (!selected) return;
    // Preserve the canonical order rather than append, so toggling an element
    // off and on again does not silently move it to the bottom of the ticket.
    const next = include
      ? TICKET_ELEMENTS.filter(
          (e) => selected.elements.some((s) => s.element === e) || e === element,
        ).map((e) => {
          const existing = selected.elements.find((s) => s.element === e);
          return existing ?? { element: e, condition: defaultConditionFor(e) };
        })
      : selected.elements.filter((s) => s.element !== element);
    save({ elements: next });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Ticket templates"
          subtitle="Different printers need different layouts."
        />
        <ul className="divide-y divide-outline-variant border-t border-outline-variant">
          {store.config.ticketTemplates.map((template) => {
            const isDefault =
              template.id === store.config.defaults.ticketTemplateId;
            return (
              <li key={template.id} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedId(template.id)}
                  className={cn(
                    "min-w-0 flex-1 px-gutter py-3 text-left transition-colors",
                    template.id === selectedId
                      ? "bg-surface-container-low"
                      : "hover:bg-surface-container-low",
                  )}
                >
                  <span className="block truncate text-body-md font-semibold text-on-surface">
                    {template.name}
                  </span>
                  <span className="font-mono text-label-caps uppercase text-on-surface-variant">
                    {PAPER_SPECS[template.paper].label} ·{" "}
                    {template.elements.length} elements
                  </span>
                </button>
                {isDefault ? (
                  <StatusChip tone="in-progress" label="Default" />
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Star className="size-4" />}
                    onClick={() =>
                      report(store.setDefaultTicketTemplate(template.id))
                    }
                  >
                    Make default
                  </Button>
                )}
                <span className="w-4" />
              </li>
            );
          })}
        </ul>
      </Card>

      {selected && (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_auto]">
          <Card>
            <CardHeader title={selected.name} />
            <div className="space-y-6 px-gutter pb-gutter">
              <ProblemList
                problems={problems.filter((p) =>
                  p.path.startsWith(`ticketTemplates.${selected.id}`),
                )}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Template name">
                  <DraftInput
                className={inputClass}
                value={selected.name}
                onCommit={(next) => save({ name: next })}
              />
                </Field>
                <Field label="Paper">
                  <select
                    className={inputClass}
                    value={selected.paper}
                    onChange={(e) =>
                      save({ paper: e.target.value as PaperSize })
                    }
                  >
                    {PAPER_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {PAPER_SPECS[size].label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <section>
                <h3 className="text-title-md font-semibold text-on-surface">
                  What to print
                </h3>
                <p className="mt-1 text-body-sm text-on-surface-variant">
                  Conditional elements keep a ticket compact without needing a
                  separate template for every variation.
                </p>
                <div className="mt-3 space-y-2">
                  {TICKET_ELEMENTS.map((element) => {
                    const spec = selected.elements.find(
                      (s) => s.element === element,
                    );
                    return (
                      <div
                        key={element}
                        className="flex flex-wrap items-center justify-between gap-3"
                      >
                        <Toggle
                          label={TICKET_ELEMENT_LABELS[element]}
                          checked={spec !== undefined}
                          onChange={(checked) => toggleElement(element, checked)}
                        />
                        {spec && (
                          <select
                            aria-label={`${TICKET_ELEMENT_LABELS[element]} condition`}
                            className={cn(inputClass, "w-auto shrink-0 py-1")}
                            value={spec.condition}
                            onChange={(e) =>
                              save({
                                elements: selected.elements.map((s) =>
                                  s.element === element
                                    ? {
                                        ...s,
                                        condition: e.target
                                          .value as ElementCondition,
                                      }
                                    : s,
                                ),
                              })
                            }
                          >
                            {ELEMENT_CONDITIONS.map((condition) => (
                              <option key={condition} value={condition}>
                                {CONDITION_LABELS[condition]}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="space-y-4">
                <h3 className="text-title-md font-semibold text-on-surface">
                  Wording
                </h3>
                <p className="text-body-sm text-on-surface-variant">
                  Tokens: <code className="font-mono">{"{ticket}"}</code>{" "}
                  <code className="font-mono">{"{journey}"}</code>{" "}
                  <code className="font-mono">{"{station}"}</code>{" "}
                  <code className="font-mono">{"{room}"}</code>{" "}
                  <code className="font-mono">{"{hospital}"}</code>{" "}
                  <code className="font-mono">{"{branch}"}</code>
                </p>
                <Field label="Instructions">
                  <DraftInput
                className={inputClass}
                value={selected.instructions}
                onCommit={(next) => save({ instructions: next })}
              />
                </Field>
                <Field label="Footer message">
                  <DraftInput
                className={inputClass}
                value={selected.footer}
                onCommit={(next) => save({ footer: next })}
              />
                </Field>
                <Field
                  label="Tracking URL"
                  hint="Encoded into the QR code, with the journey code appended."
                >
                  <DraftInput
                className={inputClass}
                value={selected.trackingUrl}
                onCommit={(next) => save({ trackingUrl: next })}
              />
                </Field>
              </section>

              <SaveFeedback feedback={feedback} />
            </div>
          </Card>

          <Card className="self-start">
            <CardHeader title="Preview" subtitle="Shown at true paper width." />
            <div className="flex justify-center bg-surface-container p-gutter">
              <div className="shadow-card ring-1 ring-outline-variant">
                <PrintableTicket
                  template={selected}
                  context={{
                    ticket: "A-023",
                    journeyCode: parseJourneyCode("QM-8F4K"),
                    patientName: "Amara Okafor",
                    hospitalName: store.config.profile.name,
                    branchName: store.config.branches[0]?.name ?? "",
                    stationName: "Consultation",
                    room: "Room 12",
                    assignedTo: "Dr Adams",
                    branchCount: store.config.branches.length,
                    issuedAt: new Date(),
                    logoUrl: null,
                  }}
                />
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
