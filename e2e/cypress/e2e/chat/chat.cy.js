// SPEC 8.1 Chat page (#1034): the address that replaced Traffic, the panes it opens with, the sidebar, the thread and its paging, the box (Enter, the `@` list and
// its status line, the refusal of @group and @everyone while the Admin flag is off), the channels' stop buttons, the unread and mention counts and the two screens at 400 px.
// Order: the tests below run in order on one server, and a later one reads what an earlier one left (named where it matters); the file resets the server once, in `before`.
// Direct Messages and the people-and-agents menus are in chat-direct.cy.js; another person's agents are in chat-across.cy.js.
import { seeded } from '../../../support/commands';

const GENERAL = 'c:general';
const GROUP = 'c:group';
const DM = 'd:dm:e2e-s-invoice|e2e-s-tester';
const H = { 'X-Podium-Respond': '1' };

/** Posts to a channel as the signed-in browser's person, by request (no typing), so a spec can fill a thread. */
const post = (channel, text) => cy.request({ method: 'POST', url: `/api/fleet/respond/chat/channels/${channel}/messages`, headers: H, body: { text }, log: false }).its('status', { log: false }).should('eq', 201);

describe('chat: the page', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('opens from the old Traffic address, which is retired, and names itself in the pill and the tab', () => {
    cy.signIn('Ed');
    cy.visit('/#/traffic');
    cy.location('hash').should('eq', '#/chat');
    cy.tid('page-pill').should('have.text', 'Chat');
    cy.title().should('eq', 'Podium chat');
    cy.get('#podium-top').contains('a.btn', /^Chat$/).should('not.exist');
    cy.get('#podium-top').contains('a.btn', 'Board');
    cy.get('main[aria-label=Chat] h1').should('have.text', 'Chat');
    cy.tid('traffic-deprecated').should('not.exist');
  });

  it('asks a signed-out visitor to sign in, and shows nothing of any channel', () => {
    cy.openConsole('#/chat');
    cy.contains('Sign in to use Chat');
    cy.tid('chat-split').should('not.exist');
  });

  it('opens with both side panes collapsed and the top bar open, kept apart from the wall\'s flags', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.tid('chat-split').should('exist');
    cy.get('button.edge-tab-left').should('have.attr', 'aria-expanded', 'false');
    cy.get('button.edge-tab-right').should('have.attr', 'aria-expanded', 'false');
    cy.get('button.edge-tab-top').should('have.attr', 'aria-expanded', 'true');
    cy.window().its('localStorage').invoke('getItem', 'podium.collapsed').should('be.null');
    cy.get('button.edge-tab-left').click().should('have.attr', 'aria-expanded', 'true');
    cy.window().its('localStorage').invoke('getItem', 'podium.collapsed.chat').should((raw) => expect(JSON.parse(raw).left).to.eq(false));
    cy.window().its('localStorage').invoke('getItem', 'podium.collapsed').should('be.null');
    cy.get('button.edge-tab-left').click();
  });

  it('lists Channels, Direct Messages and People and agents, with General open', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.get('nav[aria-label=Chat]').within(() => {
      cy.contains('h2', 'Channels');
      cy.contains('h2', 'Direct Messages');
      cy.contains('h2', 'People and agents');
    });
    cy.chatRow(GENERAL).should('contain.text', 'General').and('contain.text', 'Everyone signed in to this server');
    cy.chatRow(GENERAL).find('button.ch-row').should('have.attr', 'aria-current', 'true');
    cy.chatRow(GROUP).should('contain.text', 'My group').and('contain.text', 'You and your');
    cy.chatRow(DM).should('contain.text', 'invoice-v2').and('contain.text', 'Tester').and('contain.text', 'Two agents, and you');
    cy.chatRow('a:e2e-s-invoice').should('contain.text', 'invoice-v2').and('contain.text', 'Orchestrator on ed-mbp');
    cy.get('#th-h').should('have.text', 'General');
    cy.contains('Everyone signed in to this server can read and post here.');
  });

  it('explains the privacy rules in a modal behind the (i) in the banner, and the thread has no "Who can read what" panel (#1099, #1209)', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.tid('chat-split').should('exist');
    cy.contains('h2', 'Who can read what').should('not.exist');
    cy.get('main[aria-label=Chat] h1').should('have.text', 'Chat');
    cy.displaySettings().find('button.info').should('have.attr', 'aria-label', 'Chat privacy and controls').and('have.attr', 'aria-haspopup', 'dialog').and('have.attr', 'aria-expanded', 'false');
    cy.displaySettings().contains('.tip', 'Click to learn about chat privacy and controls');
    cy.get('[role=dialog]').should('not.exist');
    const opener = () => cy.displaySettings().find('button.info');
    const open = () => {
      opener().click().should('have.attr', 'aria-expanded', 'true');
      cy.get('[role=dialog]').should('be.visible');
    };
    const closed = () => {
      cy.get('[role=dialog]').should('not.exist');
      opener().should('have.attr', 'aria-expanded', 'false').and('have.focus');
    };
    open();
    cy.get('[role=dialog]').within(() => {
      cy.contains('h2', 'About Chat');
      cy.contains('h3', 'Chat privacy and controls');
      ['Who reads what', 'How agents act', 'Stopping a session', 'Admins'].forEach((h) => cy.contains('h3', h));
      cy.get('h3').should('have.length', 5);
      cy.get('li').should('have.length', 8);
      cy.contains('li', "A conversation with another person's agent is read by that person, the agent's owner and an Admin");
    });
    cy.get('body').type('{esc}');
    closed();
    open();
    cy.get('[role=dialog]').find('button[aria-label="Close (Esc)"]').click();
    closed();
    open();
    cy.get('.scrim').trigger('mousedown', 'topLeft', { force: true });
    closed();
  });

  it('folds a section from its title, tips the + buttons, and opens New direct message from a person with their name searched (#1234)', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    const fold = () => cy.get('nav[aria-label=Chat] #sec-ch .ch-fold');
    fold().should('have.attr', 'aria-expanded', 'true').click().should('have.attr', 'aria-expanded', 'false');
    cy.chatRow(GENERAL).should('not.be.visible');
    fold().click().should('have.attr', 'aria-expanded', 'true');
    cy.chatRow(GENERAL).should('be.visible');
    // The + takes the shared tip on hover and on keyboard focus.
    cy.get('nav[aria-label=Chat] button[aria-label="New channel"]').focus();
    cy.contains('[role=tooltip]', 'Create a channel').should('be.visible');
    cy.get('nav[aria-label=Chat] button[aria-label="New channel"]').blur();
    // A person is a row in People and agents; Message opens New direct message with their name in the search.
    cy.chatRow('p:Alex').should('contain.text', 'Person').find('button.ch-row').click();
    cy.get('[role=dialog]').should('contain.text', 'New direct message');
    cy.get('[role=dialog] input[type=search]').should('have.value', 'Alex');
  });

  it('colors a People and agents row by the agent\'s state when it is pointed at, with the state said in words', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    // The row carries its state's class, which the hover and focus colors are keyed on; the words are on the row.
    cy.chatRow('a:e2e-s-tester').should('have.class', 'hl-waiting').and('contain.text', 'waiting for you');
    cy.chatRow('a:e2e-s-arm64-check').should('have.class', 'hl-running').and('contain.text', 'running');
    cy.chatRow('a:e2e-s-invoice').should('have.class', 'hl-deleg').and('contain.text', 'delegating');
  });

  it('shows a Direct Message with the person as the third reader, its four messages and where each one is', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(DM).find('button.ch-row').click();
    cy.get('#th-h').should('contain.text', 'invoice-v2').and('contain.text', 'Tester');
    // A Direct Message has two parties, named by the avatars before the title, and no members stack or panel (#1236).
    cy.get('.ch-head h2 .ch-av-pair').should('exist');
    cy.get('button[aria-controls="ch-members"]').should('not.exist');
    cy.tid('chat-message').should('have.length', 4);
    cy.tid('chat-thread').should('contain.text', 'Please run the unit tests on this branch.').and('contain.text', '2 of 14 failed on Ubuntu 24.04.');
    cy.tid('chat-thread').should('contain.text', 'Waiting: Tester is working. It gets this when its turn ends.');
    cy.tid('chat-thread').should('contain.text', 'Agents addressing each other: 2 of 10 round trips');
    cy.contains('Showing 4 of 4');
  });

  it('sends a message in General with Enter and keeps a line break for Shift+Enter', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.tid('chat-box').should('have.attr', 'placeholder', 'Write a message. Type @ to address someone.');
    cy.tid('chat-box').type('first line{shift}{enter}second line');
    cy.tid('chat-box').invoke('val').should('eq', 'first line\nsecond line');
    cy.tid('chat-message').should('have.length', 0);
    cy.tid('chat-box').type('{enter}');
    cy.tid('chat-box').should('have.value', '');
    cy.tid('chat-message').should('have.length', 1).first().should('contain.text', 'You').and('contain.text', 'first line').and('contain.text', 'second line').and('contain.text', 'Posted. No agent was addressed, so none will act on it.');
    // The box stays empty and is read again from the server after a reload.
    cy.reload();
    cy.tid('chat-message').should('have.length', 1);
  });

  it('opens a list of what an @ can mean, says how many match, narrows as you type, and picks with the arrow keys and Enter', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.tid('chat-box').type('@');
    cy.tid('chat-listbox').should('be.visible').find('[role=option]').should(($o) => {
      expect($o.length).to.be.greaterThan(3);
      expect(Cypress.$('[data-testid=chat-matches]').text()).to.eq(`${$o.length} people and agents. Use the arrow keys.`);
    });
    cy.tid('chat-listbox').contains('[role=option]', '@group').should('have.attr', 'aria-disabled', 'true').and('contain.text', 'Off. An Admin turns it on in Admin > Settings.');
    cy.tid('chat-box').type('inv');
    cy.tid('chat-listbox').find('[role=option]').should('have.length', 1).first().should('contain.text', '@invoice-v2@ed-mbp').and('have.attr', 'aria-selected', 'true');
    cy.tid('chat-matches').should('have.text', '1 person or agent. Use the arrow keys.');
    cy.tid('chat-box').type('{enter}');
    cy.tid('chat-box').should('have.value', '@invoice-v2@ed-mbp ');
    cy.tid('chat-listbox').should('not.be.visible');
    cy.tid('chat-matches').should('have.text', '');
    // Arrow keys move the choice, and Escape closes the list without choosing.
    cy.tid('chat-box').clear().type('@T');
    cy.tid('chat-listbox').find('[role=option]').should('have.length.greaterThan', 0);
    cy.tid('chat-box').type('{esc}');
    cy.tid('chat-listbox').should('not.be.visible');
    cy.tid('chat-box').clear().type('@');
    cy.tid('chat-listbox').find('[role=option]').first().should('have.attr', 'aria-selected', 'true');
    cy.tid('chat-box').type('{downarrow}');
    cy.tid('chat-listbox').find('[role=option]').eq(1).should('have.attr', 'aria-selected', 'true');
    cy.tid('chat-box').type('{uparrow}');
    cy.tid('chat-listbox').find('[role=option]').first().should('have.attr', 'aria-selected', 'true');
    cy.tid('chat-box').clear();
  });

  it('draws the message box as one box with a Send icon that ends at its edge, grows with its text, and has an @ tool and Tab to pick (#1233)', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.get('.ch-composer label').should('have.text', 'Message General').and('have.class', 'vh');
    cy.tid('chat-send').should('have.attr', 'aria-label', 'Send message').and('be.disabled');
    cy.tid('chat-box').type('hello');
    cy.tid('chat-send').should('not.be.disabled');
    // Send ends at the box's right edge, within the box's padding.
    cy.get('.ch-box').then(($box) => {
      cy.tid('chat-send').should(($send) => {
        const gap = $box[0].getBoundingClientRect().right - $send[0].getBoundingClientRect().right;
        expect(gap).to.be.within(0, 12);
      });
    });
    // One line to start; it grows with its text and stops at 180 px.
    cy.tid('chat-box').clear().type('a{shift}{enter}{enter}{enter}{enter}{enter}{enter}{enter}');
    cy.tid('chat-box').should(($b) => expect($b[0].getBoundingClientRect().height).to.be.within(100, 181));
    cy.tid('chat-box').clear();
    cy.tid('chat-box').should(($b) => expect($b[0].getBoundingClientRect().height).to.be.below(60));
    // The @ tool writes an @ and opens the list; Tab picks the first entry, and an entry that is off is not picked.
    cy.tid('chat-tool-at').click();
    cy.tid('chat-box').should('have.value', '@').and('have.attr', 'role', 'combobox').and('have.attr', 'aria-expanded', 'true');
    cy.tid('chat-listbox').should('be.visible');
    cy.tid('chat-box').type('inv').trigger('keydown', { key: 'Tab' });
    cy.tid('chat-box').should('have.value', '@invoice-v2@ed-mbp ');
    cy.tid('chat-box').clear().type('@gr').trigger('keydown', { key: 'Tab' });
    cy.tid('chat-box').should('have.value', '@gr');
    cy.tid('chat-listbox').should('be.visible');
    cy.tid('chat-box').clear();
  });

  it('shows an addressed agent waiting for its turn, with the @ as a chip in the message', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.tid('chat-box').type('@Tester@ci-runner-01 how is the suite going?{enter}');
    cy.tid('chat-message').last().should('contain.text', 'how is the suite going?').and('contain.text', 'Tester@ci-runner-01 waiting').and('contain.text', 'Waiting: Tester gets this when its current turn ends.');
  });

  it('refuses @group and @everyone while the Admin flag is off, keeps the draft, and sends them once it is on', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    // Read once on purpose: a thread shows its messages only after one load, whole, so the first message found means the count is complete (#1137).
    cy.tid('chat-message').then(($m) => {
      const had = $m.length;
      cy.tid('chat-box').type('@everyone stand up{enter}');
      cy.tid('chat-send-error').should('contain.text', '@group and @everyone are off, so nothing was sent.').and('contain.text', 'Address one agent as name@location instead.');
      cy.tid('chat-box').should('have.value', '@everyone stand up');
      cy.tid('chat-message').should('have.length', had);
      cy.setFlags({ 'chat-everyone': true });
      cy.tid('chat-box').type('{enter}');
      cy.tid('chat-send-error').should('not.exist');
      cy.tid('chat-message').should('have.length', had + 1).last().should('contain.text', '@everyone stand up');
      // The list of addresses is read again after a send, on the same page, so @group and @everyone can be picked at once.
      cy.tid('chat-box').type('@');
      cy.tid('chat-listbox').contains('[role=option]', '@group').should('not.have.attr', 'aria-disabled');
      cy.tid('chat-listbox').contains('[role=option]', '@everyone').should('not.have.attr', 'aria-disabled');
      cy.tid('chat-box').clear();
      // The list of addresses is read again on a fresh page, and now says @group can be picked.
      cy.reload();
      cy.tid('chat-box').type('@');
      cy.tid('chat-listbox').contains('[role=option]', '@group').should('not.have.attr', 'aria-disabled');
      cy.setFlags({ 'chat-everyone': false });
    });
  });

  it('sends in My group, which only Ed and his own agents read', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(GROUP).find('button.ch-row').click();
    cy.get('#th-h').should('have.text', 'My group');
    cy.contains('Only you and your own orchestrators, subagents and forks can read and post here.');
    cy.tid('chat-box').should('have.attr', 'placeholder', 'Write a message. Type @ to address someone.').type('group note{enter}');
    cy.tid('chat-message').should('have.length', 1).and('contain.text', 'group note');
    // Another person has a group of their own, and General does not show this.
    cy.signIn('Alex');
    cy.openConsole('#/chat');
    cy.chatRow(GROUP).find('button.ch-row').click();
    cy.tid('chat-message').should('have.length', 0);
    cy.tid('chat-intro').should('contain', 'This is the start of');
    cy.chatRow(GENERAL).find('button.ch-row').click();
    cy.tid('chat-thread').should('not.contain.text', 'group note');
  });
});

describe('chat: the stop buttons of a channel', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  const openMenu = (row) => {
    cy.chatRow(row).find('button.ch-more').click();
    return cy.tid('chat-menu').should('be.visible');
  };

  it('opens the same menu on the "..." button and on a right-click, and closes it on Escape returning focus', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    openMenu(GENERAL).should('have.attr', 'aria-label', 'Actions for General');
    cy.tid('chat-menu').find('[role=menuitem]').should(($i) => expect([...$i].map((i) => i.textContent.trim())).to.deep.eq(['Pause my agents in General', 'Disconnect my agents in General']));
    cy.tid('chat-menu').should('contain.text', 'Only an Admin can pause General for everyone or remove its messages.');
    cy.tid('chat-menu').find('[role=menuitem]').first().should('have.focus');
    cy.focused().type('{esc}');
    cy.tid('chat-menu').should('not.exist');
    cy.chatRow(GENERAL).find('button.ch-more').should('have.focus').and('have.attr', 'aria-expanded', 'false');
    cy.chatRow(GENERAL).rightclick();
    cy.tid('chat-menu').should('have.attr', 'aria-label', 'Actions for General');
    cy.tid('chat-menu').find('[role=menuitem]').should('have.length', 2);
    cy.get('body').click(0, 0);
    cy.tid('chat-menu').should('not.exist');
  });

  it('pauses Ed\'s agents in General, turns the box off with the reason, and resumes', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    openMenu(GENERAL).contains('[role=menuitem]', 'Pause my agents in General').click();
    cy.chatRow(GENERAL).should('contain.text', 'Paused');
    cy.tid('chat-box').should('be.disabled').and('have.attr', 'placeholder', 'Paused');
    cy.contains('Paused: messages are held. Resume from the menu to send.');
    cy.tid('chat-send').should('be.disabled');
    openMenu(GENERAL).contains('[role=menuitem]', 'Resume my agents in General').click();
    cy.chatRow(GENERAL).should('not.contain.text', 'Paused');
    cy.tid('chat-box').should('not.be.disabled');
  });

  it('holds a message to an agent while the channel is paused and says so on its line', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    openMenu(GROUP).contains('[role=menuitem]', 'Pause every agent in the group').click();
    cy.chatRow(GROUP).find('button.ch-row').click();
    cy.chatRow(GROUP).should('contain.text', 'Paused');
    cy.tid('chat-box').should('be.disabled');
    openMenu(GROUP).contains('[role=menuitem]', 'Resume every agent in the group').click();
    cy.chatRow(GROUP).should('not.contain.text', 'Paused');
  });

  it('disconnects Ed\'s agents from a channel and reconnects them', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    openMenu(GENERAL).contains('[role=menuitem]', 'Disconnect my agents in General').click();
    cy.chatRow(GENERAL).should('contain.text', 'Your agents are disconnected');
    cy.tid('chat-box').should('be.disabled').and('have.attr', 'placeholder', 'Disconnected');
    cy.contains('Your agents are disconnected from this channel. Reconnect them from its menu to send.');
    openMenu(GENERAL).contains('[role=menuitem]', 'Reconnect my agents in General').click();
    cy.chatRow(GENERAL).should('not.contain.text', 'disconnected');
    cy.tid('chat-box').should('not.be.disabled');
  });

  it('says what failed and changes nothing when a stop button cannot be saved', () => {
    cy.signIn('Ed');
    cy.intercept('PUT', '**/chat/channels/general/pause', { statusCode: 500, body: { ok: false, error: 'the store is busy' } });
    cy.openConsole('#/chat');
    openMenu(GENERAL).contains('[role=menuitem]', 'Pause my agents in General').click();
    cy.tid('chat-action-error').invoke('text').should('match', /^Could not pause General: .+\. Nothing changed\. Try again\.$/);
    cy.chatRow(GENERAL).should('not.contain.text', 'Paused');
    cy.tid('chat-box').should('not.be.disabled');
  });

  it('lets only an Admin pause General for everyone or remove its messages, and asks before removing', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(GENERAL).find('button.ch-row').click();
    cy.tid('chat-box').type('something to remove{enter}');
    cy.tid('chat-message').should('have.length', 1);
    cy.signIn('Admin');
    cy.openConsole('#/chat');
    // The admin secret reads General and has no group or Direct Messages of its own.
    cy.chatRow(GROUP).should('not.exist');
    cy.contains('Direct Messages and People and agents belong to a person.');
    cy.tid('chat-message').should('have.length', 1);
    openMenu(GENERAL).find('[role=menuitem]').should(($i) => expect([...$i].map((i) => i.textContent.trim())).to.include.members(['Pause General for everyone', 'Remove all messages…']));
    cy.tid('chat-menu').contains('[role=menuitem]', 'Pause General for everyone').click();
    cy.chatRow(GENERAL).should('contain.text', 'Paused for everyone');
    cy.contains('Paused for everyone by an Admin: messages are held until it resumes.');
    // Ed sees it paused and cannot resume what an Admin paused: his menu offers his own agents' pause only.
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(GENERAL).should('contain.text', 'Paused for everyone');
    cy.tid('chat-box').should('be.disabled');
    cy.signIn('Admin');
    cy.openConsole('#/chat');
    openMenu(GENERAL).contains('[role=menuitem]', 'Resume General for everyone').click();
    cy.chatRow(GENERAL).should('not.contain.text', 'Paused');
    openMenu(GENERAL).contains('[role=menuitem]', 'Remove all messages…').click();
    cy.tid('chat-confirm').should('contain.text', 'Remove all 1 messages in General?').and('contain.text', 'cannot be recovered');
    cy.tid('chat-confirm').contains('button', 'Keep them').click();
    cy.tid('chat-confirm').should('not.exist');
    cy.tid('chat-message').should('have.length', 1);
    openMenu(GENERAL).contains('[role=menuitem]', 'Remove all messages…').click();
    cy.tid('chat-confirm').contains('button', 'Remove all messages').click();
    cy.tid('chat-message').should('have.length', 0);
    cy.tid('chat-intro').should('contain', 'This is the start of');
  });

  it('lets a person remove all the messages of My group after a confirmation', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(GROUP).find('button.ch-row').click();
    cy.tid('chat-box').type('one{enter}');
    cy.tid('chat-message').should('have.length', 1);
    openMenu(GROUP).contains('[role=menuitem]', 'Remove all messages…').click();
    cy.tid('chat-confirm').should('contain.text', 'The history is deleted, and it cannot be recovered.');
    cy.tid('chat-confirm').find('button').first().should('have.focus');
    cy.tid('chat-confirm').contains('button', 'Remove all messages').click();
    cy.tid('chat-message').should('have.length', 0);
  });
});

describe('chat: a long thread, and what is new', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('shows the newest 50 messages and pages back with Earlier messages', () => {
    cy.signIn('Ed');
    cy.putSettings({ chat: { perMinute: 600 } });
    cy.openConsole('#/chat');
    cy.chatRow(GENERAL).should('exist');
    Cypress._.times(60, (i) => post('general', `note ${String(i + 1).padStart(2, '0')}`));
    cy.reload();
    cy.contains('Showing 50 of 60');
    cy.tid('chat-message').should('have.length', 50).first().should('contain.text', 'note 11');
    cy.tid('chat-message').last().should('contain.text', 'note 60');
    cy.contains('button', 'Earlier messages').click();
    cy.contains('Showing 60 of 60');
    cy.tid('chat-message').should('have.length', 60).first().should('contain.text', 'note 01');
    cy.contains('button', 'Earlier messages').should('not.exist');
  });

  it('counts what is new on the row of a thread that is not open, with a mention when it is addressed to the person, and clears it on opening', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(DM).find('button.ch-row').click();
    cy.chatRow(GENERAL).find('.unread').should('not.exist');
    // An agent posts with its owner's token, the way the mod will (route shape only in this release); the open thread is another one.
    // It answers a channel that called it, so Ed mentions it in General first (#1065).
    post('general', '@invoice-v2@ed-mbp are you there?');
    const agentPost = (text) => cy.request({ method: 'POST', url: '/api/fleet/sessions/e2e-s-invoice/chat/channels/general/messages', headers: { 'X-Podium-Token': seeded().people.Ed.token }, body: { text }, log: false }).its('status', { log: false }).should('eq', 201);
    agentPost('build is green');
    cy.chatRow(GENERAL).find('.unread').should('have.text', '1').and('have.attr', 'aria-label', '1 new');
    agentPost('@Ed@console please look at the diff');
    cy.chatRow(GENERAL).find('.unread').should('contain.text', '@ 1').and('have.attr', 'aria-label', '1 mention of you');
    cy.chatRow(GENERAL).find('button.ch-row').click();
    cy.tid('chat-message').last().should('contain.text', 'please look at the diff');
    cy.chatRow(GENERAL).find('.unread').should('not.exist');
    cy.reload();
    cy.chatRow(GENERAL).should('exist');
    cy.chatRow(GENERAL).find('.unread').should('not.exist');
  });
});

describe('chat: at 400 px', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('shows the list and the thread as two screens, with Back to the list, and does not scroll sideways', () => {
    cy.atWidth(400);
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.tid('chat-split').should('have.attr', 'data-pane', 'side');
    cy.chatRow(DM).should('be.visible');
    cy.tid('chat-thread').should('not.be.visible');
    cy.chatRow(DM).find('button.ch-row').click();
    cy.tid('chat-split').should('have.attr', 'data-pane', 'thread');
    cy.tid('chat-thread').should('be.visible');
    cy.chatRow(DM).should('not.be.visible');
    cy.document().should((doc) => expect(doc.documentElement.scrollWidth, 'the page does not scroll sideways').to.be.at.most(doc.documentElement.clientWidth));
    cy.get('#th-h').should('have.focus');
    cy.contains('button', 'Back to the list').click();
    cy.tid('chat-split').should('have.attr', 'data-pane', 'side');
    cy.chatRow(DM).should('be.visible');
  });
  it('fills the window with a 16 px gutter on every side, at two heights, with the box always in view', () => {
    cy.signIn('Ed');
    [700, 1100].forEach((h) => {
      cy.viewport(1440, h);
      cy.openConsole('#/chat');
      cy.tid('chat-split').should('exist');
      cy.tid('chat-split').then(($s) => {
        const r = $s[0].getBoundingClientRect();
        const page = $s[0].closest('.apage').getBoundingClientRect();
        expect(r.top - page.top, 'top gutter').to.eq(16);
        expect(r.left - page.left, 'left gutter').to.eq(16);
        expect(page.right - r.right, 'right gutter').to.eq(16);
        expect(page.bottom - r.bottom, 'bottom gutter').to.eq(16);
        expect(Math.round(page.bottom), 'the page ends at the window').to.eq(h);
      });
      cy.get('.ch-composer textarea').should('be.visible');
      cy.document().should((doc) => expect(doc.documentElement.scrollHeight, 'the page does not scroll').to.be.at.most(doc.documentElement.clientHeight));
    });
  });
});

describe('chat: messages drawn as rows (#1232)', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  const LONG = `const longLine = "${'x'.repeat(240)}";`;

  const seedRows = () => {
    cy.signIn('Alex');
    cy.openConsole('#/chat');
    cy.chatRow(GENERAL).should('exist');
    post('general', 'hello from Alex');
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(GENERAL).should('exist');
    post('general', 'first from Ed');
    post('general', 'second from Ed');
    post('general', `see this:\n\`\`\`js\n${LONG}\n\`\`\`\nand \`inline\` code <script>window.__pwned = 1</script>`);
    cy.reload();
    cy.tid('chat-message').should('have.length', 4);
  };

  it('groups a run under one name, right-aligns your own messages in the same bubble, and dates the day', () => {
    seedRows();
    cy.tid('chat-message').eq(0).should('have.class', 'first').and('not.have.class', 'mine').and('contain.text', 'hello from Alex');
    cy.tid('chat-message').eq(1).should('have.class', 'first').and('have.class', 'mine');
    cy.tid('chat-message').eq(2).should('have.class', 'cont').and('have.class', 'mine').and('contain.text', 'second from Ed');
    cy.tid('chat-message').eq(2).find('.who').should('not.exist');
    cy.tid('chat-message').eq(3).should('have.class', 'cont').and('have.class', 'mine');
    cy.tid('chat-message').eq(0).find('.ch-tx').invoke('attr', 'class').then((theirs) => {
      cy.tid('chat-message').eq(1).find('.ch-tx').should('have.attr', 'class', theirs);
    });
    cy.get('ol.ch-msgs li.ch-day').should('have.length', 1).and('contain.text', 'Today');
  });

  it('draws a fenced block as text in a focusable pre, and a script tag as text', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.tid('chat-message').should('have.length', 4);
    cy.tid('chat-code').should('have.length', 1).within(() => {
      cy.get('pre[tabindex=0] code').should('contain.text', 'const longLine');
      cy.get('.ch-code-lang').should('have.text', 'js');
      cy.contains('button', 'Copy').should('be.visible');
    });
    cy.tid('chat-message').last().find('code.ch-inline').should('have.text', 'inline');
    cy.tid('chat-message').last().should('contain.text', '<script>window.__pwned = 1</script>');
    cy.tid('chat-message').last().find('script').should('not.exist');
    cy.window().its('__pwned').should('be.undefined');
  });

  it('keeps the page from scrolling sideways at 400 px while the code block scrolls inside itself', () => {
    cy.atWidth(400);
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(GENERAL).find('button.ch-row').click();
    cy.tid('chat-code').scrollIntoView().should('be.visible');
    cy.document().should((doc) => expect(doc.documentElement.scrollWidth, 'the page does not scroll sideways').to.eq(doc.documentElement.clientWidth));
    cy.tid('chat-code').then(($c) => {
      expect($c[0].getBoundingClientRect().right, 'the block is inside the window').to.be.at.most(400);
    });
    cy.tid('chat-code').find('pre').should(($p) => expect($p[0].scrollWidth, 'the pre scrolls sideways').to.be.greaterThan($p[0].clientWidth));
  });

  it('is a polite log of additions once it has settled', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.tid('chat-message').should('have.length', 4);
    cy.get('[role=log][aria-label=Messages]').should('have.attr', 'aria-relevant', 'additions').and('have.attr', 'aria-live', 'polite');
    cy.get('[role=log][aria-label=Messages] ol.ch-msgs').should('exist');
  });
});
