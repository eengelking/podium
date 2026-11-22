// SPEC 7.5 Concluding a Direct Message and SPEC 8.1 the concluded-direct-messages notice (#1283): when an agent finishes (its session reports done and is swept) every Direct Message it is in is
// concluded, deleted and gone from the sidebar. The people in it see a wall notice (dismissed on its own, switched off in Admin > Settings > Wall notices) and, with the thread open, a banner
// with the composer off. A conversation of people and agents that still has two or more people stays, with the agent shown as ended. A heartbeat that is only lost is not final: that case, hidden
// and back with its text when the agent reports again, is in chat-direct.cy.js. Not asserted here (unit and server tests): a conversation with fewer than two people left, the count of
// messages not delivered, and the notice to the agent that remains.
// Order: in each describe the tests run in order on one server and a later one reads what an earlier one left (named where it matters); each describe resets the server once, in `before`.
// An agent finishes by reporting `done`; the run's server keeps it for two hours before sweeping it, so LINGER_MS shortens that to two seconds.
import { seeded } from '../../../support/commands';

const DM = 'd:dm:e2e-s-invoice|e2e-s-tester';
const API = '/api/fleet/respond/chat';
const H = { 'X-Podium-Respond': '1' };
const finish = () => cy.reportAgain('tester', { status: 'done', endReason: 'prompt_input_exit' });

describe('chat: a Direct Message concluded because an agent finished', () => {
  before(() => cy.resetServer({ seedArgs: '--talk', env: ['LINGER_MS=2000'] }));

  it('takes the open thread off for good with a banner, the composer off, and Back to conversations', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(DM).find('button.ch-row').click();
    cy.tid('chat-message').should('have.length', 4);
    cy.tid('chat-concluded').should('not.exist');
    finish();
    cy.tid('chat-concluded').should('contain.text', 'Tester ended. This direct message has been concluded and deleted. Nothing in it is kept.');
    cy.tid('chat-box').should('be.disabled');
    cy.contains('This direct message has ended.').should('exist');
    // The conversation and its text are deleted: the row has left the sidebar, and a reload shows no trace of it.
    cy.chatRow(DM).should('not.exist');
    cy.contains('button', 'Back to conversations').click();
    cy.tid('chat-concluded').should('not.exist');
    cy.reload();
    cy.chatRow('c:general').should('exist');
    cy.chatRow(DM).should('not.exist');
  });

  it('puts a notice on the wall that says what was concluded, and the Admin can switch the kind off and on', () => {
    cy.signIn('Ed');
    cy.openConsole('#/');
    cy.get('.notices .fold').should('have.length', 1).and('contain.text', 'Tester ended.')
      .and('contain.text', 'Its direct message with invoice-v2 was concluded and deleted. A conversation with two or more people stays.');
    cy.openAdmin('Settings');
    cy.settingSwitch('notice-concluded-direct-messages').should('have.attr', 'aria-checked', 'true').click().should('have.attr', 'aria-checked', 'false');
    // Signing in as Ed again replaces the Admin's session (the notice is Ed's, so an Admin has none).
    cy.signIn('Ed');
    cy.openConsole('#/');
    cy.cards().should('have.length.greaterThan', 0);
    cy.get('.notices').should('not.exist');
    cy.openAdmin('Settings');
    cy.settingSwitch('notice-concluded-direct-messages').click().should('have.attr', 'aria-checked', 'true');
    cy.signIn('Ed');
    cy.openConsole('#/');
    cy.get('.notices .fold').should('have.length', 1).and('contain.text', 'Tester ended.');
  });

  it('dismisses the one notice with its X, confirms it, and keeps it gone after a reload', () => {
    cy.signIn('Ed');
    cy.openConsole('#/');
    cy.get('button[aria-label="Close notice: Concluded direct messages"]').click();
    cy.get('.notices').should('not.exist');
    cy.get('.toast').should('contain.text', 'Notice dismissed').within(() => {
      cy.contains('a.go', 'Open Admin > Settings').should('have.attr', 'href', '#/admin/settings');
    });
    cy.reload();
    cy.cards().should('have.length.greaterThan', 0);
    cy.get('.notices').should('not.exist');
    // Dismissing only removes the row: the kind is still on for the next one.
    cy.openAdmin('Settings');
    cy.settingSwitch('notice-concluded-direct-messages').should('have.attr', 'aria-checked', 'true');
  });
});

describe('chat: a conversation of people and agents that stays when an agent finishes', () => {
  before(() => {
    cy.resetServer({ seedArgs: '--talk', env: ['LINGER_MS=2000'] });
    cy.addPerson('Maya');
  });

  it('stays with its text, shows the agent as ended in the header, the thread and the members panel, and tells the wall nothing of it', () => {
    cy.signIn('Ed');
    cy.request({
      method: 'POST', url: `${API}/conversations`, headers: H, log: false,
      body: { members: [{ kind: 'person', name: 'Maya' }, { kind: 'agent', sessionId: seeded().sessions.tester }], text: 'Can you both look at the invoice totals? conv-stays-5b2e' },
    }).its('status').should('be.oneOf', [200, 201]);
    cy.openConsole('#/chat');
    cy.get('[data-testid^="chat-row-v:"]').should('have.length', 1).find('button.ch-row').click();
    cy.tid('chat-message').should('have.length', 1);
    cy.tid('chat-conversation-ended').should('not.exist');
    finish();
    cy.tid('chat-conversation-ended').should('contain.text', 'Tester: Ended. It can no longer be written to.');
    cy.tid('chat-conversation-ended-line').should('contain.text', 'Tester ended.');
    cy.tid('chat-message').should('have.length', 1).and('contain.text', 'conv-stays-5b2e');
    cy.tid('chat-concluded').should('not.exist');
    cy.tid('chat-box').should('not.be.disabled');
    cy.tid('chat-members-toggle').click();
    cy.get('#ch-members').should('contain.text', 'Tester').and('contain.text', 'Agent, ended');
    // The seeded conversation of the two agents was concluded when Tester finished, and is the one notice; this conversation stays, so none names Maya.
    cy.openConsole('#/');
    cy.get('.notices .fold').should('have.length', 1).and('contain.text', 'Its direct message with invoice-v2 was concluded').and('not.contain.text', 'Maya');
  });
});

// #1311: what was concluded is read once for the wall and the Chat page, again whenever the console's chat signal moves, so it is read at most once for each read of Chat's overview,
// where the wall's and the page's own made two.
describe('chat: what was concluded is read once for each read of the overview', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('reads it on opening Chat and again for the signal a new message makes, never more often than the overview is read, and the message shows', () => {
    const reads = { overview: 0, concluded: 0 };
    cy.signIn('Ed');
    cy.intercept('GET', /\/api\/fleet\/respond\/chat\/concluded$/, () => void (reads.concluded += 1));
    cy.intercept('GET', /\/api\/fleet\/respond\/chat(\?.*)?$/, () => void (reads.overview += 1));
    cy.openConsole('#/chat');
    cy.chatRow('c:general').should('exist');
    cy.tid('chat-message').should('have.length.greaterThan', 0);
    // Never more reads of what was concluded than of the overview (the wall's and the page's own made two for one). A signal that lands between the two starting can leave the
    // overview one ahead for a moment, which is why this bounds the count and does not ask for equality.
    cy.wrap(reads).should((r) => {
      expect(r.overview, 'the overview was read').to.be.greaterThan(0);
      expect(r.concluded, 'what was concluded was read').to.be.greaterThan(0);
      expect(r.concluded, 'what was concluded was read at most once for each read of the overview').to.be.at.most(r.overview);
    });
    // Read once, after the assertion above waited for the first reads to land.
    let first = 0;
    cy.then(() => void (first = reads.concluded));
    cy.request({ method: 'POST', url: `${API}/channels/general/messages`, headers: H, log: false, body: { text: 'one read for the signal 7c1e' } }).its('status').should('be.oneOf', [200, 201]);
    cy.contains('[data-testid=chat-message]', 'one read for the signal 7c1e');
    cy.wrap(reads).should((r) => {
      expect(r.concluded, 'the signal read what was concluded again').to.be.greaterThan(first);
      expect(r.concluded, 'what was concluded was read at most once for each read of the overview').to.be.at.most(r.overview);
    });
  });
});
