// Traffic's reads, words and map layout (#417), without drawing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { RespondError } from "./respondApi";
import {
  bezier,
  canManage,
  canRead,
  cut,
  deliveryWords,
  keptWords,
  labelWords,
  layoutMap,
  lineLabel,
  noRightToSend,
  ordered,
  pairWords,
  pillWidth,
  stateWords,
  tripsWords,
  trafficApi,
  waysOf,
  whereWords,
  type PeerMessage,
  type TrafficEnd,
  type TrafficLink,
} from "./trafficData";

const end = (sessionId: string, name: string, machine: string, reporterKey: string): TrafficEnd => ({ sessionId, name, machine, reporterKey });
const A = end("s-a", "alpha", "mac", "k1");
const A2 = end("s-a2", "alpha-2", "mac", "k1");
const B = end("s-b", "beta", "linux", "k2");
const C = end("s-c", "gamma", "pi", "k3");
const D = end("s-d", "delta", "win", "k4");

const link = (a: TrafficEnd, b: TrafficEnd, over: Partial<TrafficLink> = {}): TrafficLink => ({
  link: "l",
  a,
  b,
  owner: "Ed",
  messages: 1,
  lastAt: 0,
  state: "active",
  aToB: true,
  bToA: true,
  roundTrips: { used: 1, cap: 10 },
  ...over,
});

const msg = (over: Partial<PeerMessage>): PeerMessage => ({ id: "m", from: A, to: B, owner: "Ed", text: "", sentAt: 0, state: "delivered", stateAt: 0, why: null, approved: false, ...over });

afterEach(() => vi.unstubAllGlobals());

describe("the words", () => {
  it("names how long a conversation is kept, in the Admin's days", () => {
    expect(keptWords(30)).toBe("for 30 days");
    expect(keptWords(1)).toBe("for 1 day");
    expect(keptWords(undefined)).toBe("for as long as Admin > Settings says");
  });

  it("reads a link both ways, one way either way, or neither", () => {
    expect(waysOf(link(A, B))).toBe("both");
    expect(waysOf(link(A, B, { bToA: false }))).toBe("aToB");
    const back = link(A, B, { aToB: false });
    expect(waysOf(back)).toBe("bToA");
    expect(pairWords(back)).toBe("beta to alpha");
    expect(ordered(back).map((e) => e.name)).toEqual(["beta", "alpha"]);
    const none = link(A, B, { aToB: false, bToA: false });
    expect(waysOf(none)).toBe("none");
    expect(pairWords(none)).toBe("alpha and beta");
    expect(tripsWords(none)).toBe("n/a, neither can send");
    expect(tripsWords(link(A, B, { bToA: false }))).toBe("n/a, one way");
    expect(tripsWords(link(A, B))).toBe("1 of 10");
  });

  it("names where the two run, and a line in full words", () => {
    expect(whereWords(link(A, A2))).toBe("mac, same machine");
    expect(whereWords(link(A, B))).toBe("mac and linux");
    expect(lineLabel(link(A, B, { messages: 1 }))).toBe("alpha and beta, 1 message, active. Show the conversation");
    expect(lineLabel(link(A, B, { state: "waiting", messages: 3 }))).toBe("alpha and beta, 3 messages, a message waits for approval. Show the conversation");
  });

  it("says a link is paused while a message also waits for approval, on the label and in the line's name", () => {
    const both = link(A, B, { state: "waiting", paused: true, messages: 3 });
    expect(labelWords(both)).toBe("3 messages, waiting, paused");
    expect(lineLabel(both)).toBe("alpha and beta, 3 messages, a message waits for approval, paused. Show the conversation");
    expect(layoutMap([both]).edges[0]!.label).toBe("3 messages, waiting, paused");
    // Not paused: the wait alone.
    expect(labelWords(link(A, B, { state: "waiting", paused: false, messages: 3 }))).toBe("3 messages, waiting");
  });

  it("names a link where neither side can send, in place of Active only", () => {
    const none = link(A, B, { aToB: false, bToA: false, messages: 2 });
    expect(noRightToSend(none)).toBe(true);
    expect(stateWords(none)).toBe("No right to send");
    expect(labelWords(none)).toBe("2 messages, no right to send");
    expect(lineLabel(none)).toBe("alpha and beta, 2 messages, no right to send. Show the conversation");
    // A paused or waiting state stays as it is.
    for (const over of [{ paused: true }, { state: "paused" as const }, { state: "waiting" as const }]) {
      const l = link(A, B, { aToB: false, bToA: false, ...over });
      expect(noRightToSend(l)).toBe(false);
      expect(stateWords(l)).not.toBe("No right to send");
    }
    expect(noRightToSend(link(A, B, { bToA: false }))).toBe(false);
    expect(stateWords(link(A, B))).toBe("Active");
    expect(labelWords(link(A, B))).toBe("1 message");
  });

  it("makes room on the label for the icon of a link where neither side can send", () => {
    const l = link(A, B, { aToB: false, bToA: false });
    const e = layoutMap([l]).edges[0]!;
    expect(e.label).toBe("1 message, no right to send");
    expect(e.pill.w).toBe(pillWidth("1 message, no right to send", true));
  });

  it("says where each message is", () => {
    expect(deliveryWords(msg({ state: "handed", to: B }), false)).toEqual({ icon: "queue", text: "Handed to linux. Waiting for it to say beta took it.", wait: true });
    expect(deliveryWords(msg({ state: "queued" }), false).text).toBe("Waiting: beta is working. It gets this when its turn ends.");
    expect(deliveryWords(msg({ state: "queued" }), true).icon).toBe("pause");
    expect(deliveryWords(msg({ state: "dropped", why: "something-new" }), false).text).toMatch(/: the server let it go\. It was not delivered\.$/);
    expect(deliveryWords(msg({ state: "dropped", why: null }), false).icon).toBe("no");
    expect(deliveryWords(msg({ state: "approval" }), true).icon).toBe("clock");
  });

  it("cuts a long name with an ellipsis", () => {
    expect(cut("short", 10)).toBe("short");
    expect(cut("abcdefghijk", 5)).toBe("abcd…");
  });

  it("lets only the owner and an Admin read, and only the owner manage", () => {
    expect(canRead(null, "Ed")).toBe(false);
    expect(canRead({ signedIn: false, name: null, admin: false }, "Ed")).toBe(false);
    expect(canRead({ signedIn: true, name: "ed", admin: false }, "Ed")).toBe(true);
    expect(canRead({ signedIn: true, name: "Ann", admin: false }, "Ed")).toBe(false);
    expect(canRead({ signedIn: true, name: "Admin", admin: true }, "Ed")).toBe(true);
    expect(canRead({ signedIn: true, name: null, admin: false }, "Ed")).toBe(false);
    expect(canManage({ signedIn: true, name: "ED", admin: false } as never, "Ed")).toBe(true);
    expect(canManage({ signedIn: true, name: "Admin" }, "Admin")).toBe(false);
    expect(canManage({ signedIn: true, name: null }, "Ed")).toBe(false);
    expect(canManage(null, "Ed")).toBe(false);
  });
});

describe("the map's layout", () => {
  it("centres a lone machine and bows its lines out to the left", () => {
    const m = layoutMap([link(A, A2)]);
    expect(m.machines).toHaveLength(1);
    expect(m.machines[0]!.x).toBe((900 - 270) / 2);
    expect(m.nodes.map((n) => n.name)).toEqual(["alpha", "alpha-2"]);
    expect(m.nodes[1]!.y).toBeGreaterThan(m.nodes[0]!.y);
    const e = m.edges[0]!;
    // Starts on the node's left side.
    expect(e.d.startsWith(`M${m.nodes[0]!.x - 22} `)).toBe(true);
    expect(m.height).toBeGreaterThan(m.machines[0]!.y + m.machines[0]!.h);
  });

  it("puts machines in two columns, runs lines side to side, and bows a line inside the right column to the right", () => {
    // By name: linux, mac, pi, win, each to the shorter column.
    const m = layoutMap([link(A, B), link(C, D), link(B, D)]);
    const col = (k: string) => m.machines.find((x) => x.key === k)!.x;
    expect(m.machines.map((x) => x.name)).toEqual(["linux", "mac", "pi", "win"]);
    expect(col("k2")).toBe(30);
    expect(col("k1")).toBe(600);
    expect(col("k3")).toBe(30);
    expect(col("k4")).toBe(600);
    const edge = (a: string, b: string) => m.edges.find((e) => e.id === `${a}|${b}`)!;
    // From mac on the right to linux on the left: it leaves the node's left side.
    expect(edge("s-a", "s-b").d.startsWith(`M${600 + 135 - 22} `)).toBe(true);
    // pi to win, left to right: it leaves the node's right side.
    expect(edge("s-c", "s-d").d.startsWith(`M${30 + 135 + 22} `)).toBe(true);
    // mac and win share the right column, so a line between them bows out to the right.
    const inRight = layoutMap([link(A, D), link(B, C)]).edges.find((e) => e.id === "s-a|s-d")!;
    expect(inRight.d.startsWith(`M${600 + 135 + 22} `)).toBe(true);
    // A line drawn from the right column to the left starts on the node's left side.
    const back = layoutMap([link(B, A), link(A, C)]).edges[0]!;
    expect(back.d).toMatch(/^M\d+ \d+ C /);
  });

  it("places each label clear of the others and of the nodes, and makes a busier line thicker", () => {
    const many = [link(A, B, { messages: 9 }), link(A2, B), link(A, C), link(A2, C), link(A, A2, { state: "paused" })];
    const m = layoutMap(many);
    const pills = m.edges.map((e) => e.pill);
    for (let i = 0; i < pills.length; i++) {
      for (let j = i + 1; j < pills.length; j++) {
        const p = pills[i]!;
        const q = pills[j]!;
        const apart = p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y;
        expect(apart, `labels ${i} and ${j}`).toBe(true);
      }
    }
    const edge = (id: string) => m.edges.find((e) => e.id === id)!;
    expect(edge("s-a|s-b").width).toBe(7);
    expect(edge("s-a2|s-b").width).toBeCloseTo(2.8);
    expect(edge("s-a|s-a2").label).toBe("1 message, paused");
    expect(edge("s-a|s-a2").pill.w).toBe(pillWidth("1 message, paused", true));
  });

  it("keeps a long label on a line that bows out of either column inside the map", () => {
    // Two orchestrators each on linux (the left column, first by name) and mac (the right). Each pair on one machine
    // has a long label, and its line bows out toward the map's edge.
    const B2 = end("s-b2", "beta-2", "linux", "k2");
    const long = { aToB: false, bToA: false, messages: 8 };
    const m = layoutMap([link(A, A2, long), link(A, B), link(B, B2, long)]);
    expect(m.machines.find((x) => x.key === "k2")!.x).toBe(30);
    expect(m.machines.find((x) => x.key === "k1")!.x).toBe(600);
    for (const id of ["s-a|s-a2", "s-b|s-b2"]) {
      const e = m.edges.find((x) => x.id === id)!;
      expect(e.label).toBe("8 messages, no right to send");
      expect.soft(e.pill.x, `${id} left edge`).toBeGreaterThanOrEqual(0);
      expect.soft(e.pill.x + e.pill.w, `${id} right edge`).toBeLessThanOrEqual(m.width);
      expect(e.pill.y).toBeGreaterThanOrEqual(0);
      expect(e.pill.y + e.pill.h).toBeLessThanOrEqual(m.height);
    }
  });

  it("falls back to the middle when every place along a curve is taken, still inside the map", () => {
    // Twenty conversations from one machine's orchestrators to another's.
    const crowd = Array.from({ length: 20 }, (_, i) => link(end(`s-x${i}`, `x${i}`, "mac", "k1"), B));
    const m = layoutMap(crowd);
    expect(m.edges).toHaveLength(20);
    // Twelve lines along one curve, between the same two orchestrators, cannot all find room: the last falls back to
    // the middle of its curve, where the first label already sits.
    const same = layoutMap(Array.from({ length: 12 }, () => link(A, B))).edges;
    expect(same[same.length - 1]!.pill).toEqual(same[0]!.pill);
    for (const e of m.edges) {
      expect(Number.isFinite(e.pill.x)).toBe(true);
      expect(e.pill.x).toBeGreaterThanOrEqual(0);
      expect(e.pill.x + e.pill.w).toBeLessThanOrEqual(m.width);
    }
  });

  it("finds a point on a curve", () => {
    expect(bezier([0, 0], [0, 0], [10, 10], [10, 10], 0)).toEqual([0, 0]);
    expect(bezier([0, 0], [0, 0], [10, 10], [10, 10], 1)).toEqual([10, 10]);
    expect(bezier([0, 0], [0, 0], [10, 10], [10, 10], 0.5)).toEqual([5, 5]);
  });
});

describe("trafficApi", () => {
  const ok = (body: unknown) => vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }));

  it("reads the open route, and the owner's routes with the respond header", async () => {
    const f = ok({ enabled: true, conversations: [] });
    vi.stubGlobal("fetch", f);
    await trafficApi.read("24h");
    expect(f).toHaveBeenLastCalledWith("/api/fleet/peers/traffic?range=24h", expect.objectContaining({ method: "GET" }));
    await trafficApi.conversation("s/a", "s-b");
    expect(f).toHaveBeenLastCalledWith("/api/fleet/respond/peers/conversations/s%2Fa/s-b", expect.objectContaining({ method: "GET", headers: { "X-Podium-Respond": "1" } }));
    await trafficApi.pause("k1", "k2", true);
    expect(f).toHaveBeenLastCalledWith(
      "/api/fleet/respond/peers/links",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ a: "k1", b: "k2", paused: true }), headers: { "X-Podium-Respond": "1", "Content-Type": "application/json" } }),
    );
    await trafficApi.remove("k1", "k2");
    expect(f).toHaveBeenLastCalledWith("/api/fleet/respond/peers/links", expect.objectContaining({ method: "DELETE", body: JSON.stringify({ a: "k1", b: "k2" }) }));
  });

  it("throws the server's refusal in its words, and copes with a body that is not JSON or is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ ok: false, error: "only its owner and an Admin can read a conversation" }) })));
    await expect(trafficApi.conversation("a", "b")).rejects.toThrow("only its owner and an Admin can read a conversation");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502, text: async () => "<html>Bad gateway</html>" })));
    const err = await trafficApi.read("live").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RespondError);
    expect((err as RespondError).message).toBe("HTTP 502");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => "" })));
    await expect(trafficApi.pause("a", "b", false)).resolves.toEqual({});
  });
});
