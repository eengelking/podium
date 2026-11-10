// SPEC 8.1 Chat page (#1034), an Admin reading and stopping a person's conversations: the "Read a person's conversations" picker, Ed's My group and Direct Message read only (red
// banner, no box, no unread cleared), `GET /chat?owner=` for an Admin only; what Ed sees while an Admin has a thread open (red banner naming the Admin, the "Who is reading" tip, the
// "Admin reading" tag on the row, cleared when the Admin stops), the record line that stays, an Admin's Pause link on a Direct Message and its red tag and banner for Ed, who cannot resume
// it, and an Admin's pause, disconnect and Remove all messages in a group. The callout shown to the person in the terminal is the reporter's and is not in the console (docs/e2e/COVERAGE.md).
// Order: in each describe the tests run in order on one server, and a later one reads what an earlier one left (named where it matters); each describe resets the server once, in `before`.
// An Admin's "reading" is made through the API the way the Admin's open page makes it (a read of the thread and its 15-second ping), because only one browser is open at a time.
// The page decides a reading has ended by the server's clock it was given and its own clock, so the spec waits the 30 seconds out, in a retrying query (it does not move the clock).
import { seeded } from '../../../support/commands';

const GROUP = 'c:group';
const GENERAL = 'c:general';
const DM = 'd:dm:e2e-s-invoice|e2e-s-tester';
const A = 'e2e-s-invoice';
const B = 'e2e-s-tester';
const H = { 'X-Podium-Respond': '1' };
const API = '/api/fleet/respond/chat';
// The admin secret signs in as the actor "Admin secret", and that is the name the person is told.
const ADMIN = 'Admin secret';
const READ_AS = `${ADMIN} (an Admin)`;

const get = (url) => cy.request({ url: `${API}/${url}`, log: false }).its('status', { log: false }).should('eq', 200);
const send = (method, url, body) => cy.request({ method, url: `${API}/${url}`, headers: H, body, log: false }).its('status', { log: false }).should('eq', 200);
/** Ed writes a group note, by request. */
const edNote = (text) => {
  cy.signIn('Ed');
  cy.request({ method: 'POST', url: `${API}/channels/group/messages`, headers: H, body: { text }, log: false }).its('status', { log: false }).should('eq', 201);
};
/** The Admin reads Ed's group and Ed's Direct Message and pings both, as an open page of theirs does; then the browser is Ed's again. */
const adminReads = () => {
  cy.signIn('Admin');
  get('channels/group/messages?owner=Ed&limit=50');
  send('POST', 'channels/group/reading', { owner: 'Ed' });
  get(`dm/${A}/${B}/messages?limit=50`);
  send('POST', `dm/${A}/${B}/reading`, {});
  cy.signIn('Ed');
};
const openMenu = (row) => {
  cy.chatRow(row).find('button.ch-more').click();
  return cy.tid('chat-menu').should('be.visible');
};
const asAdminReading = (person = 'Ed') => {
  cy.signIn('Admin');
  cy.openConsole('#/chat');
  cy.tid('chat-read-as').select(person);
};

describe('chat: an Admin reads a person\'s conversations', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('is set up: Ed has a note in My group and an agent has posted there, so the row has an unread count', () => {
    // The note calls the agent in, so that its post is answered (#1065).
    edNote('@invoice-v2@ed-mbp group note for the Admin');
    cy.request({ method: 'POST', url: `/api/fleet/sessions/${A}/chat/channels/group/messages`, headers: { 'X-Podium-Token': seeded().people.Ed.token }, body: { text: 'agent says hi' }, log: false }).its('status', { log: false }).should('eq', 201);
    cy.openConsole('#/chat');
    cy.chatRow(GROUP).find('.unread').should('have.text', '1');
  });

  it('answers the overview of a person to an Admin only, with names and counts and never a message', () => {
    cy.signIn('Admin');
    cy.request(`${API}?owner=Ed`).then((r) => {
      expect(r.status).to.eq(200);
      expect(JSON.stringify(r.body)).not.to.contain('group note for the Admin');
    });
    cy.request({ url: `${API}?owner=`, failOnStatusCode: false }).its('status').should('eq', 400);
    cy.signIn('Ed');
    cy.request({ url: `${API}?owner=Alex`, failOnStatusCode: false }).its('status').should('eq', 403);
    cy.request({ url: `${API}/channels/group/messages?owner=Alex`, failOnStatusCode: false }).its('status').should('eq', 403);
  });

  it('shows the picker to an Admin only, and a signed-in person has none', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(GROUP).should('exist');
    cy.tid('chat-read-as').should('not.exist');
    cy.signIn('Admin');
    cy.openConsole('#/chat');
    cy.contains('h2', 'Read as an Admin');
    cy.get('label[for=read-as]').should('have.text', 'Read a person\'s conversations');
    cy.tid('chat-read-as').find('option').first().should('have.text', 'Choose a person…');
    cy.tid('chat-read-as').find('option').should(($o) => expect([...$o].map((o) => o.textContent)).to.include('Ed'));
  });

  it('lets the Admin stop reading in place, from the picker and from the thread (#1066)', () => {
    cy.signIn('Admin');
    cy.openConsole('#/chat');
    cy.tid('chat-stop-reading').should('not.exist');
    cy.get('[aria-label="About reading as an Admin"]').focus().invoke('attr', 'aria-describedby').then((id) => cy.get(`#${id}`).should('be.visible').and('contain.text', 'never the text'));
    cy.tid('chat-read-as').select('Ed');
    cy.tid('chat-stop-reading').should('be.visible').and('have.text', 'Stop reading');
    cy.chatRow(GROUP).find('button.ch-row').click();
    cy.tid('chat-ro-banner').should('exist');
    cy.tid('chat-stop-reading-thread').click();
    cy.tid('chat-ro-banner').should('not.exist');
    cy.tid('chat-stop-reading').should('not.exist');
    cy.tid('chat-read-as').should('have.value', '');
    cy.chatRow(DM).should('not.exist');
    cy.tid('chat-read-as').select('Ed');
    cy.tid('chat-stop-reading').click();
    cy.tid('chat-stop-reading').should('not.exist');
    cy.tid('chat-read-as').should('have.value', '');
  });

  it('opens a person\'s My group read only: red banner, no message box, the reason, and their messages', () => {
    asAdminReading();
    cy.chatRow(GROUP).should('contain.text', 'read only');
    cy.chatRow(GROUP).find('button.ch-row').click();
    cy.tid('chat-ro-banner').should('contain.text', 'Reading Ed\'s conversation as an Admin. You cannot send here.').and('contain.text', 'Ed is told while you read');
    cy.tid('chat-box').should('not.exist');
    cy.tid('chat-ro-note').should('contain.text', 'You are reading as an Admin, so there is no message box.');
    cy.tid('chat-thread').should('contain.text', 'group note for the Admin').and('contain.text', 'agent says hi');
    cy.get('#th-h').should('have.text', 'My group');
  });

  it('refuses an Admin\'s message into a person\'s My group, with no box to write in, and leaves the group as it was', () => {
    const REFUSED = 'An Admin can read and stop a person\'s group but cannot write in it.';
    asAdminReading();
    cy.chatRow(GROUP).find('button.ch-row').click();
    cy.tid('chat-box').should('not.exist');
    // Read once on purpose: a thread shows its messages only after one load, whole (#1137).
    cy.tid('chat-thread').find('[data-testid=chat-message]').its('length').then((before) => {
      cy.request({ method: 'POST', url: `${API}/channels/group/messages?owner=Ed`, headers: H, body: { text: 'an Admin writes in Ed\'s group', owner: 'Ed' }, failOnStatusCode: false, log: false }).then((r) => {
        expect(r.status).to.eq(403);
        expect(r.body.error).to.eq(REFUSED);
      });
      cy.request({ url: `${API}/channels/group/messages?owner=Ed&limit=50`, log: false }).then((r) => expect(JSON.stringify(r.body)).not.to.contain('an Admin writes in Ed'));
      cy.tid('chat-message').should('have.length', before);
    });
  });

  it('opens a person\'s Direct Message read only, shows its four messages, and leaves General the Admin\'s own', () => {
    asAdminReading();
    cy.chatRow(DM).find('button.ch-row').click();
    cy.tid('chat-ro-banner').should('contain.text', 'Reading Ed\'s conversation as an Admin.');
    cy.tid('chat-box').should('not.exist');
    cy.tid('chat-ro-note').should('exist');
    cy.tid('chat-message').should('have.length', 4);
    cy.tid('chat-thread').should('contain.text', 'Please run the unit tests on this branch.');
    cy.chatRow(GENERAL).find('button.ch-row').click();
    cy.tid('chat-ro-banner').should('not.exist');
    cy.tid('chat-box').should('exist');
    // Choosing no one goes back to the Admin's own conversations.
    cy.tid('chat-read-as').select('');
    cy.chatRow(DM).should('not.exist');
    cy.tid('chat-ro-banner').should('not.exist');
  });

  it('leaves Ed\'s unread count alone, and leaves a record line in each thread Ed opens', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(GROUP).find('.unread').should('have.text', '1');
    cy.chatRow(GROUP).find('button.ch-row').click();
    cy.tid('chat-record').should('have.length.greaterThan', 0).first().should('contain.text', `${READ_AS} read this conversation on `);
    cy.chatRow(DM).find('button.ch-row').click();
    cy.tid('chat-message').should('have.length', 4);
    cy.tid('chat-record').first().should('contain.text', `${READ_AS} read this conversation on `);
  });
});

describe('chat: what the person sees while an Admin reads', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('is set up: Ed has a note in My group', () => {
    edNote('a note an Admin will read');
  });

  it('shows a red banner naming the Admin and an "Admin reading" tag on the row, with the tip listing who reads, until the Admin stops', () => {
    adminReads();
    cy.openConsole('#/chat');
    cy.chatRow(GROUP).find('[data-testid=chat-tag-reading]').should('contain.text', 'Admin reading');
    cy.chatRow(DM).find('[data-testid=chat-tag-reading]').should('contain.text', 'Admin reading');
    cy.chatRow(GROUP).find('button.ch-row').click();
    cy.tid('chat-reading-banner').should('contain.text', `${READ_AS} is reading this conversation.`).and('contain.text', 'Only you and Admins can read it.').and('contain.text', `The notice clears about 30 seconds after ${ADMIN} stops.`);
    cy.tid('chat-thread').find('[data-testid=chat-tag-reading]').should('exist');
    // The "Who is reading" tip opens on focus, lists every reading Admin, and closes on Escape.
    cy.tid('chat-reading-banner').contains('.tip', 'Who is reading').as('tip').focus();
    cy.tid('chat-reading-banner').find('[role=tooltip]').should('be.visible').and('contain.text', `Reading now: ${ADMIN} since `);
    cy.get('@tip').type('{esc}');
    cy.tid('chat-reading-banner').find('[role=tooltip]').should('not.be.visible');
    cy.chatRow(DM).find('button.ch-row').click();
    cy.tid('chat-reading-banner').should('contain.text', `${READ_AS} is reading this conversation.`);
    // About 30 seconds after the Admin\'s last read, the notice and the tags clear, and the record line stays. The page hides a reading only once the server has answered
    // after its end, never on its own clock (#1051), so this waits the real 30 seconds, in a query that retries.
    cy.tid('chat-reading-banner', { timeout: 60000 }).should('not.exist');
    cy.tid('chat-tag-reading').should('not.exist');
    cy.tid('chat-record').first().should('contain.text', `${READ_AS} read this conversation on `);
  });
});

describe('chat: an Admin pauses and stops what is a person\'s', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('is set up: Ed has a note in My group', () => {
    edNote('a note before the stop');
  });

  it('lets an Admin pause a Direct Message link, shows Ed a red tag and banner, and keeps Ed from resuming it', () => {
    cy.signIn('Admin');
    send('PUT', `dm/${A}/${B}/link`, { op: 'pause' });
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(DM).find('[data-testid=chat-tag-paused]').should('contain.text', 'Paused by an Admin');
    cy.chatRow(DM).find('button.ch-row').click();
    cy.tid('chat-admin-pause-banner').should('contain.text', `${READ_AS} paused this link.`).and('contain.text', 'Only an Admin can resume it.');
    cy.tid('chat-box').should('be.disabled');
    openMenu(DM).contains('[role=menuitem]', 'Resume link').should('have.attr', 'aria-disabled', 'true').and('contain.text', 'Only an Admin can resume this link.');
    cy.tid('chat-menu').contains('[role=menuitem]', 'Resume link').click();
    cy.tid('chat-admin-pause-banner').should('exist');
    cy.tid('chat-record').last().should('contain.text', `${READ_AS} paused this link on `);
  });

  it('shows the Admin the same pause as theirs to lift, offers Pause link and Resume link only, and Ed has the link again after', () => {
    asAdminReading();
    cy.chatRow(DM).find('[data-testid=chat-tag-paused]').should('exist');
    cy.chatRow(DM).find('button.ch-row').click();
    cy.tid('chat-admin-pause-banner').should('contain.text', 'You paused this link. Messages are held until you resume it from its menu.');
    openMenu(DM).find('[role=menuitem]').should(($i) => expect([...$i].map((i) => i.textContent.trim())).to.deep.eq(['Resume link']));
    cy.tid('chat-menu').contains('[role=menuitem]', 'Resume link').click();
    cy.tid('chat-admin-pause-banner').should('not.exist');
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(DM).find('[data-testid=chat-tag-paused]').should('not.exist');
    cy.chatRow(DM).find('button.ch-row').click();
    cy.tid('chat-box').should('not.be.disabled');
    cy.tid('chat-record').should(($r) => expect([...$r].map((r) => r.textContent)).to.satisfy((t) => t.some((x) => x.includes('paused this link')) && t.some((x) => x.includes('resumed this link'))));
  });

  it('lets an Admin pause a group, and Ed sees the tag and banner and cannot resume it', () => {
    asAdminReading();
    cy.chatRow(GROUP).find('button.ch-row').click();
    openMenu(GROUP).contains('[role=menuitem]', 'Pause every agent in Ed\'s group').click();
    cy.tid('chat-admin-pause-banner').should('contain.text', 'You paused every agent in this group. Messages are held until you resume it from its menu.');
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(GROUP).find('[data-testid=chat-tag-paused]').should('contain.text', 'Paused by an Admin');
    cy.chatRow(GROUP).find('button.ch-row').click();
    cy.tid('chat-admin-pause-banner').should('contain.text', `${READ_AS} paused every agent in this group.`).and('contain.text', 'Only an Admin can resume it.');
    cy.tid('chat-box').should('be.disabled');
    openMenu(GROUP).contains('[role=menuitem]', 'Resume every agent in the group').should('have.attr', 'aria-disabled', 'true').and('contain.text', 'Only an Admin can resume it.');
    cy.focused().type('{esc}');
    asAdminReading();
    cy.chatRow(GROUP).find('button.ch-row').click();
    openMenu(GROUP).contains('[role=menuitem]', 'Resume every agent in Ed\'s group').click();
    cy.tid('chat-admin-pause-banner').should('not.exist');
  });

  it('lets an Admin disconnect a group and reconnect it, and remove all its messages after a confirmation, leaving the records', () => {
    asAdminReading();
    cy.chatRow(GROUP).find('button.ch-row').click();
    openMenu(GROUP).contains('[role=menuitem]', 'Disconnect every agent in Ed\'s group').click();
    openMenu(GROUP).contains('[role=menuitem]', 'Reconnect every agent in Ed\'s group').click();
    openMenu(GROUP).contains('[role=menuitem]', 'Disconnect every agent in Ed\'s group');
    cy.focused().type('{esc}');
    // Both stay on the thread as record lines, which Ed sees too (checked below with the other records).
    cy.tid('chat-record').should(($r) => expect([...$r].map((r) => r.textContent)).to.satisfy((t) => t.some((x) => x.includes(`${READ_AS} disconnected the agents in this group on `)) && t.some((x) => x.includes(`${READ_AS} reconnected the agents in this group on `))));
    cy.tid('chat-message').should('have.length', 1);
    openMenu(GROUP).contains('[role=menuitem]', 'Remove all messages…').click();
    cy.tid('chat-confirm').should('contain.text', 'Remove all 1 messages in My group?');
    cy.tid('chat-confirm').contains('button', 'Keep them').click();
    cy.tid('chat-message').should('have.length', 1);
    openMenu(GROUP).contains('[role=menuitem]', 'Remove all messages…').click();
    cy.tid('chat-confirm').contains('button', 'Remove all messages').click();
    cy.tid('chat-message').should('have.length', 0);
    // What the Admin did stays on the thread for good, and Ed sees it too.
    cy.tid('chat-record').should(($r) => expect([...$r].map((r) => r.textContent)).to.satisfy((t) => t.some((x) => x.includes(`${READ_AS} removed all messages on `))));
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(GROUP).find('button.ch-row').click();
    cy.tid('chat-message').should('have.length', 0);
    cy.tid('chat-record').should(($r) => expect([...$r].map((r) => r.textContent)).to.satisfy((t) => t.some((x) => x.includes(`${READ_AS} removed all messages on `))));
    cy.tid('chat-record').should(($r) => expect([...$r].map((r) => r.textContent)).to.satisfy((t) => t.some((x) => x.includes('disconnected the agents in this group')) && t.some((x) => x.includes('reconnected the agents in this group'))));
  });
});
