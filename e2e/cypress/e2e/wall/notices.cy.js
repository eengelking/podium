// SPEC 8.1 Wall notices (#114): at the bottom of the wall, an X, a confirmation that points to Admin > Settings; errors are never notices.
// Order: the tests below run in order on one server, and a later one reads what an earlier one left (named where it matters); the file resets the server once, in `before`.
describe('wall: notices', () => {
  before(() => cy.resetServer({ env: ['DETACHED_HIDE_AFTER_MS=1500'] }));

  it('shows the background-sessions notice at the bottom of the wall once a detached session is set aside, and can show them', () => {
    cy.openConsole('#/');
    cy.reportAgain('api', { attached: false });
    cy.get('.notices .fold', { timeout: 20000 }).should('contain.text', '1 background session hidden').and('contain.text', 'nobody is attached');
    cy.card('api').should('not.exist');
    cy.contains('.notices button.link', 'Show them').click();
    cy.get('.notices .fold').should('contain.text', '1 background session shown');
    cy.card('api').should('contain.text', 'nobody attached');
    cy.contains('.notices button.link', 'Hide them').click();
    cy.card('api').should('not.exist');
  });

  it('closes a notice with its X for everyone, confirms it, and points to Admin > Settings', () => {
    cy.openConsole('#/');
    cy.get('button[aria-label="Close notice: Background sessions"]', { timeout: 20000 }).click();
    cy.get('.notices').should('not.exist');
    cy.get('.toast').should('contain.text', 'Notice turned off').and('contain.text', 'will not show again').within(() => {
      cy.contains('a.go', 'Open Admin > Settings').should('have.attr', 'href', '#/admin/settings');
      cy.get('button[aria-label="Close this message"]').click();
    });
    cy.get('.toast').should('not.exist');
    // It stays off after a reload, because the Admin setting changed for everyone.
    cy.reload();
    cy.cards().should('have.length', 11);
    cy.get('.notices').should('not.exist');
  });

  it('never shows an error as a notice: a lost connection is a red alert at the top', () => {
    cy.openConsole('#/');
    cy.task('server:pause', null, { timeout: 60000 });
    cy.get('[role=alert]', { timeout: 20000 }).should('contain.text', 'Lost the connection to the Podium server.');
    cy.get('.notices').should('not.exist');
    cy.task('server:resume', null, { timeout: 60000 });
    cy.get('[role=alert]', { timeout: 30000 }).should('not.exist');
  });
});
