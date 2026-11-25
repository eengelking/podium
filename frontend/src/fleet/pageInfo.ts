// What each page is called and what it is for (#1209). One place, so the chip in the top bar, the banner under it and the (i) that opens the full
// description cannot drift apart. The chip is `name`. The banner shows the description's whole sentences that fit on its one line, and its (i)
// opens the rest. A page body no longer carries a title or description of its own where these two already say it.
//
// The first sentence is what the banner shows at 400 px beside the (i) and the Wall options pill, so it stays short: `FIRST_SENTENCE_MAX`
// characters at most. pageInfo.test.ts holds that, and that no two pages share a name or a description.

export type PageKey = "fleet" | "board" | "orchestrator" | "history" | "chat" | "myReporters" | "myUsage" | "traffic" | "admin";

/** The longest the first sentence of a description may be (in characters) and still fit beside the (i) and the Wall options pill at 400 px. */
export const FIRST_SENTENCE_MAX = 36;

const ESTIMATE = "Cost is an estimate from token counts and a price table, not a bill.";

export const PAGE_INFO: Record<PageKey, { name: string; description: string }> = {
  fleet: { name: "Fleet", description: `Every session on this machine, live. Each orchestrator's model, plan, agents, cost and context are on its card. ${ESTIMATE}` },
  board: { name: "Board", description: `The fleet as a board of cards. Sessions are grouped by what each one is doing. ${ESTIMATE}` },
  orchestrator: { name: "Orchestrator", description: `One orchestrator and its agents. Its plan, files, activity, cost and context are here. ${ESTIMATE}` },
  history: { name: "History", description: "Past sessions, read-only. They are built from what the server stored. Cost is an estimate, not a bill." },
  chat: { name: "Chat", description: "Talk with orchestrators and agents. Read what they say to each other, and join in." },
  myReporters: {
    name: "My reporters",
    description: "Your reporters and who may message. This is which of your machines report to this server, and which of them may message each other.",
  },
  myUsage: { name: "My usage", description: `What your own sessions cost. They are listed with how each ended and what failed. Only you can see this page. ${ESTIMATE}` },
  traffic: { name: "Traffic", description: "Messages between orchestrators. The list covers every machine that reports here." },
  admin: {
    name: "Admin",
    description:
      "Manage access, settings and reports. People, groups and reporters decide who can report here. Settings, model prices, security, certificates and stored data decide how the server runs. Reports cover usage, spend, sessions, tools and failures, and the Admin log lists what happened in Admin.",
  },
};

/** My reporters adds what only a person with reporters needs (#1209): that only their own are listed, and that a request from Chat waits for them. */
export function myReportersDescription(hasReporters: boolean): string {
  const base = PAGE_INFO.myReporters.description;
  return hasReporters ? `${base} Only your own reporters are here. A person using Chat who wants to message one of your agents asks you below first.` : base;
}

/** A description's sentences, in order. A sentence ends at ., ! or ? followed by a space; the text has no abbreviations that end in a full stop. */
export function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s !== "");
}

/**
 * The most whole sentences of `text` that `fits`. At least the first is always returned: a banner never shows nothing, and it is never cut inside a
 * sentence, so a first sentence that does not fit is returned as it is (and `fits` is false for it; see `PageBanner`). `clipped` says some were left out.
 */
export function fitSentences(text: string, fits: (shown: string) => boolean): { shown: string; clipped: boolean } {
  const all = sentencesOf(text);
  for (let n = all.length; n > 1; n--) {
    const shown = all.slice(0, n).join(" ");
    if (fits(shown)) return { shown, clipped: n < all.length };
  }
  return { shown: all[0] ?? "", clipped: all.length > 1 };
}
