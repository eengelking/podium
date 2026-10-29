// Cypress for Podium (#782, DECISIONS 48). It runs inside the pinned cypress/included container that scripts/e2e-up.sh starts beside
// Podium's own image on a private network. Nothing installs Cypress: this file is CommonJS and imports nothing. Docs: docs/e2e/COVERAGE.md.
const { registerTasks } = require('./support/tasks.cjs');

const server = process.env.CYPRESS_E2E_SERVER || 'localhost';

module.exports = {
  e2e: {
    // The server container's name on the private network, from scripts/e2e-up.sh.
    baseUrl: process.env.CYPRESS_baseUrl || `http://${server}:4317`,
    specPattern: 'cypress/e2e/**/*.cy.js',
    supportFile: 'support/e2e.js',
    fixturesFolder: false,
    // Flakiness plan (DECISIONS 48): no retries, so a flaky spec fails loudly; no video; screenshots only for a failure.
    retries: { runMode: 0, openMode: 0 },
    video: false,
    screenshotOnRunFailure: true,
    screenshotsFolder: '/out/screenshots',
    downloadsFolder: '/out/downloads',
    defaultCommandTimeout: 8000,
    requestTimeout: 10000,
    pageLoadTimeout: 30000,
    viewportWidth: 1440,
    viewportHeight: 900,
    numTestsKeptInMemory: 0,
    // The spec files run one after another in one browser and share one server; each calls cy.resetServer() first.
    setupNodeEvents(on, config) {
      registerTasks(on, config);
      on('before:browser:launch', (browser, launchOptions) => {
        if (browser.family === 'chromium') {
          // Reduced motion for every page; the server is plain http on a container name, which Chrome would treat as an insecure
          // context (no clipboard), so it is allowed as a secure origin for this run only.
          launchOptions.args.push('--force-prefers-reduced-motion', '--font-render-hinting=none', '--disable-lcd-text');
          // The headless window is 1280 x 720 by default; the 1440 x 900 viewport the specs use must fit in it, or an element past 1280 px counts as covered.
          launchOptions.args.push('--window-size=1440,1000', '--force-device-scale-factor=1');
          launchOptions.args.push(`--unsafely-treat-insecure-origin-as-secure=http://${server}:4317`);
        }
        return launchOptions;
      });
      return config;
    },
  },
};
