// More axe (color-contrast and target-size included): the orchestrator page, the dialogs, and every Admin page. See axe.cy.js for the rules and for how a known finding is listed.
describe('accessibility (axe): orchestrator page, dialogs and Admin', () => {
  before(() => cy.resetServer({ seedArgs: '--talk --recording' }));

  // Real findings axe reports here, not yet fixed, each tracked (see docs/e2e/COVERAGE.md). Each is let through only while axe still reports it.
  // Each target is the whole selector axe reports for the one element, so a new violation on another element is not let through.
  const BLOW = { rule: 'color-contrast', target: /^\.l1 > \.blow\.l2$/, html: /class="blow l2"/ }; // #798: the "2x" blowout badge on the orchestrator page
  const DIRTY = { rule: 'color-contrast', target: /^(\.dirty|button\[data-session="[^"]+"\] > \.z1 > \.git > \.dirty\[title="Modified files"\])$/, html: /^<span class="dirty" title="Modified files"/ }; // #794
  const RECORD_NAME = { rule: 'label-content-name-mismatch', target: /^button\[aria-haspopup="dialog"\]$/, html: /aria-label="Record this session"/ }; // #799: "Record this session" against the visible word "Record"
  const DIFF_ROWS = { rule: 'label-content-name-mismatch', target: /^(\.(added|deleted|renamed|modified(\.openable:nth-child\(\d+\))?) > button\[aria-haspopup="dialog"\]|button\[aria-label="Open diff of [^"]+"\])$/, html: /^<button[^>]* aria-label="Open diff of / }; // #800: "Open diff of <path>" against the visible file name

  const theme = (mode) => (win) => win.localStorage.setItem('podium.theme', JSON.stringify({ theme: 'podium', mode }));

  for (const mode of ['light', 'dark']) {
    for (const width of [1440, 400]) {
      it(`the orchestrator page, ${mode}, ${width} px`, () => {
        cy.atWidth(width);
        cy.visit('/#/?open=e2e-s-invoice', { onBeforeLoad: theme(mode) });
        cy.get('html').should('have.attr', 'data-theme', mode);
        cy.contains('.fact', 'Est. cost').should('exist');
        cy.get('button.trow').should('have.length', 5);
        cy.checkA11y({ known: mode === 'light' ? [BLOW, DIRTY] : [BLOW] });
      });
    }
  }

  context('dialogs', () => {
    const settle = () => cy.get('[role=dialog]').should('be.visible');

    it('the sign-in dialog', () => {
      cy.openConsole('#/');
      cy.get('#podium-top').contains('button', 'Sign in').click();
      settle();
      cy.checkA11y({ known: [DIRTY] });
    });

    it('the report dialog', () => {
      cy.openConsole('#/?open=e2e-s-invoice');
      cy.get('#row-e2e-a-map').click();
      cy.get('#podium-side-body').contains('button.docbtn', 'Final answer').click();
      settle();
      cy.checkA11y({ known: [BLOW, DIRTY] });
    });

    it('the respond dialog for a question', () => {
      cy.signIn('Ed');
      cy.openConsole('#/');
      cy.card('question').parent().find('button.respond').click();
      settle();
      cy.checkA11y();
    });

    it('the record picker', () => {
      cy.signIn('Ed');
      cy.openConsole('#/?open=e2e-s-api-gateway');
      cy.get('button[aria-label="Record this session"]').click();
      settle();
      cy.checkA11y({ known: [DIRTY, RECORD_NAME] });
    });

    it('the file diff dialog', () => {
      cy.task('diffs:start');
      cy.signIn('Ed');
      cy.openConsole('#/?open=e2e-s-invoice');
      cy.get('[role=tab]').contains('Files').click();
      cy.get('button[aria-label="Open diff of src/invoice/export.ts"]').click();
      cy.contains('[role=dialog]', 'export const header = "invoice-v2";', { timeout: 15000 });
      cy.checkA11y({ known: [BLOW, DIFF_ROWS] });
      cy.task('diffs:stop');
    });

    it('the activity dialog', () => {
      cy.openConsole('#/?open=e2e-s-invoice');
      cy.get('#row-e2e-a-port').click();
      cy.get('#podium-side-body').contains('button', 'Expand').click();
      settle();
      cy.checkA11y({ known: [BLOW, DIRTY] });
    });
  });

  context('Admin', () => {
    const PAGES = ['People', 'Groups', 'Reporters', 'Settings', 'Model prices', 'Security', 'Certificates', 'Data', 'Stored activity', 'Usage', 'Spend', 'People and groups', 'Sessions', 'Failures', 'Admin activity', 'Admin log'];
    for (const page of PAGES) {
      it(`${page}, light, 1440 px`, () => {
        cy.openAdmin(page);
        cy.get('main h1').should('have.text', page);
        cy.get('main').invoke('text').should('have.length.greaterThan', 100);
        cy.checkA11y();
      });
    }
    for (const page of ['Settings', 'Spend']) {
      it(`${page}, dark, 1440 px`, () => {
        cy.unlockAdmin();
        cy.visit('/#/admin', { onBeforeLoad: theme('dark') });
        cy.adminPage(page);
        cy.get('main h1').should('have.text', page);
        cy.checkA11y();
      });
    }
    for (const page of ['People', 'Settings', 'Reporters']) {
      it(`${page}, 400 px`, () => {
        cy.atWidth(400);
        cy.openAdmin(page);
        cy.get('main h1').should('have.text', page);
        cy.checkA11y();
      });
    }
  });
});
