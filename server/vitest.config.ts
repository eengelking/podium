import { defineConfig } from "vitest/config";

// The server suite also runs the simulator's tests (scripts/), which import server code.
// testSetup.ts keeps the tests' own servers on loopback (issue #137; see docs/gotchas/).
export default defineConfig({
  // The mod's tests import describe, test and expect from claude-code/testing, which only exists inside Claude Code.
  // The ones that need no engine also run here, so CI measures the mod's pure modules (the test code is the same).
  resolve: { alias: { "claude-code/testing": "vitest" } },
  test: {
    include: ["src/**/*.test.ts", "../scripts/**/*.test.ts", "../plugin/core/**/*.test.ts", "../plugin/opencode/**/*.test.ts", "../plugin/claudecode/hooks/{fileDiff,transport,peers}.test.ts"],
    setupFiles: ["src/testSetup.ts"],
    // The limits are for a hung test, not a slow one. The slowest PostgreSQL step takes about 1 s on a quiet laptop, CI runs 3 to 4 times
    // slower, and a laptop with other suites running was seen 10 times slower (#1098), so the vitest defaults (5 s and 10 s) failed it.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Fails the run when an adapter's test server is not configured (unless PODIUM_TEST_ONLY limits the run, and then it says what was NOT RUN) or does not answer (#891, #1008).
    globalSetup: ["src/storage/postgres/globalSetup.ts", "src/storage/mariadb/globalSetup.ts"],
    // Only `npm run test:coverage` turns this on. The lcov file is what SonarCloud reads (sonar-project.properties).
    coverage: {
      provider: "v8",
      allowExternal: true, // the simulator in scripts/ and the mod's pure modules are tested here too
      reporter: ["text-summary", "lcov"],
      include: ["src/**/*.ts", "../scripts/**/*.ts", "../scripts/docLinks.mjs", "../scripts/docFrontmatter.mjs", "../scripts/docTopics.mjs", "../scripts/build-doc-indexes.mjs", "../scripts/check-doc-refs.mjs", "../scripts/check-deprecations.mjs", "../scripts/changelog-assemble.mjs", "../scripts/live-test-parity.mjs", "../scripts/atlas-functions.mjs", "../scripts/podium-compaction-seed.mjs", "../scripts/podium-peers-seed.mjs", "../scripts/plugin-build.mjs", "../scripts/plugin-dev.mjs", "../scripts/plugin-dist-check.mjs", "../scripts/plugin-dist-compare.mjs", "../scripts/git-bin.mjs", "../scripts/harness-scripts.mjs", "../scripts/podium-reporter-zip.mjs", "../scripts/promise-misuse.mjs", "../scripts/storage-order-parity.mjs", "../scripts/db-adapters.mjs", "../scripts/e2e-shards.mjs", "../site/scripts/lib.mjs", "../site/docs-nav.mjs", "../plugin/core/*.ts", "../plugin/core/tls/*.mjs", "../plugin/core/tls/*.ts", "../plugin/opencode/*.ts", "../plugin/claudecode/hooks/*.ts"], // the mod's pure modules are tested from scripts/
      exclude: ["**/*.test.ts", "../plugin/core/tls/helper.mjs", "../plugin/opencode/index.ts", "src/testSetup.ts", "**/*.d.ts", "**/*.d.mts"],
    },
  },
});
