// Harness badge, neutral labels and capability-driven fields (#853). One sequence on one server: a wall of one harness first, then the same
// new session reported by OpenCode (a report v2 with a harness block) so the wall holds two harnesses. A session never changes harness, so it is a new id.
describe('harness badge and neutral labels', () => {
  before(() => cy.resetServer());

  const OC = 'e2e-s-opencode';
  const oc = () => cy.get(`button.card.sc[data-session="${OC}"]`);
  const opencode = { harness: { id: 'opencode', name: 'OpenCode', version: '1.0.0', surface: null }, capabilities: {} };

  it('draws no harness badge on a wall of one harness', () => {
    cy.openConsole('#/');
    cy.cards().should('have.length', 12);
    cy.get('.chip.hx').should('not.exist');
  });

  it('shows the badge on every card once a second harness reports, and drops Context from the OpenCode card', () => {
    cy.reportAgain('api', { id: OC, name: 'oc-session', harness: 'opencode', costSource: 'harness', costUsd: 2.5 }, undefined, undefined, opencode);
    cy.openConsole('#/');
    cy.cards().should('have.length', 13);
    oc().find('.chip.hx').should('contain.text', 'OpenCode');
    oc().find('.chip.hx svg').should('have.attr', 'data-shape', 'diamond');
    oc().find('.z3').should('have.class', 'three');
    oc().find('.z3 .c.ctx').should('not.exist');
    oc().contains('.src', 'from OpenCode');
    cy.card('api').find('.chip.hx').should('contain.text', 'Claude Code');
    cy.card('api').find('.chip.hx svg').should('have.attr', 'data-shape', 'square');
    cy.card('api').find('.z3 .c.ctx').should('exist');
    cy.card('api').find('.src').should('not.exist');
  });

  it('names the harness on the orchestrator page: no context size, a plain Cost label, Fork not available', () => {
    cy.openConsole('#/');
    oc().click();
    cy.get('main#podium-main h1').should('contain.text', 'oc-session');
    cy.grantClipboard();
    cy.get('button[aria-label="Copy resume command"]').click();
    cy.window().then((w) => w.navigator.clipboard.readText()).should('match', /opencode .*--session e2e-s-opencode/s);
    cy.get('main#podium-main').within(() => {
      cy.get('.chip.hx').should('contain.text', 'OpenCode');
      cy.contains('OpenCode does not report context size.');
      cy.contains('.fact .k', /^Cost$/).should('exist');
      cy.contains('.fact .k', 'Est. cost').should('not.exist');
      cy.get('button[aria-label="Copy fork command"]').should('not.exist');
      cy.contains('.fact .k', 'Fork').parent().find('.v').should('have.text', 'Not available');
    });
  });
});
