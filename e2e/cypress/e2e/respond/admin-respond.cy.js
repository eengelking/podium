// SPEC 8.1 Responding, DECISIONS 71 (#1251): an Admin answers and sends to another person's session only when that person has allowed it, per reporter, in My reporters ("Admin may respond",
// off by default). An Admin still reads a waiting ask. A refused try is written to the Admin log as respond_refused.
// The tests run in order on one server and tell one story (off, switched on, accepted, switched off, refused); each leaves the switch off for the next file's reset to find.
describe('respond: an Admin responds only when the owner allows it', () => {
  before(() => cy.resetServer());
  const dialog = () => cy.get('[role=dialog]');
  const adminSends = () => cy.task('respond:as', { as: 'Admin', path: '/sessions/e2e-s-turn-ended/messages', body: { text: 'from the admin' } });
  const row = () => cy.contains('table.ptab tr', 'ed-mbp');
  const adminSwitch = () => row().find('[role=switch][aria-labelledby*="pm-adm-s-"]');

  it('shows Ed an "Admin may respond" switch on each of his reporters, off by default, that he turns on and off and that survives a reload', () => {
    cy.intercept('PUT', '**/admin-respond').as('allow');
    cy.signIn('Ed');
    cy.openConsole('#/me/reporters');
    cy.contains('th', 'Admin may respond');
    adminSwitch().should('have.attr', 'aria-checked', 'false');
    row().should('contain.text', 'Off');
    adminSwitch().click();
    cy.wait('@allow').its('request.body').should('deep.eq', { allow: true });
    adminSwitch().should('have.attr', 'aria-checked', 'true');
    cy.reload();
    adminSwitch().should('have.attr', 'aria-checked', 'true');
    adminSwitch().click();
    cy.wait('@allow').its('request.body').should('deep.eq', { allow: false });
    adminSwitch().should('have.attr', 'aria-checked', 'false');
    cy.reload();
    adminSwitch().should('have.attr', 'aria-checked', 'false');
  });

  it('refuses an Admin\'s message with 403 while it is off, and the Admin log records respond_refused', () => {
    adminSends().then((res) => {
      expect(res.status).to.eq(403);
      expect(res.body.error).to.eq("Ed has not allowed an Admin to respond. Ed can turn it on in My reporters.");
    });
    cy.openAdmin('Admin log');
    cy.contains('td', 'was refused a send or an answer in turn-ended').should('contain.text', 'Ed has not allowed it');
  });

  it('opens the Respond window to an Admin read only: the ask is shown, with no answer controls, and the reason where they would be', () => {
    cy.signIn('Admin');
    cy.openConsole('#/');
    cy.card('question').parent().find('button.respond').should('not.be.disabled').click();
    dialog().should('contain.text', 'How many History rows per page?');
    dialog().contains("Ed hasn't allowed an Admin to respond.");
    dialog().should('contain.text', 'Ed can allow responding in My reporters.');
    dialog().find('textarea').should('not.exist');
    dialog().contains('button', /^Send$/).should('not.exist');
    dialog().contains('button', 'Submit').should('not.exist');
  });

  it('accepts the Admin\'s message once Ed allows it, and the window is as before', () => {
    cy.adminMayRespond(true);
    adminSends().its('status').should('eq', 202);
    cy.signIn('Admin');
    cy.openConsole('#/');
    cy.card('idle').parent().find('button.respond').click();
    dialog().find('textarea').should('exist');
    dialog().contains("hasn't allowed an Admin to respond").should('not.exist');
  });

  it('refuses the Admin again after Ed turns it off, and tells him why in the window', () => {
    cy.adminMayRespond(false);
    adminSends().its('status').should('eq', 403);
    cy.signIn('Admin');
    cy.openConsole('#/');
    cy.card('idle').parent().find('button.respond').click();
    dialog().find('textarea').should('not.exist');
  });
});
