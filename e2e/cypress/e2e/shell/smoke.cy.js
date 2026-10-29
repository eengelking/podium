// The first spec of every run: the server is the version just built, the production bundle loads with no console error, and the wall shows the seed.
describe('smoke', () => {
  before(() => {
    cy.resetServer();
  });

  it('serves the version in package.json', () => {
    cy.request('/api/fleet/health').then((res) => {
      expect(res.body.ok).to.eq(true);
      cy.readFile('/repo/package.json').then((pkg) => expect(res.body.serverVersion).to.eq(pkg.version));
    });
  });

  it('loads the wall from the built bundle with no console error', () => {
    cy.visit('/', {
      onBeforeLoad(win) {
        cy.spy(win.console, 'error').as('consoleError');
      },
    });
    cy.get('[data-testid="connection-pill"]').should('have.attr', 'data-state', 'live');
    cy.contains('.pill', '12 reporters live');
    cy.get('button.card.sc').should('have.length', 12);
    cy.get('@consoleError').should('not.have.been.called');
  });
});
