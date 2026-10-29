import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { format, scan } from "./promise-misuse.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The repo's own code, tests included. A new finding fails here with its file, line and kind; allow a deliberate one with
// `// promise-ok: <why>` on the same or the previous line (docs/gotchas/a-store-call-without-await-compiles-and-answers-wrongly.md, #809).
describe("promise-misuse over the repo", () => {
  for (const tsconfig of ["server/tsconfig.json", "scripts/tsconfig.json"]) {
    it(`finds no Promise used as a value or left floating in ${tsconfig}`, () => {
      expect(scan(join(ROOT, tsconfig), { tests: true }).map(format)).toEqual([]);
    }, 60_000);
  }
});
