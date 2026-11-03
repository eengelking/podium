import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PermissionForm, QuestionForm } from "./RespondForms";
import { HarnessContext } from "../harnessContext";
import type { AskDetail } from "../types";

afterEach(cleanup);

const T0 = 1_000_000;
const permission = (name: string): AskDetail => ({
  ask: { id: "t1", kind: "permission", agentId: null, openedAt: T0, tool: { name, input: { command: "npm test" }, cut: false } },
  state: "open", delivery: null, closed: null, lastSeenAt: T0,
});
const question: AskDetail = {
  ask: { id: "q1", kind: "question", agentId: null, openedAt: T0, questions: [{ question: "Which size?", header: "Size", multiSelect: false, options: [{ label: "Fixed 50 (Recommended)", description: "d", preview: null }, { label: "Choice", description: "d", preview: null }] }] },
  state: "open", delivery: null, closed: null, lastSeenAt: T0,
};
const noop = () => {};

const asHarness = (harness: string, ui: JSX.Element) => render(<HarnessContext.Provider value={harness}>{ui}</HarnessContext.Provider>);
const perm = (name: string, allow = true) => <PermissionForm detail={permission(name)} allow={allow} reason="" onAllow={noop} onReason={noop} busy={false} onSubmit={noop} />;
const ask = (harness: string) => asHarness(harness, <QuestionForm detail={question} tab={0} drafts={[null]} onTab={noop} onDraft={noop} onSubmit={noop} busy={false} />);

describe("the answer forms for each harness (#853)", () => {
  it("reads OpenCode's shell tool as a command and names the model, not Claude", () => {
    asHarness("opencode", perm("shell"));
    expect(screen.getByText("shell wants to run a command")).toBeInTheDocument();
    expect(screen.getByText("Runs this command now. The next one asks again.")).toBeInTheDocument();
    expect(screen.getByText("The model is told no and keeps going.")).toBeInTheDocument();
    cleanup();
    asHarness("opencode", perm("shell", false));
    expect(screen.getByLabelText("Tell the model why")).toBeInTheDocument();
  });

  it("reads Claude Code's Bash the same way and does not take a tool named shell for a command", () => {
    asHarness("claude-code", perm("Bash"));
    expect(screen.getByText("Bash wants to run a command")).toBeInTheDocument();
    expect(screen.getByText("Claude is told no and keeps going.")).toBeInTheDocument();
    cleanup();
    asHarness("claude-code", perm("shell"));
    expect(screen.getByText("shell wants your permission")).toBeInTheDocument();
  });

  it("shows the (Recommended) tag for Claude Code and leaves the label whole for OpenCode", () => {
    ask("claude-code");
    expect(screen.getByText("Fixed 50")).toBeInTheDocument();
    cleanup();
    ask("opencode");
    expect(screen.getByText("Fixed 50 (Recommended)")).toBeInTheDocument();
  });
});
