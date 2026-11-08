// An Admin reading the content of a person's session tells the person (#1073, #1074, mockup/podium-admin-read-notices.html): the red notice while an Admin
// reads, a quiet line for each read after, an X on each that only the owner has, the ping an Admin's open read sends, and the stream counter. Words only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { SessionReadNotes } from "./components/SessionReadNotes";
import { RespondError, type RespondApi, type SessionReadersReply } from "./respondApi";
import { PING_MS, SessionReadsProvider, readRecordLine, readingKey, readingLabel, readingLine, readingRest, recordLabel, useReadingPing } from "./sessionReads";
import { RespondProvider } from "./useRespond";
import { fleetReducer, initialState } from "./store";
import { isUrgentChange } from "./updateInterval";
import type { AdminRead, AdminReading } from "./chatData";
import type { RespondMe } from "./types";
import type { SessionReadKind } from "./respondApi";

const at = (h: number, m: number, s = 0) => new Date(2026, 10, 7, h, m, s).getTime();
const NOW = at(14, 30);
const ME: RespondMe = { enabled: true, signedIn: true, name: "Dana", admin: false };
const ADMIN_ME: RespondMe = { enabled: true, signedIn: true, name: "Root", admin: true };
const SESSION = { id: "s1", name: "history-paging", owner: "Dana" };

const live = (admin: string, since = NOW - 20_000): AdminReading => ({ admin, since, until: NOW + 25_000 });
const read = (admin: string, startedAt: number, kind: AdminRead["kind"] = "read"): AdminRead => ({ admin, startedAt, lastSeenAt: startedAt + 60_000, kind });

function fakeApi(over: { me?: RespondMe; readers?: SessionReadersReply["readers"]; records?: AdminRead[]; readsFail?: number } = {}) {
  let fails = over.readsFail ?? 0;
  return {
    me: vi.fn(async () => over.me ?? ME),
    signIn: vi.fn(),
    signOut: vi.fn(),
    sessionReadRecords: vi.fn(async () => ({ ok: true as const, serverTime: NOW, adminReads: over.records ?? [], adminReading: [] })),
    sessionReads: vi.fn(async (): Promise<SessionReadersReply> => {
      if (fails-- > 0) throw new RespondError(500, { ok: false, error: "boom" });
      return { ok: true, serverTime: NOW, readers: over.readers ?? {} };
    }),
    sessionReading: vi.fn(async () => ({ ok: true as const })),
  } as unknown as RespondApi & { sessionReadRecords: ReturnType<typeof vi.fn>; sessionReads: ReturnType<typeof vi.fn>; sessionReading: ReturnType<typeof vi.fn> };
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });

async function notes(api: ReturnType<typeof fakeApi>, kind: SessionReadKind = "ask", session: { id: string; name: string; owner: string | null } = SESSION, rev = 1, placement: "band" | "above" = "band") {
  const view = (r: number) => (
    <RespondProvider api={api} flagsOn>
      <SessionReadsProvider rev={r}>
        <SessionReadNotes kind={kind} session={session} placement={placement} />
      </SessionReadsProvider>
    </RespondProvider>
  );
  const out = render(view(rev));
  await flush();
  return {
    ...out,
    again: async (r: number) => {
      out.rerender(view(r));
      await flush();
    },
  };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the owner's red notice while an Admin reads", () => {
  it("names the Admin and the waiting plan, who can open it and when it clears, with an eye and words, and nothing else", async () => {
    const { container } = await notes(fakeApi({ readers: { ask: { s1: [live("Root")] } } }));
    const note = container.querySelector("[data-testid='read-notice']")!;
    expect(note.textContent).toContain("Root (an Admin) is reading your waiting plan, question or tool request.");
    expect(note.textContent).toContain("Only you and Admins can open it. The notice clears about 30 seconds after Root stops.");
    expect(note.getAttribute("role")).toBe("status");
    expect(note.classList.contains("crit")).toBe(true);
    expect(note.querySelector("svg")).not.toBeNull();
    expect(container.querySelector(".read-notes.band")).not.toBeNull();
  });

  it("says the stored Activity of the session for that kind, and sits above the ask when placed there", async () => {
    const { container } = await notes(fakeApi({ readers: { activity: { s1: [live("Root")] } } }), "activity", SESSION, 1, "above");
    expect(container.querySelector("[data-testid='read-notice']")!.textContent).toContain("Root (an Admin) is paging through the stored Activity of history-paging.");
    expect(container.querySelector(".read-notes.above")).not.toBeNull();
  });

  it("shows only the kind it is asked for and only this session", async () => {
    const { container } = await notes(fakeApi({ readers: { activity: { s1: [live("Root")] }, ask: { other: [live("Root")] } } }));
    expect(container.querySelector(".read-notes")).toBeNull();
  });

  it("hides on the X, for that reading only, and stays hidden when the page is opened again; a later read shows again", async () => {
    const first = await notes(fakeApi({ readers: { ask: { s1: [live("Root", NOW - 20_000)] } } }));
    fireEvent.click(screen.getByRole("button", { name: "Close notice: Admin reading your waiting plan, question or tool request" }));
    expect(first.container.querySelector("[data-testid='read-notice']")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("podium.sessionreads.dismissed")!)).toEqual([readingKey("ask", "s1", "Root", NOW - 20_000)]);
    first.unmount();
    const again = await notes(fakeApi({ readers: { ask: { s1: [live("Root", NOW - 20_000)] } } }));
    expect(again.container.querySelector("[data-testid='read-notice']")).toBeNull();
    again.unmount();
    const later = await notes(fakeApi({ readers: { ask: { s1: [live("Root", NOW - 1_000)] } } }));
    expect(later.container.querySelector("[data-testid='read-notice']")).not.toBeNull();
  });

  it("is seen by the owner only: an Admin who is not the owner, a person who is not, and a session of the shared Admin name see nothing", async () => {
    const readers = { ask: { s1: [live("Root")] } };
    for (const [me, session] of [
      [ADMIN_ME, SESSION],
      [{ ...ME, name: "Alex" }, SESSION],
      [ADMIN_ME, { ...SESSION, owner: "Admin" }],
      [ME, { ...SESSION, owner: null }],
    ] as const) {
      const { container, unmount } = await notes(fakeApi({ me, readers, records: [read("Root", at(14, 2))] }), "ask", session);
      expect(container.querySelector(".read-notes")).toBeNull();
      unmount();
    }
  });

  it("is seen by an Admin who is the session's owner, and the Admin can dismiss it", async () => {
    const { container } = await notes(fakeApi({ me: ADMIN_ME, readers: { ask: { s1: [live("Sam")] } } }), "ask", { ...SESSION, owner: "Root" });
    expect(container.querySelector("[data-testid='read-notice']")!.textContent).toContain("Sam (an Admin) is reading your waiting plan, question or tool request.");
    fireEvent.click(screen.getByRole("button", { name: /Close notice/ }));
    expect(container.querySelector("[data-testid='read-notice']")).toBeNull();
  });

  it("is gone once the Admin's reading has ended by the server's clock", async () => {
    const { container } = await notes(fakeApi({ readers: { ask: { s1: [{ admin: "Root", since: NOW - 60_000, until: NOW - 1 }] } } }));
    expect(container.querySelector("[data-testid='read-notice']")).toBeNull();
  });

  it("hides every Admin of one notice with one X", async () => {
    const { container } = await notes(fakeApi({ readers: { ask: { s1: [live("Root"), live("Sam", NOW - 10_000)] } } }));
    expect(container.querySelector("[data-testid='read-notice']")!.textContent).toContain("Root and Sam (Admins) are reading your waiting plan, question or tool request.");
    fireEvent.click(screen.getByRole("button", { name: /Close notice/ }));
    expect(container.querySelector("[data-testid='read-notice']")).toBeNull();
  });
});

describe("the quiet record lines after a read", () => {
  it("shows newest first, at most three, each with who, what and when, and an X on each", async () => {
    const records = [read("Sam", at(9, 41)), read("Root", at(14, 2)), read("Root", at(10, 0)), read("Kim", at(8, 0))];
    const { container } = await notes(fakeApi({ records }));
    const lines = [...container.querySelectorAll("[data-testid='read-record']")].map((n) => n.textContent);
    expect(lines).toEqual(["Root (an Admin) opened your waiting plan, question or tool request on 14:02.", "Root (an Admin) opened your waiting plan, question or tool request on 10:00.", "Sam (an Admin) opened your waiting plan, question or tool request on 09:41."]);
    expect(screen.getAllByRole("button", { name: /Close notice: .* opened your waiting plan, question or tool request/ })).toHaveLength(3);
    expect(container.querySelector("[data-testid='read-record']")!.classList.contains("crit")).toBe(false);
  });

  it("says the stored Activity of the session for that kind", async () => {
    const { container } = await notes(fakeApi({ records: [read("Root", at(14, 2))] }), "activity");
    expect(container.querySelector("[data-testid='read-record']")!.textContent).toBe("Root (an Admin) read the stored Activity of history-paging on 14:02.");
  });

  it("hides one line on its X and leaves the others, and ignores the Admin's stops", async () => {
    const records = [read("Root", at(14, 2)), read("Sam", at(9, 41)), read("Root", at(13, 0), "paused")];
    const { container } = await notes(fakeApi({ records }));
    expect(container.querySelectorAll("[data-testid='read-record']")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Close notice: Root (an Admin) opened your waiting plan, question or tool request" }));
    expect([...container.querySelectorAll("[data-testid='read-record']")].map((n) => n.textContent)).toEqual(["Sam (an Admin) opened your waiting plan, question or tool request on 09:41."]);
  });

  it("does not repeat a read that is still open as a line", async () => {
    const { container } = await notes(fakeApi({ readers: { ask: { s1: [live("Root", at(14, 29, 40))] } }, records: [read("Root", at(14, 29, 40))] }));
    expect(container.querySelectorAll("[data-testid='read-record']")).toHaveLength(0);
    expect(container.querySelectorAll("[data-testid='read-notice']")).toHaveLength(1);
  });

  it("shows an Admin who reads now once, whatever loop the record is of, and a line only for those who stopped", async () => {
    const { container } = await notes(
      fakeApi({ readers: { activity: { s1: [live("Root", at(14, 29, 40))] } }, records: [read("Root", at(14, 29, 40)), read("Root", at(14, 29, 55)), read("Mia", at(14, 20))] }),
      "activity",
    );
    expect(container.querySelectorAll("[data-testid='read-notice']")).toHaveLength(1);
    const lines = [...container.querySelectorAll("[data-testid='read-record']")].map((l) => l.textContent ?? "");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Mia");
  });

  it("reads the records again when the stream's counter moves", async () => {
    const api = fakeApi();
    const { again } = await notes(api, "ask", SESSION, 1);
    expect(api.sessionReadRecords).toHaveBeenCalledTimes(1);
    await again(2);
    expect(api.sessionReadRecords).toHaveBeenCalledTimes(2);
  });
});

describe("reading who is reading", () => {
  it("reads again when the stream's counter moves, and tries again after a failed read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const api = fakeApi({ readsFail: 1 });
    const { again } = await notes(api, "ask", SESSION, 1);
    expect(api.sessionReads).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(api.sessionReads).toHaveBeenCalledTimes(2);
    await again(2);
    expect(api.sessionReads).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("asks again just after the earliest reading ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const api = fakeApi({ readers: { ask: { s1: [live("Root")] } } });
    await notes(api);
    expect(api.sessionReads).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000 + 1_600);
    });
    expect(api.sessionReads).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("drops the readers when the sign-in is gone, and asks nothing when signed out", async () => {
    const gone = fakeApi({ readers: { ask: { s1: [live("Root")] } } });
    gone.sessionReads.mockRejectedValue(new RespondError(401, { ok: false, error: "sign in" }));
    const a = await notes(gone);
    expect(a.container.querySelector(".read-notes")).toBeNull();
    a.unmount();
    const out = fakeApi({ me: { enabled: true, signedIn: false, name: null, admin: false } });
    const b = await notes(out);
    expect(out.sessionReads).not.toHaveBeenCalled();
    expect(b.container.querySelector(".read-notes")).toBeNull();
  });

  it("shows nothing outside the provider", () => {
    const { container } = render(<SessionReadNotes kind="ask" session={SESSION} />);
    expect(container.querySelector(".read-notes")).toBeNull();
  });
});

describe("an Admin's open read", () => {
  it("pings every 15 seconds while it is open, with the loop for an Activity read, and stops when it closes", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const api = fakeApi();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <RespondProvider api={api} flagsOn>
        {children}
      </RespondProvider>
    );
    const { rerender, unmount } = renderHook(({ on }) => useReadingPing("activity", "s1", "a1", on), { wrapper, initialProps: { on: true } });
    vi.advanceTimersByTime(PING_MS * 2);
    expect(api.sessionReading).toHaveBeenCalledTimes(2);
    expect(api.sessionReading).toHaveBeenCalledWith("s1", "activity", "a1");
    rerender({ on: false });
    vi.advanceTimersByTime(PING_MS * 2);
    expect(api.sessionReading).toHaveBeenCalledTimes(2);
    unmount();
    vi.useRealTimers();
  });

  it("sends nothing without a session", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const api = fakeApi();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <RespondProvider api={api} flagsOn>
        {children}
      </RespondProvider>
    );
    renderHook(() => useReadingPing("ask", null, undefined, true), { wrapper });
    vi.advanceTimersByTime(PING_MS * 2);
    expect(api.sessionReading).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("the stream's reads counter", () => {
  it("moves on a reads signal, and on every snapshot, and is urgent", () => {
    const next = fleetReducer(initialState, { type: "reads" });
    expect(next.readsRev).toBe(initialState.readsRev + 1);
    expect(isUrgentChange(initialState, next)).toBe(true);
  });
});

describe("the words", () => {
  it("name one, two or more Admins, and the notice's labels", () => {
    expect(readingLine("ask", "x", [live("Root")])).toBe("Root (an Admin) is reading your waiting plan, question or tool request.");
    expect(readingLine("ask", "x", [live("Root"), live("Sam")])).toBe("Root and Sam (Admins) are reading your waiting plan, question or tool request.");
    expect(readingLine("text", "x", [live("Root")])).toBe("Root (an Admin) is reading the whole prompt and answer of an agent in x.");
    expect(readingLine("live", "x", [live("Root")])).toBe("Root (an Admin) is watching the live activity of an agent in x.");
    expect(readingLine("activity", "x", [live("Root"), live("Sam"), live("Kim")])).toBe("Root, Sam and 1 more Admin are paging through the stored Activity of x.");
    expect(readingLine("ask", "x", [live("Root"), live("Sam"), live("Kim"), live("Lee")])).toBe("Root, Sam and 2 more Admins are reading your waiting plan, question or tool request.");
    expect(readingRest([live("Root"), live("Sam")])).toBe("Only you and Admins can open it. The notice clears about 30 seconds after the last of them stops.");
    expect(readRecordLine("ask", "x", read("Root", at(14, 2)), NOW)).toBe("Root (an Admin) opened your waiting plan, question or tool request on 14:02.");
    expect(readingLabel("activity")).toBe("Admin reading your stored Activity");
    expect(recordLabel("activity", "x", read("Root", at(14, 2)))).toBe("Root (an Admin) read the stored Activity of x");
  });
});
