// SPEC 8.1 Feature flags: orchestrator messaging (peer-messaging) on, off, and on with a machine's option off.
describe('flags: orchestrator messaging', () => {
  // Tests here run in order on one server, and each leaves the flag on for the next, even when it fails.
  before(() => cy.resetServer());
  afterEach(() => {
    cy.setFlags({ 'peer-messaging': true });
    cy.reportAgain('tester', { peers: true });
  });

  it('on: shows Traffic in the bar and My reporters for a signed-in person', () => {
    cy.signIn('Ed');
    cy.openConsole('#/');
    cy.get('#podium-top').contains('a.btn', 'Traffic');
    cy.get('#podium-top').contains('a, button', 'My reporters');
  });

  it('on, with a machine\'s reporter option off: My reporters shows messaging off for that machine', () => {
    cy.signIn('Ed');
    cy.reportAgain('tester', { peers: false });
    cy.openConsole('#/me/reporters');
    cy.contains('table.ptab tr', 'ci-runner-01').should('contain.text', 'Off');
    cy.contains('table.ptab tr', 'ed-mbp').should('contain.text', 'On');
  });

  it('off: removes Traffic and My reporters, says so on their pages and stops the data', () => {
    cy.setFlags({ 'peer-messaging': false });
    cy.signIn('Ed');
    cy.openConsole('#/');
    cy.get('#podium-top').contains('a.btn', 'Traffic').should('not.exist');
    cy.get('#podium-top').contains('a, button', 'My reporters').should('not.exist');
    cy.visit('/#/traffic');
    cy.contains('Orchestrator messaging is off');
    cy.request('/api/fleet/peers/traffic?range=live').then((res) => {
      expect(res.status).to.eq(200);
      expect(res.body).to.deep.eq({ enabled: false, conversations: [] });
    });
  });

  it('on again: Traffic is back without a reload', () => {
    cy.setFlags({ 'peer-messaging': false });
    cy.openConsole('#/');
    cy.get('#podium-top').contains('a.btn', 'Traffic').should('not.exist');
    cy.setFlags({ 'peer-messaging': true });
    cy.get('#podium-top').contains('a.btn', 'Traffic', { timeout: 20000 });
  });
});
