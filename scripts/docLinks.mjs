// The string helpers behind check-doc-links.mjs: how a heading becomes the anchor GitHub gives it. Plain scans rather than
// patterns, so hostile input costs one pass (#487) and no replace can leave a tag behind (#489).

/**
 * Removes `<...>` runs. A `<` with no `>` after it, or `<>`, is left as text. One pass leaves no `<` that has a `>` after it,
 * since a match always ends at the first `>`.
 */
export function stripTags(text) {
  let out = "";
  let from = 0;
  let open = text.indexOf("<");
  while (open !== -1) {
    const close = text.indexOf(">", open + 1);
    if (close === -1) break;
    if (close === open + 1) {
      open = text.indexOf("<", open + 1);
      continue;
    }
    out += text.slice(from, open);
    from = close + 1;
    open = text.indexOf("<", from);
  }
  return out + text.slice(from);
}

/** The anchor GitHub gives a heading's text. */
export const slug = (h) =>
  stripTags(h.toLowerCase()).replace(/[`*~]/g, "").replace(/[^\p{L}\p{N} _-]/gu, "").trim().replace(/ /g, "-");

/** The heading text without its closing hashes or the whitespace around them. */
export function trimClosing(text) {
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end--;
  return text.slice(0, end).trimEnd();
}

/** `[text](url)` becomes `text`. A scan, not a pattern, so brackets that never close cost one pass. */
export function stripLinks(text) {
  let out = "";
  let from = 0;
  let open = text.indexOf("[");
  while (open !== -1) {
    const close = text.indexOf("]", open + 1);
    if (close === -1) break;
    const end = text[close + 1] === "(" ? text.indexOf(")", close + 2) : -1;
    if (text[close + 1] === "(" && end === -1) break;
    if (end === -1) {
      // Every "[" before this "]" pairs with the same "]", so none of them is a link.
      open = text.indexOf("[", close + 1);
      continue;
    }
    out += text.slice(from, open) + text.slice(open + 1, close);
    from = end + 1;
    open = text.indexOf("[", from);
  }
  return out + text.slice(from);
}
