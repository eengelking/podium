// SPEC 8.1 Left rail: items, selection, "All orchestrators", paging (#242) and the stacked layout (#474).
describe('rail', () => {
  context('with the seeded twelve', () => {
    before(() => cy.resetServer());
    beforeEach(() => cy.openConsole('#/'));

    it('lists "All orchestrators" and one row per session with its state, model and plan figures', () => {
      cy.get('#podium-rail-body').within(() => {
        cy.contains('button.ritem.all', 'All orchestrators').and('contain.text', '4 running · 6 waiting · 0 stale');
        cy.contains('button.ritem', 'invoice-v2').and('contain.text', 'delegating').and('contain.text', 'Opus 5.5').and('contain.text', '1/4').and('contain.text', '2×');
        cy.contains('button.ritem', 'api-gateway').and('contain.text', 'running').and('contain.text', 'Sonnet 5.5').and('contain.text', 'no plan reported');
        cy.contains('button.ritem', 'nightly-build').and('contain.text', 'waiting on shell');
        cy.contains('button.ritem.risk', 'invoice-v2');
      });
    });

    it('opens an orchestrator from its row and returns to the wall from "All orchestrators"', () => {
      cy.get('#podium-rail-body').contains('button.ritem', 'api-gateway').click();
      cy.get('main#podium-main h1').should('have.text', 'api-gateway');
      cy.get('#podium-rail-body').contains('button.ritem', 'api-gateway').should('have.attr', 'aria-current', 'true');
      cy.get('#podium-rail-body').contains('button.ritem.all', 'All orchestrators').click();
      cy.location('hash').should('eq', '#/');
      cy.cards().should('have.length', 12);
    });

    it('pages the list when the rows do not fit and shows "Showing 1–8 of 12" with Previous and Next', () => {
      cy.viewport(1440, 900);
      cy.get('#podium-rail-body').within(() => {
        cy.contains('Showing 1–8 of 12');
        cy.contains('1 of 2');
        cy.get('button[aria-label="Previous page"]').should('be.disabled');
        cy.get('button[aria-label="Next page"]').click();
        cy.contains('Showing 9–12 of 12');
        cy.get('[role=status]').should('contain.text', 'Page 2 of 2, showing 9 to 12 of 12 orchestrators');
        cy.get('button[aria-label="Next page"]').should('be.disabled');
      });
      // Paging never touches the wall: every card stays on it.
      cy.cards().should('have.length', 12);
    });

    it('does not page in the stacked layout at 1040 px and below', () => {
      cy.viewport(1000, 800);
      cy.get('#podium-rail-body').contains('button.ritem', 'docs-sweep');
      cy.get('#podium-rail-body button[aria-label="Next page"]').should('not.exist');
    });
  });

  context('with forty-two sessions', () => {
    before(() => cy.resetServer({ seedArgs: '--bulk 30' }));
    beforeEach(() => cy.openConsole('#/'));

    it('keeps a selection that is on another page selected and offers a button to it', () => {
      cy.get('#podium-rail-body').contains('button.ritem', 'api-gateway').click();
      cy.get('#podium-rail-body button[aria-label="Next page"]').click();
      cy.get('#podium-rail-body').contains(/Selected: .* is on page \d+/);
      cy.get('#podium-rail-body .sel-note').contains('button', /^page \d+$/).click();
      cy.get('#podium-rail-body').contains('button.ritem', 'api-gateway').should('have.attr', 'aria-current', 'true');
    });

    it('moves through pages and counts them', () => {
      cy.get('#podium-rail-body').contains(/Showing 1–\d+ of 42/);
      cy.get('#podium-rail-body button[aria-label="Next page"]').click();
      cy.get('#podium-rail-body').contains(/Showing \d+–\d+ of 42/);
      cy.get('#podium-rail-body').contains(/2 of \d+/);
      cy.cards().should('have.length', 42);
    });
  });
});
