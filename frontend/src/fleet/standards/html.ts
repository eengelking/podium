// Builds the standards pages' HTML (#354). Pure string functions, so they run without a browser and a test can check them.
// The pages themselves are generated from the app (see build.tsx), never edited by hand, which is how they stay identical to it.
import { byCodeUnit } from "../../../../scripts/standards-inventory";
import { THEMES } from "../themes";

export const FONTS_HREF = "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Schibsted+Grotesk:wght@400;500;600;700&display=swap";

export interface PageLink {
  file: string;
  title: string;
  blurb: string;
}

/** The pages, in nav order, under the heading each sits beneath. The index lists them with the blurbs. */
export const NAV: ReadonlyArray<{ heading: string | null; pages: PageLink[] }> = [
  { heading: null, pages: [{ file: "index.html", title: "Index", blurb: "" }] },
  {
    heading: "Foundations",
    pages: [
      { file: "tokens.html", title: "Tokens", blurb: "Every color token by role, with its value in each theme and mode" },
      { file: "themes.html", title: "Themes", blurb: "The six palettes, light and dark, and the contrast targets" },
      { file: "scale.html", title: "Type, spacing, motion", blurb: "The sizes, radii, layers and durations the app uses today" },
    ],
  },
  {
    heading: "Building blocks",
    pages: [
      { file: "components.html", title: "Components", blurb: "Every shared piece rendered from the app, with its states" },
      { file: "patterns.html", title: "Patterns", blurb: "Wall notices, paging, status shapes, empty states" },
    ],
  },
  {
    heading: "Practice",
    pages: [
      { file: "voice.html", title: "Voice", blurb: "Wording for labels, notes and errors" },
      { file: "accessibility.html", title: "Accessibility", blurb: "Focus, keyboard, labels, reduced motion, narrow width" },
      { file: "process.html", title: "Process", blurb: "When a mockup is needed and how to add to the system" },
    ],
  },
];

export const esc = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function nav(current: string): string {
  const parts = NAV.map((g) => {
    const links = g.pages.map((p) => `<a href="${p.file}"${p.file === current ? ' aria-current="page"' : ""}>${esc(p.title)}</a>`).join("\n    ");
    return `${g.heading ? `<h2>${esc(g.heading)}</h2>\n    ` : ""}${links}`;
  });
  return `<nav class="s-nav" aria-label="Standards pages">\n    ${parts.join("\n    ")}\n  </nav>`;
}

/** A full standards page: the chrome around `body`, linking the app's own stylesheets by relative path so it works from a checkout or a file. */
export function pageHtml(opts: { file: string; title: string; body: string }): string {
  const options = THEMES.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join("");
  return `<!doctype html>
<html lang="en" data-theme-name="podium" data-theme="dark" data-mode="system">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} - Podium standards</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONTS_HREF}" rel="stylesheet">
<link rel="stylesheet" href="../../frontend/src/fleet/fleet.css">
<link rel="stylesheet" href="../../frontend/src/fleet/admin/admin.css">
<link rel="stylesheet" href="standards.css">
<script src="standards.js"></script>
</head>
<body>
<header class="s-bar">
  <a class="s-logo" href="index.html">Podium <span>standards</span></a>
  <span class="s-grow"></span>
  <label class="s-field" for="s-theme">Theme <select class="s-select" id="s-theme">${options}</select></label>
  <div class="s-seg" role="radiogroup" aria-label="Mode" id="s-mode">
    <button type="button" role="radio" aria-checked="false" data-mode="light">Light</button>
    <button type="button" role="radio" aria-checked="false" data-mode="dark">Dark</button>
    <button type="button" role="radio" aria-checked="true" data-mode="system">System</button>
  </div>
</header>
<div class="s-shell">
  ${nav(opts.file)}
  <main class="s-main">
${opts.body}
  </main>
</div>
</body>
</html>
`;
}

/** React's useId values depend on how many renders came before. Number them in order of first use so the same screen always gives the same markup. */
export function normalizeIds(html: string): string {
  const seen = new Map<string, string>();
  return html.replaceAll(/[«:]r[0-9a-z]+[»:]/g, (m) => {
    if (!seen.has(m)) seen.set(m, `:s${seen.size + 1}:`);
    return seen.get(m)!;
  });
}

/** The class names that appear in class="" attributes of some markup. */
export function classesIn(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/\sclass="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (c) out.add(c);
  return [...out].sort(byCodeUnit);
}

export interface SectionSpec {
  id: string;
  title: string;
  /** Source files the component lives in, relative to frontend/src/fleet. */
  files: string[];
  purpose: string;
  use: string[];
  avoid: string[];
  a11y: string;
}

const list = (items: string[]) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;

/** One standard on the components page: what it is for, its real markup, the classes in it, when to use it and when not, and its accessibility. */
export function sectionHtml(spec: SectionSpec, samples: Array<{ label: string; markup: string; wrap?: string }>): string {
  const wrapped = samples.map((s) => (s.wrap ? { ...s, markup: `<div class="${esc(s.wrap)}">${s.markup}</div>` } : s));
  const classes = classesIn(wrapped.map((s) => s.markup).join(" "));
  // A page has one main landmark, so one that a sample carries (Admin's) is drawn as a div. Nothing else changes.
  const asDiv = (markup: string) => markup.replaceAll(/<(\/?)main(?=[\s>])/g, "<$1div");
  const shown = wrapped
    .map((s) => `<div class="s-case"><div class="podium s-sample" data-sample="${esc(spec.id)}">${asDiv(s.markup)}</div><div class="s-cap">${esc(s.label)}</div></div>`)
    .join("\n    ");
  return `  <section class="s-panel" id="${esc(spec.id)}" data-files="${esc(spec.files.join(" "))}">
    <h3>${esc(spec.title)} ${spec.files.map((f) => `<code>${esc(f)}</code>`).join(" ")}</h3>
    <p>${esc(spec.purpose)}</p>
    ${shown}
    <div class="s-cap" data-classes>${classes.map((c) => `<code>.${esc(c)}</code>`).join("")}</div>
    <div class="s-rules"><div class="s-use"><h4>Use when</h4>${list(spec.use)}</div><div class="s-avoid"><h4>Do not</h4>${list(spec.avoid)}</div></div>
    <p>${esc(spec.a11y)}</p>
  </section>`;
}
