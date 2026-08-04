import { useEffect, useState } from "react";
import { BellRing, Download, Check } from "lucide-react";
import type { VisitId } from "@qman/domain";
import { Button } from "../../components/ui/Button.js";
import { cn } from "../../components/ui/cn.js";
import type { Notifier } from "../../runtime/notifier.js";
import type { EventBus } from "../../data/event-bus.js";
import {
  canInstall,
  isInstalled,
  onInstallabilityChange,
  promptInstall,
} from "../../runtime/pwa.js";

/**
 * The patient's control over alerts and installation.
 *
 * Permission is requested on an explicit tap, never on page load. A browser
 * permission prompt that appears before the patient understands what it is for
 * gets dismissed, and a dismissed prompt cannot be asked again — so the one
 * chance to enable the feature that lets them leave their seat is spent on a
 * dialogue they had no reason to accept.
 */
export interface PatientAlertsProps {
  visitId: VisitId;
  notifier: Notifier;
  bus: EventBus;
}

export function PatientAlerts({ visitId, notifier, bus }: PatientAlertsProps) {
  const [permission, setPermission] = useState(() => notifier.permission);
  const [installable, setInstallable] = useState(canInstall);
  const installed = isInstalled();

  // Subscribe only once the patient has agreed, so nothing is delivered — or
  // recorded as denied — before they have made a choice.
  useEffect(() => {
    if (permission !== "granted") return;
    return bus.subscribe(notifier.patientSubscriber(visitId));
  }, [bus, notifier, visitId, permission]);

  useEffect(() => onInstallabilityChange(setInstallable), []);

  const enable = async () => {
    setPermission(await notifier.requestPermission());
  };

  if (permission === "unsupported" && !installable && !installed) {
    return null;
  }

  return (
    <section
      aria-label="Alerts"
      className="mt-4 rounded-xl border border-outline-variant bg-surface-container-low p-4"
    >
      {permission === "granted" ? (
        <p className="flex items-center gap-2 text-body-sm text-tertiary">
          <Check aria-hidden="true" className="size-4 shrink-0" />
          Alerts are on. You can put your phone away — we'll tell you when it's
          your turn.
        </p>
      ) : permission === "denied" ? (
        <p className="text-body-sm text-on-surface-variant">
          Alerts are blocked in your browser settings. This page still updates on
          its own while it's open.
        </p>
      ) : permission === "unsupported" ? (
        <p className="text-body-sm text-on-surface-variant">
          This browser can't send alerts. This page still updates on its own
          while it's open.
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 flex-1 text-body-sm text-on-surface">
            Get an alert when it's your turn, so you don't have to watch the
            screen.
          </p>
          <Button
            size="sm"
            icon={<BellRing className="size-4" />}
            onClick={enable}
          >
            Turn on alerts
          </Button>
        </div>
      )}

      {installable && !installed && (
        <div
          className={cn(
            "mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-outline-variant pt-3",
          )}
        >
          <p className="min-w-0 flex-1 text-body-sm text-on-surface-variant">
            Add QMan to your home screen to reopen your visit without scanning
            again.
          </p>
          <Button
            variant="secondary"
            size="sm"
            icon={<Download className="size-4" />}
            onClick={() => void promptInstall()}
          >
            Add to home screen
          </Button>
        </div>
      )}
    </section>
  );
}
