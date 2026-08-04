/**
 * Browser capability ports.
 *
 * Speech synthesis, the Notification API and audio playback are all unavailable
 * in tests, unavailable on some devices, and behave differently across
 * browsers. Wrapping each in a narrow port means the announcement and
 * notification logic — which is where the product decisions live — is testable
 * without a browser, and a device that lacks a capability degrades to a
 * recorded `unsupported` outcome rather than an exception.
 */

export type PermissionState = "granted" | "denied" | "default" | "unsupported";

export interface NotificationPort {
  readonly supported: boolean;
  permission(): PermissionState;
  requestPermission(): Promise<PermissionState>;
  /** Resolves once shown. Rejects if the platform refused. */
  show(input: {
    title: string;
    body: string;
    tag: string;
    /** Requires interaction to dismiss — used for "it's your turn". */
    requireInteraction?: boolean;
  }): Promise<void>;
}

export interface SpeechPort {
  readonly supported: boolean;
  speak(input: {
    text: string;
    language: string;
    voice: string | null;
    repeat: number;
  }): Promise<void>;
  cancel(): void;
}

export interface ChimePort {
  play(kind: "none" | "soft" | "bell"): Promise<void>;
}

// --------------------------------------------------------- browser adapters

export function browserNotifications(): NotificationPort {
  const supported =
    typeof window !== "undefined" && "Notification" in window;

  return {
    supported,
    permission() {
      if (!supported) return "unsupported";
      return Notification.permission as PermissionState;
    },
    async requestPermission() {
      if (!supported) return "unsupported";
      // Safari historically returned via callback rather than promise.
      const result = await Notification.requestPermission();
      return result as PermissionState;
    },
    async show({ title, body, tag, requireInteraction = false }) {
      if (!supported) throw new Error("Notifications are not supported");
      if (Notification.permission !== "granted") {
        throw new Error("Notification permission not granted");
      }
      // `tag` collapses repeats: a patient recalled three times sees their
      // notification update rather than stacking three of them.
      new Notification(title, { body, tag, requireInteraction });
    },
  };
}

export function browserSpeech(): SpeechPort {
  const supported =
    typeof window !== "undefined" && "speechSynthesis" in window;

  return {
    supported,
    async speak({ text, language, voice, repeat }) {
      if (!supported) throw new Error("Speech synthesis is not supported");

      for (let i = 0; i < Math.max(1, repeat); i += 1) {
        await new Promise<void>((resolve, reject) => {
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.lang = language;
          if (voice) {
            const match = window.speechSynthesis
              .getVoices()
              .find((v) => v.name === voice);
            if (match) utterance.voice = match;
          }
          utterance.onend = () => resolve();
          utterance.onerror = (event) =>
            reject(new Error(`Speech failed: ${event.error}`));
          window.speechSynthesis.speak(utterance);
        });
      }
    },
    cancel() {
      if (supported) window.speechSynthesis.cancel();
    },
  };
}

/**
 * Chimes are synthesised rather than shipped as audio files.
 *
 * A two-tone chime is a handful of oscillator settings, and generating it
 * removes two binary assets from a bundle that a waiting-room screen may be
 * loading over hospital wi-fi.
 */
export function browserChime(): ChimePort {
  return {
    async play(kind) {
      if (kind === "none") return;
      if (typeof window === "undefined" || !("AudioContext" in window)) return;

      const context = new AudioContext();
      // Browsers suspend audio until a user gesture; a suspended context is a
      // silent no-op rather than an error.
      if (context.state === "suspended") {
        await context.resume().catch(() => undefined);
      }

      const notes = kind === "bell" ? [880, 1174.7] : [587.3, 784];
      const now = context.currentTime;

      notes.forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;

        const start = now + index * 0.18;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);

        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.5);
      });

      window.setTimeout(() => context.close().catch(() => undefined), 1200);
    },
  };
}
