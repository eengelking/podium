// The members panel behind an avatar stack (#1236, mockup/podium-chat-redesign.html): who is in a thread, from what the client already
// has (no new route), as a stack with a count in the header and a panel with search, filters, People and Agents and "Showing N of M".
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { filterMembers, membersOf, ChatMembersPanel, ChatMembersStack, MEMBER_PAGE, type Member } from "./ChatMembers";
import { makeAgent, makeSession } from "../fixtures";
import type { ChatOverview } from "../chatData";

afterEach(cleanup);

const agentRow = (i: number, status: "running" | "waiting" | "done" = "running") => ({
  sessionId: `s${i}`,
  name: `agent-${i}`,
  machine: "ed-mbp",
  reporterKey: "k",
  address: `agent-${i}@ed-mbp`,
  status,
  waitReason: null,
  peers: true,
});

function overview(over: Partial<ChatOverview> = {}): ChatOverview {
  return {
    enabled: true,
    serverTime: 0,
    me: { name: "Ed", admin: false, person: true },
    settings: { maxChars: 4000, perMinute: 20, retainDays: 30, graceHours: 24, everyone: true },
    channels: [],
    directs: [],
    agents: [agentRow(1, "waiting"), agentRow(2, "running"), agentRow(3, "done")],
    people: [
      { name: "Ed", you: true },
      { name: "Maya Kim", you: false },
    ],
    ...over,
  } as ChatOverview;
}

const sessions = {
  s2: makeSession({
    id: "s2",
    name: "agent-2",
    modelFamily: "opus",
    model: "claude-opus-5-5",
    agents: [makeAgent({ id: "a1", name: "storage-fork", kind: "fork", modelFamily: "opus", status: "running" }), makeAgent({ id: "a2", name: null, description: "Map call sites", kind: "subagent", modelFamily: "haiku", status: "done" })],
  }),
};

describe("membersOf", () => {
  it("lists you, then your orchestrators and their subagents and forks, in My group", () => {
    const { members, partial } = membersOf(overview(), sessions, { group: true, person: "Ed" });
    expect(members.map((m) => `${m.kind}:${m.name}`)).toEqual(["you:Ed", "agent:agent-1", "agent:agent-2", "agent:storage-fork", "agent:Map call sites", "agent:agent-3"]);
    expect(partial).toBe(false);
  });

  it("says what each agent is and what it is doing", () => {
    const { members } = membersOf(overview(), sessions, { group: true, person: "Ed" });
    const by = Object.fromEntries(members.map((m) => [m.name, m]));
    expect(by["agent-1"]!.state).toBe("waiting");
    expect(by["agent-1"]!.word).toBe("Waiting");
    expect(by["agent-2"]!.line).toBe("Opus · orchestrator");
    expect(by["storage-fork"]!.line).toBe("Opus · fork of agent-2");
    expect(by["Map call sites"]!.line).toBe("Haiku · subagent of agent-2");
    expect(by["Map call sites"]!.state).toBe("done");
    expect(by["Ed"]!.line).toBe("Owner");
  });

  it("lists the person an Admin reads as, not the Admin", () => {
    const { members } = membersOf(overview({ me: { name: "Root", admin: true, person: false } }), sessions, { group: true, person: "Maya Kim" });
    expect(members[0]).toMatchObject({ kind: "person", name: "Maya Kim", line: "Owner" });
  });

  it("lists the people and agents the page knows in a channel, and says the list is partial", () => {
    const { members, partial } = membersOf(overview(), sessions, { group: false, person: "Ed" });
    expect(members.filter((m) => m.kind !== "agent").map((m) => m.name)).toEqual(["Ed", "Maya Kim"]);
    expect(members.filter((m) => m.kind === "agent").map((m) => m.name)).toEqual(["agent-1", "agent-2", "agent-3"]);
    expect(partial).toBe(true);
  });

  it("gives a person who is not you the Member line and no state", () => {
    const { members } = membersOf(overview(), sessions, { group: false, person: "Ed" });
    const maya = members.find((m) => m.name === "Maya Kim")!;
    expect(maya).toMatchObject({ kind: "person", line: "Member", state: null, word: null });
  });
});

describe("filterMembers", () => {
  const all = membersOf(overview(), sessions, { group: true, person: "Ed" }).members;

  it("keeps everyone for All and an empty search", () => {
    expect(filterMembers(all, "", "all")).toHaveLength(all.length);
  });

  it("searches the name and the line, ignoring case", () => {
    expect(filterMembers(all, "FORK", "all").map((m) => m.name)).toEqual(["storage-fork"]);
    expect(filterMembers(all, "haiku", "all").map((m) => m.name)).toEqual(["Map call sites"]);
  });

  it("filters to waiting, and running which includes delegating", () => {
    expect(filterMembers(all, "", "waiting").map((m) => m.name)).toEqual(["agent-1"]);
    expect(filterMembers(all, "", "running").map((m) => m.name)).toEqual(["agent-2", "storage-fork"]);
  });
});

function Harness(p: { members: Member[]; partial?: boolean; onPick?: (k: string, a: string) => void; menu?: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <ChatMembersStack members={p.members} open={open} controls="mem" onToggle={() => setOpen(!open)} />
      {open && <ChatMembersPanel id="mem" label="My group" members={p.members} partial={p.partial ?? false} menu={p.menu ?? null} onMenu={() => {}} mention={false} reading={false} onMenuClose={() => {}} onPick={p.onPick ?? (() => {})} onClose={() => setOpen(false)} />}
    </div>
  );
}

const many = (n: number): Member[] => Array.from({ length: n }, (_, i) => ({ key: `a:${i}`, kind: "agent" as const, name: `worker-${i}`, line: "Sonnet · orchestrator", state: i % 2 ? ("waiting" as const) : ("running" as const), word: i % 2 ? "Waiting" : "Running", family: "sonnet" as const, sessionId: `w${i}` }));

describe("ChatMembersStack", () => {
  it("shows up to four avatars and the count, as one named button that says what it does", () => {
    render(<Harness members={many(9)} />);
    const b = screen.getByRole("button", { name: "Members, 9. Show the list" });
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(b.getAttribute("aria-controls")).toBe("mem");
    expect(b.querySelectorAll(".ch-av")).toHaveLength(4);
    expect(b.textContent).toBe("9");
  });

  it("shows fewer avatars when there are fewer members", () => {
    render(<Harness members={many(2)} />);
    expect(screen.getByRole("button", { name: /^Members, 2/ }).querySelectorAll(".ch-av")).toHaveLength(2);
  });

  it("opens and closes the panel, and the name follows", () => {
    render(<Harness members={many(3)} />);
    fireEvent.click(screen.getByRole("button", { name: "Members, 3. Show the list" }));
    expect(screen.getByRole("complementary", { name: "Members of My group" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Members, 3. Hide the list" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Members, 3. Hide the list" }));
    expect(screen.queryByRole("complementary")).toBeNull();
  });
});

describe("ChatMembersPanel", () => {
  const open = (members: Member[], partial = false) => {
    render(<Harness members={members} partial={partial} />);
    fireEvent.click(screen.getByRole("button", { name: /Show the list/ }));
    return screen.getByRole("complementary", { name: "Members of My group" });
  };

  it("has a header with the count and a close button", () => {
    const panel = open(many(3));
    expect(within(panel).getByRole("heading", { name: "Members 3" })).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Close members" }));
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("closes on Escape and puts the focus back on the stack", () => {
    const panel = open(many(3));
    within(panel).getByRole("searchbox", { name: "Find a member" }).focus();
    fireEvent.keyDown(within(panel).getByRole("searchbox", { name: "Find a member" }), { key: "Escape" });
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Show the list/ }));
  });

  it("leaves an Escape that something else already used (the message box closing its @ list)", () => {
    open(many(3));
    const used = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    used.preventDefault();
    document.body.dispatchEvent(used);
    expect(screen.getByRole("complementary")).toBeInTheDocument();
  });

  it("groups People and Agents with counts, each row naming the member and its state in a word", () => {
    const people: Member = { key: "p:Maya", kind: "person", name: "Maya Kim", line: "Member", state: null, word: null };
    const panel = open([people, ...many(2)]);
    expect(within(panel).getByRole("heading", { name: "People 1" })).toBeTruthy();
    expect(within(panel).getByRole("heading", { name: "Agents 2" })).toBeTruthy();
    const row = within(panel).getByText("worker-1").closest("li")!;
    expect(row.textContent).toContain("Sonnet · orchestrator");
    expect(row.textContent).toContain("Waiting");
  });

  it("filters as you type, and says when nothing matches", () => {
    const panel = open(many(9));
    const q = within(panel).getByRole("searchbox", { name: "Find a member" });
    fireEvent.change(q, { target: { value: "worker-7" } });
    expect(within(panel).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.change(q, { target: { value: "zzz" } });
    expect(within(panel).getByText("No member matches that.")).toBeTruthy();
  });

  it("has filter chips with their counts and aria-pressed", () => {
    const panel = open(many(9));
    const all = within(panel).getByRole("button", { name: "All" });
    const waiting = within(panel).getByRole("button", { name: "Waiting 4" });
    const running = within(panel).getByRole("button", { name: "Running 5" });
    expect(all.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(waiting);
    expect(waiting.getAttribute("aria-pressed")).toBe("true");
    expect(all.getAttribute("aria-pressed")).toBe("false");
    expect(within(panel).getAllByRole("listitem")).toHaveLength(4);
    fireEvent.click(running);
    expect(within(panel).getAllByRole("listitem")).toHaveLength(5);
  });

  it("pages: Showing N of M, then Show more until everyone is shown", () => {
    const panel = open(many(MEMBER_PAGE + 5));
    expect(within(panel).getByText(`Showing ${MEMBER_PAGE} of ${MEMBER_PAGE + 5}`)).toBeTruthy();
    expect(within(panel).getAllByRole("listitem")).toHaveLength(MEMBER_PAGE);
    fireEvent.click(within(panel).getByRole("button", { name: "Show 5 more" }));
    expect(within(panel).getByText(`Showing ${MEMBER_PAGE + 5} of ${MEMBER_PAGE + 5}`)).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: /Show \d+ more/ })).toBeNull();
  });

  it("says when the list is only what this page knows", () => {
    const panel = open(many(3), true);
    expect(within(panel).getByText(/only the people and agents this page knows/i)).toBeTruthy();
  });

  it("offers a menu on a row's avatar and on a right-click anywhere on the row", () => {
    const onMenu = vi.fn();
    const m = many(2);
    render(<ChatMembersPanel id="mem" label="My group" members={m} partial={false} menu={null} onMenu={onMenu} mention={false} reading={false} onMenuClose={() => {}} onPick={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions for worker-0" }));
    expect(onMenu).toHaveBeenLastCalledWith("h:w0", "button");
    fireEvent.contextMenu(screen.getByText("worker-1").closest("li")!);
    expect(onMenu).toHaveBeenLastCalledWith("h:w1", "context");
  });

  it("opens the agent's menu with Open orchestration page, and runs what is picked", () => {
    const onPick = vi.fn();
    render(<ChatMembersPanel id="mem" label="My group" members={many(1)} partial={false} menu="h:w0" onMenu={() => {}} mention={false} reading={false} onMenuClose={() => {}} onPick={onPick} onClose={() => {}} />);
    const item = screen.getByRole("menuitem", { name: "Open orchestration page" });
    expect(item.getAttribute("href")).toBe("#/?open=w0");
  });

  it("gives you and a subagent no menu", () => {
    const you: Member = { key: "you", kind: "you", name: "Ed", line: "You", state: null, word: null };
    const sub: Member = { key: "g:1", kind: "agent", name: "Map call sites", line: "Haiku · subagent of x", state: "done", word: "Done", family: "haiku" };
    render(<ChatMembersPanel id="mem" label="My group" members={[you, sub]} partial={false} menu={null} onMenu={() => {}} mention={false} reading={false} onMenuClose={() => {}} onPick={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
  });
});
