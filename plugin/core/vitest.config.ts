import { defineConfig } from "vitest/config";

// `npm run test:core`: the tests in plugin/core/ with no harness CLI and no harness API types installed (#934).
// They import describe, test and expect from claude-code/testing, which exists only inside Claude Code, so it is
// aliased to vitest here, the way server/vitest.config.ts does. `root` is this folder so the run needs no other config.
export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: { "claude-code/testing": "vitest" } },
  test: { include: ["**/*.test.ts"] },
});
