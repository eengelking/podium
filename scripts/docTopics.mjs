// A topic that is split into a folder (#697) is a `README.md` plus one page per section, entry or subsection, each with `order`
// in its frontmatter. This is the one place that reads such a folder, so the index builder, the reference check and the site agree
// on what is in it and in what order.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./docFrontmatter.mjs";

/** Folders under docs/ that hold no pages of this kind. */
export const SKIP_DIRS = new Set(["standards", "templates", "fixtures", "images"]);

export const ENTRIES_START = "<!-- entries:start -->";
export const ENTRIES_END = "<!-- entries:end -->";
export const NAV_START = "<!-- nav:start -->";
export const NAV_END = "<!-- nav:end -->";

/** Every `.md` file under `dir`, as paths that start with `dir`, leaving out the generated and example folders. Sorted. */
export function markdownUnder(dir) {
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (SKIP_DIRS.has(e.name) ? [] : walk(join(d, e.name))) : e.name.endsWith(".md") ? [join(d, e.name)] : [],
    );
  return walk(dir).sort();
}

/** Every folder under `root` (a docs folder) that has a README.md, as paths relative to `root`, outermost first. */
export function topicDirs(root) {
  const out = [];
  const walk = (rel) => {
    const abs = join(root, rel);
    if (rel && existsSync(join(abs, "README.md"))) out.push(rel);
    for (const e of readdirSync(abs, { withFileTypes: true })) if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(rel ? `${rel}/${e.name}` : e.name);
  };
  walk("");
  return out;
}

const numberOrder = (f) => (f.order === undefined || f.order === "" ? Number.POSITIVE_INFINITY : Number(f.order));

/**
 * The pages of one topic folder, in reading order: its other `.md` files and each subfolder's README.md. A page is
 * `{ name, link, fields, isFolder }`, where `link` is the path to link to from the folder's own README.md.
 */
export function topicEntries(root, dir) {
  const abs = join(root, dir);
  const entries = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    let file = null;
    if (e.isFile() && e.name.endsWith(".md") && e.name !== "README.md") file = { name: e.name, link: e.name, path: join(abs, e.name), isFolder: false };
    else if (e.isDirectory() && !SKIP_DIRS.has(e.name) && existsSync(join(abs, e.name, "README.md"))) file = { name: e.name, link: `${e.name}/README.md`, path: join(abs, e.name, "README.md"), isFolder: true };
    if (file) entries.push({ ...file, fields: parseFrontmatter(readFileSync(file.path, "utf8")).fields });
  }
  return entries.sort((a, b) => numberOrder(a.fields) - numberOrder(b.fields) || a.name.localeCompare(b.name));
}

const cell = (s) => String(s ?? "").replaceAll("|", "\\|");

/** The Markdown list for a README's entries, in the style its own frontmatter asks for: `entries: table`, `by-area` or (default) a list. */
export function entriesMarkdown(style, entries) {
  const link = (e) => `[${e.fields.title}](${e.link})`;
  if (style === "table") {
    const hasStatus = entries.some((e) => e.fields.status);
    const hasDate = entries.some((e) => e.fields.date);
    const head = ["Entry", ...(hasStatus ? ["Status"] : []), ...(hasDate ? ["Date"] : []), "Summary"];
    const rows = entries.map((e) => [link(e), ...(hasStatus ? [e.fields.status ?? ""] : []), ...(hasDate ? [e.fields.date ?? ""] : []), cell(e.fields.description)]);
    return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
  }
  if (style === "by-area") {
    const areas = [...new Set(entries.map((e) => e.fields.area ?? "Other"))];
    return areas
      .map((a) => `**${a}**\n\n${entries.filter((e) => (e.fields.area ?? "Other") === a).map((e) => `- ${link(e)}: ${e.fields.description}`).join("\n")}`)
      .join("\n\n");
  }
  return entries.map((e) => `- ${link(e)}: ${e.fields.description}`).join("\n");
}

/** Replaces what is between two markers, or returns the text unchanged when a marker is missing. */
export function replaceBetween(text, start, end, body) {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a === -1 || b === -1 || b < a) return text;
  return `${text.slice(0, a + start.length)}\n${body}\n${text.slice(b)}`;
}

/** The previous, up and next footer of one page in a folder. `up` is the README's title. */
export function navMarkdown({ prev, next, upTitle }) {
  const parts = [];
  if (prev) parts.push(`Previous: [${prev.fields.title}](${prev.href})`);
  parts.push(`Up: [${upTitle}](README.md)`);
  if (next) parts.push(`Next: [${next.fields.title}](${next.href})`);
  return `---\n\n${parts.join(" · ")}`;
}
