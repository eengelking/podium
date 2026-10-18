import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { inventory, coverageProblems, type NotRendered } from "../../../../scripts/standards-inventory";
import { buildPages, componentsPage, indexPage, renderSample } from "./build";
import { classesIn, esc, normalizeIds, NAV, pageHtml, sectionHtml } from "./html";
import { SAMPLES } from "./samples";
import { accessibilityPage, patternsPage, processPage, voicePage } from "./prose";
import type { Sample } from "./samples";
import { SCREENS } from "./screens";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "docs", "standards");

const fake: Sample = {
  id: "demo",
  title: "Demo",
  files: ["components/Demo.tsx"],
  purpose: "A demo <b>.",
  use: ["Use it."],
  avoid: ["Avoid it."],
  a11y: "It is text.",
  cases: [
    { label: "First", screen: "demo", selector: ".item.a" },
    { label: "Second", screen: "demo", selector: ".item.b" },
  ],
};
const screens = { demo: { make: () => (<div><i className="item a" data-x={`:r1:`} /><i className="item b" /><i className="other" /></div>) } };

afterEach(cleanup);

describe("html helpers", () => {
  it("escapes the characters that matter in text and attributes", () => {
    expect(esc(`a&b<c>"d"`)).toBe("a&amp;b&lt;c&gt;&quot;d&quot;");
  });

  it("numbers React ids in order of first use", () => {
    expect(normalizeIds('<a id=":r7:" for=":r9:"></a><b id=":r7:">')).toBe('<a id=":s1:" for=":s2:"></a><b id=":s1:">');
  });

  it("lists the classes in some markup once each, sorted", () => {
    expect(classesIn('<i class="b a"></i><b class="a c"></b><u class=""></u>')).toEqual(["a", "b", "c"]);
  });

  it("marks the current page in the nav and offers every theme", () => {
    const html = pageHtml({ file: "tokens.html", title: "Tokens", body: "<p>x</p>" });
    expect(html).toContain('<a href="tokens.html" aria-current="page">Tokens</a>');
    expect(html).not.toContain('<a href="index.html" aria-current="page">');
    expect(html).toContain('<option value="catppuccin">');
    expect(html).toContain('href="../../frontend/src/fleet/fleet.css"');
    expect((html.match(/<a href="[a-z]+\.html"/g) ?? []).length).toBe(NAV.flatMap((g) => g.pages).length);
  });

  it("writes a section with its markup, classes, rules and a11y note", () => {
    const html = sectionHtml(fake, [{ label: "First", markup: '<i class="item a"></i>' }]);
    expect(html).toContain('id="demo"');
    expect(html).toContain('data-files="components/Demo.tsx"');
    expect(html).toContain("<code>.a</code><code>.item</code>");
    expect(html).toContain("A demo &lt;b&gt;.");
    expect(html).toContain("<h4>Use when</h4><ul><li>Use it.</li></ul>");
  });
});

describe("rendering a sample from a screen", () => {
  it("cuts one match per label out of the rendered screen and numbers its ids", async () => {
    expect(await renderSample(fake, screens)).toEqual([
      { label: "First", markup: '<i class="item a" data-x=":s1:"></i>' },
      { label: "Second", markup: '<i class="item b"></i>' },
    ]);
  });

  it("says which sample is wrong when the screen or the selector does not fit", async () => {
    await expect(renderSample({ ...fake, cases: [{ label: "x", screen: "nope", selector: ".a" }] }, screens)).rejects.toThrow("sample demo: no screen named nope");
    await expect(renderSample({ ...fake, cases: [{ label: "x", screen: "demo", selector: ".missing" }] }, screens)).rejects.toThrow("sample demo: .missing matched nothing on screen demo");
  });

  it("waits for a screen that needs a click and some data before it reads it", async () => {
    const slow = { demo: { make: () => <div id="root2" />, act: async () => { await new Promise((r) => setTimeout(r, 5)); document.getElementById("root2")!.innerHTML = '<i class="item a late"></i><i class="item b"></i>'; } } };
    expect((await renderSample(fake, slow)).map((c) => c.markup)).toEqual(['<i class="item a late"></i>', '<i class="item b"></i>']);
  });

  it("builds the components page and the index", async () => {
    const page = await componentsPage([fake], screens);
    expect(page).toContain('<a href="#demo">Demo</a>');
    expect(page).toContain("First");
    expect(indexPage()).toContain('<a class="s-page" href="components.html">');
  });
});

describe("the written pages", () => {
  it("each builds with its heading, in the nav, and lists what the process page refers to", () => {
    expect(patternsPage()).toContain("<h1>Patterns</h1>");
    expect(patternsPage()).toContain("Close notice: &lt;name&gt;");
    expect(voicePage()).toContain("<h1>Voice</h1>");
    expect(accessibilityPage()).toContain("<h1>Accessibility and responsiveness</h1>");
    const process = processPage([{ file: "fleet.css rgba(0,0,0,.5)", reason: "A shadow." }]);
    expect(process).toContain("<h1>Process</h1>");
    expect(process).toContain("<code>fleet.css rgba(0,0,0,.5)</code>");
    expect(process).toContain("podium-standards-update");
  });
});

// Every screen the samples are cut from still renders and reaches its state. This does not compare anything with the files on
// disk, so a UI change on `development` does not fail it unless the change breaks a screen, which is a fixture to update.
describe("the screens", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(2_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("all render and reach their state", async () => {
    for (const [id, screen] of Object.entries(SCREENS)) {
      localStorage.clear();
      const { container } = render(screen.make());
      try {
        await screen.act?.(container.ownerDocument.body);
      } catch (e) {
        throw new Error(`screen ${id}: ${String(e).split("\n")[0]}`);
      }
      cleanup();
      vi.unstubAllGlobals();
    }
  }, 120_000);
});

// The pages are generated from the app, so the committed files must equal what the app renders now. This is the parity check.
// It is off in a plain `npm test`, because the app on `development` may be ahead of the standards, which follow `main`.
// `npm run standards:parity` and CI on a PR into main turn it on; `npm run standards:sync` rewrites the files.
const SYNC = process.env.STANDARDS_WRITE === "1";
describe.runIf(SYNC || process.env.STANDARDS_PARITY === "1")("standards match the app", () => {
  const zone = process.env.TZ;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(2_000_000);
    // Times in the markup (a feed entry's title, a clock) must read the same on every machine, so the zone and the language are fixed.
    process.env.TZ = "UTC";
    for (const m of ["toLocaleTimeString", "toLocaleDateString", "toLocaleString"] as const) {
      const real = Date.prototype[m];
      vi.spyOn(Date.prototype, m).mockImplementation(function (this: Date, _l?: Intl.LocalesArgument, o?: Intl.DateTimeFormatOptions) {
        return real.call(this, "en-US", { timeZone: "UTC", ...o });
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  // Building every page renders about ninety screens, so each test that builds them gets room to finish on a busy machine.
  const BUILD_MS = 60_000;

  it("has every generated page equal to what the app renders", async () => {
    const pages = await buildPages();
    if (SYNC) {
      mkdirSync(OUT, { recursive: true });
      for (const [file, html] of Object.entries(pages)) writeFileSync(join(OUT, file), html);
    }
    for (const [file, html] of Object.entries(pages)) expect(readFileSync(join(OUT, file), "utf8"), `docs/standards/${file} differs from the app: run npm run standards:sync after the change is approved`).toBe(html);
  }, BUILD_MS);

  it("renders every class in the stylesheets, or says why it cannot", async () => {
    const pages = await buildPages();
    const notRendered = (JSON.parse(readFileSync(join(OUT, "not-rendered.json"), "utf8")) as { entries: NotRendered[] }).entries;
    expect(coverageProblems(inventory().classes, classesIn(pages["components.html"]), notRendered)).toEqual([]);
  }, BUILD_MS);

  it("has a section for every component file, and only for files that exist", () => {
    const inv = inventory();
    const documented = SAMPLES.flatMap((s) => s.files);
    expect(inv.components.filter((f) => !documented.includes(f))).toEqual([]);
    expect(documented.filter((f) => !inv.components.includes(f) && !/\.(ts|css)$/.test(f))).toEqual([]);
  });

  it("has a page for every link in the nav", async () => {
    const pages = await buildPages();
    for (const g of NAV) for (const p of g.pages) expect(Object.keys(pages), p.file).toContain(p.file);
  }, BUILD_MS);
});
