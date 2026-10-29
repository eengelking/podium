// SPEC 8.1 Board > Order, paging and layout: a column pages at 25 cards. (An empty column's text is checked in board.cy.js.)
describe('board: paging and empty columns', () => {
  before(() => cy.resetServer({ seedArgs: '--rich' }));
  beforeEach(() => cy.openConsole('#/board'));

  it('pages the Pending column at 25 cards with the shared footer', () => {
    cy.get('section.kb-col[aria-label^="Pending,"]').as('col').should('have.attr', 'aria-label', 'Pending, 43 steps');
    cy.get('@col').find('a.kb-card').should('have.length', 25);
    cy.get('@col').invoke('text').should('match', /Showing 1.25 of 43/);
    cy.get('@col').find('button[aria-label="Next page"]').click();
    cy.get('@col').invoke('text').should('match', /Showing 26.43 of 43/);
    cy.get('@col').find('a.kb-card').should('have.length', 18);
  });

  it('lists the cards of a session whose step is blocked in the Blocked column, with the plan\'s own words', () => {
    cy.get('section.kb-col[aria-label^="Blocked,"]').contains('Step 11 of the migration');
  });
});
