import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, X } from "lucide-react";
import { cn } from "./cn.js";

/**
 * Action feedback.
 *
 * Clinical software must confirm that an action landed — a doctor who presses
 * "Send to Lab" and sees nothing change will press it again. Messages are
 * announced to screen readers through an `aria-live` region as well as shown,
 * because these screens are operated by keyboard at speed.
 */
export type AnnouncementTone = "success" | "error";

interface Announcement {
  id: number;
  tone: AnnouncementTone;
  message: string;
}

interface AnnouncerApi {
  announce: (message: string, tone?: AnnouncementTone) => void;
}

const AnnouncerContext = createContext<AnnouncerApi | null>(null);

export function useAnnouncer(): AnnouncerApi {
  const api = useContext(AnnouncerContext);
  if (!api) {
    throw new Error("useAnnouncer must be used inside <AnnouncerProvider>");
  }
  return api;
}

export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Announcement[]>([]);
  const nextId = useRef(0);

  const announce = useCallback(
    (message: string, tone: AnnouncementTone = "success") => {
      const id = (nextId.current += 1);
      setItems((current) => [...current, { id, tone, message }]);
      // Errors linger: they usually require the user to do something else.
      const ttl = tone === "error" ? 6000 : 3500;
      setTimeout(
        () => setItems((current) => current.filter((item) => item.id !== id)),
        ttl,
      );
    },
    [],
  );

  const api = useMemo(() => ({ announce }), [announce]);

  return (
    <AnnouncerContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-6 right-6 z-[60] flex w-full max-w-sm flex-col gap-2"
      >
        {items.map((item) => (
          <div
            key={item.id}
            role={item.tone === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex items-start gap-3 rounded-md border px-4 py-3 shadow-modal",
              item.tone === "error"
                ? "border-error/40 bg-error-container text-on-error-container"
                : "border-outline-variant bg-surface-container-lowest text-on-surface",
            )}
          >
            <span aria-hidden="true" className="mt-0.5 shrink-0">
              {item.tone === "error" ? (
                <CircleAlert className="size-4" />
              ) : (
                <CircleCheck className="size-4 text-tertiary" />
              )}
            </span>
            <p className="flex-1 text-body-sm">{item.message}</p>
            <button
              type="button"
              onClick={() =>
                setItems((current) => current.filter((i) => i.id !== item.id))
              }
              aria-label="Dismiss"
              className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </AnnouncerContext.Provider>
  );
}
