// An automated accessibility check that runs in `npm test` (#636). axe-core runs over the console's pages and the
// published standards pages in jsdom and fails on any violation not listed as known below. jsdom has no layout, so
// the rules that need one (color contrast, target size) cannot run here; `docs/standards/accessibility.html` lists
// the manual pass that covers them, and the real-browser scan found them (#636).
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import axe from "axe-core";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { FleetView } from "./FleetApp";
import { HistoryView } from "./HistoryView";
import { AdminView } from "./admin/AdminView";
import { fakeServer } from "./admin/fakeAdmin";
import { atWall, stateFrom } from "./testState";
import { makeSession } from "./fixtures";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
/** Rules jsdom cannot judge: they need layout or paint. */
const NEEDS_LAYOUT = ["color-contrast", "target-size", "scrollable-region-focusable", "link-in-text-block"];

/**
 * Violations that are known and explained, by rule and by page. A page may have its own and nothing else. Each one is
 * tracked in #636 or the issue it names; remove the entry when the finding is fixed.
 */
const SEPARATORS = "region"; // the two resize separators sit between landmarks; they are controls, not content
const CARD_COPY = "nested-interactive"; // the wall card's copy control sits inside the card's button (#759)

async function violations(root: Element | Document, known: string[] = []) {
  const r = await axe.run(root as axe.ElementContext, {
    runOnly: { type: "tag", values: TAGS },
    rules: Object.fromEntries(NEEDS_LAYOUT.map((id) => [id, { enabled: false }])),
  });
  return r.violations.filter((v) => !known.includes(v.id)).map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

class QuietSource {
  onerror = null;
  readyState = 1;
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  localStorage.clear();
  atWall();
  document.documentElement.lang = "en";
  vi.stubGlobal("EventSource", QuietSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "#/");
});

const sessions = [makeSession({ id: "s1", name: "api-refactor" }), makeSession({ id: "s2", name: "billing", status: "waiting", waitReason: "input" })];
const state = () => stateFrom({ sessions });

describe("axe on the console's pages (#636)", () => {
  it("the wall", async () => {
    const { container } = render(<FleetView state={state()} />);
    expect(await violations(container, [SEPARATORS, CARD_COPY])).toEqual([]);
  });

  it("an orchestrator's page", async () => {
    window.history.replaceState(null, "", "#/?open=s1");
    const { container } = render(<FleetView state={state()} />);
    expect(await violations(container, [SEPARATORS])).toEqual([]);
  });

  it("the board", async () => {
    const { container } = render(<FleetView board state={state()} />);
    expect(await violations(container, [])).toEqual([]);
  });

  it("Traffic and My reporters", async () => {
    const t = render(<FleetView traffic state={state()} />);
    expect(await violations(t.container, [])).toEqual([]);
    t.unmount();
    const m = render(<FleetView myReporters state={state()} />);
    expect(await violations(m.container, [])).toEqual([]);
  });

  it("History", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/history?day=")
          ? new Response(JSON.stringify({ day: "2026-10-10", sessions: [], total: 0, page: 1, pageSize: 20 }), { status: 200 })
          : new Response("{}", { status: 404 }),
      ),
    );
    const { container } = render(<HistoryView initialDay="2026-10-10" />);
    expect(await violations(container, [])).toEqual([]);
  });

  it("the Admin lock screen", async () => {
    fakeServer();
    const { container, findByLabelText } = render(<AdminView />);
    await findByLabelText("Name");
    expect(await violations(container, [])).toEqual([]);
  });
});

describe("axe on the published standards pages (#636)", () => {
  // The heading order of a reference page skips from h1 to h3 (#636, to be decided with the maintainer, since the
  // pages change only through podium-standards-update). components.html is left out: it is 20 seconds of samples of
  // the pages scanned above, so the real-browser pass covers it.
  const STANDARDS_KNOWN = ["heading-order"];
  const dir = resolve(__dirname, "../../../docs/standards");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".html") && f !== "components.html")) {
    it(file, async () => {
      const doc = new DOMParser().parseFromString(readFileSync(resolve(dir, file), "utf8"), "text/html");
      document.title = doc.title;
      document.body.innerHTML = doc.body.innerHTML;
      expect(await violations(document.body, STANDARDS_KNOWN)).toEqual([]);
    });
  }
});
