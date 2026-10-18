#!/usr/bin/env node
// Turns a mockup into the file the Artifact tool publishes: drops the doctype, html, head and body tags (the tool adds
// its own skeleton) and inlines every local <link rel="stylesheet"> (resolving @import) because an artifact cannot load
// files from the repo. Remote links (Google Fonts) stay. The repo mockup is left alone.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: node scripts/mockup-artifact.mjs <mockup.html> <out.html>

Writes <out.html> from <mockup.html> for publishing with the Artifact tool:
  - removes <!doctype>, <html>, <head>, <body> and the viewport meta
  - inlines local stylesheets (<link rel="stylesheet" href="../x.css">), following @import
  - keeps remote stylesheets, the title, styles and scripts
Put <out.html> in the session scratchpad, not in the repo.`;

/** A stylesheet's text with its relative @imports pasted in, so the result is one self-contained block. */
export function inlineCss(file, seen = new Set()) {
  const path = resolve(file);
  if (seen.has(path)) return "";
  seen.add(path);
  const css = readFileSync(path, "utf8");
  return css.replaceAll(/@import\s+(?:url\()?["']([^"')]+)["']\)?\s*;/g, (_m, rel) =>
    /^https?:/.test(rel) ? _m : inlineCss(resolve(dirname(path), rel), seen),
  );
}

export function toArtifact(html, baseDir) {
  const inlined = html.replaceAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>/g, (m, href) =>
    /^https?:/.test(href) ? m : `<style>\n${inlineCss(resolve(baseDir, href))}\n</style>`,
  );
  return inlined
    .replaceAll(/<!doctype[^>]*>\s*/gi, "")
    .replaceAll(/<\/?(html|head|body)(\s[^>]*)?>\s*/gi, "")
    .replaceAll(/<meta\s+name="viewport"[^>]*>\s*/gi, "");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || args.length !== 2) {
    console.log(USAGE);
    process.exit(args.length === 2 || args.includes("--help") || args.includes("-h") ? 0 : 1);
  }
  const [src, out] = args;
  writeFileSync(out, toArtifact(readFileSync(src, "utf8"), dirname(resolve(src))));
  console.log(`wrote ${out}`);
}
