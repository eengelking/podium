/**
 * The commit a dev build was made from: the 8-character short hash, with `-dirty` after it when the tree had local edits.
 * A release build has none, and neither has a build made without git, so null means "show the version alone" (#400).
 * It lives apart from build.ts, which reads files, because protocol.ts imports it and the frontend imports protocol.ts (#551).
 */
export function parseBuild(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return /^[0-9a-f]{7,40}(-dirty)?$/.test(v) ? v : null;
}
