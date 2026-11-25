import { useState } from "react";
import { XCircle } from "lucide-react";
import { PRIORITIES, UserId, type Priority, type Visit } from "@qman/domain";
import { Button } from "../../components/ui/Button.js";
import type { ClinicStore } from "../../data/clinic-store.js";

const LABELS: Record<Priority, string> = {
  emergency: "Emergency",
  high: "Urgent",
  vip: "VIP",
  normal: "Normal",
};

/**
 * The two corrections a reception desk makes to a visit already admitted:
 * raising or lowering its priority, and cancelling it.
 *
 * Each is shown only to someone holding its permission, and each is decided by
 * the server — a cancelled or closed visit refuses both, and the answer is
 * shown where the action was taken.
 */
export function VisitRowActions({
  visit,
  clinic,
  canEscalate,
  canCancel,
}: {
  visit: Visit;
  clinic: ClinicStore;
  canEscalate: boolean;
  canCancel: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const open = visit.status !== "completed" && visit.status !== "cancelled" && visit.status !== "closed";

  if (!open || (!canEscalate && !canCancel)) return null;

  const changePriority = async (priority: string) => {
    setError(null);
    const result = await clinic.changePriority(visit.id, priority);
    if (!result.ok) setError(result.message);
  };

  const cancel = async () => {
    setError(null);
    const result = await clinic.cancel(visit.id, UserId(""), reason.trim() || undefined);
    if (!result.ok) setError(result.message);
    else setConfirming(false);
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        {canEscalate && (
          <select
            aria-label={`Priority for ${visit.journeyCode}`}
            className="field h-8 w-auto py-0 text-body-sm"
            value={visit.priority}
            onChange={(e) => void changePriority(e.target.value)}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {LABELS[p]}
              </option>
            ))}
          </select>
        )}
        {canCancel && !confirming && (
          <Button
            size="sm"
            variant="ghost"
            icon={<XCircle className="size-4" />}
            aria-label={`Cancel visit ${visit.journeyCode}`}
            onClick={() => setConfirming(true)}
          >
            Cancel
          </Button>
        )}
      </div>
      {confirming && (
        <div className="flex items-center gap-1">
          <input
            className="field h-8 w-40 text-body-sm"
            placeholder="Reason (optional)"
            aria-label="Reason for cancelling"
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button size="sm" variant="danger" onClick={() => void cancel()}>
            Confirm cancel
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-body-sm text-error">
          {error}
        </p>
      )}
    </div>
  );
}
