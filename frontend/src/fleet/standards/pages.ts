// The generated pages that come from the stylesheets rather than from a rendered screen (#354): tokens, themes, and the
// scale of sizes, radii, layers and durations. Each takes what it reads as an argument, so a test can feed it a small stylesheet.
import type { TokenBlock } from "../../../../scripts/standards-inventory";
import { THEMES } from "../themes";
import { esc, pageHtml } from "./html";
import { breakpoints, durations, valuesOf } from "./scale";
import { TOKEN_DOCS, TOKEN_GROUPS } from "./tokens.meta";

const BASE = ":root, .podium";
const PODIUM_LIGHT = ':root[data-theme="light"], :root[data-theme="light"] .podium';

/** The tokens a theme and mode actually resolve to: the Podium base, then Podium's light override or the theme's own block. */
export function effective(blocks: TokenBlock[], theme: string, mode: "light" | "dark"): Record<string, string> {
  const base = blocks.find((b) => b.selector === BASE)?.tokens ?? {};
  if (theme === "podium") return mode === "dark" ? { ...base } : { ...base, ...blocks.find((b) => b.selector === PODIUM_LIGHT)?.tokens };
  const own = blocks.find((b) => b.selector.startsWith(`:root[data-theme-name="${theme}"][data-theme="${mode}"]`));
  return { ...base, ...own?.tokens };
}

const isFont = (name: string) => name.startsWith("font-");
const code = (s: string) => `<code>${esc(s)}</code>`;

function table(head: string[], rows: string[][]): string {
  const th = head.map((h) => `<th scope="col">${esc(h)}</th>`).join("");
  const tr = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("\n      ");
  return `<div class="s-table-wrap"><table class="s-table"><thead><tr>${th}</tr></thead><tbody>\n      ${tr}\n    </tbody></table></div>`;
}

const swatch = (name: string) => `<span class="s-swatch" style="background: var(--${esc(name)})"></span>`;

export function tokensPage(blocks: TokenBlock[]): string {
  const dark = effective(blocks, "podium", "dark");
  const light = effective(blocks, "podium", "light");
  const sections = TOKEN_GROUPS.map((group) => {
    const names = Object.keys(dark).filter((n) => TOKEN_DOCS[n]?.group === group);
    const rows = names.map((n) => [
      `${isFont(n) ? "" : swatch(n)}${code(`--${n}`)}`,
      esc(TOKEN_DOCS[n].role),
      code(dark[n]),
      code(light[n] ?? dark[n]),
    ]);
    return `  <section class="s-panel" id="${esc(group.toLowerCase().replaceAll(/\W+/g, "-"))}"><h3>${esc(group)}</h3>\n    ${table(["Token", "Role", "Podium dark", "Podium light"], rows)}\n  </section>`;
  });
  const body = `  <div><h1>Tokens</h1><p>Every color and font token, named by its role. They live in <code>frontend/src/fleet/tokens.css</code> and nowhere else: the app, these pages and new mockups all read that file. The swatches follow the theme and mode picked above. The values shown are Podium's own, dark and light.</p></div>\n${sections.join("\n")}`;
  return pageHtml({ file: "tokens.html", title: "Tokens", body });
}

export function themesPage(blocks: TokenBlock[]): string {
  const columns = THEMES.flatMap((t) => t.modes.map((m) => ({ theme: t, mode: m, tokens: effective(blocks, t.id, m) })));
  const names = Object.keys(effective(blocks, "podium", "dark")).filter((n) => !isFont(n));
  const head = ["Token", ...columns.map((c) => `${c.theme.label} ${c.mode}`)];
  const rows = names.map((n) => [code(`--${n}`), ...columns.map((c) => `<span class="s-swatch" style="background: ${esc(c.tokens[n] ?? "")}"></span>${code(c.tokens[n] ?? "")}`)]);
  const credits = THEMES.map((t) => `<li>${esc(t.label)}: ${esc(t.credit)}</li>`).join("");
  const body = `  <div><h1>Themes</h1><p>Six palettes, each in light and dark. A theme is a set of values for every color token in <code>tokens.css</code>, picked by <code>data-theme-name</code> and <code>data-theme</code> on the root element. Podium is the default and follows the system until a person picks otherwise.</p></div>
  <section class="s-panel" id="what-a-theme-supplies"><h3>What a new theme supplies</h3>
    <p>A value for each of the ${names.length} color tokens on the Tokens page, in a block for each mode it ships, plus its id in the theme list (<code>themes.ts</code>) and in the script in <code>index.html</code>. A test fails if a block lacks a token. A theme with no palette for a mode uses Podium's for that mode.</p>
  </section>
  <section class="s-panel" id="contrast"><h3>Contrast</h3>
    <p>Every theme and mode must pass <code>scripts/theme-contrast.ts</code>, which runs in <code>npm test</code>. Text tokens need 4.5:1 on the page and surface colors. Mark tokens need 3:1, or Podium's own ratio for the same mode when that is lower. The four model colors must differ from each other by at least 0.08 in OKLab distance.</p>
  </section>
  <section class="s-panel" id="palettes"><h3>Every palette</h3>
    ${table(head, rows)}
  </section>
  <section class="s-panel" id="credits"><h3>Credits</h3><ul>${credits}</ul><p>The palettes other than Podium's are credited in <code>docs/THIRD_PARTY_NOTICES.md</code>.</p></section>`;
  return pageHtml({ file: "themes.html", title: "Themes", body });
}

function valueTable(rows: Array<[string, number]>, limit = rows.length): string {
  return table(["Value", "Uses"], rows.slice(0, limit).map(([v, n]) => [code(v), String(n)]));
}

/** The scale page: what the stylesheets set today for type, radius, layers, shadow, motion, breakpoints and spacing. */
export function scalePage(css: string): string {
  const spacing = new Map<string, number>();
  for (const p of ["padding", "margin", "gap"]) for (const [v, n] of valuesOf(css, p)) spacing.set(v, (spacing.get(v) ?? 0) + n);
  const spacingRows = [...spacing].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en", { numeric: true }));
  const section = (id: string, title: string, intro: string, rows: Array<[string, number]>, limit?: number) =>
    `  <section class="s-panel" id="${id}"><h3>${esc(title)}</h3><p>${esc(intro)}</p>\n    ${valueTable(rows, limit)}\n  </section>`;
  const body = `  <div><h1>Type, spacing, motion</h1><p>The sizes, radii, layers and durations the stylesheets set today, with how many declarations use each. They are not tokens yet, so this page lists what is in use instead of a scale the app might not follow. New work picks a value from these lists; a value that is not on one needs a reason in the PR.</p></div>
${section("font-size", "Font size", "The body text is set on .podium. The most used sizes come first.", valuesOf(css, "font-size"))}
${section("font-weight", "Font weight", "", valuesOf(css, "font-weight"))}
${section("radius", "Corner radius", "", valuesOf(css, "border-radius"))}
${section("layers", "Layers (z-index)", "Higher sits in front. Tooltips and the toast sit above the page, the modal above both.", valuesOf(css, "z-index"))}
${section("shadow", "Shadow", "", valuesOf(css, "box-shadow"))}
${section("motion", "Motion", "Durations in transitions and animations. Every animation stops under prefers-reduced-motion.", durations(css))}
${section("breakpoints", "Breakpoints", "The widths the layout changes at, in media and container queries.", breakpoints(css))}
${section("spacing", "Spacing", `Padding, margin and gap together: ${spacingRows.length} distinct values. Only the ten most used are shown. There is no spacing scale yet, and adopting one would change layouts, so it is left for its own issue.`, spacingRows, 10)}`;
  return pageHtml({ file: "scale.html", title: "Type, spacing, motion", body });
}
