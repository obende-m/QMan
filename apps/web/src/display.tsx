import { StrictMode, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { PublicApi } from "./api/public-api.js";
import { PublicBoard } from "./features/display/PublicBoard.js";
import { browserChime, browserSpeech } from "./runtime/ports.js";
import "./index.css";

/**
 * The waiting-room display board.
 *
 * A kiosk with no session: it reads only the public board endpoint, which
 * resolves the board to its branch and organization on the server. The board
 * is chosen by its id in the URL, which is what the Administration portal
 * gives out:
 *   /display.html?board=<board id>
 */
const boardId = new URLSearchParams(window.location.search).get("board") ?? "";
const api = new PublicApi((import.meta.env["VITE_API_URL"] as string | undefined) ?? "");
const speech = browserSpeech();
const chime = browserChime();

function BoardApp() {
  /**
   * Called aloud, by ticket and place, never by name. Browsers block audio
   * until someone has interacted with the page; a board that has not been
   * tapped once stays silent rather than failing.
   */
  const announce = useCallback((ticket: string, station: string, room: string | null) => {
    void (async () => {
      try {
        await chime.play("soft");
        if (speech.supported) {
          const spoken = ticket.split("").join(" ");
          await speech.speak({
            text: `Ticket ${spoken}, please go to ${room ?? station}.`,
            language: document.documentElement.lang || "en",
            voice: null,
            repeat: 1,
          });
        }
      } catch {
        // Silence is a degraded board, not a broken one.
      }
    })();
  }, []);

  if (boardId === "") {
    return (
      <main className="grid min-h-screen place-items-center p-10 text-center">
        <div className="glass rounded-2xl px-10 py-8">
          <p className="text-headline-lg text-on-surface">This screen is not configured.</p>
          <p className="mt-2 text-body-md text-on-surface-variant">
            Open the board link from the Administration portal on this screen.
          </p>
        </div>
      </main>
    );
  }

  return <PublicBoard api={api} boardId={boardId} onCalled={announce} />;
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
