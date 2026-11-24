// Loaded before every spec file: the helpers (commands) and the settings that keep the suite from depending on timing.
import './commands';

// The page links Google Fonts. A test run must not depend on the internet (and the font file would change the layout between machines),
// so the request is answered with an empty stylesheet and the page uses its fallback fonts. The e2e containers have no outside network, so a request
// that got out would wait for a connection time-out of about 30 s, which is the page-load limit (#1363).
const stubFonts = () => cy.intercept({ hostname: /^fonts\.(googleapis|gstatic)\.com$/ }, { statusCode: 200, headers: { 'content-type': 'text/css' }, body: '' });

// Cypress clears every route when a test starts, so a route made in `beforeEach` does not exist in a `before()` hook, and a page opened there went to
// the real hosts. The route is made again just before each visit, wherever the visit is.
Cypress.Commands.overwrite('visit', (visit, ...args) => {
  stubFonts().then(() => visit(...args));
});

beforeEach(() => {
  // Still made at the start of each test, for a reload or a request a test makes without a visit of its own.
  stubFonts();
  // Animations and transitions off, so a spec never waits on one and an element is never read mid-move.
  cy.on('window:before:load', (win) => {
    const style = win.document.createElement('style');
    style.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important}';
    win.document.documentElement.appendChild(style);
  });
});

// Browsers report this one when a layout change lands during a resize callback (Chrome does it on entering fullscreen). It is not an
// error in the app: nothing is lost. Every other uncaught exception still fails the test.
Cypress.on('uncaught:exception', (err) => !/ResizeObserver loop (completed with undelivered notifications|limit exceeded)/.test(err.message));
