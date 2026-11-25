import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BranchId, DisplayBoardConfig } from "@qman/domain";
import { DisplayBoard } from "./features/display/DisplayBoard.js";
import { stores } from "./data/runtime-stores.js";
import { operationsStore } from "./data/operations-store.js";
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
const requestedBoardId = new URLSearchParams(window.location.search).get("board");

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
  config: stores.config,
});

/**
 * Renders once the hospital is known.
 *
 * A board shows nothing until it knows which stations it is displaying. An
 * empty grid and a board whose configuration failed to load look identical
 * from across a waiting room, and only one of them means "nobody is waiting".
 */
function BoardApp() {
  const [board, setBoard] = useState<DisplayBoardConfig | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void (async () => {
      await stores.config.load();
      if (stores.config.status !== "ready") {
        setFailed(true);
        return;
      }

      const chosen =
        (requestedBoardId !== null ? stores.config.board(requestedBoardId) : undefined) ??
        stores.config.config.displayBoards[0];

      if (chosen === undefined) {
        setFailed(true);
        return;
      }

      document.title = `QMan — ${chosen.name}`;
      setBoard(chosen);

      const branchId = stores.config.config.branches[0]?.id;
      if (branchId !== undefined) {
        await stores.clinic.load(branchId);
        stores.stream.start();
      }
    })();
  }, []);

  if (failed) {
    return (
      <main
        role="alert"
        className="grid min-h-screen place-items-center bg-background p-10 text-center"
      >
        <div className="space-y-2">
          <p className="text-headline-lg text-on-surface">
            This screen is not configured.
          </p>
          <p className="text-body-lg text-on-surface-variant">
            No display board was found. Add one in the Administration portal.
          </p>
        </div>
      </main>
    );
  }

  if (board === null) {
    return (
      <main
        role="status"
        className="grid min-h-screen place-items-center bg-background text-headline-md text-on-surface-variant"
      >
        Connecting…
      </main>
    );
  }

  return (
    <DisplayBoard
      config={board}
      branchId={stores.config.config.branches[0]!.id as BranchId}
      store={stores.clinic}
      operations={operationsStore}
    />
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root is missing from display.html");
}

createRoot(container).render(
  <StrictMode>
    <BoardApp />
  </StrictMode>,
);
