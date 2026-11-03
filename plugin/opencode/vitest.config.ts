import { defineConfig } from "vitest/config";

// Runs the OpenCode reporter's tests on the built folder (npm run test:mod:opencode builds dist/opencode with the tests into
// .build-test/opencode and points this at it). Only plugin/opencode/: the shared tests run under test:core.
export default defineConfig({
  test: { include: ["plugin/opencode/**/*.test.ts"] },
});
