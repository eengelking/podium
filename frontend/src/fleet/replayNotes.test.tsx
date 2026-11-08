// An Admin replaying a person's recorded session tells the person (#1075, mockup/podium-replay-notice.html): the red notice while it is open, a quiet line for
// each replay after, an X on each that only the owner has, and the card's second line. Words only, never any text of the recording.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RecordingLayer } from "./components/RecordingLayer";
import { SessionCard } from "./components/SessionCard";
import { makeRecording, makeSession } from "./fixtures";
import { RespondError, type RecordingReads, type RespondApi } from "./respondApi";
import { ReplayReadsProvider, readingKey, replayRecordLine, replayersCard, replayersLine } from "./replayReads";
import { RespondProvider } from "./useRespond";
import type { AdminRead, AdminReading } from "./chatData";
import type { RespondMe } from "./types";

const at = (h: number, m: number, s = 0) => new Date(2026, 10, 7, h, m, s).getTime();
const NOW = at(14, 30);
const CFG = { staleAfterMs: 15_000, dropAfterMs: 60_000, lingerMs: 8_000, detachedHideAfterMs: 60_000 };
const ME: RespondMe = { enabled: true, signedIn: true, name: "Dana", admin: false };
const ADMIN_ME: RespondMe = { enabled: true, signedIn: true, name: "Root", admin: true };

const live = (admin: string, since = NOW - 20_000): AdminReading => ({ admin, since, until: NOW + 25_000 });
const read = (admin: string, startedAt: number, mins: number): AdminRead => ({ admin, startedAt, lastSeenAt: startedAt + mins * 60_000, kind: "read" });

function fakeApi(over: { me?: RespondMe; reads?: Record<string, AdminReading[]>; records?: AdminRead[]; readsFail?: number } = {}) {
  let fails = over.readsFail ?? 0;
  return {
    me: vi.fn(async () => over.me ?? ME),
    signIn: vi.fn(),
    signOut: vi.fn(),
    recordingConsent: vi.fn(async () => ({ ok: true as const, grant: {} as never, adminReads: over.records ?? [] })),
    recordingReads: vi.fn(async (): Promise<RecordingReads> => {
      if (fails-- > 0) throw new RespondError(500, { ok: false, error: "boom" });
      return { ok: true, serverTime: NOW, sessions: over.reads ?? {} };
    }),
  } as unknown as RespondApi & { recordingConsent: ReturnType<typeof vi.fn>; recordingReads: ReturnType<typeof vi.fn> };
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });

async function layer(api: ReturnType<typeof fakeApi>, owner = "Dana", rev = 1) {
  const s = makeSession({ owner, recording: makeRecording() });
  const view = (r: number) => (
    <RespondProvider api={api} flagsOn={false} recordingOn>
      <ReplayReadsProvider rev={r}>
        <RecordingLayer s={s} now={NOW} />
      </ReplayReadsProvider>
    </RespondProvider>
  );
  const out = render(view(rev));
  await flush();
  return { ...out, s, again: async (r: number) => { out.rerender(view(r)); await flush(); } };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the owner's red notice while an Admin replays", () => {
  it("names the Admin, who can open it and when it clears, with an eye and words, and nothing else", async () => {
    const s = makeSession({ owner: "Dana" });
    const { container } = await layer(fakeApi({ reads: { [s.id]: [live("Root")] } }));
    const note = container.querySelector("[data-testid='replay-reading-notice']")!;
    expect(note.textContent).toContain("Root (an Admin) is replaying this recording.");
    expect(note.textContent).toContain("Only you and Admins can open it. The notice clears about 30 seconds after Root stops.");
    expect(note.getAttribute("role")).toBe("status");
    expect(note.classList.contains("crit")).toBe(true);
    expect(note.querySelector("svg")).not.toBeNull();
  });

  it("hides on the X, for that reading only, and stays hidden when the page is opened again; a later replay shows again", async () => {
    const s = makeSession({ owner: "Dana" });
    const first = await layer(fakeApi({ reads: { [s.id]: [live("Root", NOW - 20_000)] } }));
    fireEvent.click(screen.getByRole("button", { name: /Close notice: an Admin replaying this recording/ }));
    expect(first.container.querySelector("[data-testid='replay-reading-notice']")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("podium.replay.dismissed")!)).toEqual([readingKey(s.id, "Root", NOW - 20_000)]);
    first.unmount();
    const again = await layer(fakeApi({ reads: { [s.id]: [live("Root", NOW - 20_000)] } }));
    expect(again.container.querySelector("[data-testid='replay-reading-notice']")).toBeNull();
    again.unmount();
    const later = await layer(fakeApi({ reads: { [s.id]: [live("Root", NOW - 1_000)] } }));
    expect(later.container.querySelector("[data-testid='replay-reading-notice']")).not.toBeNull();
  });

  it("is seen by the owner only: an Admin who is not the owner, and a person who is not, see nothing", async () => {
    const s = makeSession({ owner: "Dana" });
    const reads = { [s.id]: [live("Root")] };
    for (const me of [ADMIN_ME, { ...ME, name: "Alex" }]) {
      const { container, unmount } = await layer(fakeApi({ me, reads, records: [read("Root", at(14, 2), 6)] }));
      expect(container.querySelector(".rec-notes")).toBeNull();
      unmount();
    }
  });

  it("is seen by an Admin who is the session's owner, and the Admin can dismiss it", async () => {
    const s = makeSession({ owner: "Root" });
    const { container } = await layer(fakeApi({ me: ADMIN_ME, reads: { [s.id]: [live("Sam")] } }), "Root");
    expect(container.querySelector("[data-testid='replay-reading-notice']")!.textContent).toContain("Sam (an Admin) is replaying this recording.");
    fireEvent.click(screen.getByRole("button", { name: /Close notice/ }));
    expect(container.querySelector("[data-testid='replay-reading-notice']")).toBeNull();
  });

  it("is gone once the Admin's reading has ended by the server's clock, and when the Admin has stopped it is not asked again", async () => {
    const s = makeSession({ owner: "Dana" });
    const api = fakeApi({ reads: { [s.id]: [{ admin: "Root", since: NOW - 60_000, until: NOW - 1 }] } });
    const { container } = await layer(api);
    expect(container.querySelector("[data-testid='replay-reading-notice']")).toBeNull();
  });
});

describe("the quiet record lines after a replay", () => {
  it("shows newest first, at most three, each with who, when and for how long, and an X on each", async () => {
    const records = [read("Sam", at(9, 41), 2), read("Root", at(14, 2), 6), read("Root", at(10, 0), 0), read("Kim", at(8, 0), 1)];
    const { container } = await layer(fakeApi({ records }));
    const lines = [...container.querySelectorAll("[data-testid='replay-record']")].map((n) => n.textContent);
    expect(lines).toEqual([
      "Root (an Admin) replayed this recording on 14:02, for 6 minutes.",
      "Root (an Admin) replayed this recording on 10:00, for under a minute.",
      "Sam (an Admin) replayed this recording on 09:41, for 2 minutes.",
    ]);
    expect(screen.getAllByRole("button", { name: /Close notice: .* replayed this recording/ })).toHaveLength(3);
  });

  it("hides one line on its X and leaves the others, and ignores the Admin's stops (a pause is not a replay)", async () => {
    const records: AdminRead[] = [read("Root", at(14, 2), 6), read("Sam", at(9, 41), 1), { admin: "Root", startedAt: at(13, 0), lastSeenAt: at(13, 0), kind: "paused" }];
    const { container } = await layer(fakeApi({ records }));
    expect(container.querySelectorAll("[data-testid='replay-record']")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Close notice: Root (an Admin) replayed this recording" }));
    expect([...container.querySelectorAll("[data-testid='replay-record']")].map((n) => n.textContent)).toEqual(["Sam (an Admin) replayed this recording on 09:41, for 1 minute."]);
  });

  it("does not repeat a replay that is still open as a line", async () => {
    const s = makeSession({ owner: "Dana" });
    const { container } = await layer(fakeApi({ reads: { [s.id]: [live("Root", at(14, 29, 40))] }, records: [read("Root", at(14, 29, 40), 0)] }));
    expect(container.querySelectorAll("[data-testid='replay-record']")).toHaveLength(0);
    expect(container.querySelectorAll("[data-testid='replay-reading-notice']")).toHaveLength(1);
  });
});

describe("reading who is replaying", () => {
  it("reads again when the stream's replay counter moves, and tries again after a failed read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const api = fakeApi({ readsFail: 1 });
    const { again } = await layer(api, "Dana", 1);
    expect(api.recordingReads).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(api.recordingReads).toHaveBeenCalledTimes(2);
    await again(2);
    expect(api.recordingReads).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("asks nothing and shows nothing when signed out, or when recording is off", async () => {
    const api = fakeApi({ me: { enabled: true, signedIn: false, name: null, admin: false } });
    const { container } = await layer(api);
    expect(api.recordingReads).not.toHaveBeenCalled();
    expect(container.querySelector(".rec-notes")).toBeNull();
  });
});

describe("the card's second line", () => {
  it("says who is replaying it, on the owner's card only", async () => {
    const s = makeSession({ owner: "Dana", recording: makeRecording() });
    const card = (api: ReturnType<typeof fakeApi>) => (
      <RespondProvider api={api} flagsOn={false} recordingOn>
        <ReplayReadsProvider rev={1}>
          <SessionCard s={s} now={NOW} config={CFG} entering={false} leaving={false} onOpen={() => {}} />
        </ReplayReadsProvider>
      </RespondProvider>
    );
    const mine = render(card(fakeApi({ reads: { [s.id]: [live("Root")] } })));
    await flush();
    expect(mine.container.querySelector(".band.recording small")!.textContent).toContain("Root (an Admin) is replaying it now.");
    mine.unmount();
    const other = render(card(fakeApi({ reads: {} })));
    await flush();
    expect(other.container.querySelector(".band.recording small")!.textContent).not.toContain("replaying");
  });
});

describe("the words", () => {
  it("name one, two or more Admins, and a record's length", () => {
    expect(replayersLine([live("Root")])).toBe("Root (an Admin) is replaying this recording.");
    expect(replayersLine([live("Root"), live("Sam")])).toBe("Root and Sam (Admins) are replaying this recording.");
    expect(replayersLine([live("Root"), live("Sam"), live("Kim")])).toBe("Root, Sam and 1 more Admin are replaying this recording.");
    expect(replayersLine([live("Root"), live("Sam"), live("Kim"), live("Lee")])).toBe("Root, Sam and 2 more Admins are replaying this recording.");
    expect(replayersCard([live("Root"), live("Sam")])).toBe("2 Admins are replaying it now.");
    expect(replayRecordLine(read("Root", at(14, 2), 1), NOW)).toBe("Root (an Admin) replayed this recording on 14:02, for 1 minute.");
  });
});
