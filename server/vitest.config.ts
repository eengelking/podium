import { defineConfig } from "vitest/config";

// The server suite also runs the simulator's tests (scripts/), which import server code.
// testSetup.ts keeps the tests' own servers on loopback (issue #137; see docs/GOTCHAS.md).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "../scripts/**/*.test.ts"],
    setupFiles: ["src/testSetup.ts"],
    // Only `npm run test:coverage` turns this on. The lcov file is what SonarCloud reads (sonar-project.properties).
    coverage: {
      provider: "v8",
      allowExternal: true, // the simulator in scripts/ and the mod's pure modules are tested here too
      reporter: ["text-summary", "lcov"],
      include: ["src/**/*.ts", "../scripts/**/*.ts", "../mod/podium-reporter/hooks/*.ts"], // the mod's pure modules are tested from scripts/
      exclude: ["**/*.test.ts", "src/testSetup.ts", "**/*.d.ts"],
    },
  },
});
