import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The commit a dev build was made from: the 8-character short hash, with `-dirty` after it when the tree had local edits.
 * A release build has none, and neither has a build made without git, so null means "show the version alone" (#400).
 */
export function parseBuild(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return /^[0-9a-f]{7,40}(-dirty)?$/.test(v) ? v : null;
}

/** The build from PODIUM_BUILD (a container build passes it), else build.json in `dir` (a standalone build writes it). */
export function readBuild(env: NodeJS.ProcessEnv, dir: string): string | null {
  if (env.PODIUM_BUILD !== undefined) return parseBuild(env.PODIUM_BUILD);
  try {
    return parseBuild(JSON.parse(readFileSync(path.join(dir, "build.json"), "utf8")).build);
  } catch {
    return null;
  }
}

let cached: string | null | undefined;

/** The server's own build, from the environment or server/build.json (the same relative path from src/ and dist/). */
export function serverBuild(): string | null {
  if (cached !== undefined) return cached;
  cached = readBuild(process.env, path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
  return cached;
}
