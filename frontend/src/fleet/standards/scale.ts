// Reads the sizes, radii, layers and durations the app's stylesheets use (#354). They are not tokens yet, so the standards
// page lists what is in use, with counts, instead of a scale somebody wrote down that the app might not follow.
import { stripComments } from "../../../../scripts/standards-inventory";

/** Each value a property is set to, with how many declarations use it, most used first. */
export function valuesOf(css: string, prop: string): Array<[string, number]> {
  const counts = new Map<string, number>();
  const re = new RegExp(`(?<![\\w-])${prop}\\s*:\\s*([^;}]+)`, "g");
  for (const m of stripComments(css).matchAll(re)) {
    const v = m[1].trim().replaceAll(/\s+/g, " ").replace(/\s*!important$/, "");
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en", { numeric: true }));
}

/** The durations in transition and animation declarations. */
export function durations(css: string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const prop of ["transition", "animation"])
    for (const [v, n] of valuesOf(css, prop)) for (const m of v.matchAll(/(?<![\w.-])(\d*\.?\d+m?s)\b/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + n);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en", { numeric: true }));
}

/** The widths the layout changes at, from @media and @container queries. A query with a range counts both its ends. */
export function breakpoints(css: string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const q of stripComments(css).matchAll(/@(?:media|container)[^{]*/g))
    for (const m of q[0].matchAll(/\(\s*(min|max)-width:\s*([\d.]+px)\s*\)/g)) counts.set(`${m[1]}-width: ${m[2]}`, (counts.get(`${m[1]}-width: ${m[2]}`) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en", { numeric: true }));
}
