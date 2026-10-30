import { seeded } from '../../../support/commands';

// SPEC 8.1 Admin and Responding > Signing in: five wrong tries lock an address out of Admin's unlock and the sign-in to respond together (#206, #791). The server is
// restarted with the 15 minutes cut to 20 seconds (PODIUM_TEST_TIMINGS, DECISIONS 50). The wait for the lock to lift is the time the server itself says (retryAfterSec).
const H_ADMIN = { 'X-Podium-Admin': '1' };

describe('lockout after five wrong tries', () => {
  before(() => cy.resetServer({ env: ['PODIUM_TEST_TIMINGS=1', 'PODIUM_TEST_LOCK_MS=20000'] }));

  const wrongTry = () => cy.request({ method: 'POST', url: '/api/admin/unlock', headers: H_ADMIN, body: { name: 'Admin', token: 'not-the-secret' }, failOnStatusCode: false, log: false });

  it('locks the address on the fifth wrong try and refuses even the right secret, in Admin and in the sign-in to respond', () => {
    for (let i = 1; i <= 4; i++) wrongTry().its('status').should('eq', 401);
    wrongTry().its('status').should('eq', 401);

    cy.visit('/#/admin');
    cy.env(['ADMIN_SECRET']).then(({ ADMIN_SECRET }) => {
      cy.get('#admin-name').type('Admin');
      cy.get('#admin-secret').type(ADMIN_SECRET, { log: false });
    });
    cy.contains('button', 'Unlock Admin').click();
    cy.get('[role=alert]').should('contain.text', 'Too many wrong tries. Try again in 1 minutes.');
    cy.get('#admin-secret').should('have.value', '');

    // The same five tries count once across both: the console's sign-in is locked too.
    const { name, token } = seeded().people.Ed;
    cy.openConsole('#/');
    cy.get('#podium-top').contains('button', 'Sign in').click();
    cy.get('[role=dialog] input[type=text]').type(name);
    cy.get('[role=dialog] input[type=password]').type(token, { log: false });
    cy.get('[role=dialog]').contains('button', 'Sign in').click();
    cy.get('[role=dialog]').should('contain.text', 'Too many wrong tries from this address. Try again in 15 minutes.');
  });

  it('lets the right secret in again once the lock has lifted', () => {
    cy.env(['ADMIN_SECRET']).then(({ ADMIN_SECRET }) => {
      // Still locked: the answer says for how long, and that is how long to wait.
      cy.request({ method: 'POST', url: '/api/admin/unlock', headers: H_ADMIN, body: { name: 'Admin', token: ADMIN_SECRET }, failOnStatusCode: false, log: false }).then((res) => {
        if (res.status === 429) {
          expect(res.body.retryAfterSec).to.be.within(1, 20);
          cy.wait(res.body.retryAfterSec * 1000 + 500);
        }
      });
      cy.request({ method: 'POST', url: '/api/admin/unlock', headers: H_ADMIN, body: { name: 'Admin', token: ADMIN_SECRET }, log: false }).its('status').should('eq', 200);
    });
    cy.visit('/#/admin');
    cy.get('nav[aria-label="Admin sections"]').should('be.visible');
  });
});
