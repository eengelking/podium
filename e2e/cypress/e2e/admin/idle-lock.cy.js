// SPEC 8.1 Admin: the idle lock (#791). The server is restarted with the idle time cut from 10 minutes to 5 seconds (PODIUM_TEST_TIMINGS, DECISIONS 50). The Reporters
// page asks again every 10 seconds, and the first ask after the idle time is answered "locked", so the lock screen comes up by itself: a retrying assertion, no fixed sleep.
describe('admin: the idle lock', () => {
  before(() => cy.resetServer({ env: ['PODIUM_TEST_TIMINGS=1', 'PODIUM_TEST_ADMIN_IDLE_MS=5000'] }));

  it('locks Admin after the idle time, says why, hides the work behind it, and opens again with the admin secret', () => {
    cy.openAdmin('Reporters');
    cy.get('nav[aria-label="Admin sections"]').should('be.visible');
    cy.get('table tbody tr').should('have.length.greaterThan', 0);

    cy.get('#admin-name', { timeout: 40000 }).should('be.visible');
    cy.get('[role=status], [role=alert]').should('contain.text', 'Admin locked after 10 minutes without activity. Sign in with your name and token to continue.');
    cy.contains('button', 'Unlock Admin');
    cy.get('nav[aria-label="Admin sections"]').should('not.exist');
    cy.get('table').should('not.exist');

    // One test, because Cypress clears the page between tests and the lock screen is what is being unlocked.
    cy.env(['ADMIN_SECRET']).then(({ ADMIN_SECRET }) => {
      cy.get('#admin-name').clear().type('Admin');
      cy.get('#admin-secret').type(ADMIN_SECRET, { log: false });
    });
    cy.contains('button', 'Unlock Admin').click();
    cy.get('nav[aria-label="Admin sections"]').should('be.visible');
    cy.get('#admin-name').should('not.exist');
  });
});
