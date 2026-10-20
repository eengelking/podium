// The frontend imports protocol.ts, so everything it reaches must load in a browser. The Vite dev server does not
// tree-shake as the production build does, and a Node-only import there blanks the page (#551).
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = path.dirname(fileURLToPath(import.meta.url));
const NODE = new Set(builtinModules.map((m) => m.split("/")[0]));
// `import x from "m"`, `export * from "m"`, `import "m"`, `import("m")` and `require("m")`, outside comments.
const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
const importsOf = (file: string): string[] =>
  [...readFileSync(file, "utf8").replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").matchAll(SPEC)].map((m) => m[1]);
const isNode = (spec: string) => spec.startsWith("node:") || NODE.has(spec.split("/")[0]);
const resolve = (from: string, spec: string) => path.resolve(path.dirname(from), spec.replace(/\.js$/, ".ts"));

describe("protocol.ts import graph", () => {
  it("reaches no Node-only module", () => {
    const seen = new Set<string>();
    const nodeOnly: string[] = [];
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of importsOf(file)) {
        if (spec.startsWith(".")) walk(resolve(file, spec));
        else if (isNode(spec)) nodeOnly.push(`${path.basename(file)} imports ${spec}`);
      }
    };
    walk(path.join(dir, "protocol.ts"));
    expect(seen.size).toBeGreaterThan(1);
    expect(nodeOnly).toEqual([]);
  });

  it("recognises node: and bare built-ins", () => {
    expect(["node:fs", "fs", "path", "fs/promises", "crypto"].every(isNode)).toBe(true);
    expect(["./x.js", "zod"].some(isNode)).toBe(false);
  });
});
