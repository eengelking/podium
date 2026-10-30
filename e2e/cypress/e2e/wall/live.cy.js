// SPEC 8.1 Data flow: the wall changes with no reload, and the console reconnects after the server goes away.
describe('wall: live updates and reconnect', () => {
  before(() => cy.resetServer());
  beforeEach(() => cy.openConsole('#/'));

  it('changes a card, the KPI tiles and the rail with no reload when a reporter reports again', () => {
    cy.window().then((w) => {
      w.__stillTheSamePage = true;
    });
    cy.card('api').should('contain.text', 'Running').and('contain.text', '$0.42');
    // The card's cost is repriced from the per-model usage, so a stored cost only shows when the report carries none.
    cy.reportAgain('api', { costUsd: 7.25, usageByModel: [], status: 'waiting', waitReason: 'input' });
    cy.card('api').should('contain.text', 'Waiting for your input.').and('contain.text', '$7.25');
    cy.contains('.kpi .k', 'Orchestrators live').parent().should('contain.text', '3 running · 7 waiting');
    cy.get('#podium-rail-body').contains('button.ritem', 'api-gateway').should('contain.text', 'waiting');
    cy.window().its('__stillTheSamePage').should('eq', true);
  });

  it('shows the pill "disconnected, retrying" and the red alert when the server stops, and recovers when it returns', () => {
    cy.tid('connection-pill').should('have.attr', 'data-state', 'live');
    cy.task('server:pause', null, { timeout: 60000 });
    cy.tid('connection-pill', { timeout: 20000 }).should('have.attr', 'data-state', 'disconnected').and('contain.text', 'disconnected, retrying');
    cy.get('[role=alert]').should('contain.text', 'Lost the connection to the Podium server.').and('contain.text', 'Retrying every 2 seconds');
    cy.task('server:resume', null, { timeout: 60000 });
    cy.tid('connection-pill', { timeout: 30000 }).should('have.attr', 'data-state', 'live');
    cy.get('[role=alert]').should('not.exist');
    // The seed survived the pause (same database), so the wall is whole again.
    cy.cards().should('have.length', 12);
  });

  it('keeps the disconnect alert visible even with every pane and the top bar collapsed', () => {
    cy.get('button.edge-tab-left').click();
    cy.get('button.edge-tab-right').click();
    cy.get('button.edge-tab-top').click();
    cy.task('server:pause', null, { timeout: 60000 });
    cy.get('[role=alert]', { timeout: 20000 }).should('contain.text', 'Lost the connection').and('be.visible');
    cy.get('.strip.bad').should('exist');
    cy.task('server:resume', null, { timeout: 60000 });
    cy.get('[role=alert]', { timeout: 30000 }).should('not.exist');
  });
});
