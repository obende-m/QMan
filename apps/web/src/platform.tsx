/**
 * The Platform application.
 *
 * A fourth entry point, for the same reason the Display Board is a separate one
 * rather than a route: it is a different trust domain with a different
 * authentication model, and shipping it inside the staff bundle would put the
 * code that creates and suspends organizations into the bundle every hospital
 * receptionist downloads.
 *
 * It builds its own client and its own store. It deliberately does not import
 * `stores` from `runtime-stores.js` — that composition root owns the
 * organization session, the configuration and the clinic stream, and none of
 * them mean anything here.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiClient } from "./api/client.js";
import { PlatformApi } from "./data/platform-api.js";
import { PlatformStore } from "./data/platform-store.js";
import { PlatformPortal } from "./features/platform/PlatformPortal.js";
import "./index.css";

const API_BASE_URL = (import.meta.env["VITE_API_URL"] as string | undefined) ?? "";

const store = new PlatformStore(new PlatformApi(new ApiClient({ baseUrl: API_BASE_URL })));

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root is missing from platform.html");
}

createRoot(container).render(
  <StrictMode>
    <PlatformPortal store={store} />
  </StrictMode>,
);
