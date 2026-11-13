// SPEC 8.1 Session recording, an Admin's replay is told to its owner (#1075): the red notice under the recording layer while the replay is live, the quiet record line
// each replay leaves (with an X that hides it in that browser only), and the second line an Admin's replay adds to the owner's recorded card. An Admin who is not the owner sees none of it,
// and the owner's own replay records nothing. The callout shown in the terminal is the reporter's and is not in the console (docs/e2e/COVERAGE.md).
// The Admin's replay is made through the API the way their open page makes it (a read of the recording and its 15-second ping), because only one browser is open at a time.
// Order: the tests run in order on one server and a later one reads what an earlier one left (named where it matters). The page decides a replay has ended by the server's clock it was
// given, so the spec waits the 30 seconds out in a retrying query (it does not move the clock).
const A = 'e2e-s-invoice';
const API = '/api/fleet/respond';
const H = { 'X-Podium-Respond': '1' };
const READ_AS = 'Admin secret (an Admin)';

const get = (url) => cy.request({ url: `${API}/${url}`, log: false }).its('status', { log: false }).should('eq', 200);
/** The Admin opens the replay of Ed's recording and pings it, as their open page does; then the browser is Ed's again. */
const adminReplays = () => {
  cy.signIn('Admin');
  get(`sessions/${A}/recording?limit=5`);
  cy.request({ method: 'POST', url: `${API}/sessions/${A}/recording/reading`, headers: H, body: {}, log: false }).its('status', { log: false }).should('eq', 200);
  cy.signIn('Ed');
};
const open = () => {
  cy.openConsole('#/');
  cy.card('invoice').click();
  cy.get('main#podium-main h1').should('exist');
};

describe('session recording: an Admin replays a person\'s recording', () => {
  before(() => cy.resetServer({ seedArgs: '--recording' }));

  it('tells no one when the owner replays their own recording', () => {
    cy.signIn('Ed');
    get(`sessions/${A}/recording?limit=5`);
    open();
    cy.contains('This session is being recorded.');
    cy.tid('replay-reading-notice').should('not.exist');
    cy.tid('replay-record').should('not.exist');
    cy.openConsole('#/');
    cy.card('invoice').should('contain.text', 'Recording 3 of 5 loops').and('not.contain.text', 'is replaying it now');
  });

  it('refuses the live ping from a person who is not an Admin', () => {
    cy.signIn('Alex');
    cy.request({ method: 'POST', url: `${API}/sessions/${A}/recording/reading`, headers: H, body: {}, failOnStatusCode: false, log: false }).its('status', { log: false }).should('be.oneOf', [403, 404]);
  });

  it('shows the owner a red notice on the page and a second line on the wall card, naming the Admin, until the Admin stops', () => {
    adminReplays();
    cy.openConsole('#/');
    cy.card('invoice').should('contain.text', `${READ_AS} is replaying it now.`);
    cy.card('invoice').click();
    cy.tid('replay-reading-notice').should('contain.text', `${READ_AS} is replaying this recording.`).and('contain.text', 'Only you and Admins can open it.').and('contain.text', 'The notice clears about 30 seconds after Admin secret stops.');
    // About 30 seconds after the Admin's last read the notice and the card line clear and the record line stays. The page hides a reading only once the server has answered after its end.
    cy.tid('replay-reading-notice', { timeout: 60000 }).should('not.exist');
    cy.tid('replay-record').should('have.length', 1).first().should('contain.text', `${READ_AS} replayed this recording on `);
  });

  it('keeps the record line until the owner closes it, and hides it in that browser only', () => {
    cy.signIn('Ed');
    open();
    cy.tid('replay-record').should('have.length', 1).first().and('contain.text', `${READ_AS} replayed this recording on `);
    cy.tid('replay-record').first().find('button.x').should('have.attr', 'aria-label').and('match', /^Close notice: /);
    cy.tid('replay-record').first().find('button.x').click();
    cy.tid('replay-record').should('not.exist');
    cy.reload();
    cy.get('main#podium-main h1').should('exist');
    cy.tid('replay-record').should('not.exist');
    // The record is not erased: another browser of Ed's (a fresh storage) still finds it.
    cy.request(`${API}/sessions/${A}/recording/consent`).its('body.adminReads', { log: false }).should('have.length', 1);
  });

  it('shows the Admin none of it, and a stranger none either', () => {
    adminReplays();
    cy.signIn('Admin');
    open();
    cy.contains('This session is being recorded.');
    cy.tid('replay-reading-notice').should('not.exist');
    cy.tid('replay-record').should('not.exist');
    cy.signIn('Alex');
    open();
    cy.contains('This session is being recorded.');
    cy.tid('replay-reading-notice').should('not.exist');
    cy.tid('replay-record').should('not.exist');
  });
});
