/**
 * The waiting-room board and the patient tracker, against the public API.
 *
 * Both are driven by a fake of the public API alone. That is the point: they
 * must work with nothing else — no session, no configuration read, no staff
 * visit list — because that is what a kiosk and a patient's phone have.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { PublicBoard } from "./PublicBoard.js";
import { PublicTracker } from "../track/PublicTracker.js";
import { PublicApiError, type BoardView, type PublicApi, type TrackView } from "../../api/public-api.js";

afterEach(() => cleanup());

function board(overrides: Partial<BoardView["stations"][number]> = {}): BoardView {
  return {
    board: { id: "b", name: "Outpatients", showRoom: true, showEstimatedWait: true },
    hospital: { name: "Ikeja General Hospital", brandColor: "#003ec7" },
    stations: [
      {
        id: "s1",
        name: "Consultation",
        enabled: true,
        room: "Room 12",
        serving: { ticket: "A-023", status: "called", calledAt: null, callAttempts: 1, name: null },
        waiting: [
          { ticket: "A-024", position: 1, name: null },
          { ticket: "A-025", position: 2, name: null },
        ],
        waitingCount: 5,
        estimatedWaitMinutes: 18,
        ...overrides,
      },
    ],
    at: new Date().toISOString(),
  };
}

function fakeApi(impl: Partial<Record<keyof PublicApi, (...args: never[]) => Promise<unknown>>>): PublicApi {
  return impl as unknown as PublicApi;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("public display board", () => {
  it("shows the ticket being called, where to go, and who is next — from the public API alone", async () => {
    render(<PublicBoard api={fakeApi({ board: async () => board() })} boardId="b" />);
    await flush();

    expect(screen.getByText("Outpatients")).toBeDefined();
    expect(screen.getByText("A-023")).toBeDefined();
    expect(screen.getByText(/please go to room 12/i)).toBeDefined();
    expect(screen.getByText("A-024")).toBeDefined();
    expect(screen.getByText(/and 3 more waiting/i)).toBeDefined();
    expect(screen.getByText(/≈ 18 min/)).toBeDefined();
  });

  it("says a board is not configured when the link matches none", async () => {
    render(
      <PublicBoard
        api={fakeApi({ board: async () => Promise.reject(new PublicApiError(404, "No such board.")) })}
        boardId="missing"
      />,
    );
    await flush();
    expect(screen.getByText(/not configured/i)).toBeDefined();
  });

  it("shows an empty station honestly", async () => {
    render(<PublicBoard api={fakeApi({ board: async () => board({ serving: null, waiting: [], waitingCount: 0 }) })} boardId="b" />);
    await flush();
    expect(screen.getByText(/please wait to be called/i)).toBeDefined();
    expect(screen.getByText(/nobody waiting/i)).toBeDefined();
  });

  it("announces a newly called ticket, but not what was already on screen when it started", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let current = board();
    const announced: string[] = [];
    render(
      <PublicBoard
        api={fakeApi({ board: async () => current })}
        boardId="b"
        pollMillis={1000}
        onCalled={(ticket) => announced.push(ticket)}
      />,
    );
    await flush();
    expect(announced).toEqual([]);

    current = board({ serving: { ticket: "A-024", status: "called", calledAt: null, callAttempts: 1, name: null } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(announced).toEqual(["A-024"]);
    vi.useRealTimers();
  });
});

function track(overrides: Partial<TrackView> = {}): TrackView {
  return {
    status: "queued",
    journeyCode: "QM-8F4K",
    hospital: { name: "Ikeja General Hospital", supportPhone: null },
    current: {
      ticket: "A-024",
      status: "waiting",
      stationName: "Consultation",
      room: "Room 12",
      queuedAt: new Date().toISOString(),
      calledAt: null,
      position: 3,
      ahead: 2,
      estimatedWaitMinutes: 12,
    },
    journey: [
      { name: "Reception", state: "done" },
      { name: "Consultation", state: "current" },
      { name: "Pharmacy", state: "upcoming" },
    ],
    at: new Date().toISOString(),
    ...overrides,
  };
}

describe("public patient tracker", () => {
  it("follows a visit by the token in the QR code", async () => {
    const trackByToken = vi.fn(async () => track());
    render(<PublicTracker api={fakeApi({ trackByToken })} initial={{ kind: "token", token: "t".repeat(40) }} branchId={null} />);
    await flush();

    expect(trackByToken).toHaveBeenCalledWith("t".repeat(40));
    expect(screen.getByText("A-024")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined();
    expect(screen.getByText(/≈ 12 min/)).toBeDefined();
    expect(screen.getByText(/consultation · room 12/i)).toBeDefined();
  });

  it("tells the patient plainly when it is their turn", async () => {
    const called = track({
      current: { ...track().current!, status: "called", position: null, ahead: null, estimatedWaitMinutes: null },
    });
    render(<PublicTracker api={fakeApi({ trackByToken: async () => called })} initial={{ kind: "token", token: "x".repeat(40) }} branchId={null} />);
    await flush();
    expect(screen.getByText(/it's your turn/i)).toBeDefined();
  });

  it("explains an expired link rather than showing nothing", async () => {
    render(
      <PublicTracker
        api={fakeApi({ trackByToken: async () => Promise.reject(new PublicApiError(404, "That tracking link is not valid.")) })}
        initial={{ kind: "token", token: "y".repeat(40) }}
        branchId={null}
      />,
    );
    await flush();
    expect(screen.getByText(/no longer active/i)).toBeDefined();
  });

  it("never shows the patient's name", async () => {
    render(<PublicTracker api={fakeApi({ trackByToken: async () => track() })} initial={{ kind: "token", token: "z".repeat(40) }} branchId={null} />);
    await flush();
    expect(document.body.textContent).not.toMatch(/amara/i);
  });
});
