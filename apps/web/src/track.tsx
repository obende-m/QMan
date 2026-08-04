import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PatientJourney } from "./features/track/PatientJourney.js";
import { clinicStore, eventBus, operationsStore } from "./data/bootstrap.js";
import { configStore } from "./data/config-store.js";
import { Notifier } from "./runtime/notifier.js";
import { browserNotifications } from "./runtime/ports.js";
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

const notifier = new Notifier({
  notifications: browserNotifications(),
  operations: operationsStore,
  config: configStore,
});

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root is missing from track.html");
}

createRoot(container).render(
  <StrictMode>
    <PatientJourney
      store={clinicStore}
      {...(code ? { initialCode: code } : {})}
      alerts={{ notifier, bus: eventBus }}
    />
  </StrictMode>,
);
