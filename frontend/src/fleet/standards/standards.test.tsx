import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { buildPages, componentsPage, indexPage, renderSample } from "./build";
import { classesIn, esc, normalizeIds, NAV, pageHtml, sectionHtml } from "./html";
import type { Sample } from "./samples";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "docs", "standards");

const fake: Sample = {
  id: "demo",
  title: "Demo",
  files: ["components/Demo.tsx"],
  purpose: "A demo <b>.",
  use: ["Use it."],
  avoid: ["Avoid it."],
  a11y: "It is text.",
  screen: "demo",
  selector: ".item",
  labels: ["First", "Second"],
};
const screens = { demo: () => (<div><i className="item a" data-x={`:r1:`} /><i className="item b" /><i className="other" /></div>) };

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
  it("cuts one match per label out of the rendered screen and numbers its ids", () => {
    expect(renderSample(fake, screens)).toEqual(['<i class="item a" data-x=":s1:"></i>', '<i class="item b"></i>']);
  });

  it("says which sample is wrong when the screen or the selector does not fit", () => {
    expect(() => renderSample({ ...fake, screen: "nope" }, screens)).toThrow("sample demo: no screen named nope");
    expect(() => renderSample({ ...fake, selector: ".missing" }, screens)).toThrow("sample demo: .missing matched 0, expected 2");
  });

  it("builds the components page and the index", () => {
    const page = componentsPage([fake], screens);
    expect(page).toContain('<a href="#demo">Demo</a>');
    expect(page).toContain("First");
    expect(indexPage()).toContain('<a class="s-page" href="components.html">');
  });
});

// The pages are generated from the app, so the committed files must equal what the app renders now. This is the parity check.
// It is off in a plain `npm test`, because the app on `development` may be ahead of the standards, which follow `main`.
// `npm run standards:parity` and CI on a PR into main turn it on; `npm run standards:sync` rewrites the files.
const SYNC = process.env.STANDARDS_WRITE === "1";
describe.runIf(SYNC || process.env.STANDARDS_PARITY === "1")("standards match the app", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(2_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("has every generated page equal to what the app renders", () => {
    const pages = buildPages();
    if (SYNC) {
      mkdirSync(OUT, { recursive: true });
      for (const [file, html] of Object.entries(pages)) writeFileSync(join(OUT, file), html);
    }
    for (const [file, html] of Object.entries(pages)) expect(readFileSync(join(OUT, file), "utf8"), `docs/standards/${file} differs from the app: run npm run standards:sync after the change is approved`).toBe(html);
  });
});
