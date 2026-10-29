// SPEC 8.1 Session cards > status band, heartbeat lost: a session that stops reporting goes stale, shows the countdown and can be removed.
describe('wall: heartbeat lost', () => {
  before(() => cy.resetServer({ env: ['STALE_AFTER_MS=2000', 'HOOK_STALE_AFTER_MS=2000', 'DROP_AFTER_MS=7200000', 'LINGER_MS=7200000'] }));
  beforeEach(() => cy.openConsole('#/'));

  it('writes the last heartbeat and the countdown on the card, and the full sentence on the orchestrator page', () => {
    cy.card('api').should('contain.text', 'Last heartbeat').and('contain.text', 'Goes away in');
    cy.card('api').click();
    cy.get('main#podium-main').should('contain.text', 'No heartbeat for').and('contain.text', 'Goes away in');
    cy.get('main#podium-main').should('contain.text', 'The session may have crashed or been closed without a clean exit.');
    cy.contains('main#podium-main button', 'Remove now').should('be.visible');
  });

  it('counts the sessions as stale in the KPI tile', () => {
    cy.contains('.kpi .k', 'Orchestrators live').parent().should('contain.text', '0 running · 0 waiting · 11 stale');
  });

  it('filters to the stale sessions with the Stale segment', () => {
    cy.contains('[aria-label="Filter by status"] button', 'Stale').click();
    cy.cards().should('have.length.greaterThan', 5).each(($c) => expect($c.text()).to.contain('Last heartbeat'));
  });

  it('removes a stale session with its own Remove button', () => {
    cy.card('api').parent().find('button.remove').click();
    cy.get('button.card.sc[data-session="e2e-s-api-gateway"]', { timeout: 15000 }).should('not.exist');
    cy.get('button.info').should('have.attr', 'aria-label').and('match', /^11 shown/);
  });
});
