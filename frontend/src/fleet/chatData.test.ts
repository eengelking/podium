// Chat's words and small rules (#1034): the tags, the delivery lines, the `@` query and the message parts, without drawing.
import { describe, it, expect } from "vitest";
import {
  addressMatches,
  channelDelivery,
  channelTag,
  dmDelivery,
  dmKey,
  dmName,
  dmTag,
  mentionChip,
  mentionQuery,
  messageParts,
  stamp,
  type Address,
  type ChannelMessage,
  type ChatChannel,
  type DirectInfo,
  type DirectMessage,
  type Party,
} from "./chatData";

const agent = (sessionId: string, name: string, over: Partial<Party> = {}): Party => ({ sessionId, name, machine: "ed-mbp", reporterKey: "k", kind: "agent", live: true, status: "running", ...over });
const person: Party = { sessionId: "person:ed", name: "Ed", machine: "", reporterKey: "", kind: "person", live: true, status: null };
const dm = (a: Party, b: Party, over: Partial<DirectInfo> = {}): DirectInfo => ({
  thread: "dm:x",
  a,
  b,
  owner: "Ed",
  messages: 3,
  lastAt: 1,
  state: "active",
  paused: false,
  canSend: { aToB: true, bToA: true },
  roundTrips: { used: 0, cap: 10 },
  ended: [],
  unread: 0,
  mentions: 0,
  hiddenAt: null,
  ...over,
});
const chan = (over: Partial<ChatChannel> = {}): ChatChannel => ({
  id: "general",
  name: "General",
  thread: "public",
  unread: 0,
  mentions: 0,
  messages: 1,
  paused: false,
  pausedForEveryone: false,
  disconnected: false,
  can: { pause: true, pauseEveryone: false, disconnect: true, removeAll: false },
  ...over,
});
const cm = (over: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id: "c1",
  authorKind: "person",
  authorName: "Ed",
  authorRef: "Ed",
  text: "hi",
  createdAt: 1,
  updatedAt: 1,
  replyTo: null,
  issue: null,
  project: null,
  milestone: null,
  mine: true,
  mentions: [],
  ...over,
});
const dmsg = (over: Partial<DirectMessage> = {}): DirectMessage => ({
  id: "m1",
  author: "agent",
  from: { kind: "agent", sessionId: "s1", name: "dash", machine: "ed-mbp" },
  to: [{ sessionId: "s2", name: "Tester", machine: "ci", state: "delivered", why: null }],
  text: "x",
  sentAt: 1,
  state: "delivered",
  stateAt: 1,
  why: null,
  approved: false,
  ...over,
});

describe("a Direct Message's key and name", () => {
  it("is the agents in it, so a new message with one agent and the stored conversation are the same row", () => {
    expect(dmKey(dm(person, agent("s2", "infra")))).toBe("s2");
    expect(dmKey(dm(agent("s9", "b"), agent("s1", "a")))).toBe("s1+s9");
  });
  it("names an agent's conversation with you by the agent and two agents by both", () => {
    expect(dmName(dm(person, agent("s2", "infra-notes")))).toBe("infra-notes");
    expect(dmName(dm(agent("s1", "claude-dashboard"), agent("s2", "Tester")))).toBe("claude-dashboard, Tester");
  });
});

describe("the state tags", () => {
  it("says Paused for a channel, and for everyone when an Admin paused General", () => {
    expect(channelTag(chan())).toBeNull();
    expect(channelTag(chan({ paused: true }))).toEqual({ icon: "pause", text: "Paused", warn: true });
    expect(channelTag(chan({ paused: true, pausedForEveryone: true }))?.text).toBe("Paused for everyone");
    expect(channelTag(chan({ disconnected: true }))?.text).toBe("Your agents are disconnected");
  });
  it("tells a conversation's link state, ended agents and approvals in words", () => {
    expect(dmTag(dm(agent("a", "A"), agent("b", "B")))).toBeNull();
    expect(dmTag(dm(agent("a", "A"), agent("b", "B"), { paused: true, state: "paused" }))?.text).toBe("Paused");
    expect(dmTag(dm(agent("a", "A"), agent("b", "B"), { state: "waiting" }))).toEqual({ icon: "clock", text: "Waiting for approval", warn: true });
    expect(dmTag(dm(agent("a", "A"), agent("b", "B"), { canSend: { aToB: false, bToA: false } }))?.text).toBe("Link removed");
    expect(dmTag(dm(person, agent("b", "B"), { canSend: { aToB: false, bToA: false } }))).toBeNull();
    expect(dmTag(dm(agent("a", "A"), agent("b", "B"), { ended: ["A", "B"] }))?.text).toBe("A and B ended");
  });
});

describe("the delivery line of a channel message", () => {
  it("is Posted, and says nobody was addressed when nobody was", () => {
    expect(channelDelivery(cm({ mine: false }))).toEqual({ icon: "ok", text: "Posted", wait: false });
    expect(channelDelivery(cm()).text).toBe("Posted. No agent was addressed, so none will act on it.");
  });
  it("names who gets it when their turn ends, who is notified, what is held and what was not delivered with the reason", () => {
    const m = (state: ChannelMessage["mentions"][number]["state"], typed: string, why: string | null = null) => ({ typed, sessionId: "s", state, why, stateAt: 1 });
    expect(channelDelivery(cm({ mentions: [{ ...m("done", "Maya@console", "notified"), sessionId: null }] })).text).toBe("Posted. Maya was notified.");
    expect(channelDelivery(cm({ mentions: [m("waiting", "Tester@ci"), m("waiting", "dash@mbp")] }))).toEqual({
      icon: "queue",
      text: "Waiting: Tester and dash get this when their current turn ends.",
      wait: true,
    });
    expect(channelDelivery(cm({ mentions: [m("held", "Tester@ci", "My group is paused")] }))).toEqual({ icon: "pause", text: "Held: My group is paused. It goes when the channel resumes.", wait: true });
    expect(channelDelivery(cm({ mentions: [m("not-delivered", "Tester@ci", "it refused")] }))).toEqual({ icon: "no", text: "Not delivered to Tester: it refused.", wait: false });
    expect(channelDelivery(cm({ mentions: [m("dropped", "Tester@ci", "the agent ended")] })).text).toBe("Not delivered to Tester: the agent ended.");
    expect(channelDelivery(cm({ mentions: [m("working", "Tester@ci")] })).text).toBe("Posted. Tester is working on it.");
  });
});

describe("a mention's state chip", () => {
  const m = (state: ChannelMessage["mentions"][number]["state"], why: string | null = null) => ({ typed: "Tester@ci", sessionId: "s", state, why, stateAt: 1 });
  it("shows the address and the state, and the server's reason when it gave one", () => {
    expect(mentionChip(m("waiting"))).toEqual({ kind: "wait", state: "waiting", text: "Tester@ci waiting" });
    expect(mentionChip(m("working"))).toEqual({ kind: "run", state: "running", text: "Tester@ci working" });
    expect(mentionChip(m("done"))).toEqual({ kind: "done", state: "done", text: "Tester@ci done" });
    expect(mentionChip(m("held", "My group is paused"))).toEqual({ kind: "wait", state: "waiting", text: "Tester@ci held: My group is paused" });
    expect(mentionChip(m("not-delivered", "it refused")).text).toBe("Tester@ci not delivered: it refused");
  });
});

describe("the delivery line of a Direct Message", () => {
  it("says Delivered with the time, and who approved it", () => {
    expect(dmDelivery(dmsg(), false, "Ed", () => "13:52").text).toBe("Delivered at 13:52.");
    expect(dmDelivery(dmsg({ approved: true }), false, "Ed", () => "13:52").text).toBe("Delivered at 13:52, after Ed approved it.");
  });
  it("says Waiting for a working agent, Held on a paused link, and Waiting for approval with where", () => {
    expect(dmDelivery(dmsg({ state: "queued" }), false, "Ed", () => "x")).toEqual({ icon: "queue", text: "Waiting: Tester is working. It gets this when its turn ends.", wait: true });
    expect(dmDelivery(dmsg({ state: "ready" }), true, "Ed", () => "13:21").text).toBe("Held: Ed paused this link. It goes when the link resumes.");
    expect(dmDelivery(dmsg({ state: "approval" }), false, "Ed", () => "x").text).toBe("Waiting for Ed to approve it, in My reporters or in a session on ci.");
  });
  it("says Not delivered with the reason for a dropped or declined message", () => {
    expect(dmDelivery(dmsg({ state: "declined" }), false, "Ed", () => "13:00")).toEqual({ icon: "no", text: "Declined at 13:00. It was not delivered.", wait: false });
    expect(dmDelivery(dmsg({ state: "dropped", why: "receiver-ended" }), false, "Ed", () => "13:00").text).toMatch(/^Dropped at 13:00: .* It was not delivered\.$/);
  });
});

describe("the @ query", () => {
  it("finds the word being typed after an @, with spaces allowed, and nothing in the middle of a word", () => {
    expect(mentionQuery("hello @Te", 9)).toEqual({ from: 6, to: 9, q: "Te" });
    expect(mentionQuery("@my agent@ma", 12)).toEqual({ from: 0, to: 12, q: "my agent@ma" });
    expect(mentionQuery("mail me@home", 12)).toBeNull();
    expect(mentionQuery("no at here", 5)).toBeNull();
    expect(mentionQuery("done @a\nnew line", 16)).toBeNull();
  });
  const book: Address[] = [
    { typed: "My Agent@mbp", label: "Orchestrator", role: "orchestrator", sessionId: "s1" },
    { typed: "Tester@ci-1", label: "Orchestrator", role: "orchestrator", sessionId: "s2" },
    { typed: "Tester@ci-2", label: "Orchestrator", role: "orchestrator", sessionId: "s3" },
    { typed: "Maya@console", label: "Person", role: "person", sessionId: null },
  ];
  it("keeps every address that starts with what is typed, folded, so same-named agents at two places both stay", () => {
    expect(addressMatches(book, "").length).toBe(4);
    expect(addressMatches(book, "tes").map((a) => a.typed)).toEqual(["Tester@ci-1", "Tester@ci-2"]);
    expect(addressMatches(book, "my a").map((a) => a.typed)).toEqual(["My Agent@mbp"]);
    expect(addressMatches(book, "zzz")).toEqual([]);
  });
});

describe("a message's text parts", () => {
  it("splits a redaction marker and mentions out, and keeps everything else as plain text", () => {
    expect(messageParts("see @Tester@ci and [redacted] <b>x</b>")).toEqual([
      { kind: "text", text: "see " },
      { kind: "mention", text: "@Tester@ci" },
      { kind: "text", text: " and " },
      { kind: "redacted", text: "[redacted]" },
      { kind: "text", text: " <b>x</b>" },
    ]);
    expect(messageParts("@group and @everyone").filter((p) => p.kind === "mention").map((p) => p.text)).toEqual(["@group", "@everyone"]);
  });
});

describe("a message's time", () => {
  it("is the clock time today and the weekday with it on any other day", () => {
    const noon = new Date(2026, 9, 12, 12, 0).getTime();
    expect(stamp(new Date(2026, 9, 12, 9, 5).getTime(), noon)).toBe("09:05");
    expect(stamp(new Date(2026, 9, 9, 13, 52).getTime(), noon)).toBe("Fri 13:52");
  });
});
