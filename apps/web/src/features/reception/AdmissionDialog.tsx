import { useEffect, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, Printer, TriangleAlert, UserPlus, X } from "lucide-react";
import { PRIORITIES, type Priority, type Visit } from "@qman/domain";
import { Button } from "../../components/ui/Button.js";
import { JourneyCode } from "../../components/ui/JourneyCode.js";
import type { ClinicStore } from "../../data/clinic-store.js";
import type { ConfigStore } from "../../data/config-store.js";
import { stationName, stationRoom } from "../../data/clinic-projections.js";
import { randomId } from "../../data/ids.js";
import { TicketPrintDialog } from "../printing/TicketPrintDialog.js";

const PRIORITY_LABELS: Record<Priority, string> = {
  emergency: "Emergency",
  high: "Urgent",
  vip: "VIP",
  normal: "Normal",
};

export interface AdmissionDialogProps {
  clinic: ClinicStore;
  config: ConfigStore;
  /** Whether the user may raise a patient above the ordinary queue. */
  canSetPriority: boolean;
  onClose: () => void;
}

/**
 * Admitting a patient.
 *
 * The receptionist enters the minimum QMan holds — a name, optionally the HMS
 * number and a phone — chooses the journey where there is more than one, and
 * the server issues the Journey Code and the first station's ticket.
 *
 * **One form, one admission.** The idempotency key is created when the form
 * opens and reused for every submission of it. A receptionist who presses
 * Admit again because the network was slow gets the same visit back, not a
 * second patient in the queue.
 */
export function AdmissionDialog({ clinic, config, canSetPriority, onClose }: AdmissionDialogProps) {
  const [key] = useState(() => randomId());
  const [name, setName] = useState("");
  const [hospitalNumber, setHospitalNumber] = useState("");
  const [phone, setPhone] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const workflows = config.config.workflows;
  const [workflowId, setWorkflowId] = useState(
    () => (workflows.find((w) => w.isDefault) ?? workflows[0])?.id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [admitted, setAdmitted] = useState<{ visit: Visit; token: string } | null>(null);
  const [printing, setPrinting] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstField.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !printing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, printing]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") {
      setError("Enter the patient's name.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await clinic.admit(
      {
        patientName: name.trim(),
        ...(hospitalNumber.trim() ? { hospitalNumber: hospitalNumber.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(priority !== "normal" ? { priority } : {}),
        ...(workflowId ? { workflowId } : {}),
      },
      key,
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (result.visit && result.trackingToken) {
      setAdmitted({ visit: result.visit, token: result.trackingToken });
    }
  };

  const template = config.ticketTemplate();
  const entry = admitted?.visit.currentEntry;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-inverse-surface/30 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="admission-title"
        className="glass-strong glass-raised w-full max-w-lg rounded-2xl"
      >
        <header className="flex items-center gap-3 border-b border-outline-variant/60 px-gutter py-4">
          <span aria-hidden="true" className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
            <UserPlus className="size-5" />
          </span>
          <h2 id="admission-title" className="text-title-md font-semibold text-on-surface">
            {admitted ? "Patient admitted" : "Admit a patient"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto rounded-full p-2 text-on-surface-variant hover:bg-surface-container-high"
          >
            <X className="size-5" />
          </button>
        </header>

        {admitted && entry ? (
          <div className="space-y-5 p-gutter">
            <div className="flex items-start gap-3 rounded-xl border border-tertiary/30 bg-tertiary/10 p-4">
              <CheckCircle2 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-tertiary" />
              <p className="text-body-md text-on-surface">
                {admitted.visit.patient.name || "The patient"} is queued at{" "}
                <strong>{stationName(config.config, entry.stationId)}</strong>.
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-4">
              <div className="rounded-xl border border-outline-variant/70 bg-surface-container-lowest/70 p-4">
                <dt className="font-mono text-label-caps uppercase text-on-surface-variant">Ticket</dt>
                <dd className="mt-1 font-mono text-headline-lg font-semibold text-primary">{entry.queueLabel}</dd>
              </div>
              <div className="rounded-xl border border-outline-variant/70 bg-surface-container-lowest/70 p-4">
                <dt className="font-mono text-label-caps uppercase text-on-surface-variant">Journey code</dt>
                <dd className="mt-2">
                  <JourneyCode code={admitted.visit.journeyCode} />
                </dd>
              </div>
            </dl>
            <p className="text-body-sm text-on-surface-variant">
              The printed ticket carries a QR code that opens the patient's own tracking page. It
              is shown only now; reprinting later issues a new code and retires this one.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                Done
              </Button>
              {template && (
                <Button icon={<Printer className="size-4" />} onClick={() => setPrinting(true)}>
                  Print ticket
                </Button>
              )}
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4 p-gutter" noValidate>
            {error && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-md border border-error/40 bg-error-container/40 p-3 text-body-sm text-on-surface"
              >
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-error" />
                {error}
              </p>
            )}
            <label className="block">
              <span className="field-label">Patient name</span>
              <input
                ref={firstField}
                className="field"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                autoComplete="off"
                required
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="field-label">Hospital number <span className="font-normal text-on-surface-variant">(optional)</span></span>
                <input
                  className="field font-mono"
                  value={hospitalNumber}
                  onChange={(e) => setHospitalNumber(e.target.value)}
                  maxLength={64}
                  autoComplete="off"
                />
              </label>
              <label className="block">
                <span className="field-label">Phone <span className="font-normal text-on-surface-variant">(optional)</span></span>
                <input
                  className="field"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  maxLength={32}
                  autoComplete="off"
                />
              </label>
            </div>
            {workflows.length > 1 && (
              <label className="block">
                <span className="field-label">Journey</span>
                <select className="field" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
                  {workflows.map((workflow) => (
                    <option key={workflow.id} value={workflow.id}>
                      {workflow.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {canSetPriority && (
              <fieldset>
                <legend className="field-label">Priority</legend>
                <div className="flex flex-wrap gap-2">
                  {[...PRIORITIES].reverse().map((option) => (
                    <label
                      key={option}
                      className={
                        "cursor-pointer rounded-full border px-4 py-2 text-body-sm font-semibold transition-colors " +
                        (priority === option
                          ? option === "emergency"
                            ? "border-error bg-error-container text-on-error-container"
                            : "border-primary bg-primary/10 text-primary"
                          : "border-outline-variant bg-surface-container-lowest/70 text-on-surface-variant hover:bg-surface-container-high")
                      }
                    >
                      <input
                        type="radio"
                        name="priority"
                        value={option}
                        checked={priority === option}
                        onChange={() => setPriority(option)}
                        className="sr-only"
                      />
                      {PRIORITY_LABELS[option]}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy} icon={<UserPlus className="size-4" />}>
                {busy ? "Admitting…" : "Admit"}
              </Button>
            </div>
          </form>
        )}
      </div>

      {printing && admitted && entry && template && (
        <TicketPrintDialog
          template={template}
          context={{
            ticket: entry.queueLabel,
            journeyCode: admitted.visit.journeyCode,
            patientName: admitted.visit.patient.name,
            hospitalName: config.config.profile.name,
            branchName: config.config.branches.find((b) => b.id === admitted.visit.branchId)?.name ?? "",
            stationName: stationName(config.config, entry.stationId),
            room: stationRoom(config.config, entry.stationId),
            assignedTo: null,
            branchCount: config.config.branches.length,
            issuedAt: admitted.visit.createdAt,
            logoUrl: null,
            trackingToken: admitted.token,
          }}
          onClose={() => setPrinting(false)}
        />
      )}
    </div>
  );
}
