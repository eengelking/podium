// Loaded before every spec file: the helpers (commands) and the settings that keep the suite from depending on timing.
import './commands';

beforeEach(() => {
  // The page links Google Fonts. A test run must not depend on the internet (and the font file would change the layout between machines),
  // so the request is answered with an empty stylesheet and the page uses its fallback fonts.
  cy.intercept({ hostname: /^fonts\.(googleapis|gstatic)\.com$/ }, { statusCode: 200, headers: { 'content-type': 'text/css' }, body: '' });
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
