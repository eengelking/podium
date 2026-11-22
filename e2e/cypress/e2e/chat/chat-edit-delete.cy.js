// SPEC 8.1 Chat page (#1269), editing and deleting your own Chat messages: the menu a right-click opens on one of your own messages (and on no one else's), the editor (Save, Cancel,
// Escape, Enter, Shift+Enter, the refusal to change who is mentioned), the confirmation before a delete and the note it leaves, the lock once Podium has sent a message to an agent (the
// menu's reason and the server's 409), the keyboard (Up from the empty box, Up and Down among your own messages, E, Delete, Escape one level at a time), a Direct Message that waits for
// another person's approval (changeable) and one already sent to your own agent (locked), a second console seeing an edit and a delete live, also on an earlier page, and who may change
// what (another person, the admin secret).
// Order: in each describe the tests run in order on one server, and a later one reads what an earlier one left (named where it matters); each describe resets the server once, in `before`.

import { personDmRow, personKey } from '../../../support/commands';

const API = '/api/fleet/respond/chat';
const H = { 'X-Podium-Respond': '1' };
const GROUP = 'c:group';
const GENERAL = 'c:general';
const INVOICE = 'e2e-s-invoice';
const AGENT_ROW = () => personDmRow(INVOICE, 'Alex');
const OWN_ROW = () => personDmRow(INVOICE, 'Ed');
const REQUEST = '[role=group][aria-label="A person\'s message waiting for approval"]';
const LOCKED = 'Podium has already sent this message to invoice-v2, so it can no longer be changed.';
const NO_MENTIONS = 'To change who is mentioned, delete this message and send a new one.';

/** A person posts or changes something from Node, as a second browser would (it signs in on its own, so the page's cookie is never touched). Yields { status, body }. */
const as = (who, method, path, body) => cy.task('respond:as', { as: who, method, path, body }, { log: false });
const say = (who, channel, text) => as(who, 'POST', `/chat/channels/${channel}/messages`, { text }).its('status', { log: false }).should('eq', 201);
/** The agent's own post, with its owner's token (it must have been called into the channel by an @ first). */
const agentSays = (channel, text) => cy.task('mod:post', { who: 'Ed', path: `/sessions/${INVOICE}/chat/channels/${channel}/messages`, body: { text } }, { log: false }).its('status', { log: false }).should('eq', 201);

/** One message of the open thread, by a piece of its text. */
const msg = (text) => cy.contains('[data-testid=chat-message]', text);
const rightClick = (text) => msg(text).find('.ch-tx').rightclick();
const menuItem = (name) => cy.tid('chat-menu').contains('[role=menuitem]', name);
const choose = (text, name) => {
  rightClick(text);
  menuItem(name).click();
};
const editor = () => cy.get('textarea[aria-label="Edit your message"]');
const save = () => cy.tid('chat-edit').contains('button', /^Save$/).click();
const dialog = () => cy.get('[role=alertdialog]');
const open = (row, as_ = 'Ed') => {
  cy.signIn(as_);
  cy.openConsole('#/chat');
  cy.chatRow(row).find('button.ch-row').click();
};
/** The id of a message in a channel as the signed-in browser reads it, found by a piece of its text. Read once: the call follows a step the spec already waited for. */
const idIn = (channel, text) =>
  cy.request({ url: `${API}/channels/${channel}/messages?limit=100`, log: false }).its('body.messages', { log: false }).then((ms) => {
    const m = ms.find((x) => x.text.includes(text));
    expect(m, `a message with "${text}"`).to.exist;
    return m.id;
  });
const watchChanges = () => {
  cy.intercept('PATCH', '**/messages/*').as('edit');
  cy.intercept('DELETE', '**/messages/*').as('delete');
};

describe('chat: edit and delete your own messages in My group', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('is set up: Ed has changeable notes, one sent to his agent and an agent reply in My group, and General has others\' messages', () => {
    // A change counts as a message against the per-minute limit, which a few quick posts and edits would reach.
    cy.putSettings({ chat: { perMinute: 600 } });
    // The order below is the order the thread shows.
    say('Ed', 'group', 'Alpha: first note.');
    say('Ed', 'group', 'Bravo: second note.');
    say('Ed', 'group', 'Charlie: third note.');
    say('Ed', 'group', '@invoice-v2@ed-mbp Locked: review the plan.');
    agentSays('group', 'Reply from the agent in My group.');
    say('Ed', 'group', 'Delta: fourth note.');
    say('Alex', 'general', 'Alex says hello in General.');
    say('Ed', 'general', '@invoice-v2@ed-mbp are you there?');
    agentSays('general', 'Agent reply in General.');
  });

  it('opens a menu with Edit message and Delete message on a right-click of your own message, with no "..." button on the row, and on no one else\'s', () => {
    open(GROUP);
    msg('Alpha: first note.').find('button').should('not.exist');
    rightClick('Alpha: first note.');
    cy.tid('chat-menu').should('be.visible').and('have.attr', 'role', 'menu').and('have.attr', 'aria-label', 'Your message');
    cy.tid('chat-menu').find('[role=menuitem]').should('have.length', 2);
    menuItem(/^Edit message/).should('not.have.attr', 'aria-disabled');
    menuItem(/^Delete message/).should('not.have.attr', 'aria-disabled');
    cy.tid('chat-menu').find('.why').should('not.exist');
    // The marked row keeps its text size and its bubble (#1326): no general `.podium .sel` rule shrinks it. jsdom loads no CSS, so this is read here.
    msg('Alpha: first note.').should('have.class', 'ch-sel').find('.ch-tx').should('have.css', 'font-size', '15px').and('have.css', 'border-top-width', '0px');
    cy.focused().should('have.attr', 'role', 'menuitem').and('contain.text', 'Edit message');
    cy.focused().type('{esc}');
    cy.tid('chat-menu').should('not.exist');
    // Another person's message and an agent's have no such menu, and neither has the agent's reply in My group.
    rightClick('Reply from the agent in My group.');
    cy.tid('chat-menu').should('not.exist');
    cy.chatRow(GENERAL).find('button.ch-row').click();
    msg('Alex says hello in General.').find('button.ch-more, .ch-more').should('not.exist');
    rightClick('Alex says hello in General.');
    cy.tid('chat-menu').should('not.exist');
    rightClick('Agent reply in General.');
    cy.tid('chat-menu').should('not.exist');
    msg('Alex says hello in General.').find('.ch-tx').should('be.visible');
  });

  it('edits a message: the editor holds the text with Save and Cancel, and Save shows the new text with an "edited" time', () => {
    watchChanges();
    open(GROUP);
    choose('Alpha: first note.', /^Edit message/);
    cy.tid('chat-edit').should('be.visible');
    editor().should('have.value', 'Alpha: first note.').and('have.focus');
    cy.tid('chat-edit').contains('button', /^Cancel$/);
    cy.tid('chat-edit').contains('button', /^Save$/);
    editor().clear().type('Alpha: first note, changed.');
    save();
    cy.wait('@edit').its('response.statusCode').should('eq', 200);
    cy.tid('chat-edit').should('not.exist');
    msg('Alpha: first note, changed.').find('.ed-edited').should(($e) => expect($e.text()).to.match(/^edited \d{2}:\d{2}$/));
    msg('Alpha: first note, changed.').find('.ed-edited').should('have.attr', 'title');
    // The stored text is the new one, read again from the server.
    idIn('group', 'Alpha: first note, changed.');
  });

  it('leaves the text as it was on Cancel and on Escape, and saves on Enter without opening the menu, and adds a line on Shift+Enter', () => {
    watchChanges();
    open(GROUP);
    choose('Bravo: second note.', /^Edit message/);
    editor().type(' extra');
    cy.tid('chat-edit').contains('button', /^Cancel$/).click();
    cy.tid('chat-edit').should('not.exist');
    msg('Bravo: second note.').should('not.contain.text', 'extra').find('.ed-edited').should('not.exist');
    choose('Bravo: second note.', /^Edit message/);
    editor().type(' extra{esc}');
    cy.tid('chat-edit').should('not.exist');
    msg('Bravo: second note.').should('not.contain.text', 'extra').find('.ed-edited').should('not.exist');
    // Enter saves.
    choose('Bravo: second note.', /^Edit message/);
    editor().clear().type('Bravo: saved with Enter.{enter}');
    cy.wait('@edit').its('response.statusCode').should('eq', 200);
    cy.tid('chat-edit').should('not.exist');
    msg('Bravo: saved with Enter.').find('.ed-edited').should('exist');
    // The message takes the focus back, and the Enter that saved did not open its menu.
    cy.focused().should('have.attr', 'data-testid', 'chat-message').and('contain.text', 'Bravo: saved with Enter.');
    cy.tid('chat-menu').should('not.exist');
    // Shift+Enter adds a line and the editor stays open; Save then keeps both lines.
    choose('Charlie: third note.', /^Edit message/);
    editor().type('{shift}{enter}second line');
    cy.tid('chat-edit').should('exist');
    editor().should(($t) => expect($t.val()).to.eq('Charlie: third note.\nsecond line'));
    save();
    cy.wait('@edit').its('response.statusCode').should('eq', 200);
    msg('Charlie: third note.').should('contain.text', 'second line').find('.ed-edited').should('exist');
  });

  it('refuses an edit that adds an @ mention in the editor\'s own words and keeps the editor open', () => {
    watchChanges();
    open(GROUP);
    choose('Delta: fourth note.', /^Edit message/);
    editor().type(' @Tester@ci-runner-01');
    save();
    cy.wait('@edit').its('response.statusCode').should('eq', 422);
    cy.tid('chat-edit').should('exist').find('[role=alert]').should('contain.text', NO_MENTIONS);
    editor().should('exist').and('contain.value', '@Tester@ci-runner-01');
    editor().type('{esc}');
    cy.tid('chat-edit').should('not.exist');
    msg('Delta: fourth note.').should('not.contain.text', 'Tester').find('.ed-edited').should('not.exist');
  });

  it('locks a message that mentions an agent already sent it: both items disabled with the reason, and the server answers 409 locked', () => {
    watchChanges();
    open(GROUP);
    rightClick('Locked: review the plan.');
    cy.tid('chat-menu').should('be.visible');
    menuItem(/^Edit message/).should('have.attr', 'aria-disabled', 'true');
    menuItem(/^Delete message/).should('have.attr', 'aria-disabled', 'true');
    cy.tid('chat-menu').find('.why').should('have.text', LOCKED);
    // Choosing a disabled item changes nothing and leaves the menu open.
    menuItem(/^Edit message/).click();
    menuItem(/^Delete message/).click();
    cy.tid('chat-menu').should('be.visible');
    cy.tid('chat-edit').should('not.exist');
    dialog().should('not.exist');
    cy.focused().type('{esc}');
    cy.tid('chat-menu').should('not.exist');
    idIn('group', 'Locked: review the plan.').then((id) => {
      cy.request({ method: 'PATCH', url: `${API}/channels/group/messages/${id}`, headers: H, body: { text: 'Locked: changed.' }, failOnStatusCode: false, log: false }).then((r) => {
        expect(r.status).to.eq(409);
        expect(r.body.reason).to.eq('locked');
        expect(r.body.error).to.eq(LOCKED);
      });
      cy.request({ method: 'DELETE', url: `${API}/channels/group/messages/${id}`, headers: H, failOnStatusCode: false, log: false }).then((r) => {
        expect(r.status).to.eq(409);
        expect(r.body.reason).to.eq('locked');
      });
    });
    msg('Locked: review the plan.').should('not.contain.text', 'changed').find('.ed-edited').should('not.exist');
  });

  it('walks the keyboard: Up from the empty box, Up and Down among your own messages only, E, Delete, arrows in the confirmation and Escape one level at a time', () => {
    open(GROUP);
    cy.tid('chat-message').should('have.length', 6);
    // Your own messages in order are Alpha, Bravo, Charlie, Locked and Delta: the agent's reply between them is skipped.
    cy.tid('chat-box').should('have.value', '').type('{uparrow}');
    cy.focused().should('have.attr', 'data-testid', 'chat-message').and('contain.text', 'Delta: fourth note.');
    cy.tid('chat-msg-said').should('contain.text', 'Your message').and('contain.text', 'Delta: fourth note').and('contain.text', 'Press E to edit or Delete to delete.');
    for (const t of ['Locked: review the plan.', 'Charlie: third note.', 'Bravo: saved with Enter.', 'Alpha: first note, changed.']) {
      cy.focused().type('{uparrow}');
      cy.focused().should('have.attr', 'data-testid', 'chat-message').and('contain.text', t);
    }
    // Down goes the other way, past the agent's reply, and the last message's Down returns to the box.
    for (const t of ['Bravo: saved with Enter.', 'Charlie: third note.', 'Locked: review the plan.']) {
      cy.focused().type('{downarrow}');
      cy.focused().should('contain.text', t);
    }
    // On a locked message E and Delete say why and change nothing.
    cy.focused().type('e');
    cy.tid('chat-msg-said').should('have.text', LOCKED);
    cy.tid('chat-edit').should('not.exist');
    cy.focused().type('{del}');
    dialog().should('not.exist');
    cy.focused().type('{downarrow}');
    cy.focused().should('contain.text', 'Delta: fourth note.');
    cy.focused().type('{downarrow}');
    cy.tid('chat-box').should('have.focus');
    // E opens the editor, and Escape steps back to the message, and Escape again to the box.
    cy.tid('chat-box').type('{uparrow}');
    cy.focused().type('{uparrow}{uparrow}{uparrow}');
    cy.focused().should('contain.text', 'Bravo: saved with Enter.');
    cy.focused().type('e');
    cy.tid('chat-edit').should('be.visible');
    editor().should('have.focus').type('{esc}');
    cy.tid('chat-edit').should('not.exist');
    cy.focused().should('have.attr', 'data-testid', 'chat-message').and('contain.text', 'Bravo: saved with Enter.');
    // Delete opens the confirmation with Cancel first; the arrow keys move between its two buttons; Escape closes it with the message focused.
    cy.focused().type('{del}');
    dialog().should('contain.text', 'Delete this message?');
    dialog().contains('button', /^Cancel$/).should('have.focus');
    cy.focused().type('{rightarrow}');
    dialog().contains('button', /^Delete message$/).should('have.focus');
    cy.focused().type('{leftarrow}');
    dialog().contains('button', /^Cancel$/).should('have.focus');
    cy.focused().type('{downarrow}');
    dialog().contains('button', /^Delete message$/).should('have.focus');
    cy.focused().type('{uparrow}');
    dialog().contains('button', /^Cancel$/).should('have.focus');
    cy.focused().type('{esc}');
    dialog().should('not.exist');
    cy.focused().should('have.attr', 'data-testid', 'chat-message').and('contain.text', 'Bravo: saved with Enter.');
    // Backspace opens it too; Cancel leaves the message.
    cy.focused().type('{backspace}');
    dialog().should('exist');
    dialog().contains('button', /^Cancel$/).click();
    dialog().should('not.exist');
    msg('Bravo: saved with Enter.').find('.ed-del').should('not.exist');
    // Enter on a message opens its menu, Escape closes it, and a last Escape goes back to the box.
    cy.focused().type('{enter}');
    cy.tid('chat-menu').should('be.visible');
    cy.focused().type('{esc}');
    cy.tid('chat-menu').should('not.exist');
    cy.focused().should('have.attr', 'data-testid', 'chat-message');
    cy.focused().type('{esc}');
    cy.tid('chat-box').should('have.focus');
  });

  it('deletes a message after a confirmation that quotes it and says who loses it, and leaves a note in its place', () => {
    watchChanges();
    open(GROUP);
    idIn('group', 'Charlie: third note.').then((id) => {
      choose('Charlie: third note.', /^Delete message/);
      dialog().should('be.visible').and('contain.text', 'Delete this message?').and('contain.text', 'It will be deleted for everyone in My group, and the agents there will not see it. This cannot be undone.');
      dialog().find('.ed-q').should('contain.text', 'Charlie: third note.');
      dialog().contains('button', /^Cancel$/).should('have.focus').click();
      dialog().should('not.exist');
      msg('Charlie: third note.').should('exist');
      choose('Charlie: third note.', /^Delete message/);
      dialog().should('be.visible');
      cy.focused().type('{esc}');
      dialog().should('not.exist');
      msg('Charlie: third note.').find('.ed-del').should('not.exist');
      choose('Charlie: third note.', /^Delete message/);
      dialog().contains('button', /^Delete message$/).click();
      cy.wait('@delete').its('response.statusCode').should('eq', 200);
      dialog().should('not.exist');
      cy.tid('chat-thread').should('not.contain.text', 'Charlie: third note.');
      cy.get('.ed-del').should('have.length', 1).first().should(($d) => expect($d.text()).to.match(/^This message was deleted by You at \d{2}:\d{2}\.$/));
      // Nothing of it is stored, and the note has no menu.
      cy.request({ url: `${API}/channels/group/messages?limit=100`, log: false }).its('body.messages', { log: false }).should((ms) => {
        const m = ms.find((x) => x.id === id);
        expect(m.text).to.eq('');
        expect(m.deletedAt).to.be.a('number');
        expect(m.canChange).to.eq(false);
      });
      cy.get('.ed-del').rightclick();
      cy.tid('chat-menu').should('not.exist');
    });
  });

  it('leaves a message to an agent that did not take it changeable, since Podium sent it nowhere', () => {
    watchChanges();
    cy.reportAgain('tester', { respond: { level: 'off', accepts: [], limits: [] } });
    open(GROUP);
    cy.tid('chat-box').type('@Tester@ci-runner-01 Held: are you there?{enter}');
    msg('Held: are you there?').should('contain.text', 'Tester@ci-runner-01');
    rightClick('Held: are you there?');
    menuItem(/^Edit message/).should('not.have.attr', 'aria-disabled');
    menuItem(/^Delete message/).should('not.have.attr', 'aria-disabled');
    menuItem(/^Edit message/).click();
    editor().clear().type('@Tester@ci-runner-01 Held: are you still there?');
    save();
    cy.wait('@edit').its('response.statusCode').should('eq', 200);
    msg('Held: are you still there?').find('.ed-edited').should('exist');
    cy.reportAgain('tester', {});
  });

  it('refuses another person and the admin secret, and leaves the message as it was', () => {
    open(GROUP);
    idIn('group', 'Bravo: saved with Enter.').then((groupId) => {
      idIn('general', 'are you there?').then((generalId) => {
        // Alex has no such message in his own group, and Ed's General message is not his to change.
        as('Alex', 'PATCH', `/chat/channels/group/messages/${groupId}`, { text: 'Alex was here' }).its('status').should('be.oneOf', [403, 404]);
        as('Alex', 'DELETE', `/chat/channels/group/messages/${groupId}`).its('status').should('be.oneOf', [403, 404]);
        as('Alex', 'PATCH', `/chat/channels/general/messages/${generalId}`, { text: 'Alex was here' }).then((r) => {
          expect(r.status).to.eq(403);
          expect(r.body.error).to.eq('Only the person who wrote a message can change it.');
        });
        as('Alex', 'DELETE', `/chat/channels/general/messages/${generalId}`).its('status').should('eq', 403);
        // The admin secret has no messages of its own.
        for (const [method, path, body] of [['PATCH', `/chat/channels/group/messages/${groupId}`, { text: 'Admin was here' }], ['DELETE', `/chat/channels/group/messages/${groupId}`], ['PATCH', `/chat/channels/general/messages/${generalId}`, { text: 'Admin was here' }], ['DELETE', `/chat/channels/general/messages/${generalId}`]]) {
          as('Admin', method, path, body).then((r) => {
            expect(r.status).to.eq(403);
            expect(r.body.error).to.eq('The admin secret has no messages of its own to change. Sign in with your own name.');
          });
        }
      });
    });
    cy.request({ url: `${API}/channels/group/messages?limit=100`, log: false }).its('body.messages', { log: false }).should((ms) => {
      const m = ms.find((x) => x.text.includes('Bravo: saved with Enter.'));
      expect(m.deletedAt).to.eq(null);
      expect(m.text).to.eq('Bravo: saved with Enter.');
    });
    cy.request({ url: `${API}/channels/general/messages?limit=100`, log: false }).its('body.messages', { log: false }).should((ms) => {
      const m = ms.find((x) => x.text.includes('are you there?'));
      expect(m.deletedAt).to.eq(null);
      expect(m.text).to.eq('@invoice-v2@ed-mbp are you there?');
    });
  });
});

describe('chat: a second console sees an edit and a delete at once', () => {
  before(() => cy.resetServer());

  it('is set up: Ed has a first message in General and fifty-five after it, so the first one is on an earlier page', () => {
    cy.putSettings({ chat: { perMinute: 600 } });
    say('Ed', 'general', 'Live target: the oldest message.');
    for (let i = 1; i <= 55; i++) say('Ed', 'general', `Live note ${String(i).padStart(2, '0')}`);
  });

  it('shows Alex an edit and a delete of Ed\'s newest message and of one on an earlier page, with no reload', () => {
    cy.signIn('Alex');
    cy.openConsole('#/chat');
    cy.tid('chat-message').should('have.length', 50);
    msg('Live note 55').should('exist');
    cy.contains('button', 'Earlier messages').click();
    msg('Live target: the oldest message.').should('exist');
    // A marker on the window: if the page reloaded it would be gone.
    cy.window().then((w) => {
      w.__e2eNoReload = true;
    });
    as('Ed', 'GET', '/chat/channels/general/messages?limit=100').then((r) => {
      const ids = (text) => r.body.messages.find((x) => x.text.includes(text)).id;
      const oldest = ids('Live target');
      const newest = ids('Live note 55');
      as('Ed', 'PATCH', `/chat/channels/general/messages/${newest}`, { text: 'Live note 55, edited by Ed' }).its('status').should('eq', 200);
      msg('Live note 55, edited by Ed').find('.ed-edited').should(($e) => expect($e.text()).to.match(/^edited \d{2}:\d{2}$/));
      as('Ed', 'PATCH', `/chat/channels/general/messages/${oldest}`, { text: 'Live target, edited by Ed' }).its('status').should('eq', 200);
      msg('Live target, edited by Ed').find('.ed-edited').should('exist');
      // Alex has no menu on it.
      rightClick('Live target, edited by Ed');
      cy.tid('chat-menu').should('not.exist');
      as('Ed', 'DELETE', `/chat/channels/general/messages/${oldest}`).its('status').should('eq', 200);
      cy.get('.ed-del').should('have.length', 1).first().should(($d) => expect($d.text()).to.match(/^This message was deleted by Ed at \d{2}:\d{2}\.$/));
      cy.tid('chat-thread').should('not.contain.text', 'Live target');
      as('Ed', 'DELETE', `/chat/channels/general/messages/${newest}`).its('status').should('eq', 200);
      cy.get('.ed-del').should('have.length', 2);
      cy.tid('chat-thread').should('not.contain.text', 'Live note 55');
    });
    cy.window().its('__e2eNoReload').should('eq', true);
  });
});

describe('chat: a Direct Message you wrote to an agent', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  const ASK = 'Please run the unit tests on invoice-v2.';

  it('can be edited while it waits for the agent\'s owner to approve it, and the owner sees the new words', () => {
    watchChanges();
    cy.signIn('Alex');
    cy.openConsole('#/chat');
    cy.chatRow(GENERAL).find('button.ch-row').click();
    cy.tid('chat-box').type(`@invoice-v2@ed-mbp ${ASK}{enter}`);
    cy.chatRow(AGENT_ROW()).should('contain.text', 'Waiting for approval');
    cy.chatRow(AGENT_ROW()).find('button.ch-row').click();
    msg(ASK).should('contain.text', 'Waiting for Ed to approve it.');
    rightClick(ASK);
    menuItem(/^Edit message/).should('not.have.attr', 'aria-disabled');
    menuItem(/^Delete message/).should('not.have.attr', 'aria-disabled');
    menuItem(/^Edit message/).click();
    editor().clear().type('Please run the unit tests and the lint on invoice-v2.{enter}');
    cy.wait('@edit').its('response.statusCode').should('eq', 200);
    msg('and the lint on invoice-v2.').find('.ed-edited').should('exist');
    msg('and the lint on invoice-v2.').should('contain.text', 'Waiting for Ed to approve it.');
    cy.signIn('Ed');
    cy.openConsole('#/me/reporters');
    cy.get(REQUEST).should('have.length', 1).and('contain.text', 'Please run the unit tests and the lint on invoice-v2.');
  });

  it('can be deleted while it waits: the note replaces it, and the owner\'s request goes', () => {
    watchChanges();
    open(AGENT_ROW(), 'Alex');
    choose('and the lint on invoice-v2.', /^Delete message/);
    dialog().should('contain.text', 'It will be deleted for you and for invoice-v2, and invoice-v2 will not see it.');
    dialog().find('.ed-q').should('contain.text', 'Please run the unit tests and the lint on invoice-v2.');
    dialog().contains('button', /^Delete message$/).click();
    cy.wait('@delete').its('response.statusCode').should('eq', 200);
    cy.get('.ed-del').should('have.length', 1).first().should(($d) => expect($d.text()).to.match(/^This message was deleted by You at \d{2}:\d{2}\.$/));
    cy.tid('chat-thread').should('not.contain.text', 'the unit tests');
    cy.signIn('Ed');
    cy.openConsole('#/me/reporters');
    cy.get(REQUEST).should('not.exist');
  });

  it('is locked once it is sent to your own agent: both items disabled with the reason, and the server answers 409 locked', () => {
    watchChanges();
    open(`a:${INVOICE}`);
    cy.tid('chat-box').type('Please check the failing test.{enter}');
    cy.chatRow(OWN_ROW()).should('exist');
    msg('Please check the failing test.').should('exist');
    rightClick('Please check the failing test.');
    menuItem(/^Edit message/).should('have.attr', 'aria-disabled', 'true');
    menuItem(/^Delete message/).should('have.attr', 'aria-disabled', 'true');
    cy.tid('chat-menu').find('.why').should('have.text', LOCKED);
    menuItem(/^Edit message/).click();
    cy.tid('chat-edit').should('not.exist');
    cy.focused().type('{esc}');
    cy.request({ url: `${API}/dm/${personKey('Ed')}/${INVOICE}/messages?limit=50`, log: false }).its('body.messages', { log: false }).then((ms) => {
      const m = ms.find((x) => x.text === 'Please check the failing test.');
      expect(m.canChange).to.eq(false);
      cy.request({ method: 'PATCH', url: `${API}/dm/${personKey('Ed')}/${INVOICE}/messages/${m.id}`, headers: H, body: { text: 'Changed.' }, failOnStatusCode: false, log: false }).then((r) => {
        expect(r.status).to.eq(409);
        expect(r.body.reason).to.eq('locked');
      });
      cy.request({ method: 'DELETE', url: `${API}/dm/${personKey('Ed')}/${INVOICE}/messages/${m.id}`, headers: H, failOnStatusCode: false, log: false }).its('status').should('eq', 409);
    });
    msg('Please check the failing test.').should('not.contain.text', 'Changed.').find('.ed-edited').should('not.exist');
  });
});
