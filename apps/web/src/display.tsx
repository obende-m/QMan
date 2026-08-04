import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DisplayBoard } from "./features/display/DisplayBoard.js";
import { boardById, displayBoards } from "./data/display-boards.js";
import { clinicStore, eventBus, operationsStore } from "./data/bootstrap.js";
import { configStore } from "./data/config-store.js";
import { VoiceAnnouncer } from "./runtime/announcer.js";
import { browserChime, browserSpeech } from "./runtime/ports.js";
import "./index.css";

/**
 * The Display Board application.
 *
 * A separate entry point from the staff app, not a route inside it. Three
 * reasons, in order of weight:
 *
 *  1. It is unattended signage. A screen bolted to a waiting-room wall should
 *     not be one mis-click away from a receptionist's worklist, and it must
 *     survive a browser restart by loading straight back into the board.
 *  2. It ships no staff code. Nothing that can call, skip or route a patient
 *     is in this bundle at all, so a public screen cannot be made to mutate
 *     clinical state — a guarantee a client-side route cannot make.
 *  3. It has different runtime characteristics: no authentication, no
 *     navigation, and a lifetime measured in weeks rather than minutes.
 *
 * Which board to show comes from the URL, so one build serves every screen in
 * the hospital: /display.html?board=board-lab
 */
const params = new URLSearchParams(window.location.search);
const config = boardById(params.get("board") ?? displayBoards()[0]!.id);

document.title = `QMan — ${config.name}`;

/**
 * The board speaks. It is the one surface with a speaker in a room full of
 * patients, so voice announcements are registered here rather than in the staff
 * app — a receptionist's laptop announcing "Ticket A-023" at the desk would be
 * noise, not information.
 */
const announcer = new VoiceAnnouncer({
  speech: browserSpeech(),
  chime: browserChime(),
  operations: operationsStore,
  config: configStore,
});
eventBus.subscribe(announcer.subscriber());

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root is missing from display.html");
}

createRoot(container).render(
  <StrictMode>
    <DisplayBoard config={config} store={clinicStore} operations={operationsStore} />
  </StrictMode>,
);
