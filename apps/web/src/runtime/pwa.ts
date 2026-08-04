/**
 * Progressive Web App plumbing for the Patient Journey Tracker.
 *
 * Installation matters more here than it usually does: a patient who scanned a
 * QR code once has no bookmark and no way back if they close the tab. Adding it
 * to the home screen turns a one-shot link into something they can reopen from
 * the waiting-room chair without hunting for the ticket again.
 */

export function registerServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }
  // Registration after load, so it never competes with the first paint on the
  // slow connections this app is most often opened on.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // A tracker that cannot cache still works; failing loudly here would help
      // nobody standing in a queue.
    });
  });
}

/** The `beforeinstallprompt` event, which TypeScript does not model. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredPrompt: InstallPromptEvent | null = null;
const listeners = new Set<(available: boolean) => void>();

export function watchInstallability(): void {
  if (typeof window === "undefined") return;

  window.addEventListener("beforeinstallprompt", (event) => {
    // Chrome shows its own banner unless this is prevented; the app offers the
    // prompt at a moment that makes sense instead.
    event.preventDefault();
    deferredPrompt = event as InstallPromptEvent;
    notify(true);
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notify(false);
  });
}

export function onInstallabilityChange(
  listener: (available: boolean) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function canInstall(): boolean {
  return deferredPrompt !== null;
}

export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!deferredPrompt) return "unavailable";
  await deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  // The prompt is single-use; a dismissed prompt cannot be replayed.
  deferredPrompt = null;
  notify(false);
  return outcome;
}

/** True when running from the home screen rather than a browser tab. */
export function isInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari predates the standard and reports this instead.
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

function notify(available: boolean): void {
  for (const listener of listeners) listener(available);
}
