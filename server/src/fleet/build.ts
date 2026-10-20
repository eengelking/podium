import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBuild } from "./parseBuild.js";

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
