// SPEC 8.1 Feature flags: orchestrator messaging (peer-messaging) on, off, and on with a machine's option off.
describe('flags: orchestrator messaging', () => {
  // Tests here run in order on one server, and each leaves the flag on for the next, even when it fails.
  before(() => cy.resetServer());
  afterEach(() => {
    cy.setFlags({ 'peer-messaging': true });
    cy.reportAgain('tester', { peers: true });
  });

  it('on: shows Chat in the bar and My reporters for a signed-in person', () => {
    cy.signIn('Ed');
    cy.openConsole('#/');
    cy.get('#podium-top').contains('a.btn', 'Chat');
    cy.get('#podium-top').contains('a, button', 'My reporters');
  });

  it('on, with a machine\'s reporter option off: My reporters shows messaging off for that machine', () => {
    cy.signIn('Ed');
    cy.reportAgain('tester', { peers: false });
    cy.openConsole('#/me/reporters');
    cy.contains('table.ptab tr', 'ci-runner-01').should('contain.text', 'Off');
    cy.contains('table.ptab tr', 'ed-mbp').should('contain.text', 'On');
    // The word is a hover/focus note (#857) that names both Claude Code routes to turn it on (#837); there is no separate line under the table.
    cy.contains('table.ptab tr', 'ci-runner-01').find('.tip.tt [role=tooltip]')
      .should('contain.text', 'ci-runner-01 has messaging off. Only that machine can turn it on.')
      .and('contain.text', 'In Claude Code there, run /plugin configure podium-reporter@eengelking-marketplace and set peers to on.')
      .and('contain.text', 'In the Claude desktop app there, open Settings > Plugins > Podium-Reporter > Settings and turn on peers.');
    cy.contains('.pm-note', 'has messaging off').should('not.exist');
  });

  it('off: removes Chat and My reporters, says so on their pages and stops the data', () => {
    cy.setFlags({ 'peer-messaging': false });
    cy.signIn('Ed');
    cy.openConsole('#/');
    cy.get('#podium-top').contains('a.btn', 'Chat').should('not.exist');
    cy.get('#podium-top').contains('a, button', 'My reporters').should('not.exist');
    cy.visit('/#/chat');
    cy.contains('Orchestrator messaging is off');
    // The server refuses Chat's read while the flag is off.
    cy.request({ url: '/api/fleet/respond/chat', failOnStatusCode: false }).its('status').should('eq', 403);
    cy.request('/api/fleet/peers/traffic?range=live').then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq({ enabled: false, conversations: [] });
    });
  });

  it('on again: Chat is back without a reload', () => {
    cy.setFlags({ 'peer-messaging': false });
    cy.openConsole('#/');
    cy.get('#podium-top').contains('a.btn', 'Chat').should('not.exist');
    cy.setFlags({ 'peer-messaging': true });
    cy.get('#podium-top').contains('a.btn', 'Chat', { timeout: 20000 });
  });
});
