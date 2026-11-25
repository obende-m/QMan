import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PatientJourney } from "./features/track/PatientJourney.js";
import { stores } from "./data/runtime-stores.js";
import { operationsStore } from "./data/operations-store.js";
import { registerServiceWorker, watchInstallability } from "./runtime/pwa.js";
import "./index.css";

/**
 * The Patient Journey Tracking application.
 *
 * Its own entry point for the same reason as the display board, but with more
 * force: this is the only surface in QMan a member of the public loads. Nothing
 * that can mutate clinical state — call, skip, route, escalate — belongs in
 * this bundle, and keeping it a separate build makes that a property of the
 * artefact rather than a promise about routing.
 *
 * It is also the smallest bundle in the product, which matters: patients open
 * it on hospital wi-fi or mobile data, often on older phones.
 *
 * The Journey Code arrives from the QR code in the URL, so scanning a ticket
 * lands the patient directly on their own journey:
 *   /track.html?code=QM-8F4K
 */
const params = new URLSearchParams(window.location.search);
const code = params.get("code") ?? params.get("journey") ?? undefined;

watchInstallability();
registerServiceWorker();

/**
 * Loads the hospital, then the branch, then renders.
 *
 * A patient's page needs the configuration to name the station they are at.
 * Rendering before it arrives would show "Station" where a room number belongs.
 */
function TrackerApp() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void (async () => {
      await stores.config.load();
      const branchId = stores.config.status === "ready"
        ? stores.config.config.branches[0]?.id
        : undefined;
      if (branchId !== undefined) {
        await stores.clinic.load(branchId);
        stores.stream.start();
      }
      setReady(true);
    })();
  }, []);

  if (!ready) {
    return (
      <main
        role="status"
        className="grid min-h-screen place-items-center text-body-lg text-on-surface-variant"
      >
        Loading…
      </main>
    );
  }

  return (
    /*
     * No alerts prop.
     *
     * TODO(backend): patient notifications need a public per-visit event
     * stream. `PatientAlerts` subscribes to domain events, and the only stream
     * that carries them is `/api/v1/stream`, which requires a staff session —
     * this surface is opened by a patient with no account. The public board
     * projection deliberately carries no Journey Code or visit id, so it
     * cannot be filtered to one patient either.
     *
     * The page still updates: it re-reads on the interval below. What is
     * missing is the push notification when a patient's own turn arrives.
     */
    <PatientJourney
      store={stores.clinic}
      {...(code ? { initialCode: code } : {})}
    />
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root is missing from track.html");
}

createRoot(container).render(
  <StrictMode>
    <TrackerApp />
  </StrictMode>,
);
