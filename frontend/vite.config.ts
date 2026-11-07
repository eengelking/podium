import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";

// The versions of React and TypeScript the console is built with (#862): Admin > About shows them, and only the build knows them.
const need = createRequire(import.meta.url);
const versionOf = (pkg: string): string => (need(`${pkg}/package.json`) as { version: string }).version;

// The API server binds 127.0.0.1 (see server/src/index.ts). Proxy to that address rather than
// "localhost", which can resolve to ::1 first and fail. PORT matches the server's PORT.
const apiTarget = `http://127.0.0.1:${process.env.PORT ?? "4317"}`;

export default defineConfig({
  plugins: [react()],
  define: {
    __PODIUM_REACT__: JSON.stringify(versionOf("react")),
    __PODIUM_TYPESCRIPT__: JSON.stringify(versionOf("typescript")),
  },
  server: {
    proxy: {
      // Server-Sent Events: http-proxy streams the response as it arrives. The server sends
      // `Cache-Control: no-cache` and no compression, so nothing in between buffers it.
      "/api": { target: apiTarget, changeOrigin: false },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/setupTests.ts",
    // The coverage run passes 20 s on the command line; the plain run gets the same, so a heavy Admin test on a busy runner is not cut off at 5 s.
    testTimeout: 20_000,
    // Only `npm run test:coverage` turns this on. The lcov file is what SonarCloud reads (sonar-project.properties).
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "src/setupTests.ts", "**/*.d.ts"],
    },
  },
});
