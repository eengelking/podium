// SPEC 8.1 Feature flags: the defaults of a fresh server. This file does not enable anything: five flags are off, the activity feed and the release check are on.
describe('flags: defaults on a fresh server', () => {
  before(() => cy.resetServer({ seedArgs: '--flags defaults' }));

  const OFF = ['activity-output', 'respond', 'file-diff', 'peer-messaging', 'session-recording'];
  const ON = ['activity-feed', 'update-check'];

  it('starts with the five off-by-default flags off and the other two on, in Admin > Settings', () => {
    cy.openAdmin('Settings');
    for (const id of OFF) cy.settingSwitch(`feature-${id}`).should('have.attr', 'aria-checked', 'false');
    for (const id of ON) cy.settingSwitch(`feature-${id}`).should('have.attr', 'aria-checked', 'true');
  });

  it('shows none of the off features in the console: no Respond, no Traffic, no sign-in, no diffs, no recording control', () => {
    cy.openConsole('#/');
    cy.get('button.respond').should('not.exist');
    cy.get('#podium-top').contains('a.btn', 'Traffic').should('not.exist');
    cy.get('#podium-top').contains('button', 'Sign in').should('not.exist');
    cy.card('invoice').click();
    cy.get('main#podium-main h1').should('have.text', 'invoice-v2');
    cy.get('.fact.rec button[aria-haspopup="dialog"]').should('not.exist');
    cy.get('.fact.rec').should('contain.text', 'Not recorded');
    cy.get('[role=tab]').contains('Files').click();
    cy.contains('Sign in to open diffs.').should('not.exist');
    cy.get('li.openable > button').should('not.exist');
  });

  it('keeps the agent activity feed on by default', () => {
    cy.openConsole('#/');
    cy.card('invoice').click();
    cy.get('#row-e2e-a-port').click();
    cy.get('#podium-side-body').contains('button', 'Expand');
    cy.get('#podium-side-body').contains('The activity feed is turned off by the Admin.').should('not.exist');
  });

  it('refuses the routes of an off feature', () => {
    cy.request('/api/fleet/respond/me').its('body.enabled').should('eq', false);
  });
});
