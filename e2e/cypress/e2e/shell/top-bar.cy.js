// SPEC 8.1 Shell > Top bar: the buttons each page shows, the page pill, the connection pill, the way back to the wall.
describe('top bar', () => {
  before(() => cy.resetServer());

  it('shows Board, History and Traffic on the wall, with no Fleet button and no Admin button', () => {
    cy.openConsole('#/');
    cy.tid('page-pill').should('have.text', 'Fleet');
    cy.get('#podium-top').within(() => {
      cy.contains('a.btn', 'Board');
      cy.contains('a.btn', 'History');
      cy.contains('a.btn', 'Traffic');
      cy.contains('a.btn', /^Fleet$/).should('not.exist');
      cy.contains('a.btn', 'Admin').should('not.exist');
      cy.get('a.logo').should('have.attr', 'aria-label', 'Podium, fleet').and('have.attr', 'href', '#/');
    });
  });

  it('names each page in its pill and leaves that page\'s own button off', () => {
    cy.openConsole('#/board');
    cy.tid('page-pill').should('have.text', 'Board');
    cy.get('#podium-top').contains('a.btn', /^Board$/).should('not.exist');
    cy.get('#podium-top').contains('a.btn', 'Fleet');

    cy.visit('/#/history');
    cy.tid('page-pill').should('have.text', 'History');
    cy.get('#podium-top').contains('a.btn', /^History$/).should('not.exist');

    cy.visit('/#/traffic');
    cy.tid('page-pill').should('have.text', 'Traffic');
    cy.get('#podium-top').contains('a.btn', /^Traffic$/).should('not.exist');
  });

  it('names an orchestrator page "Orchestrator" and the Fleet button returns to the wall', () => {
    cy.openConsole('#/');
    cy.card('api').click();
    cy.tid('page-pill').should('have.text', 'Orchestrator');
    cy.get('main#podium-main h1').should('have.text', 'api-gateway');
    cy.get('#podium-top').contains('a.btn', /^Fleet$/).click();
    cy.tid('page-pill').should('have.text', 'Fleet');
    cy.get('button.card.sc').should('have.length.greaterThan', 5);
  });

  it('reads "N reporters live" with the number of connected reporters', () => {
    cy.openConsole('#/');
    cy.tid('connection-pill').should('have.attr', 'data-state', 'live').and('contain.text', '12 reporters live');
  });

  it('shows the Admin button only to a signed-in Administrator', () => {
    cy.signIn('Ed');
    cy.openConsole('#/');
    cy.get('#podium-top').contains('a.btn', 'Admin').should('not.exist');
    cy.signIn('Admin');
    cy.openConsole('#/');
    cy.get('#podium-top').contains('a.btn', 'Admin').should('have.attr', 'href', '#/admin');
  });
});
