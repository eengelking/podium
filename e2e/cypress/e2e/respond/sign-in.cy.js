import { seeded } from '../../../support/commands';

// SPEC 8.1 Responding > Signing in: the top bar's Sign in dialog, its messages, who is shown once signed in, and that the page never keeps the token.
describe('sign in', () => {
  before(() => cy.resetServer());
  beforeEach(() => cy.openConsole('#/'));

  const top = () => cy.get('#podium-top');
  const dialog = () => cy.get('[role=dialog]');

  it('puts Sign in at the far end of the top bar after the other buttons', () => {
    top().find('button.btn').last().should('contain.text', 'Sign in');
  });

  it('opens a small Sign in dialog with Name and Token fields, and closes it with Esc', () => {
    top().contains('button', 'Sign in').click();
    dialog().should('contain.text', 'To answer and message your own sessions');
    dialog().find('input[type=text]').should('exist');
    dialog().find('input[type=password]').should('exist');
    cy.get('body').type('{esc}');
    dialog().should('not.exist');
    cy.focused().should('contain.text', 'Sign in');
  });

  it('says what is missing when a field is empty, and does not say which of name or token was wrong', () => {
    top().contains('button', 'Sign in').click();
    dialog().contains('button', 'Sign in').click();
    dialog().should('contain.text', 'Enter your name and your token.');
    dialog().find('input[type=text]').type('Ed');
    dialog().find('input[type=password]').type('pdm_000000000000_wrong');
    dialog().contains('button', 'Sign in').click();
    dialog().should('contain.text', "That name and token don't match. Check the userName and token options in podium-reporter.");
    dialog().find('input[type=text]').should('have.value', 'Ed');
    dialog().find('input[type=password]').should('have.value', '');
  });

  it('signs in with a person\'s name and token, shows who is signed in, and keeps no token in the page', () => {
    const { name, token } = seeded().people.Ed;
    top().contains('button', 'Sign in').click();
    dialog().find('input[type=text]').type(name);
    dialog().find('input[type=password]').type(token, { log: false });
    dialog().contains('button', 'Sign in').click();
    dialog().should('not.exist');
    top().should('contain.text', 'Signed in as').and('contain.text', 'Ed');
    top().contains('button', 'Sign out');
    cy.window().then((win) => {
      expect(JSON.stringify({ ...win.localStorage }), 'localStorage').not.to.contain(token);
      expect(JSON.stringify({ ...win.sessionStorage }), 'sessionStorage').not.to.contain(token);
      expect(win.document.cookie, 'the cookie is HttpOnly').not.to.contain('podium');
    });
  });

  it('stays signed in over a reload and signs out with Sign out', () => {
    cy.signIn('Ed');
    cy.openConsole('#/');
    top().should('contain.text', 'Signed in as');
    cy.reload();
    top().should('contain.text', 'Signed in as');
    top().contains('button', 'Sign out').click();
    top().contains('button', 'Sign in');
    cy.request('/api/fleet/respond/me').its('body.signedIn').should('eq', false);
  });

  it('shows My reporters in the bar once a person is signed in', () => {
    cy.signIn('Ed');
    cy.openConsole('#/');
    top().contains('a, button', 'My reporters').should('exist');
  });

  it('has no Sign in at all while no feature needs it', () => {
    cy.setFlags({ respond: false, 'peer-messaging': false, 'session-recording': false, 'file-diff': false });
    cy.openConsole('#/');
    top().contains('button', 'Sign in').should('not.exist');
  });
});
