import { defineConfig } from "vitest/config";

// The server suite also runs the simulator's tests (scripts/), which import server code.
// testSetup.ts keeps the tests' own servers on loopback (issue #137; see docs/gotchas/).
export default defineConfig({
  // The mod's tests import describe, test and expect from claude-code/testing, which only exists inside Claude Code.
  // The ones that need no engine also run here, so CI measures the mod's pure modules (the test code is the same).
  resolve: { alias: { "claude-code/testing": "vitest" } },
  test: {
    include: ["src/**/*.test.ts", "../scripts/**/*.test.ts", "../mod/podium-reporter/hooks/{diffRedact,fileDiff,git,transport}.test.ts"],
    setupFiles: ["src/testSetup.ts"],
    // Only `npm run test:coverage` turns this on. The lcov file is what SonarCloud reads (sonar-project.properties).
    coverage: {
      provider: "v8",
      allowExternal: true, // the simulator in scripts/ and the mod's pure modules are tested here too
      reporter: ["text-summary", "lcov"],
      include: ["src/**/*.ts", "../scripts/**/*.ts", "../scripts/docLinks.mjs", "../scripts/docFrontmatter.mjs", "../scripts/docTopics.mjs", "../scripts/atlas-functions.mjs", "../site/scripts/lib.mjs", "../site/docs-nav.mjs", "../mod/podium-reporter/hooks/*.ts"], // the mod's pure modules are tested from scripts/
      exclude: ["**/*.test.ts", "src/testSetup.ts", "**/*.d.ts"],
    },
  },
});
