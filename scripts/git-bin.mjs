// The full path of git, found in fixed system folders and not looked up on PATH, which a build could not trust (the same rule as
// site/scripts/build.mjs). The plugin scripts (#927) run git through this, so there is one place to review (Sonar S4036).
import { existsSync } from "node:fs";
import { join } from "node:path";

export const GIT_DIRS = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];

/** The path of the git executable, or throws when none of `dirs` holds one. */
export function gitBin(dirs = GIT_DIRS, exists = existsSync) {
  const dir = dirs.find((d) => exists(join(d, "git")));
  if (!dir) throw new Error(`git was not found in ${dirs.join(", ")}`);
  return join(dir, "git");
}
