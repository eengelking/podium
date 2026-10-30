// More axe (color-contrast and target-size included): the orchestrator page, the dialogs, and every Admin page.
describe('accessibility (axe): orchestrator page, dialogs and Admin', () => {
  before(() => cy.resetServer({ seedArgs: '--talk --recording' }));

  const theme = (mode) => (win) => win.localStorage.setItem('podium.theme', JSON.stringify({ theme: 'podium', mode }));

  for (const mode of ['light', 'dark']) {
    for (const width of [1440, 400]) {
      it(`the orchestrator page, ${mode}, ${width} px`, () => {
        cy.atWidth(width);
        cy.visit('/#/?open=e2e-s-invoice', { onBeforeLoad: theme(mode) });
        cy.get('html').should('have.attr', 'data-theme', mode);
        cy.contains('.fact', 'Est. cost').should('exist');
        cy.get('button.trow').should('have.length', 5);
        cy.checkA11y();
      });
    }
  }

  context('dialogs', () => {
    const settle = () => cy.get('[role=dialog]').should('be.visible');

    it('the sign-in dialog', () => {
      cy.openConsole('#/');
      cy.get('#podium-top').contains('button', 'Sign in').click();
      settle();
      cy.checkA11y();
    });

    it('the report dialog', () => {
      cy.openConsole('#/?open=e2e-s-invoice');
      cy.get('#row-e2e-a-map').click();
      cy.get('#podium-side-body').contains('button.docbtn', 'Final answer').click();
      settle();
      cy.checkA11y();
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
      cy.get('.fact.rec button[aria-haspopup="dialog"]').click();
      settle();
      cy.checkA11y();
    });

    it('the file diff dialog', () => {
      cy.task('diffs:start');
      cy.signIn('Ed');
      cy.openConsole('#/?open=e2e-s-invoice');
      cy.get('[role=tab]').contains('Files').click();
      cy.get('li.openable > button:has(.fn[title="src/invoice/export.ts"])').click();
      cy.contains('[role=dialog]', 'export const header = "invoice-v2";', { timeout: 15000 });
      cy.checkA11y();
      cy.task('diffs:stop');
    });

    it('the activity dialog', () => {
      cy.openConsole('#/?open=e2e-s-invoice');
      cy.get('#row-e2e-a-port').click();
      cy.get('#podium-side-body').contains('button', 'Expand').click();
      settle();
      cy.checkA11y();
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
