import { useCallback, useState } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import type { ConfigProblem } from "@qman/domain";
import { cn } from "../../components/ui/cn.js";
import type { SaveResult } from "../../data/config-store.js";

/**
 * Save feedback for the administration portal.
 *
 * Configuration edits save as you type rather than behind a Save button, so the
 * portal has to be explicit about what happened — a silent refusal would look
 * identical to a successful save.
 */
export interface Feedback {
  tone: "saved" | "warning" | "error";
  messages: string[];
}

export function useSaveFeedback() {
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const report = useCallback((result: SaveResult) => {
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

export function SaveFeedback({ feedback }: { feedback: Feedback | null }) {
  if (!feedback) return null;

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
