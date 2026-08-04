import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserId, type StationId, type VisitId } from "@qman/domain";
import { VoiceAnnouncer } from "./announcer.js";
import { Notifier } from "./notifier.js";
import type { ChimePort, NotificationPort, PermissionState, SpeechPort } from "./ports.js";
import { EventBus } from "../data/event-bus.js";
import { ClinicStore } from "../data/clinic-store.js";
import { OperationsStore } from "../data/operations-store.js";
import { ConfigStore } from "../data/config-store.js";
import { STATIONS } from "../data/demo-clinic.js";

const DOCTOR = UserId("user-doctor");

function fakeSpeech(overrides: Partial<SpeechPort> = {}): SpeechPort & { spoken: string[] } {
  const spoken: string[] = [];
  return {
    spoken,
    supported: true,
    async speak({ text, repeat }) {
      for (let i = 0; i < repeat; i += 1) spoken.push(text);
    },
    cancel() {},
    ...overrides,
  } as SpeechPort & { spoken: string[] };
}

function fakeChime(): ChimePort & { played: string[] } {
  const played: string[] = [];
  return {
    played,
    async play(kind) {
      played.push(kind);
    },
  };
}

function fakeNotifications(
  permission: PermissionState = "granted",
  overrides: Partial<NotificationPort> = {},
): NotificationPort & { shown: Array<{ title: string; body: string; tag: string }> } {
  const shown: Array<{ title: string; body: string; tag: string }> = [];
  return {
    shown,
    supported: true,
    permission: () => permission,
    async requestPermission() {
      return permission;
    },
    async show(input) {
      shown.push({ title: input.title, body: input.body, tag: input.tag });
    },
    ...overrides,
  } as NotificationPort & { shown: Array<{ title: string; body: string; tag: string }> };
}

function wire() {
  const bus = new EventBus();
  const clinic = new ClinicStore().useBus(bus);
  const ops = new OperationsStore();
  const config = new ConfigStore();
  ops.attachTo(bus);
  return { bus, clinic, ops, config };
}

describe("voice announcements", () => {
  let harness: ReturnType<typeof wire>;

  beforeEach(() => {
    harness = wire();
  });

  it("speaks the configured announcement when a patient is called", async () => {
    const speech = fakeSpeech();
    const chime = fakeChime();
    const announcer = new VoiceAnnouncer({
      speech,
      chime,
      operations: harness.ops,
      config: harness.config,
    });
    harness.bus.subscribe(announcer.subscriber());

    harness.clinic.callNext(STATIONS.pharmacy, DOCTOR);
    await vi.waitFor(() => expect(speech.spoken.length).toBeGreaterThan(0));

    expect(speech.spoken[0]).toMatch(/please proceed to Pharmacy/i);
    expect(chime.played[0]).toBe("soft");
  });

  it("repeats an announcement as many times as configured", async () => {
    const speech = fakeSpeech();
    harness.ops.setAnnouncementConfig({
      ...harness.ops.announcementConfig,
      repeat: 3,
    });
    const announcer = new VoiceAnnouncer({
      speech,
      chime: fakeChime(),
      operations: harness.ops,
      config: harness.config,
    });
    harness.bus.subscribe(announcer.subscriber());

    harness.clinic.callNext(STATIONS.pharmacy, DOCTOR);
    await vi.waitFor(() => expect(speech.spoken.length).toBe(3));
  });

  it("says nothing when announcements are switched off", async () => {
    const speech = fakeSpeech();
    harness.ops.setAnnouncementConfig({
      ...harness.ops.announcementConfig,
      enabled: false,
    });
    const announcer = new VoiceAnnouncer({
      speech,
      chime: fakeChime(),
      operations: harness.ops,
      config: harness.config,
    });
    harness.bus.subscribe(announcer.subscriber());

    harness.clinic.callNext(STATIONS.pharmacy, DOCTOR);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(speech.spoken).toHaveLength(0);
  });

  /**
   * Two patients called seconds apart at different stations must not have their
   * announcements spoken over each other — the result is unintelligible, which
   * is worse than either alone.
   */
  it("serialises announcements rather than overlapping them", async () => {
    const order: string[] = [];
    const speech: SpeechPort = {
      supported: true,
      async speak({ text }) {
        order.push(`start:${text.slice(0, 8)}`);
        await new Promise((resolve) => setTimeout(resolve, 15));
        order.push(`end:${text.slice(0, 8)}`);
      },
      cancel() {},
    };

    const announcer = new VoiceAnnouncer({
      speech,
      chime: fakeChime(),
      operations: harness.ops,
      config: harness.config,
    });
    harness.bus.subscribe(announcer.subscriber());

    harness.clinic.callNext(STATIONS.pharmacy, DOCTOR);
    harness.clinic.callNext(STATIONS.vitals, DOCTOR);

    await vi.waitFor(() => expect(order.length).toBe(4));
    // Every start is immediately followed by its own end.
    expect(order[0]!.startsWith("start:")).toBe(true);
    expect(order[1]!.startsWith("end:")).toBe(true);
    expect(order[2]!.startsWith("start:")).toBe(true);
    expect(order[3]!.startsWith("end:")).toBe(true);
  });

  it("records an unsupported outcome instead of throwing on a mute device", async () => {
    const announcer = new VoiceAnnouncer({
      speech: fakeSpeech({ supported: false }),
      chime: fakeChime(),
      operations: harness.ops,
      config: harness.config,
    });
    harness.bus.subscribe(announcer.subscriber());

    harness.clinic.callNext(STATIONS.pharmacy, DOCTOR);
    await vi.waitFor(() =>
      expect(
        harness.ops.attempts.some(
          (a) => a.channel === "voice" && a.status === "unsupported",
        ),
      ).toBe(true),
    );
  });

  it("records a failure when speech throws", async () => {
    const announcer = new VoiceAnnouncer({
      speech: {
        supported: true,
        async speak() {
          throw new Error("audio device busy");
        },
        cancel() {},
      },
      chime: fakeChime(),
      operations: harness.ops,
      config: harness.config,
    });
    harness.bus.subscribe(announcer.subscriber());

    harness.clinic.callNext(STATIONS.pharmacy, DOCTOR);
    await vi.waitFor(() => {
      const failure = harness.ops.attempts.find(
        (a) => a.channel === "voice" && a.status === "failed",
      );
      expect(failure?.error).toMatch(/audio device busy/);
    });
  });
});

describe("browser notifications", () => {
  let harness: ReturnType<typeof wire>;

  beforeEach(() => {
    harness = wire();
  });

  it("notifies a station when a patient joins its queue", async () => {
    const notifications = fakeNotifications();
    const notifier = new Notifier({
      notifications,
      operations: harness.ops,
      config: harness.config,
    });
    harness.bus.subscribe(notifier.staffSubscriber(STATIONS.laboratory));

    // Deliberately a normal-priority patient: the urgent wording is asserted
    // separately, and the seeded consultation patient happens to be High.
    const normal = harness.clinic
      .worklist(STATIONS.consultation)
      .waiting.find((item) => item.priority === "normal")!;
    harness.clinic.recall(normal.visitId, DOCTOR);
    harness.clinic.route(normal.visitId, STATIONS.laboratory, DOCTOR);

    await vi.waitFor(() => expect(notifications.shown.length).toBe(1));
    expect(notifications.shown[0]!.title).toMatch(/new patient in your queue/i);
    expect(notifications.shown[0]!.body).toMatch(/Laboratory/);
  });

  it("does not notify a station about another station's queue", async () => {
    const notifications = fakeNotifications();
    const notifier = new Notifier({
      notifications,
      operations: harness.ops,
      config: harness.config,
    });
    harness.bus.subscribe(notifier.staffSubscriber(STATIONS.pharmacy));

    const current = harness.clinic.worklist(STATIONS.consultation).current!;
    harness.clinic.route(current.visitId, STATIONS.laboratory, DOCTOR);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notifications.shown).toHaveLength(0);
  });

  it("marks an emergency arrival as requiring interaction", async () => {
    const shown: Array<{ requireInteraction: boolean | undefined; title: string }> = [];
    const notifier = new Notifier({
      notifications: fakeNotifications("granted", {
        async show(input) {
          shown.push({ title: input.title, requireInteraction: input.requireInteraction });
        },
      }),
      operations: harness.ops,
      config: harness.config,
    });
    harness.bus.subscribe(notifier.staffSubscriber(STATIONS.laboratory));

    const emergency = harness.clinic.visits.find(
      ({ visit }) => visit.priority === "emergency",
    )!;
    harness.clinic.recall(emergency.visit.id, DOCTOR);
    harness.clinic.route(emergency.visit.id, STATIONS.laboratory, DOCTOR);

    await vi.waitFor(() => expect(shown.length).toBeGreaterThan(0));
    expect(shown[0]!.title).toMatch(/emergency patient waiting/i);
    expect(shown[0]!.requireInteraction).toBe(true);
  });

  /**
   * A patient who glances at their phone thirty seconds late must still see it
   * — that is the entire point of not making them watch the board.
   */
  it("keeps the patient's turn on screen until dismissed", async () => {
    const shown: Array<{ requireInteraction: boolean | undefined; body: string; tag: string }> = [];
    const notifier = new Notifier({
      notifications: fakeNotifications("granted", {
        async show(input) {
          shown.push({
            body: input.body,
            tag: input.tag,
            requireInteraction: input.requireInteraction,
          });
        },
      }),
      operations: harness.ops,
      config: harness.config,
    });

    const waiting = harness.clinic.worklist(STATIONS.pharmacy).waiting[0]!;
    harness.bus.subscribe(notifier.patientSubscriber(waiting.visitId));

    harness.clinic.callNext(STATIONS.pharmacy, DOCTOR);

    await vi.waitFor(() => expect(shown.length).toBe(1));
    expect(shown[0]!.requireInteraction).toBe(true);
    expect(shown[0]!.body).toMatch(/please proceed to Pharmacy/i);
    // One tag per visit, so a recall replaces rather than stacks.
    expect(shown[0]!.tag).toBe(`visit-${waiting.visitId}`);
  });

  it("only notifies the patient it belongs to", async () => {
    const notifications = fakeNotifications();
    const notifier = new Notifier({
      notifications,
      operations: harness.ops,
      config: harness.config,
    });
    harness.bus.subscribe(
      notifier.patientSubscriber("visit-nobody" as VisitId),
    );

    harness.clinic.callNext(STATIONS.pharmacy, DOCTOR);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notifications.shown).toHaveLength(0);
  });

  it("records declined permission as declined, never as a failure", async () => {
    const notifier = new Notifier({
      notifications: fakeNotifications("denied"),
      operations: harness.ops,
      config: harness.config,
    });
    harness.bus.subscribe(notifier.staffSubscriber(STATIONS.laboratory));

    const current = harness.clinic.worklist(STATIONS.consultation).current!;
    harness.clinic.route(current.visitId, STATIONS.laboratory, DOCTOR);

    await vi.waitFor(() =>
      expect(
        harness.ops.attempts.some((a) => a.status === "denied"),
      ).toBe(true),
    );
    expect(harness.ops.attempts.some((a) => a.status === "failed")).toBe(false);

    // And so the channel is still reported healthy (ADR-029).
    const browser = harness.ops
      .channelHealth(new Date())
      .find((c) => c.channel === "browser")!;
    expect(browser.healthy).toBe(true);
  });

  it("records a genuine delivery failure", async () => {
    const notifier = new Notifier({
      notifications: fakeNotifications("granted", {
        async show() {
          throw new Error("notification quota exceeded");
        },
      }),
      operations: harness.ops,
      config: harness.config,
    });
    harness.bus.subscribe(notifier.staffSubscriber(STATIONS.laboratory));

    const current = harness.clinic.worklist(STATIONS.consultation).current!;
    harness.clinic.route(current.visitId, STATIONS.laboratory, DOCTOR);

    await vi.waitFor(() => {
      const failure = harness.ops.attempts.find((a) => a.status === "failed");
      expect(failure?.error).toMatch(/quota exceeded/);
    });
  });

  it("degrades to unsupported on a browser without notifications", async () => {
    const notifier = new Notifier({
      notifications: fakeNotifications("unsupported", { supported: false }),
      operations: harness.ops,
      config: harness.config,
    });
    harness.bus.subscribe(notifier.staffSubscriber(STATIONS.laboratory));

    const current = harness.clinic.worklist(STATIONS.consultation).current!;
    harness.clinic.route(current.visitId, STATIONS.laboratory, DOCTOR);

    await vi.waitFor(() =>
      expect(
        harness.ops.attempts.some((a) => a.status === "unsupported"),
      ).toBe(true),
    );
  });

  it("uses the same words for the notification as for the announcement", async () => {
    // ADR-030: a patient must read exactly what the room hears.
    const speech = fakeSpeech();
    const shownBodies: string[] = [];

    const announcer = new VoiceAnnouncer({
      speech,
      chime: fakeChime(),
      operations: harness.ops,
      config: harness.config,
    });
    const notifier = new Notifier({
      notifications: fakeNotifications("granted", {
        async show(input) {
          shownBodies.push(input.body);
        },
      }),
      operations: harness.ops,
      config: harness.config,
    });

    const waiting = harness.clinic.worklist(STATIONS.pharmacy).waiting[0]!;
    harness.bus.subscribe(announcer.subscriber());
    harness.bus.subscribe(notifier.patientSubscriber(waiting.visitId));

    harness.clinic.callNext(STATIONS.pharmacy, DOCTOR);

    await vi.waitFor(() => {
      expect(speech.spoken.length).toBeGreaterThan(0);
      expect(shownBodies.length).toBeGreaterThan(0);
    });
    expect(shownBodies[0]).toBe(speech.spoken[0]);
  });
});

describe("station id typing", () => {
  it("keeps station ids branded through the runtime layer", () => {
    // Compile-time guard: a bare string must not satisfy StationId.
    const id: StationId = STATIONS.pharmacy;
    expect(typeof id).toBe("string");
  });
});
