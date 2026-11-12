// SPEC 8.1 An Admin never reads in silence (#1072, #1073, #1074): when an Admin who is not the owner reads a person's content, the owner is told in the console. Three reads:
// an agent-to-agent conversation (through the Admin route and through the owner-or-Admin route: Ed's Chat shows the red banner, then the record line), a waiting ask (a red
// notice under the status band of the orchestrator page and above the ask in the Respond window, then a quiet record line; the Admin log gets `ask_read`) and the stored Activity
// (a red notice under the band, then a record line; the Admin log gets `activity_admin_read`). The X hides a notice on that browser only, the owner's own read tells no one.
// An agent's whole prompt and answer (`text`) and its live Activity (`live`) are the same (#1082): an Admin's read of Ed's agent is a red notice under the band and then a record
// line, and the Admin log gets `text_admin_read` and `live_admin_read`; Ed's own read tells no one. Who may read at all (401, 403) is in orchestrator/agent-read-gate.cy.js.
// The callout shown to the person in the terminal is the reporter's and is not in the console (docs/e2e/COVERAGE.md). An Administrator who owns the agents is not noticed: that is
// covered by the server's own tests, because no seeded Administrator owns a session.
// Order: the tests run in order on one server, and a later one reads what an earlier one left (named where it matters).
// An Admin's "reading" is made through the API the way the Admin's open page makes it (the read and its 15-second ping), because only one browser is open at a time. A notice
// clears about 30 seconds after the last ping, by the server's clock, so the spec waits that out in a retrying query (it does not move the clock).
import { seeded } from '../../../support/commands';

const H = { 'X-Podium-Respond': '1' };
const RESPOND = '/api/fleet/respond';
const A = 'e2e-s-invoice';
const B = 'e2e-s-tester';
const DM = `d:dm:${A}|${B}`;
const ASK = 'toolu_e2e_q';
const MAIN = '@orchestrator';
// The admin secret signs in as the actor "Admin secret", and that is the name the person is told.
const ADMIN = 'Admin secret';
const AS_ADMIN = `${ADMIN} (an Admin)`;
const AGENT = 'e2e-a-map';
const ASK_WORDS = 'your waiting plan, question or tool request';

const ok = (req) => cy.request({ log: false, ...req }).its('status', { log: false }).should('be.oneOf', [200, 202]);
/** The Admin opens Ed's ask and pings it, as the open Respond window does. */
const adminOpensAsk = () => {
  cy.signIn('Admin');
  const id = seeded().sessions.question;
  ok({ url: `${RESPOND}/sessions/${id}/asks/${ASK}` });
  ok({ method: 'POST', url: `${RESPOND}/sessions/${id}/admin-reads/ask/reading`, headers: H, body: {} });
};
/** The Admin pages Ed's stored Activity and pings it. */
const adminPagesActivity = () => {
  cy.signIn('Admin');
  const id = seeded().sessions.stored;
  ok({ url: `${RESPOND}/sessions/${id}/activity-history?loop=${encodeURIComponent(MAIN)}` });
  ok({ method: 'POST', url: `${RESPOND}/sessions/${id}/admin-reads/activity/reading`, headers: H, body: { loop: MAIN } });
};
/** The notes box of one kind of read (its test id is `read-notes-<kind>`). */
const notes = (kind) => cy.get(`[data-testid="read-notes-${kind}"]`);
const records = (kind, session) => cy.request({ url: `${RESPOND}/sessions/${session}/admin-reads/${kind}`, log: false }).its('body.adminReads', { log: false });

describe('an Admin never reads in silence: what the person is told', () => {
  before(() => {
    cy.resetServer({ seedArgs: '--talk --stored' });
    // The seed's agent has an excerpt only; its full answer is what an Admin's read of the whole text opens (#1082).
    cy.reportAgain('invoice', {}, { [AGENT]: { answerText: 'Found 42 call sites across 9 modules. Every one is listed in the full answer.' } });
  });

  it('tells no one when the owner reads their own ask and stored Activity', () => {
    cy.signIn('Ed');
    const { question, stored } = seeded().sessions;
    ok({ url: `${RESPOND}/sessions/${question}/asks/${ASK}` });
    ok({ url: `${RESPOND}/sessions/${stored}/activity-history?loop=${encodeURIComponent(MAIN)}` });
    records('ask', question).should('have.length', 0);
    records('activity', stored).should('have.length', 0);
    cy.openConsole(`#/?open=${question}`);
    notes('ask').should('not.exist');
    notes('activity').should('not.exist');
  });

  it('shows Ed a red banner when an Admin reads a conversation between agents through the Admin route, and the record line when it ends', () => {
    cy.unlockAdmin();
    cy.request({ url: `/api/admin/peers/conversations/${A}/${B}`, log: false }).its('body.messages', { log: false }).should('have.length', 4);
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(DM).find('button.ch-row').click();
    cy.tid('chat-reading-banner').should('contain.text', `${AS_ADMIN} is reading this conversation.`).and('contain.text', `The notice clears about 30 seconds after ${ADMIN} stops.`);
    // The read was made once and never pinged, so it clears about 30 seconds after, and the record line stays.
    cy.tid('chat-reading-banner', { timeout: 60000 }).should('not.exist');
    cy.tid('chat-record').first().should('contain.text', `${AS_ADMIN} read this conversation on `);
  });

  it('shows Ed the same banner when an Admin reads it through the owner-or-Admin route', () => {
    cy.signIn('Admin');
    cy.request({ url: `${RESPOND}/peers/conversations/${A}/${B}`, log: false }).its('body.messages', { log: false }).should('have.length', 4);
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(DM).find('button.ch-row').click();
    cy.tid('chat-reading-banner').should('contain.text', `${AS_ADMIN} is reading this conversation.`);
    cy.tid('chat-reading-banner', { timeout: 60000 }).should('not.exist');
  });

  it('does not notice Ed\'s own read of his conversation between agents', () => {
    cy.signIn('Ed');
    cy.request({ url: `${RESPOND}/peers/conversations/${A}/${B}`, log: false }).its('status', { log: false }).should('eq', 200);
    cy.openConsole('#/chat');
    cy.chatRow(DM).find('button.ch-row').click();
    cy.tid('chat-message').should('have.length', 4);
    cy.tid('chat-reading-banner').should('not.exist');
  });

  it('shows Ed a red notice under the band and above the ask in Respond while an Admin has the ask open', () => {
    adminOpensAsk();
    cy.signIn('Ed');
    cy.openConsole(`#/?open=${seeded().sessions.question}`);
    notes('ask').first().find('[data-testid=read-notice]').should('have.attr', 'role', 'status').and('contain.text', `${AS_ADMIN} is reading ${ASK_WORDS}.`).and('contain.text', 'Only you and Admins can open it.').and('contain.text', `The notice clears about 30 seconds after ${ADMIN} stops.`);
    notes('activity').should('not.exist');
    cy.get('main#podium-main').contains('button', 'Respond').click();
    cy.get('[role=dialog]').within(() => notes('ask').find('[data-testid=read-notice]').should('contain.text', `${AS_ADMIN} is reading ${ASK_WORDS}.`));
    cy.get('[role=dialog]').should('contain.text', 'How many History rows per page?');
  });

  it('leaves a quiet record line, and no red notice, once the Admin stops, and logs the open as ask_read', () => {
    // The last ping was in the test above; the notice clears about 30 seconds after it.
    cy.signIn('Ed');
    cy.openConsole(`#/?open=${seeded().sessions.question}`);
    // The record line is shown only once the reading has ended, so it is awaited first (up to the 30 seconds): "no red notice" asserted at once would pass before the page
    // has read who is reading, and the notice would then appear.
    cy.tid('read-record', { timeout: 60000 }).first().should('contain.text', `${AS_ADMIN} opened ${ASK_WORDS} on `);
    cy.tid('read-notice').should('not.exist');
    cy.openAdmin('Admin log');
    cy.contains('td', 'opened an ask of Ed in claude-dashboard').should('exist');
  });

  it('shows Ed a red notice under the band while an Admin pages his stored Activity, then a record line, and logs it as activity_admin_read', () => {
    adminPagesActivity();
    cy.signIn('Ed');
    const id = seeded().sessions.stored;
    cy.openConsole(`#/?open=${id}`);
    notes('activity').find('[data-testid=read-notice]').should('contain.text', `${AS_ADMIN} is paging through the stored Activity of stored-run.`);
    notes('ask').should('not.exist');
    cy.tid('read-notice', { timeout: 60000 }).should('not.exist');
    notes('activity').find('[data-testid=read-record]').should('have.length', 1).and('contain.text', `${AS_ADMIN} read the stored Activity of stored-run on `);
    cy.openAdmin('Admin log');
    cy.contains('td', 'read the stored Activity of stored-run').should('contain.text', 'owned by Ed');
  });

  it('has no X on the live red notice: it cannot be closed, it is still there after a reload, and the record stays on the server', () => {
    // A second read of the same thread within 30 minutes is the same record, live again.
    adminPagesActivity();
    cy.signIn('Ed');
    const id = seeded().sessions.stored;
    cy.openConsole(`#/?open=${id}`);
    notes('activity').find('[data-testid=read-notice]').should('exist');
    notes('activity').find('[data-testid=read-notice] button').should('not.exist');
    cy.reload();
    cy.get('[data-testid="connection-pill"]', { timeout: 15000 }).should('have.attr', 'data-state', 'live');
    notes('activity').find('[data-testid=read-notice]').should('exist');
    notes('activity').find('[data-testid=read-notice] button').should('not.exist');
    records('activity', id).should('have.length', 1);
  });
  it('tells no one when the owner reads the whole text and the live activity of his own agent', () => {
    cy.signIn('Ed');
    const id = seeded().sessions.invoice;
    ok({ url: `/api/fleet/sessions/${id}/agents/${AGENT}/text` });
    ok({ url: `/api/fleet/sessions/${id}/agents/${MAIN}/activity?every=5` });
    records('text', id).should('have.length', 0);
    records('live', id).should('have.length', 0);
    cy.openConsole(`#/?open=${id}`);
    notes('text').should('not.exist');
    notes('live').should('not.exist');
  });

  it('shows Ed a red notice under the band while an Admin reads the whole text and watches the live activity of his agent, then record lines, and logs both', () => {
    const id = seeded().sessions.invoice;
    cy.signIn('Admin');
    ok({ url: `/api/fleet/sessions/${id}/agents/${AGENT}/text` });
    ok({ method: 'POST', url: `${RESPOND}/sessions/${id}/admin-reads/text/reading`, headers: H, body: { loop: AGENT } });
    ok({ url: `/api/fleet/sessions/${id}/agents/${MAIN}/activity?every=5` });
    ok({ method: 'POST', url: `${RESPOND}/sessions/${id}/admin-reads/live/reading`, headers: H, body: { loop: MAIN } });
    cy.signIn('Ed');
    cy.openConsole(`#/?open=${id}`);
    notes('text').find('[data-testid=read-notice]').should('have.attr', 'role', 'status').and('contain.text', `${AS_ADMIN} is reading the whole prompt and answer of an agent in invoice-v2.`).and('contain.text', `The notice clears about 30 seconds after ${ADMIN} stops.`);
    notes('live').find('[data-testid=read-notice]').should('contain.text', `${AS_ADMIN} is watching the live activity of an agent in invoice-v2.`);
    // They clear about 30 seconds after the last ping; the record lines stay and never hold the text.
    cy.tid('read-notice', { timeout: 60000 }).should('not.exist');
    notes('text').find('[data-testid=read-record]').should('have.length', 1).and('contain.text', `${AS_ADMIN} read the whole prompt and answer of an agent in invoice-v2 on `);
    notes('live').find('[data-testid=read-record]').should('have.length', 1).and('contain.text', `${AS_ADMIN} watched the live activity of an agent in invoice-v2 on `);
    cy.openAdmin('Admin log');
    cy.contains('td', `read the whole prompt and answer of agent ${AGENT} in invoice-v2`).should('contain.text', 'owned by Ed');
    cy.contains('td', `read the live Activity of agent ${MAIN} in invoice-v2`).should('contain.text', 'owned by Ed');
  });
});
