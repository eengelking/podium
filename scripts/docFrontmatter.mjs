// The frontmatter every page in docs/ carries (#696): `title`, `description` and `group`. One parser, used by
// check-doc-frontmatter.mjs and by the docs site build, so the two never read a page differently.

export const GROUPS = ["Getting started", "Running it", "Reference", "Project internals"];
export const MAX_DESCRIPTION = 160;

/**
 * Splits a doc into its frontmatter fields and the rest. Frontmatter is a block of `key: value` lines between two `---` lines at the
 * very top. A value is plain text or a double-quoted string. A doc with no block gets empty fields and its whole text as the body.
 * @returns {{ fields: Record<string, string>, body: string }}
 */
export function parseFrontmatter(md) {
  const lines = md.split("\n");
  if (lines[0].trim() !== "---") return { fields: {}, body: md };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end === -1) return { fields: {}, body: md };
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    let value = line.slice(colon + 1).trim();
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    }
    fields[line.slice(0, colon).trim()] = value;
  }
  return { fields, body: lines.slice(end + 1).join("\n").replace(/^\n+/, "") };
}

/** What is wrong with a doc's frontmatter, as short sentences. Empty when the page is fine. */
export function frontmatterProblems(md) {
  const { fields } = parseFrontmatter(md);
  const problems = [];
  for (const key of ["title", "description", "group"]) if (!fields[key]) problems.push(`missing ${key}`);
  if (fields.description && fields.description.length > MAX_DESCRIPTION) problems.push(`description is ${fields.description.length} characters, over ${MAX_DESCRIPTION}`);
  if (fields.group && !GROUPS.includes(fields.group)) problems.push(`group "${fields.group}" is not one of: ${GROUPS.join(", ")}`);
  return problems;
}
