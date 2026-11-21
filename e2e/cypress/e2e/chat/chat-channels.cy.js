// SPEC 8.1 Chat page (#1035), public channels beside General and My group: the New channel form (name, description, an optional link to an issue, a milestone or a project) and its
// refusals (a name in use, a link in use, an issue typed "#12" or "12" being one link, a bad name, a link with nothing named, the 50 channels the server keeps), the description
// and the link chip on the thread, Edit description… for the opener and an Admin only, a second person and an agent reading and posting in a channel, an Admin's read raising no
// notice and writing no record, nothing from My group or a Direct Message reaching a channel, an Admin removing a channel after a confirmation, the New direct message form (an
// own agent, another person's agent waiting for its owner), a description shown as the text it is, and the sidebar's wider column.
// The callout a channel's opener is shown in the terminal when an Admin edits or removes their channel is the reporter's and is not in the console (docs/e2e/COVERAGE.md).
// Order: in each describe the tests run in order on one server, and a later one reads what an earlier one left (named where it matters); each describe resets the server once, in `before`.
import { personDmRow, seeded } from '../../../support/commands';

const H = { 'X-Podium-Respond': '1' };
const API = '/api/fleet/respond/chat';
const CH = 'release-1-7';
const CH_ROW = `c:${CH}`;
const DESC = 'Everything for the 1.7 release: blockers, the cut, the notes.';
const INVOICE = 'e2e-s-invoice';
const GROUP = 'c:group';
const MARK = 'only-in-my-group-4f1c';
const DM_MARK = 'only-in-a-dm-9b2e';

const openMenu = (row) => {
  cy.chatRow(row).find('button.ch-more').click();
  return cy.tid('chat-menu').should('be.visible');
};
const item = (label) => cy.tid('chat-menu').contains('[role=menuitem]', label);
const edToken = () => ({ 'X-Podium-Token': seeded().people.Ed.token });
/** A request as the signed-in browser's person; failOnStatusCode is off so a refusal can be read. */
const call = (method, url, body) => cy.request({ method, url: `${API}${url}`, headers: H, body, failOnStatusCode: false, log: false });
const create = (name, description, link) => call('POST', '/channels', { name, description, link });
/** Fills the New channel form: `link` is [kind, ref] or null. */
const fillChannel = (name, desc, link) => {
  cy.tid('channel-form').within(() => {
    if (name) cy.contains('label', /^\s*Name/).find('input').type(name);
    if (desc) cy.contains('label', /^\s*Description/).find('textarea').type(desc);
    if (link) {
      cy.contains('label', /^\s*About/).find('select').select(link[0]);
      cy.contains('label', /^\s*Which one/).find('input').type(link[1]);
    }
  });
};
const openNewChannel = () => {
  cy.get('nav[aria-label=Chat] button[aria-label="New channel"]').click();
  cy.get('[role=dialog]').should('be.visible').and('contain.text', 'New channel');
};
const openChat = (who) => {
  cy.signIn(who);
  cy.openConsole('#/chat');
  cy.chatRow('c:general').should('exist');
};

describe('chat: public channels', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('opens a channel from New channel with a description and an issue, and selects it', () => {
    openChat('Ed');
    cy.get('nav[aria-label=Chat] button[aria-label="New channel"]').should('not.be.disabled');
    openNewChannel();
    cy.get('[role=dialog]').should('contain.text', 'Every person and Admin signed in to this server can read and post in a channel, and so can an orchestrator for the hour after an @ calls it in.');
    fillChannel(CH, DESC, ['Issue', '#12']);
    cy.contains('[role=dialog] button', 'Create channel').click();
    cy.get('[role=dialog]').should('not.exist');
    cy.get('#th-h').should('contain.text', CH);
    cy.tid('chat-link-chip').should('have.text', 'Issue #12');
    cy.tid('chat-desc').should('have.text', DESC);
    cy.chatRow(CH_ROW).should('contain.text', CH).and('contain.text', DESC);
    cy.chatRow(CH_ROW).find('button.ch-row').should('have.attr', 'aria-current', 'true');
    cy.contains('[role=status]', `Channel ${CH} created.`);
    cy.contains('Opened by Ed');
    cy.contains('Every person and Admin signed in to this server can read and post here. An orchestrator reads or posts here only when an @ called it in during the last hour, and sees at most that hour.');
    // The channel stays in the list across a reload, with General above it.
    cy.reload();
    cy.chatRow(CH_ROW).should('contain.text', DESC);
  });

  it('refuses a name in use, a link in use, a bad name and an unfinished link, and keeps the form open with the reason', () => {
    openChat('Ed');
    openNewChannel();
    cy.contains('[role=dialog] button', 'Create channel').click();
    cy.tid('channel-form-error').should('have.text', 'Name the channel.');
    fillChannel('Bad_Name');
    cy.contains('label', /^\s*Name/).find('input').should('have.value', 'bad_name');
    cy.contains('[role=dialog] button', 'Create channel').click();
    cy.tid('channel-form-error').should('contain.text', 'A name has lowercase letters, numbers and hyphens only');
    cy.contains('label', /^\s*Name/).find('input').clear().type(CH);
    cy.contains('[role=dialog] button', 'Create channel').click();
    cy.tid('channel-form-error').should('contain.text', `There is already a channel called ${CH}.`);
    cy.contains('label', /^\s*Name/).find('input').clear().type('another');
    cy.contains('label', /^\s*About/).find('select').select('Issue');
    cy.contains('[role=dialog] button', 'Create channel').click();
    cy.tid('channel-form-error').should('have.text', 'Say which issue it is about, or choose Nothing.');
    // "12" is the same issue as "#12" (the server keeps the number without its #).
    cy.contains('label', /^\s*Which one/).find('input').type('12');
    cy.contains('[role=dialog] button', 'Create channel').click();
    cy.tid('channel-form-error').should('contain.text', 'There is already a channel for issue').and('contain.text', CH);
    cy.get('[role=dialog]').should('exist');
    cy.contains('[role=dialog] button', 'Cancel').click();
    cy.get('[role=dialog]').should('not.exist');
    cy.chatRow('c:another').should('not.exist');
  });

  it('answers the same refusals from the route, and takes a milestone and a project as links', () => {
    cy.signIn('Ed');
    create(CH, '', null).then((r) => {
      expect(r.status).to.eq(409);
      expect(r.body.reason).to.eq('name-taken');
    });
    create('via-api-a', '', { kind: 'issue', ref: '12' }).then((r) => {
      expect(r.status).to.eq(409);
      expect(r.body.reason).to.eq('link-taken');
    });
    create('via-api-b', '', { kind: 'issue', ref: '#12' }).its('status').should('eq', 409);
    create('Not Valid', '', null).its('status').should('eq', 422);
    create('via-api-c', '', { kind: 'milestone', ref: 'v1.7' }).its('status').should('eq', 201);
    create('via-api-d', '', { kind: 'project', ref: 'podium' }).its('status').should('eq', 201);
    create('via-api-e', '', { kind: 'milestone', ref: 'v1.7' }).its('status').should('eq', 409);
    cy.request({ method: 'POST', url: `${API}/channels`, headers: H, body: { name: 'bad-link', link: { kind: 'issue' } }, failOnStatusCode: false, log: false }).its('status').should('eq', 400);
    cy.openConsole('#/chat');
    cy.chatRow('c:via-api-c').find('button.ch-row').click();
    cy.tid('chat-link-chip').should('have.text', 'Milestone v1.7');
    cy.chatRow('c:via-api-d').find('button.ch-row').click();
    cy.tid('chat-link-chip').should('have.text', 'Project podium');
    // A channel with no description says so in the list and shows no description line on the thread.
    cy.chatRow('c:via-api-d').should('contain.text', 'No description yet.');
    cy.tid('chat-desc').should('not.exist');
  });

  it('lets the opener change the description, shows it as text and not as markup, and gives another person no such item', () => {
    openChat('Ed');
    cy.chatRow(CH_ROW).find('button.ch-row').click();
    openMenu(CH_ROW);
    item('Edit description…').click();
    cy.get('[role=dialog]').should('contain.text', 'Edit description');
    cy.contains('[role=dialog] label', /^\s*Name/).find('input').should('be.disabled').and('have.value', CH);
    cy.get('[role=dialog]').should('contain.text', 'Linked to Issue #12. The link cannot be changed.');
    cy.contains('[role=dialog] label', /^\s*Description/).find('textarea').should('have.value', DESC).clear().type('<b>bold</b> & <i>x</i> "quoted"');
    cy.contains('[role=dialog]', 'of 280');
    cy.contains('[role=dialog] button', 'Save description').click();
    cy.get('[role=dialog]').should('not.exist');
    cy.contains('[role=status]', 'Description saved.');
    cy.tid('chat-desc').should('have.text', '<b>bold</b> & <i>x</i> "quoted"');
    cy.tid('chat-desc').find('b, i').should('not.exist');
    cy.chatRow(CH_ROW).find('.sub').should('contain.text', '<b>bold</b>');
    cy.chatRow(CH_ROW).find('.sub b').should('not.exist');
    // Alex did not open it: the menu has no Edit description… and the route refuses.
    cy.signIn('Alex');
    call('PATCH', `/channels/${CH}`, { description: 'taken over' }).then((r) => {
      expect(r.status).to.eq(403);
      expect(r.body.error).to.contain('Only Ed or an Admin can change the description');
    });
    cy.openConsole('#/chat');
    cy.chatRow(CH_ROW).should('exist');
    openMenu(CH_ROW);
    cy.tid('chat-menu').should('not.contain.text', 'Edit description…').and('not.contain.text', 'Remove channel…');
    cy.tid('chat-menu').should('contain.text', 'Only an Admin can pause');
    cy.get('body').type('{esc}');
    cy.tid('chat-desc').should('not.exist');
    cy.chatRow(CH_ROW).find('button.ch-row').click();
    cy.tid('chat-desc').should('have.text', '<b>bold</b> & <i>x</i> "quoted"');
    // General has no description to change.
    call('PATCH', '/channels/general', { description: 'x' }).its('status').should('eq', 403);
    call('DELETE', '/channels/general').its('status').should('eq', 403);
  });

  it('lets an agent read and post in a channel only after an @ called it in, as in General, and shows a second person the post', () => {
    const NOT_CALLED = 'You were not called into this channel in the last hour.';
    const agent = (method, channel, body) => cy.request({ method, url: `/api/fleet/sessions/${INVOICE}/chat/channels${channel}`, headers: edToken(), body, failOnStatusCode: false, log: false });
    cy.signIn('Ed');
    // The list of channels needs no call-in: General and every public channel, never My group.
    agent('GET', '').then((r) => {
      expect(r.status).to.eq(200);
      const names = r.body.channels.map((c) => c.name);
      expect(names).to.include.members(['general', CH]);
      expect(names).not.to.include('group');
      const mine = r.body.channels.find((c) => c.name === CH);
      expect(mine.link).to.deep.eq({ kind: 'issue', ref: '12' });
      expect(mine.openedBy).to.eq('Ed');
    });
    // Not called in: neither a read nor a post, and the refusal says why.
    agent('GET', `/${CH}/messages`).then((r) => {
      expect(r.status).to.eq(403);
      expect(r.body.error).to.eq(NOT_CALLED);
    });
    agent('POST', `/${CH}/messages`, { text: 'uninvited' }).then((r) => {
      expect(r.status).to.eq(403);
      expect(r.body.error).to.eq(NOT_CALLED);
    });
    agent('POST', '/no-such-channel/messages', { text: 'hello' }).its('status').should('eq', 404);
    // Ed calls it in with an @ (his own agent: no approval is waited for).
    call('POST', `/channels/${CH}/messages`, { text: '@invoice-v2@ed-mbp what blocks the cut?' }).its('status').should('eq', 201);
    agent('GET', `/${CH}/messages`).then((r) => {
      expect(r.status).to.eq(200);
      expect(r.body.messages.map((m) => m.text)).to.deep.eq(['@invoice-v2@ed-mbp what blocks the cut?']);
      expect(r.body.older).to.eq(null);
    });
    agent('POST', `/${CH}/messages`, { text: 'blockers: none from invoice-v2' }).its('status').should('eq', 201);
    // A call into one channel is no call into another.
    agent('GET', '/via-api-c/messages').then((r) => {
      expect(r.status).to.eq(403);
      expect(r.body.error).to.eq(NOT_CALLED);
    });
    agent('POST', '/via-api-c/messages', { text: 'uninvited' }).its('status').should('eq', 403);
    openChat('Alex');
    cy.chatRow(CH_ROW).find('.unread').should('exist');
    cy.chatRow(CH_ROW).find('button.ch-row').click();
    cy.tid('chat-message').should('have.length', 2).last().should('contain.text', 'blockers: none from invoice-v2').and('contain.text', 'orchestrator of Ed');
    cy.tid('chat-box').type('Alex here: the cut is tomorrow.{enter}');
    cy.tid('chat-message').should('have.length', 3).last().should('contain.text', 'Alex here: the cut is tomorrow.');
    cy.chatRow(CH_ROW).find('.unread').should('not.exist');
    // The agent now reads the hour, all three, with nothing older behind.
    cy.signIn('Ed');
    agent('GET', `/${CH}/messages`).then((r) => {
      expect(r.body.messages.map((m) => m.text)).to.deep.eq(['@invoice-v2@ed-mbp what blocks the cut?', 'blockers: none from invoice-v2', 'Alex here: the cut is tomorrow.']);
      expect(r.body.older).to.eq(null);
    });
    cy.openConsole('#/chat');
    cy.chatRow(CH_ROW).find('.unread').should('exist');
    cy.chatRow(CH_ROW).find('button.ch-row').click();
    cy.tid('chat-message').should('have.length', 3).last().should('contain.text', 'Alex here: the cut is tomorrow.');
  });

  it('opens a Direct Message from New direct message to one of the person\'s own agents, and filters the list as they type', () => {
    openChat('Ed');
    // Its accessible name is its visible text: an aria-label that does not contain it fails axe's label-content-name-mismatch.
    cy.get('nav[aria-label=Chat] h2#sec-dm button[aria-label="New direct message"]').should('have.attr', 'aria-haspopup', 'dialog');
    cy.get('nav[aria-label=Chat] h2#sec-dm button[aria-label="New direct message"]').click();
    cy.get('[role=dialog]').should('contain.text', 'New direct message').and('contain.text', 'Between people only, a direct message is read by them alone and an Admin cannot read it.');
    cy.tid('dm-form').contains('h3', 'Your agents');
    cy.tid('dm-form').contains('label', 'invoice-v2').should('contain.text', 'Your orchestrator');
    // Alex's agents are not offered to Ed (its reporter does not take part in messaging), so there is no second group.
    cy.tid('dm-form').contains('h3', 'Other people\'s agents').should('not.exist');
    // Nothing chosen and nothing written are refused where they are.
    cy.contains('[role=dialog] button', 'Send message').click();
    cy.tid('dm-form-error').should('have.text', 'Choose at least one person or agent.');
    cy.contains('label', /^\s*Find a person or an agent/).find('input').type('zzzz');
    cy.tid('dm-form').contains('No person or agent matches that.');
    cy.contains('label', /^\s*Find a person or an agent/).find('input').clear().type('invoice');
    cy.tid('dm-form').find('input[type=checkbox]').should('have.length', 1);
    cy.tid('dm-form').contains('label', 'invoice-v2').find('input[type=checkbox]').check();
    cy.contains('[role=dialog] button', 'Send message').click();
    cy.tid('dm-form-error').should('have.text', 'Write the first message.');
    cy.tid('dm-form').find('textarea').type(`Hello from the form ${DM_MARK}`);
    cy.contains('[role=dialog] button', 'Send message').click();
    cy.get('[role=dialog]').should('not.exist');
    cy.get('#th-h').should('have.text', 'invoice-v2');
    cy.tid('chat-message').should('have.length', 1).first().should('contain.text', `Hello from the form ${DM_MARK}`);
    cy.chatRow(personDmRow(INVOICE, 'Ed')).should('exist');
    cy.contains('[role=status]', 'Sent to invoice-v2.');
  });

  it('lists another person\'s agent disabled in New direct message, and a message to it by the route waits for that person\'s approval', () => {
    openChat('Alex');
    cy.get('nav[aria-label=Chat] h2#sec-dm button[aria-label="New direct message"]').click();
    cy.tid('dm-form').contains('h3', 'Other people\'s agents');
    cy.tid('dm-form').contains('h3', 'Your agents');
    cy.tid('dm-form').contains('label', 'invoice-v2').should('contain.text', 'Ed').and('contain.text', 'Adding another person\'s agent is not available yet.').find('input[type=checkbox]').should('be.disabled');
    cy.get('[role=dialog] button[aria-label="Close (Esc)"]').click();
    cy.get('[role=dialog]').should('not.exist');
    // The dialog does not add it yet (#1278); the route that waits for the owner is unchanged, and the row and Ed's notice show it.
    call('POST', `/dm/me/${INVOICE}/messages`, { text: 'Please run the unit tests on invoice-v2.' }).its('status').should('eq', 202);
    cy.chatRow(personDmRow(INVOICE, 'Alex')).should('contain.text', 'Waiting for approval').find('button.ch-row').click();
    cy.tid('chat-message').should('have.length', 1).first().should('contain.text', 'Waiting for Ed to approve it.');
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.contains('a.ch-notice', '1 message from another person waits for your approval in My reporters.');
  });

  it('keeps My group and Direct Message text out of every channel, for a person, an agent and the route', () => {
    cy.signIn('Ed');
    call('POST', '/channels/group/messages', { text: MARK }).its('status').should('eq', 201);
    for (const body of [
      call('GET', `/channels/${CH}/messages?limit=100`),
      call('GET', '/channels/general/messages?limit=100'),
    ]) body.its('body').should((b) => expect(JSON.stringify(b)).not.to.contain(MARK).and.not.to.contain(DM_MARK));
    cy.request({ url: `/api/fleet/sessions/${INVOICE}/chat/channels/${CH}/messages`, headers: edToken(), log: false }).its('body').should((b) => expect(JSON.stringify(b)).not.to.contain(MARK).and.not.to.contain(DM_MARK));
    cy.request({ url: `/api/fleet/sessions/${INVOICE}/chat/channels`, headers: edToken(), log: false }).its('body').should((b) => expect(JSON.stringify(b)).not.to.contain(MARK));
    cy.signIn('Alex');
    call('GET', `/channels/${CH}/messages?limit=100`).its('body').should((b) => expect(JSON.stringify(b)).not.to.contain(MARK).and.not.to.contain(DM_MARK));
    cy.openConsole('#/chat');
    cy.chatRow(CH_ROW).find('button.ch-row').click();
    cy.tid('chat-message').should('have.length', 3);
    cy.tid('chat-thread').should('not.contain.text', MARK).and('not.contain.text', DM_MARK);
    // The group note is still there, in the group.
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(GROUP).find('button.ch-row').click();
    cy.tid('chat-thread').should('contain.text', MARK);
  });

  it('raises no notice and writes no record when an Admin reads a channel, and the Admin can post in it', () => {
    cy.signIn('Admin');
    call('GET', `/channels/${CH}/messages?limit=100`).its('status').should('eq', 200);
    call('POST', `/channels/${CH}/reading`, {}).then((r) => {
      expect(r.status).to.eq(400);
      expect(r.body.error).to.contain('public, so reading it is not recorded');
    });
    cy.openConsole('#/chat');
    cy.chatRow(CH_ROW).find('button.ch-row').click();
    cy.tid('chat-message').should('have.length', 3);
    cy.tid('chat-ro-banner').should('not.exist');
    cy.tid('chat-reading-banner').should('not.exist');
    // Ed and Alex are told nothing: no reader on the channel, no record line, no banner.
    for (const who of ['Ed', 'Alex']) {
      cy.signIn(who);
      cy.request({ url: API, log: false }).its('body', { log: false }).should((b) => {
        const c = b.channels.find((x) => x.id === CH);
        expect(c.adminReading ?? []).to.have.length(0);
        expect(b.listReads ?? []).to.have.length(0);
      });
      cy.openConsole('#/chat');
      cy.chatRow(CH_ROW).find('button.ch-row').click();
      cy.tid('chat-message').should('have.length', 3);
      cy.tid('chat-reading-banner').should('not.exist');
      cy.chatRow(CH_ROW).should('not.contain.text', 'Admin reading');
    }
    // Picking a person to read as is a read of that person's own list and is told to them; a channel opened while it is picked is still public: readable, with a box, and no read-only banner.
    cy.signIn('Admin');
    cy.openConsole('#/chat');
    cy.tid('chat-read-as').select('Ed');
    cy.chatRow(CH_ROW).find('button.ch-row').click();
    cy.tid('chat-message').should('have.length', 3);
    cy.tid('chat-box').should('exist');
    cy.tid('chat-ro-banner').should('not.exist');
    cy.tid('chat-stop-reading').click();
  });

  it('lets an Admin remove a channel after a confirmation, falls back to General, and frees its link', () => {
    cy.signIn('Ed');
    // Only an Admin removes a channel.
    call('DELETE', `/channels/${CH}`).then((r) => {
      expect(r.status).to.eq(403);
      expect(r.body.error).to.eq('Only an Admin can remove a channel.');
    });
    openChat('Admin');
    cy.chatRow(CH_ROW).find('button.ch-row').click();
    cy.tid('chat-desc').should('exist');
    openMenu(CH_ROW);
    cy.tid('chat-menu').should('contain.text', 'Edit description…').and('contain.text', 'Remove channel…').and('contain.text', `Pause ${CH} for everyone`);
    item('Remove channel…').click();
    cy.tid('chat-confirm').should('contain.text', `Remove the channel ${CH}?`).and('contain.text', 'removed for everyone, and it cannot be recovered').and('contain.text', 'Ed is told that an Admin removed it.');
    cy.tid('chat-confirm').contains('button', 'Keep it').click();
    cy.tid('chat-confirm').should('not.exist');
    cy.chatRow(CH_ROW).should('exist');
    openMenu(CH_ROW);
    item('Remove channel…').click();
    cy.tid('chat-confirm').contains('button', 'Remove channel').click();
    cy.chatRow(CH_ROW).should('not.exist');
    cy.get('#th-h').should('have.text', 'General');
    cy.contains('[role=status]', 'Channel removed.');
    // Gone for everyone, agents included, and its link can be used again.
    cy.signIn('Ed');
    call('GET', `/channels/${CH}/messages`).its('status').should('eq', 404);
    cy.request({ url: `/api/fleet/sessions/${INVOICE}/chat/channels/${CH}/messages`, headers: edToken(), failOnStatusCode: false, log: false }).its('status').should('eq', 404);
    create('release-1-7-again', '', { kind: 'issue', ref: '12' }).its('status').should('eq', 201);
  });

  it('gives the sidebar a column of 300 to 360 px at the wide width', () => {
    openChat('Ed');
    cy.get('nav.ch-side').should(($n) => {
      const w = $n[0].getBoundingClientRect().width;
      expect(w).to.be.within(299, 361);
    });
  });
});

describe('chat: the 50 channels a server keeps', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('turns New channel off at 50 and says why, refuses the 51st, and turns it on when an Admin removes one', () => {
    cy.signIn('Ed');
    Cypress._.times(50, (i) => create(`fill-${i + 1}`, '', null).its('status').should('eq', 201));
    create('one-too-many', '', null).then((r) => {
      expect(r.status).to.eq(409);
      expect(r.body.reason).to.eq('limit-reached');
      expect(r.body.error).to.contain('This server has 50 channels besides General, the most it keeps.');
    });
    cy.openConsole('#/chat');
    cy.get('nav[aria-label=Chat] button[aria-label="New channel"]').should('be.disabled');
    cy.get('nav[aria-label=Chat]').contains('This server has 50 channels besides General, the most it keeps. An Admin can remove one that is no longer used.');
    cy.signIn('Admin');
    call('DELETE', '/channels/fill-50').its('status').should('eq', 200);
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.get('nav[aria-label=Chat] button[aria-label="New channel"]').should('not.be.disabled');
    cy.chatRow('c:fill-50').should('not.exist');
    create('now-it-fits', '', null).its('status').should('eq', 201);
  });
});
