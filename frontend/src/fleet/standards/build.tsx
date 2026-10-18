// Renders the standards pages from the app (#354). `buildPages` returns every file under docs/standards that is generated,
// keyed by file name. The sync script writes them, and the parity test compares them with what is on disk.
import { render, cleanup } from "@testing-library/react";
import { classesIn, esc, normalizeIds, NAV, pageHtml, sectionHtml } from "./html";
import { SAMPLES, type Sample } from "./samples";
import { SCREENS } from "./screens";

/** The markup of each match of a sample's selector on its screen. */
export function renderSample(sample: Sample, screens = SCREENS): string[] {
  const make = screens[sample.screen];
  if (!make) throw new Error(`sample ${sample.id}: no screen named ${sample.screen}`);
  const { container } = render(make());
  const hits = [...container.ownerDocument.body.querySelectorAll(sample.selector)];
  const wanted = sample.labels ? sample.labels.length : 1;
  if (hits.length < wanted) throw new Error(`sample ${sample.id}: ${sample.selector} matched ${hits.length}, expected ${wanted}`);
  const out = hits.slice(0, wanted).map((el) => normalizeIds(el.outerHTML));
  cleanup();
  return out;
}

export function componentsPage(samples: Sample[] = SAMPLES, screens = SCREENS): string {
  const sections = samples.map((s) => {
    const markup = renderSample(s, screens);
    return sectionHtml(s, markup.map((m, i) => ({ label: s.labels?.[i] ?? s.title, markup: m })));
  });
  const toc = samples.map((s) => `<a href="#${esc(s.id)}">${esc(s.title)}</a>`).join("");
  const body = `  <div><h1>Components</h1><p>Every shared piece, rendered from the app with its own CSS. A sample here is what the app produces, so it cannot differ from it.</p></div>\n  <div class="s-toc">${toc}</div>\n${sections.join("\n")}`;
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
export function buildPages(): Record<string, string> {
  return { "index.html": indexPage(), "components.html": componentsPage() };
}

export { classesIn };
