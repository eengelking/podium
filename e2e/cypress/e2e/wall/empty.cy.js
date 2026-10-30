// SPEC 8.1: empty states have an instruction, never a blank panel.
describe('wall: empty state', () => {
  before(() => cy.resetServer({ noSeed: true }));

  it('tells you how to start a session when nothing reports', () => {
    cy.openConsole('#/');
    cy.contains('.none', 'No Claude Code sessions are reporting.');
    cy.contains('.none', 'claude --plugin-dir mod/podium-reporter');
    cy.tid('connection-pill').should('contain.text', '0 reporters live');
  });

  it('says so on the board, in History and on Traffic too', () => {
    cy.visit('/#/board');
    cy.contains('No plans on the board');
    cy.visit('/#/history');
    cy.get('.none').invoke('text').should('match', /^No sessions ended on \d{4}-\d{2}-\d{2}\.$/);
    // A server with nothing set up has messaging off, so Traffic says that (there are no seeded flags).
    cy.visit('/#/traffic');
    cy.contains('Orchestrator messaging is off');
  });
});
