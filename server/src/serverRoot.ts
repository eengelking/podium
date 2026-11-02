import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The server package's folder (the one with server/package.json), found by walking up from the file at `moduleUrl`.
 * The compiled code sits at server/dist/server/src/ because the build also compiles plugin/core/ (the one copy of the
 * report types, outside this package), so a fixed number of `..` is right in src/ and wrong in dist/.
 */
export function serverDir(moduleUrl: string): string {
  let dir = path.dirname(fileURLToPath(moduleUrl));
  while (!existsSync(path.join(dir, "package.json"))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`no package.json above ${fileURLToPath(moduleUrl)}`);
    dir = up;
  }
  return dir;
}

/** The repository's folder: the one above the server package. */
export function repoRoot(moduleUrl: string): string {
  return path.dirname(serverDir(moduleUrl));
}
