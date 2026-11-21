// Who a message in a Direct Message was for, and the @ list narrowed to its members (#1282).
import { describe, it, expect } from "vitest";
import { conversationAddresses, conversationDelivery, conversationFor, conversationSummary, type ConversationDelivery } from "./chatData";

const d = (name: string, over: Partial<ConversationDelivery> = {}): ConversationDelivery => ({ kind: "agent", name, named: false, state: "queued", ...over });
const member = (kind: "person" | "agent", name: string, over: Record<string, unknown> = {}) => ({ kind, name, you: false, addedBy: null, address: kind === "person" ? `${name}@console` : `${name}@ed-mbp`, sessionId: kind === "agent" ? `s-${name}` : null, ...over });

describe("the @ list of a conversation", () => {
  const c = { members: [member("person", "Ed", { you: true }), member("person", "Maya"), member("agent", "Tester"), member("agent", "gone", { address: null })] };
  it("lists its members other than the viewer, and nobody else", () => {
    expect(conversationAddresses(c).map((a) => a.typed)).toEqual(["Maya@console", "Tester@ed-mbp", "gone"]);
  });
  it("lists an agent that has ended, and does not let it be picked", () => {
    expect(conversationAddresses(c)[2]).toMatchObject({ disabled: true, why: "Has ended, so it cannot take a message." });
    expect(conversationAddresses(c)[1]).toMatchObject({ role: "orchestrator", sessionId: "s-Tester" });
  });
  it("sums up who is in it, the viewer first", () => {
    expect(conversationSummary(c)).toBe("You, Maya and 2 agents.");
    expect(conversationSummary({ members: [member("person", "Maya"), member("person", "Ed", { you: true }), member("agent", "Tester")] })).toBe("You, Maya and 1 agent.");
  });
});

describe("who a message was for", () => {
  it("says nothing for a message that keeps no record", () => {
    expect(conversationFor({ deliveries: [] })).toBeNull();
    expect(conversationDelivery({ deliveries: [] })).toBeNull();
  });
  it("says everyone when no one was named, and lists the agents that took it", () => {
    const m = { deliveries: [d("Tester", { state: "delivered" }), d("infra-notes", { state: "delivered" })] };
    expect(conversationFor(m)).toEqual({ everyone: true, text: "For everyone in this conversation" });
    expect(conversationDelivery(m)).toEqual({ state: "done", text: "Delivered to Tester and infra-notes" });
  });
  it("names the member it was for, and the delivery line names only that agent", () => {
    const m = { deliveries: [d("Tester", { named: true, state: "delivered" })] };
    expect(conversationFor(m)).toEqual({ everyone: false, text: "For Tester" });
    expect(conversationDelivery(m)).toEqual({ state: "done", text: "Delivered to Tester" });
  });
  it("says no agent received a message that names only a person, and has no delivery line", () => {
    const m = { deliveries: [d("Maya", { kind: "person", named: true, state: null })] };
    expect(conversationFor(m)).toEqual({ everyone: false, text: "For Maya. No agent received it." });
    expect(conversationDelivery(m)).toBeNull();
  });
  it("says waiting while an agent has not taken it, and which one did not take it when it was dropped", () => {
    expect(conversationDelivery({ deliveries: [d("infra-notes", { named: true })] })).toEqual({ state: "wait", text: "Waiting for infra-notes to take it" });
    expect(conversationDelivery({ deliveries: [d("Tester", { state: "delivered" }), d("infra-notes", { state: "dropped" })] })).toEqual({ state: "bad", text: "Delivered to Tester. infra-notes did not take it" });
  });
  it("names a person and an agent together", () => {
    expect(conversationFor({ deliveries: [d("Tester", { named: true }), d("Maya", { kind: "person", named: true, state: null })] })).toEqual({ everyone: false, text: "For Tester and Maya" });
  });
});
