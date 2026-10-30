// SPEC 8.1 Responding > Signing in: a sign-in ends after it has been idle (#791). The server is restarted with the 12 hours cut to 8 seconds (PODIUM_TEST_TIMINGS,
// DECISIONS 50). The page checks its sign-in once a minute, so the top bar goes back to "Sign in" by itself: a retrying assertion, no fixed sleep.
describe('sign in: idle', () => {
  before(() => cy.resetServer({ env: ['PODIUM_TEST_TIMINGS=1', 'PODIUM_TEST_SIGN_IN_IDLE_MS=8000'] }));

  it('signs the browser out once the idle time has passed, with no reload', () => {
    cy.signIn('Ed');
    cy.openConsole('#/');
    cy.get('#podium-top').should('contain.text', 'Signed in as').and('contain.text', 'Ed');
    cy.get('#podium-top', { timeout: 90000 }).should('not.contain.text', 'Signed in as');
    cy.get('#podium-top').contains('button', 'Sign in');

    // Same test: Cypress clears cookies between tests, which would make a separate "not signed in" check pass without the idle time.
    cy.request({ url: '/api/fleet/respond/me', log: false }).its('body.signedIn').should('eq', false);
    cy.signIn('Ed');
    cy.request({ url: '/api/fleet/respond/me', log: false }).its('body.signedIn').should('eq', true);
  });
});
