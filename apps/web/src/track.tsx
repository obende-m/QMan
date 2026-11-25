import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PublicApi } from "./api/public-api.js";
import { PublicTracker, type TrackerCredential } from "./features/track/PublicTracker.js";
import { registerServiceWorker, watchInstallability } from "./runtime/pwa.js";
import "./index.css";

/**
 * The Patient Journey Tracking application.
 *
 * The only surface in QMan a member of the public loads, so it is its own
 * bundle and it talks only to the public tracking endpoints. It holds no
 * session and never calls a staff endpoint: an earlier version did, and so
 * showed nothing at all to an actual patient.
 *
 * The URL carries the credential:
 *   /track.html?t=<token>          from the QR code on the ticket
 *   /track.html?b=<branch>         from a printed link, to type a code
 *   /track.html?b=<branch>&code=QM-8F4K
 */
const params = new URLSearchParams(window.location.search);
const token = params.get("t");
const branchId = params.get("b");
const code = params.get("code") ?? params.get("journey");

const initial: TrackerCredential | null = token
  ? { kind: "token", token }
  : branchId && code
    ? { kind: "code", branchId, code }
    : null;

// The token is a credential. Once read, it is removed from the address bar so
// it is not left in a screenshot, a shared link or the browser's history list.
if (token) {
  window.history.replaceState(null, "", window.location.pathname + (branchId ? `?b=${encodeURIComponent(branchId)}` : ""));
}

watchInstallability();
registerServiceWorker();

const api = new PublicApi((import.meta.env["VITE_API_URL"] as string | undefined) ?? "");

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root is missing from track.html");
}

createRoot(container).render(
  <StrictMode>
    <PublicTracker api={api} initial={initial} branchId={branchId} />
  </StrictMode>,
);
