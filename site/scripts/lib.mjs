// The pure parts of the site build (#688): turning a doc in docs/ into a page Starlight can read, and choosing which released versions
// the site shows. Plain scans rather than patterns on text that comes from the docs, so hostile input costs one pass (#487, #489).
import fs from "node:fs";
import path from "node:path";
import { PAGES, EMBEDS, STATIC_DIRS, STYLES, REPO, SITE_ORIGIN } from "../docs-nav.mjs";

const MAX_DESCRIPTION = 160;

/** Calls `fn` on each line outside a fenced code block, and passes the line through unchanged inside one. */
function mapOutsideFences(md, fn) {
  let fence = "";
  return md
    .split("\n")
    .map((line) => {
      const t = line.trimStart();
      const marker = t.startsWith("```") ? "```" : t.startsWith("~~~") ? "~~~" : "";
      if (marker && (!fence || fence === marker)) {
        fence = fence ? "" : marker;
        return line;
      }
      return fence ? line : fn(line);
    })
    .join("\n");
}

/** Calls `fn` on the parts of a line that are not inline code. */
function mapOutsideInlineCode(line, fn) {
  let out = "";
  let from = 0;
  let open = line.indexOf("`");
  while (open !== -1) {
    let end = open;
    while (line[end] === "`") end++;
    const ticks = line.slice(open, end);
    const close = line.indexOf(ticks, end);
    if (close === -1) break;
    out += fn(line.slice(from, open)) + line.slice(open, close + ticks.length);
    from = close + ticks.length;
    open = line.indexOf("`", from);
  }
  return out + fn(line.slice(from));
}

/** The text of a heading or paragraph without Markdown marks: links become their text, code and emphasis lose their marks. */
export function plain(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "[") {
      const close = text.indexOf("](", i);
      const end = close === -1 ? -1 : text.indexOf(")", close + 2);
      if (end !== -1 && !text.slice(i + 1, close).includes("[")) {
        out += plain(text.slice(i + 1, close));
        i = end + 1;
        continue;
      }
    }
    if (ch !== "`" && ch !== "*" && ch !== "_" && ch !== "~") out += ch;
    else if (ch === "_" && /\w/.test(text[i - 1] ?? "") && /\w/.test(text[i + 1] ?? "")) out += ch;
    i++;
  }
  return out.replaceAll(/\s+/g, " ").trim();
}

/** The first `# ` heading outside a code block, or "". */
export function titleOf(md) {
  let title = "";
  mapOutsideFences(md, (line) => {
    if (!title && line.startsWith("# ")) title = plain(line.slice(2));
    return line;
  });
  return title;
}

/** The first paragraph of prose after the title, cut to a sentence or a word boundary that fits a search result. */
export function descriptionOf(md) {
  const lines = md.split("\n");
  const para = [];
  for (let i = lines.findIndex((l) => l.startsWith("# ")) + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("#")) break;
    const isBlock = /^([>|<]|```|~~~|!\[|[*+-] |\d+\. )/.test(t);
    if (!t || isBlock) {
      if (para.length) break;
      continue;
    }
    para.push(t);
  }
  const text = plain(para.join(" "));
  if (text.length <= MAX_DESCRIPTION) return text;
  const cut = text.slice(0, MAX_DESCRIPTION);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "));
  if (sentence > 60) return cut.slice(0, sentence + 1);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[ ,;:(-]+$/, "") + "\u2026";
}

function hasScheme(t) {
  const colon = t.indexOf(":");
  if (colon < 1) return false;
  for (let i = 0; i < colon; i++) if (!/[a-z0-9+.-]/i.test(t[i])) return false;
  return /[a-z]/i.test(t[0]);
}

/**
 * Where a link written in a doc points on the site. A page or a static folder becomes a site address, anything else in the
 * repository becomes a GitHub address at `ref`, and a link that is not a relative path is left alone.
 * @param {string} target the link as written
 * @param {{ base: string, ref: string, fromDir: string, slugs: Map<string, string> }} ctx
 */
export function rewriteTarget(target, ctx) {
  if (!target || target.startsWith("#") || target.startsWith("/") || hasScheme(target)) return target;
  const hashAt = target.indexOf("#");
  const rel = hashAt === -1 ? target : target.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : target.slice(hashAt);
  if (!rel) return target;
  const resolved = path.posix.normalize(path.posix.join("docs", ctx.fromDir, rel));
  if (resolved.startsWith("../")) return target;
  const inDocs = resolved.startsWith("docs/") ? resolved.slice(5) : null;
  if (inDocs !== null) {
    const slug = ctx.slugs.get(inDocs);
    if (slug) return `${ctx.base}${slug}/${hash}`;
    for (const dir of STATIC_DIRS) {
      if (inDocs === dir.from || inDocs.startsWith(`${dir.from}/`)) {
        const rest = inDocs.slice(dir.from.length + 1);
        const tail = rest === "" || rest.endsWith("/") ? `${rest}index.html` : (dir.rename?.[rest] ?? rest);
        return `${ctx.base}${dir.to}/${tail}${hash}`;
      }
    }
  }
  const kind = rel.endsWith("/") || !path.posix.extname(resolved) ? "tree" : "blob";
  const repoPath = resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
  return `https://github.com/${REPO}/${kind}/${ctx.ref}/${repoPath}${hash}`;
}

/** Rewrites every `[text](target)` and `![alt](target)` outside code in a doc. */
export function rewriteLinks(md, ctx) {
  return mapOutsideFences(md, (line) =>
    mapOutsideInlineCode(line, (part) => {
      let out = "";
      let from = 0;
      let at = part.indexOf("](");
      while (at !== -1) {
        const start = at + 2;
        let depth = 1;
        let end = start;
        while (end < part.length && depth > 0) {
          if (part[end] === "(") depth++;
          else if (part[end] === ")") depth--;
          end++;
        }
        if (depth !== 0) break;
        const inner = part.slice(start, end - 1);
        const space = inner.search(/\s/);
        const target = space === -1 ? inner : inner.slice(0, space);
        const title = space === -1 ? "" : inner.slice(space);
        out += part.slice(from, start) + rewriteTarget(target, ctx) + title + ")";
        from = end;
        at = part.indexOf("](", from);
      }
      return out + part.slice(from);
    }),
  );
}

/** YAML frontmatter. Strings are written as JSON, which is valid YAML, so a colon or a quote in a title needs no care. */
export function frontmatter(fields) {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${k === "lastUpdated" ? v : JSON.stringify(v)}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

/**
 * Builds one page's Markdown for the site from a doc.
 * @param {{ file: string, slug: string, label: string }} page
 * @param {string} md the doc's text
 * @param {{ base: string, ref: string, slugs: Map<string, string>, editBase: string, lastUpdated?: string, older?: boolean }} ctx
 */
export function preparePage(page, md, ctx) {
  const title = titleOf(md) || page.label;
  const body = rewriteLinks(removeTitle(md), { ...ctx, fromDir: path.posix.dirname(page.file) === "." ? "" : path.posix.dirname(page.file) });
  const head = frontmatter({
    title,
    description: descriptionOf(md),
    editUrl: ctx.editBase ? `${ctx.editBase}docs/${page.file}` : undefined,
    lastUpdated: ctx.lastUpdated,
    // Starlight shows its banner slot only when a page has this field; the site's Banner says which version it is.
    banner: ctx.older ? { content: "Older version" } : undefined,
  });
  return { title, description: descriptionOf(md), content: head + body.replace(/^\n+/, "") };
}

function removeTitle(md) {
  let done = false;
  const kept = [];
  let fence = "";
  for (const line of md.split("\n")) {
    const t = line.trimStart();
    const marker = t.startsWith("```") ? "```" : t.startsWith("~~~") ? "~~~" : "";
    if (marker && (!fence || fence === marker)) fence = fence ? "" : marker;
    if (!done && !fence && line.startsWith("# ")) {
      done = true;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/** The Markdown of a page that shows a static page in a frame, without a table of contents. theme.css widens a page that has a frame. */
export function embedPage(embed, base) {
  const head = frontmatter({
    title: embed.title,
    description: embed.description,
    tableOfContents: false,
    prev: false,
    next: false,
    lastUpdated: false,
  });
  const src = `${base}${embed.src}`;
  return `${head}<iframe class="embed" src="${src}" title="${embed.frame}" loading="lazy"></iframe>\n\n<p class="embed-note"><a href="${src}">Open this on its own page</a></p>\n`;
}

function copyTree(from, to, only, rename = {}) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, rename[entry.name] ?? entry.name);
    if (entry.isDirectory()) copyTree(src, dst, only, rename);
    else if (!only || entry.name.endsWith(only)) fs.copyFileSync(src, dst);
  }
}

/**
 * Writes the site's pages and static folders for one version.
 * @param {{ docsDir: string, rootDir?: string, contentDir: string, publicDir: string, base: string, ref: string, editBase: string, older?: boolean, lastUpdatedOf?: (file: string) => string | undefined }} opts
 * @returns {{ pages: object[], statics: string[] }} the pages written, in menu order, and the static folders copied
 */
export function prepareDocs(opts) {
  const { docsDir, contentDir, publicDir, base, ref, editBase } = opts;
  fs.rmSync(contentDir, { recursive: true, force: true });
  fs.mkdirSync(contentDir, { recursive: true });
  for (const dir of STATIC_DIRS) fs.rmSync(path.join(publicDir, dir.to), { recursive: true, force: true });
  const slugs = new Map(PAGES.map((p) => [p.file, p.slug]));
  const written = [];
  for (const page of PAGES) {
    const file = path.join(docsDir, page.file);
    if (!fs.existsSync(file)) continue;
    const out = preparePage(page, fs.readFileSync(file, "utf8"), { base, ref, slugs, editBase, older: opts.older, lastUpdated: opts.lastUpdatedOf?.(page.file) });
    fs.writeFileSync(path.join(contentDir, `${page.slug}.md`), out.content);
    written.push({ slug: page.slug, label: page.label, group: page.group, title: out.title, description: out.description });
  }
  const statics = [];
  for (const dir of STATIC_DIRS) {
    if (!fs.existsSync(path.join(docsDir, dir.from))) continue;
    copyTree(path.join(docsDir, dir.from), path.join(publicDir, dir.to), dir.only, dir.rename);
    statics.push(dir.to);
  }
  // The standards pages load the app's stylesheets by a path that climbs out of docs/, so the stylesheets of the same version go to
  // the matching place under the site.
  fs.rmSync(path.join(publicDir, "frontend"), { recursive: true, force: true });
  for (const css of STYLES) {
    const from = path.join(opts.rootDir ?? path.dirname(docsDir), css);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(path.join(publicDir, css)), { recursive: true });
    fs.copyFileSync(from, path.join(publicDir, css));
  }
  for (const embed of EMBEDS) {
    if (!statics.includes(embed.dir)) continue;
    fs.writeFileSync(path.join(contentDir, `${embed.slug}.md`), embedPage(embed, base));
    written.push({ slug: embed.slug, label: embed.title, group: embed.group, title: embed.title, description: embed.description });
  }
  return { pages: written, statics };
}

/** The text of `llms.txt`: what the site is and one line per page, for tools that read a site instead of a person. */
export function llmsTxt(pages, origin = SITE_ORIGIN) {
  const lines = [
    "# Podium",
    "",
    "> Podium is a live fleet console for Claude Code. It shows every session on one machine in one browser tab: each session's model, effort and plan, the agents it launched, what they cost, how full their context windows are, why anything failed, and which git branch it works in. It watches; it never types into a terminal.",
    "",
    "## Docs",
    "",
    ...pages.map((p) => `- [${p.title}](${origin}/${p.slug}/): ${p.description}`),
    "",
  ];
  return lines.join("\n");
}

function parseTag(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), tag } : null;
}

const lineOf = (v) => `${v.major}.${v.minor}`;
const compareLines = (a, b) => {
  const [am, an] = a.split(".").map(Number);
  const [bm, bn] = b.split(".").map(Number);
  return am - bm || an - bn;
};

/**
 * The versions the site shows, newest first. The newest is the working tree (`ref: null`), served at the root and built from the
 * docs as they are, because the site is built when `main` moves, before the release is tagged. Each older release line from
 * `firstLine` on is built from its newest tag and served at `/<line>/`.
 */
export function computeVersions({ tags, headVersion, firstLine }) {
  const [major, minor] = headVersion.split(".");
  const headLine = `${major}.${minor}`;
  const newestByLine = new Map();
  for (const v of tags.map(parseTag).filter(Boolean)) {
    const line = lineOf(v);
    const have = newestByLine.get(line);
    if (!have || v.patch > have.patch) newestByLine.set(line, v);
  }
  const older = [...newestByLine.keys()]
    .filter((line) => compareLines(line, firstLine) >= 0 && compareLines(line, headLine) < 0)
    .sort((a, b) => compareLines(b, a))
    .map((line) => ({ line, label: line, latest: false, ref: newestByLine.get(line).tag, base: `/${line}/` }));
  return [{ line: headLine, label: headLine, latest: true, ref: null, base: "/" }, ...older];
}

/** The GitHub page that lists what a version changed: the latest release for the newest version, the tag's release for an older one. */
export function releaseUrl(version) {
  return version.latest ? `https://github.com/${REPO}/releases/latest` : `https://github.com/${REPO}/releases/tag/${version.ref}`;
}
