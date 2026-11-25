import { useCallback, useEffect, useState } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import type { ConfigProblem } from "@qman/domain";
import { cn } from "../../components/ui/cn.js";
import type { SaveResult } from "../../data/config-store.js";

/**
 * Save feedback for the administration portal.
 *
 * Configuration edits commit when a field is finished with rather than behind a
 * global Save button, so the portal has to be explicit about what happened — a
 * silent refusal would look identical to a successful save.
 */
export interface Feedback {
  tone: "saving" | "saved" | "warning" | "error";
  messages: string[];
}

export function useSaveFeedback() {
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  /**
   * Takes the promise a save now returns.
   *
   * Saving reaches the server, so the outcome arrives later than the keystroke
   * that caused it. Reporting on the promise keeps every call site a single
   * expression, and keeps "saving" from being a state each section tracks for
   * itself.
   */
  const report = useCallback(async (pending: Promise<SaveResult> | SaveResult) => {
    setFeedback({ tone: "saving", messages: [] });
    const result = await pending;
    if (!result.ok) {
      setFeedback({
        tone: "error",
        messages: result.problems.map((p) => p.message),
      });
      return result;
    }
    if (result.warnings.length > 0) {
      setFeedback({
        tone: "warning",
        messages: result.warnings.map((p) => p.message),
      });
      return result;
    }
    setFeedback({ tone: "saved", messages: [] });
    return result;
  }, []);

  return { feedback, report };
}

/**
 * An input that commits when the edit is finished, not on every keystroke.
 *
 * The portal used to save on `onChange`, which was free when the configuration
 * lived in memory. Against the API it is one PATCH and one audit entry per
 * character typed — a hospital renamed from "Ikeja" to "Ikeja General" writes
 * eight rows into the audit trail, seven of them describing names that never
 * existed. The trail is meant to answer "who changed this and to what", and
 * that noise is how it stops being readable.
 *
 * Committing on blur rather than behind a Save button keeps the existing feel
 * of the portal: a field is edited and it is saved, with no extra step.
 * Enter commits too, because a keyboard user should not have to leave the field
 * to find out whether it was accepted.
 */
export function DraftInput({
  value,
  onCommit,
  className,
  ...rest
}: {
  value: string;
  onCommit: (next: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [draft, setDraft] = useState(value);

  // Follows the store when the value changes underneath — another
  // administrator's edit, or the server normalising what was just sent.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = (): void => {
    if (draft !== value) onCommit(draft);
  };

  return (
    <input
      {...rest}
      className={className}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") setDraft(value);
      }}
    />
  );
}

export function SaveFeedback({ feedback }: { feedback: Feedback | null }) {
  if (!feedback) return null;

  if (feedback.tone === "saving") {
    return (
      <p role="status" className="text-body-sm text-on-surface-variant">
        Saving…
      </p>
    );
  }

  if (feedback.tone === "saved") {
    return (
      <p
        role="status"
        className="flex items-center gap-2 text-body-sm text-tertiary"
      >
        <CircleCheck aria-hidden="true" className="size-4" />
        Saved.
      </p>
    );
  }

  return (
    <div
      role={feedback.tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-md border p-3",
        feedback.tone === "error"
          ? "border-error/40 bg-error-container/40"
          : "border-warning/40 bg-warning-container/30",
      )}
    >
      <p
        className={cn(
          "flex items-center gap-2 text-body-sm font-semibold",
          feedback.tone === "error" ? "text-error" : "text-on-surface",
        )}
      >
        <TriangleAlert aria-hidden="true" className="size-4" />
        {feedback.tone === "error"
          ? "Not saved — this change would break the configuration."
          : "Saved, with suggestions."}
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-8 text-body-sm text-on-surface-variant">
        {feedback.messages.map((message, index) => (
          <li key={index}>{message}</li>
        ))}
      </ul>
    </div>
  );
}

export function ProblemList({
  problems,
}: {
  problems: readonly ConfigProblem[];
}) {
  if (problems.length === 0) return null;

  return (
    <ul className="space-y-1">
      {problems.map((problem, index) => (
        <li
          key={index}
          className={cn(
            "flex items-start gap-2 rounded-md border p-2 text-body-sm",
            problem.severity === "error"
              ? "border-error/40 bg-error-container/30 text-on-surface"
              : "border-warning/40 bg-warning-container/30 text-on-surface",
          )}
        >
          <TriangleAlert
            aria-hidden="true"
            className={cn(
              "mt-0.5 size-4 shrink-0",
              problem.severity === "error" ? "text-error" : "text-warning",
            )}
          />
          {problem.message}
        </li>
      ))}
    </ul>
  );
}
