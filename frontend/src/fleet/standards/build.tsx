// Renders the standards pages from the app (#354). `buildPages` returns every file under docs/standards that is generated,
// keyed by file name. The sync script writes them, and the parity test compares them with what is on disk.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, cleanup } from "@testing-library/react";
import { vi } from "vitest";
import { FLEET_DIR, tokenBlocks } from "../../../../scripts/standards-inventory";
import { classesIn, esc, normalizeIds, NAV, pageHtml, sectionHtml } from "./html";
import { SAMPLES, type Sample } from "./samples";
import { scalePage, themesPage, tokensPage } from "./pages";
import { accessibilityPage, patternsPage, processPage, voicePage, type Entry } from "./prose";
import { SCREENS, type Screen } from "./screens";

/**
 * The markup of each case of a sample. A screen is rendered once, however many cases cut from it, and a case whose
 * selector matches nothing is an error that names the sample, so a renamed class never silently empties a page.
 */
export async function renderSample(sample: Sample, screens: Record<string, Screen> = SCREENS): Promise<Array<{ label: string; markup: string }>> {
  const out = new Map<string, string>();
  for (const id of new Set(sample.cases.map((c) => c.screen))) {
    const screen = screens[id];
    if (!screen) throw new Error(`sample ${sample.id}: no screen named ${id}`);
    // What one screen stores (collapsed panes, the board's layout, a theme) must not reach the next.
    localStorage.clear();
    sessionStorage.clear();
    for (const k of Object.keys(document.documentElement.dataset)) delete document.documentElement.dataset[k];
    const { container } = render(screen.make());
    const body = container.ownerDocument.body;
    await screen.act?.(body);
    for (const c of sample.cases.filter((x) => x.screen === id)) {
      const hit = body.querySelector(c.selector);
      if (!hit) throw new Error(`sample ${sample.id}: ${c.selector} matched nothing on screen ${id}`);
      out.set(c.label, normalizeIds(hit.outerHTML));
    }
    cleanup();
    vi.unstubAllGlobals();
  }
  return sample.cases.map((c) => ({ label: c.label, markup: out.get(c.label)! }));
}

const NOT_RENDERED = join(FLEET_DIR, "..", "..", "..", "docs", "standards", "not-rendered.json");
const DEFERRED = join(FLEET_DIR, "..", "..", "..", "docs", "standards", "deferred.json");
const readEntries = <T,>(file: string): T[] => (JSON.parse(readFileSync(file, "utf8")) as { entries: T[] }).entries;

/** The classes in the stylesheets that no sample renders, each with why, at the foot of the components page. */
function notRenderedSection(entries: Array<{ class: string; reason: string; kind: string }>): string {
  const rows = entries.map((e) => `<tr><td><code>.${esc(e.class)}</code></td><td>${esc(e.kind)}</td><td>${esc(e.reason)}</td></tr>`).join("");
  return `  <section class="s-panel" id="not-rendered"><h3>Classes these pages do not render</h3><p>The app has these classes in its stylesheets, and a sample cannot show them: they last a moment, depend on the window or the pointer, or no component uses them. Each has its reason, and a test fails if one is missing from both here and the samples.</p><div class="s-table-wrap"><table class="s-table"><thead><tr><th scope="col">Class</th><th scope="col">Kind</th><th scope="col">Why</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

export async function componentsPage(samples: Sample[] = SAMPLES, screens: Record<string, Screen> = SCREENS, notRendered: Array<{ class: string; reason: string; kind: string }> = readEntries(NOT_RENDERED)): Promise<string> {
  const sections: string[] = [];
  for (const s of samples) {
    sections.push(sectionHtml(s, await renderSample(s, screens)));
  }
  const toc = [...samples.map((s) => `<a href="#${esc(s.id)}">${esc(s.title)}</a>`), '<a href="#not-rendered">Not rendered</a>'].join("");
  const body = `  <div><h1>Components</h1><p>Every shared piece, rendered from the app with its own CSS. A sample here is what the app produces, so it cannot differ from it. The one change: a sample\'s main landmark is drawn as a div, because the page has its own.</p></div>\n  <div class="s-toc">${toc}</div>\n${sections.join("\n")}\n${notRenderedSection(notRendered)}`;
  return pageHtml({ file: "components.html", title: "Components", body });
}

export function indexPage(): string {
  const cards = NAV.flatMap((g) => g.pages)
    .filter((p) => p.file !== "index.html")
    .map((p) => `<a class="s-page" href="${p.file}"><b>${esc(p.title)}</b><span>${esc(p.blurb)}</span></a>`)
    .join("\n    ");
  const body = `  <div><h1>Podium UI standards</h1><p>What every Podium screen is built from. The samples on these pages are the app's own CSS and markup, and a test fails if a page and the app on <code>main</code> differ. Mockups and UI changes follow these pages.</p></div>\n  <div class="s-pages">\n    ${cards}\n  </div>`;
  return pageHtml({ file: "index.html", title: "Podium UI standards", body });
}

/** Every generated page. The parity test and the sync script both use this one list. */
export async function buildPages(): Promise<Record<string, string>> {
  const read = (f: string) => readFileSync(join(FLEET_DIR, f), "utf8");
  const blocks = tokenBlocks(read("tokens.css"));
  return {
    "index.html": indexPage(),
    "tokens.html": tokensPage(blocks),
    "themes.html": themesPage(blocks),
    "scale.html": scalePage(`${read("fleet.css")}\n${read("admin/admin.css")}`),
    "components.html": await componentsPage(),
    "patterns.html": patternsPage(),
    "voice.html": voicePage(),
    "accessibility.html": accessibilityPage(),
    "process.html": processPage(readEntries<Entry>(DEFERRED).map((d) => ({ file: `${d.file} ${(d as unknown as { text: string }).text}`, reason: d.reason }))),
  };
}

export { classesIn };
