// The Respond screens (#354): the real modal, forms and sign-in against a fake respond API, with the same asks the Respond tests use.
import { act, fireEvent, screen } from "@testing-library/react";
import { vi } from "vitest";
import { RespondModal } from "../components/Respond";
import { makeSession } from "../fixtures";
import { RespondError, type RespondApi } from "../respondApi";
import { RespondProvider, useRespond } from "../useRespond";
import type { Ask, AskDetail, AskSummary, RespondMe, SessionView } from "../types";
import type { Screen } from "./screens";

const T0 = 1_800_000_000_000;
const ME: RespondMe = { enabled: true, signedIn: true, name: "Ed", admin: false };
const ALL = ["question", "message", "plan-approve", "plan-feedback", "permission", "command"] as const;

const QUESTION: Ask = {
  id: "toolu_q",
  kind: "question",
  agentId: null,
  openedAt: T0,
  questions: [
    { question: "How many History rows per page?", header: "Page size", multiSelect: false, options: [{ label: "25/50/100, default 50 (Recommended)", description: "Same Pager as Admin.", preview: null }, { label: "Fixed 50, no choice", description: "Previous and Next.", preview: null }] },
    { question: "What should Back restore?", header: "Back state", multiSelect: true, options: [{ label: "The page number", description: "", preview: null }, { label: "The scroll position", description: "", preview: null }] },
  ],
};
const PREVIEW: Ask = {
  id: "toolu_v",
  kind: "question",
  agentId: null,
  openedAt: T0,
  questions: [{ question: "Which layout?", header: "Layout", multiSelect: false, options: [{ label: "Two columns", description: "Plan beside the agents.", preview: "+--------+--------+\n| plan   | agents |\n+--------+--------+" }, { label: "One column", description: "Stacked.", preview: "+-----------+\n| plan      |\n| agents    |\n+-----------+" }] }],
};
const PLAN: Ask = { id: "toolu_p", kind: "plan", agentId: null, openedAt: T0, plan: { text: "# Paginate History\n\n1. Page it", filePath: "~/.claude/plans/wise.md" } };
const TOOL: Ask = { id: "toolu_t", kind: "permission", agentId: null, openedAt: T0, tool: { name: "Bash", input: { command: "git push -u origin issue/195", description: "Push the branch to GitHub" }, cut: false } };
const summary = (a: Ask, state: AskSummary["state"] = "open"): AskSummary => ({ id: a.id, kind: a.kind, agentId: null, openedAt: a.openedAt, count: a.questions?.length ?? 1, state });
const detailOf = (ask: Ask, over: Partial<AskDetail> = {}): AskDetail => ({ ask, state: "open", delivery: null, closed: null, lastSeenAt: T0, ...over });
const mine = { id: "dlv_1", askId: "toolu_q", by: "Ed", at: T0, kind: "question" as const, answers: [{ options: [0] }, null], mine: true, handedOver: true, result: null };

function session(over: Partial<SessionView> = {}, ask: Ask | null = QUESTION, state: AskSummary["state"] = "open"): SessionView {
  return makeSession({ id: "sess-ed", name: "claude-dashboard", status: "waiting", waitReason: "input", owner: "Ed", reporterVersion: "0.14.0", activityFeed: true, respond: { level: "everything", accepts: [...ALL], limits: [] }, asks: ask ? [summary(ask, state)] : [], lastSeenAt: T0, ...over });
}

function fakeApi(me: RespondMe = ME, detail: AskDetail = detailOf(QUESTION)): RespondApi {
  return {
    me: async () => me,
    signIn: async () => ({ ok: true as const, name: "Ed", admin: false }),
    signOut: async () => ({ ok: true as const }),
    ask: async () => detail,
    answer: async () => ({ ok: true as const, deliveryId: "dlv_1" }),
    message: async () => ({ ok: true as const, deliveryId: "dlv_2", queued: false }),
    discard: async () => ({ ok: true as const }),
    fileDiff: async (_s: string, path: string) => ({ path, status: "unavailable" as const, text: null, truncated: false, shownLines: 0, totalLines: 0, redactions: 0, base: null }),
  };
}

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

/** The modal on a session, opened the way the Respond button opens it. */
function modal(s: SessionView, api: RespondApi, after?: () => Promise<void> | void, flagsOn = true): Screen {
  function Opener() {
    const ctx = useRespond();
    return ctx?.openFor ? <RespondModal s={s} now={T0 + 42_000} adminFeedOn /> : <button onClick={() => ctx?.open(s.id)}>open</button>;
  }
  return {
    make: () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ entries: [], since: T0, live: true, enabled: true, serverTime: T0 }) })));
      return (
        <RespondProvider api={api} flagsOn={flagsOn}>
          <Opener />
        </RespondProvider>
      );
    },
    act: async () => {
      await flush();
      fireEvent.click(screen.getByText("open"));
      await flush();
      await after?.();
    },
  };
}

const press = async (role: "tab" | "button", name: RegExp) => {
  fireEvent.click(screen.getByRole(role, { name }));
  await flush();
};

export const RESPOND_SCREENS: Record<string, Screen> = {
  "respond-question": modal(session(), fakeApi()),
  "respond-review": modal(session(), fakeApi(), () => press("tab", /Review/)),
  "respond-question-multi": modal(session(), fakeApi(), () => press("tab", /Back state/)),
  "respond-permission-cut": modal(session({ waitReason: "permission" }, { ...TOOL, tool: { ...TOOL.tool!, cut: true } }), fakeApi(ME, detailOf({ ...TOOL, tool: { ...TOOL.tool!, cut: true } }))),
  "respond-preview": modal(session({}, PREVIEW), fakeApi(ME, detailOf(PREVIEW))),
  "respond-plan": modal(session({ waitReason: "permission" }, PLAN), fakeApi(ME, detailOf(PLAN))),
  "respond-permission": modal(session({ waitReason: "permission" }, TOOL), fakeApi(ME, detailOf(TOOL))),
  "respond-message": modal(session({ asks: [], waitReason: null }, null), fakeApi(ME, detailOf(QUESTION))),
  "respond-pending": modal(session({}, QUESTION, "pending"), fakeApi(ME, detailOf(QUESTION, { state: "pending", delivery: mine }))),
  "respond-not-taken": modal(session({ waitReason: "permission" }, PLAN, "not-taken"), fakeApi(ME, detailOf(PLAN, { state: "not-taken", delivery: { ...mine, askId: "toolu_p", kind: "plan-approve" as const, mode: "auto" as const, answers: undefined, result: "not-taken" as const } }))),
  "respond-terminal": modal(session({ status: "running", waitReason: null }, QUESTION, "closed"), fakeApi(ME, detailOf(QUESTION, { state: "closed", closed: { outcome: "terminal", at: T0, by: null, answer: "25/50/100; The page number", planApproved: false } }))),
  "respond-closed": modal(session({ status: "running", waitReason: null }, QUESTION, "closed"), fakeApi(ME, detailOf(QUESTION, { state: "closed", closed: { outcome: "closed", at: T0, by: null, answer: null, planApproved: false } }))),
  "respond-stale": modal(session({ status: "stale" }, QUESTION, "pending"), fakeApi(ME, detailOf(QUESTION, { state: "pending", delivery: { ...mine, handedOver: false } }))),
  "respond-someone-else": modal(session({}, QUESTION, "pending"), fakeApi(ME, detailOf(QUESTION, { state: "pending", delivery: { ...mine, by: "Alex", mine: false, answers: [{ options: [1] }, null] } }))),
  "respond-signed-out": modal(session(), fakeApi({ enabled: true, signedIn: false, name: null, admin: false })),
  "respond-off": modal(session(), fakeApi(), undefined, false),
  "respond-typeahead": modal(session({ asks: [], waitReason: null }, null), fakeApi(ME, detailOf(QUESTION)), async () => {
    fireEvent.change(screen.getByRole("textbox", { name: "Message to claude-dashboard" }), { target: { value: "/" } });
    await flush();
  }),
  "respond-clear-confirm": modal(session({ asks: [], waitReason: null }, null), fakeApi(ME, detailOf(QUESTION)), async () => {
    fireEvent.change(screen.getByRole("textbox", { name: "Message to claude-dashboard" }), { target: { value: "/clear" } });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await flush();
  }),
  "respond-send-error": modal(session({ asks: [], waitReason: null }, null), { ...fakeApi(ME, detailOf(QUESTION)), message: async () => Promise.reject(new RespondError(409, { error: "session is not waiting" })) }, async () => {
    fireEvent.change(screen.getByRole("textbox", { name: "Message to claude-dashboard" }), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await flush();
  }),
  "respond-signin-error": modal(session(), { ...fakeApi({ enabled: true, signedIn: false, name: null, admin: false }), signIn: async () => Promise.reject(new RespondError(401, { error: "wrong name or token" })) }, async () => {
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ed" } });
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "pdm_x" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await flush();
  }),
};

