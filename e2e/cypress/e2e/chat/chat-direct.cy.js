// SPEC 8.1 Chat page (#1034), Direct Messages: the controls Traffic had, now in the menu on each Direct Message (Pause link, Resume link, Remove link…, Delete conversation…), who may
// use them, what a failure says, messaging an agent from People and agents, an agent's menu, and a conversation that leaves the list when its agents have ended.
// Order: in each describe the tests run in order on one server, and a later one reads what an earlier one left (named where it matters); each describe resets the server once, in `before`.
import { seeded } from '../../../support/commands';

const DM = 'd:dm:e2e-s-invoice|e2e-s-tester';
const GENERAL = 'c:general';
const NAME = 'Actions for invoice-v2, Tester';

const openMenu = (row) => {
  cy.chatRow(row).find('button.ch-more').click();
  return cy.tid('chat-menu').should('be.visible');
};
// People and agents is paged ten at a time (#1272): a row that is not on the first page is found by paging forward.
const showRow = (key, pagesLeft = 6) => {
  cy.get('#list-pe > li').should('have.length.greaterThan', 0);
  return cy.get('body').then(($b) => {
    if ($b.find(`[data-testid="chat-row-${key}"]`).length) return;
    const next = $b.find('nav[aria-label="People and agents pages"] button[aria-label="Next page"]:not(:disabled)');
    if (!next.length || pagesLeft === 0) throw new Error(`chat-row-${key} is on no page of People and agents`);
    cy.wrap(next).click();
    showRow(key, pagesLeft - 1);
  });
};
const openDm = () => {
  cy.signIn('Ed');
  cy.openConsole('#/chat');
  cy.chatRow(DM).find('button.ch-row').click();
  cy.tid('chat-message').should('have.length.greaterThan', 0);
};

describe('chat: the controls of a Direct Message', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('adds to a conversation between two agents as the third person, and says where the message is', () => {
    openDm();
    cy.get('label').contains('Add to this conversation');
    cy.tid('chat-box').should('have.attr', 'placeholder', 'Write a message.').type('Thanks, carry on.{enter}');
    cy.tid('chat-message').should('have.length', 5).last().should('contain.text', 'You').and('contain.text', 'Thanks, carry on.');
    cy.tid('chat-message').last().should('contain.text', 'Waiting:');
    cy.contains('It reaches each agent when its current turn ends');
  });

  it('offers the three controls on the "..." button and on a right-click, to the owner only', () => {
    openDm();
    openMenu(DM).should('have.attr', 'aria-label', NAME);
    cy.tid('chat-menu').find('[role=menuitem]').should(($i) => expect([...$i].map((i) => i.textContent.trim())).to.deep.eq(['Pause link', 'Remove link…', 'Delete conversation…']));
    cy.focused().type('{esc}');
    cy.tid('chat-menu').should('not.exist');
    cy.chatRow(DM).rightclick();
    cy.tid('chat-menu').find('[role=menuitem]').should('have.length', 3);
    cy.get('body').click(0, 0);
    // Another person has no such conversation in their list.
    cy.signIn('Alex');
    cy.openConsole('#/chat');
    cy.chatRow(DM).should('not.exist');
    cy.contains('No conversations. Start one from People and agents.');
    // And the server answers them as it would for a conversation that does not exist (404), with no text.
    cy.request({ url: '/api/fleet/respond/chat/dm/e2e-s-invoice/e2e-s-tester/messages?limit=50', failOnStatusCode: false }).then((r) => {
      expect(r.status).to.eq(404);
      expect(r.body.error).to.eq('There is no such conversation.');
    });
  });

  it('says so, and changes nothing, when Pause link fails', () => {
    cy.intercept('PUT', '**/peers/links*', { statusCode: 500, body: { ok: false } });
    openDm();
    openMenu(DM).contains('[role=menuitem]', 'Pause link').click();
    cy.tid('chat-action-error').invoke('text').should('match', /^Could not pause the link: .+\. The link is still active\. Try again\.$/);
    openMenu(DM).contains('[role=menuitem]', 'Pause link');
    cy.chatRow(DM).should('not.contain.text', 'Paused');
  });

  it('pauses a link and resumes it, keeping the rights, and the server holds it over a reload', () => {
    openDm();
    openMenu(DM).contains('[role=menuitem]', 'Pause link').click();
    cy.chatRow(DM).should('contain.text', 'Paused');
    cy.tid('chat-box').should('be.disabled').and('have.attr', 'placeholder', 'Paused');
    cy.contains('Paused: messages are held. Resume from the menu to send.');
    cy.reload();
    cy.chatRow(DM).should('contain.text', 'Paused');
    openMenu(DM).contains('[role=menuitem]', 'Resume link').click();
    cy.chatRow(DM).should('not.contain.text', 'Paused');
    cy.tid('chat-box').should('not.be.disabled');
    cy.visit('/#/me/reporters');
    cy.get('select[id="g-e2e0000mbp01-e2e0000ci001"]').find(':selected').should('have.text', 'Can send');
  });

  it('asks before it removes a link, naming what goes, and Keep it keeps it', () => {
    openDm();
    openMenu(DM).contains('[role=menuitem]', 'Remove link…').click();
    cy.tid('chat-confirm').should('have.attr', 'aria-label', 'Remove link').and('contain.text', 'Both directions lose every right').and('contain.text', 'this conversation stays here until it expires');
    cy.tid('chat-confirm').find('button').first().should('have.text', 'Keep it').and('have.focus').click();
    cy.tid('chat-confirm').should('not.exist');
    cy.chatRow(DM).find('button.ch-more').should('have.focus');
    openMenu(DM).contains('[role=menuitem]', 'Remove link…');
  });

  it('says so, and keeps the link, when Remove link fails', () => {
    cy.intercept({ method: /PUT|DELETE|POST/, url: '**/peers/**' }, (req) => {
      if (/links|rights/.test(req.url)) req.reply({ statusCode: 500, body: { ok: false } });
    });
    openDm();
    openMenu(DM).contains('[role=menuitem]', 'Remove link…').click();
    cy.tid('chat-confirm').contains('button', /^Remove link$/).click();
    cy.tid('chat-action-error').invoke('text').should('match', /^Could not remove the link: .+\. Nothing changed\. Try again\.$/);
    cy.chatRow(DM).should('not.contain.text', 'Link removed');
  });

  it('removes a link after the owner confirms, and the conversation stays until it expires', () => {
    openDm();
    openMenu(DM).contains('[role=menuitem]', 'Remove link…').click();
    cy.tid('chat-confirm').contains('button', /^Remove link$/).click();
    cy.tid('chat-confirm').should('not.exist');
    cy.chatRow(DM).should('contain.text', 'Link removed');
    cy.tid('chat-box').should('be.disabled').and('have.attr', 'placeholder', 'Link removed');
    cy.contains('This link was removed, so nothing can be sent. Delete the conversation to clear it from the list.');
    cy.tid('chat-thread').should('contain.text', 'Please run the unit tests on this branch.');
    cy.reload();
    cy.chatRow(DM).should('contain.text', 'Link removed');
    cy.visit('/#/me/reporters');
    cy.get('select[id="g-e2e0000mbp01-e2e0000ci001"]').find(':selected').should('have.text', 'No access');
    cy.get('select[id="g-e2e0000ci001-e2e0000mbp01"]').find(':selected').should('have.text', 'No access');
  });

  it('asks before it deletes a conversation, then removes it from the list and falls back to General', () => {
    openDm();
    openMenu(DM).find('[role=menuitem]').should(($i) => expect([...$i].map((i) => i.textContent.trim())).to.deep.eq(['Delete conversation…']));
    cy.tid('chat-menu').contains('[role=menuitem]', 'Delete conversation…').click();
    // The count in the question is the number of messages the thread shows (the merged ones), not a figure of its own.
    // Read once on purpose: openDm showed the thread, which is drawn whole after one load (#1137).
    cy.tid('chat-message').its('length').then((n) => {
      cy.tid('chat-confirm').should('have.attr', 'aria-label', 'Delete conversation').and('contain.text', `Its ${n} messages are removed for you and an Admin, and it leaves your list.`);
    });
    cy.tid('chat-confirm').contains('button', 'Keep it').click();
    cy.chatRow(DM).should('exist');
    openMenu(DM).contains('[role=menuitem]', 'Delete conversation…').click();
    cy.tid('chat-confirm').contains('button', /^Delete conversation$/).click();
    cy.chatRow(DM).should('not.exist');
    cy.contains('No conversations. Start one from People and agents.');
    cy.get('#th-h').should('have.text', 'General');
    cy.chatRow(GENERAL).find('button.ch-row').should('have.attr', 'aria-current', 'true');
  });
});

describe('chat: People and agents', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('offers Message, Mention and Open orchestration page on an agent, from the "..." button and a right-click', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    openMenu('a:e2e-s-invoice').should('have.attr', 'aria-label', 'Actions for invoice-v2');
    cy.tid('chat-menu').find('[role=menuitem]').should(($i) => expect([...$i].map((i) => i.textContent.trim())).to.deep.eq(['Message invoice-v2', 'Mention invoice-v2', 'Open orchestration page']));
    cy.tid('chat-menu').contains('a[role=menuitem]', 'Open orchestration page').should('have.attr', 'href', '#/?open=e2e-s-invoice');
    cy.focused().type('{esc}');
    cy.tid('chat-menu').should('not.exist');
    cy.chatRow('a:e2e-s-invoice').rightclick();
    cy.tid('chat-menu').find('[role=menuitem]').should('have.length', 3);
    cy.get('body').click(0, 0);
  });

  it('starts a Direct Message with an agent, which joins the list once the first message is sent', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow('d:dm:e2e-s-arm64-check|person:ed').should('not.exist');
    cy.chatRow('a:e2e-s-arm64-check').find('button.ch-row').should('have.attr', 'title', 'Message arm64-check').click();
    cy.get('#th-h').should('have.text', 'arm64-check');
    cy.get('label').contains('Message arm64-check');
    cy.tid('chat-intro').should('contain', 'This is the start of');
    cy.tid('chat-box').should('have.attr', 'placeholder', 'Write a message, or type / for a command.').type('Is the arm64 build ready?{enter}');
    cy.tid('chat-message').should('have.length', 1).first().should('contain.text', 'You').and('contain.text', 'Is the arm64 build ready?').and('contain.text', 'Waiting:');
    cy.chatRow('d:dm:e2e-s-arm64-check|person:ed').should('contain.text', 'arm64-check').and('contain.text', 'You and one agent');
    // A conversation with one agent has no link to pause: only Delete is offered.
    openMenu('d:dm:e2e-s-arm64-check|person:ed').find('[role=menuitem]').should(($i) => expect([...$i].map((i) => i.textContent.trim())).to.deep.eq(['Delete conversation…']));
    cy.focused().type('{esc}');
  });

  it('shows the owner their own agent\'s answer in the same thread, with the agent as author and a new badge on the row', () => {
    // Reads the message Ed sent to arm64-check in the test above. The agent answers through its reporter's route, as podium_send to the person does.
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow('d:dm:e2e-s-arm64-check|person:ed').find('.unread').should('not.exist');
    cy.request({ method: 'POST', url: '/api/fleet/sessions/e2e-s-arm64-check/peers/messages', headers: { 'X-Podium-Token': seeded().people.Ed.token }, body: { to: 'person:ed', text: 'The arm64 build is ready.' }, log: false }).its('status', { log: false }).should('eq', 202);
    cy.chatRow('d:dm:e2e-s-arm64-check|person:ed').find('.unread').should('have.text', '1').and('have.attr', 'aria-label', '1 new');
    cy.chatRow('d:dm:e2e-s-arm64-check|person:ed').find('button.ch-row').click();
    cy.tid('chat-message').should('have.length', 2).first().should('contain.text', 'Is the arm64 build ready?');
    cy.tid('chat-message').last().should('contain.text', 'arm64-check').and('contain.text', 'The arm64 build is ready.').and('not.contain.text', 'You');
    cy.chatRow('d:dm:e2e-s-arm64-check|person:ed').find('.unread').should('not.exist');
  });

  it('opens an agent\'s orchestration page from its row in the members panel of My group (#1236)', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow('c:group').find('button.ch-row').click();
    cy.get('button[aria-controls="ch-members"]').click();
    cy.tid('chat-members').should('be.visible').and('contain.text', 'invoice-v2').and('contain.text', 'Ed (you)');
    cy.tid('chat-members').find('button[aria-label="Actions for invoice-v2"]').click();
    cy.tid('chat-menu').find('[role=menuitem]').should(($i) => expect([...$i].map((i) => i.textContent.trim())).to.deep.eq(['Message invoice-v2', 'Mention invoice-v2', 'Open orchestration page']));
    cy.tid('chat-menu').contains('a[role=menuitem]', 'Open orchestration page').click();
    cy.location('hash').should('eq', '#/?open=e2e-s-invoice');
    cy.get('main#podium-main h1').should('have.text', 'invoice-v2');
  });

  it('searches the members panel, closes it on Escape and puts the focus back on the stack (#1236)', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow('c:group').find('button.ch-row').click();
    cy.get('button[aria-controls="ch-members"]').click();
    cy.get('input[aria-label="Find a member"]').type('tester');
    cy.tid('chat-members').find('li').should('have.length', 1).and('contain.text', 'Tester');
    cy.get('input[aria-label="Find a member"]').type('{esc}');
    cy.tid('chat-members').should('not.exist');
    cy.focused().should('have.attr', 'aria-controls', 'ch-members');
  });
});

describe('chat: a conversation whose agents have left', () => {
  // The seeded sessions go stale after two seconds and stay on the wall, so each can be removed with the card's own Remove button, which is how an agent leaves.
  before(() => cy.resetServer({ seedArgs: '--talk', env: ['STALE_AFTER_MS=2000', 'HOOK_STALE_AFTER_MS=2000', 'DROP_AFTER_MS=7200000', 'LINGER_MS=7200000'] }));
  const remove = (key) => {
    cy.openConsole('#/');
    cy.card(key).parent().find('button.remove').click();
    cy.get(`button.card.sc[data-session="${seeded().sessions[key]}"]`, { timeout: 15000 }).should('not.exist');
  };

  it('names the agent that left while the other is still there, and still lets the person write', () => {
    cy.signIn('Ed');
    remove('tester');
    cy.openConsole('#/chat');
    cy.chatRow(DM).should('contain.text', 'Tester ended');
    // The agent that left is gone from People and agents (it fades out for the wall's leave time first, #1110, and is then removed); the other stays.
    cy.chatRow(`a:${seeded().sessions.tester}`).should('not.exist');
    cy.chatRow(`a:${seeded().sessions.invoice}`).should('exist');
    cy.chatRow(DM).find('button.ch-row').click();
    cy.tid('chat-thread').should('contain.text', 'Tester ended');
    cy.tid('chat-box').should('not.be.disabled');
    cy.contains('Tester has ended and will not receive this.');
  });

  it('takes the conversation off the list when every agent in it has left, and falls back to General', () => {
    cy.signIn('Ed');
    remove('invoice');
    cy.openConsole('#/chat');
    cy.chatRow(DM).should('not.exist');
    cy.chatRow(`a:${seeded().sessions.invoice}`).should('not.exist');
    cy.get('#th-h').should('have.text', 'General');
    cy.contains('No conversations. Start one from People and agents.');
  });

  it('shows it again, with what it held, when one of its agents reports again', () => {
    cy.reportAgain('invoice', {});
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(DM).should('exist').and('contain.text', 'Tester ended');
    cy.chatRow(DM).find('button.ch-row').click();
    cy.tid('chat-message').should('have.length', 4);
  });

  // #1113: the seed's reports carry resumeWindowDays 30, so a closed conversation is kept for the harness's resume window and not the Admin's 24 hours. Past that window the purge
  // is in the hourly sweep and no test-only clock reaches days, so it is covered in server/src/fleet/chatRoutes.test.ts (see docs/e2e/COVERAGE.md).
  it('shows none of the old conversation for a new session of the same agent', () => {
    cy.reportAgain('tester', { id: 'e2e-s-tester-resumed-new', name: 'Tester' });
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow('a:e2e-s-tester-resumed-new').should('exist');
    // The new session has its own conversation, and it holds nothing yet: no row pairs it with the other agent.
    cy.chatRow('d:dm:e2e-s-invoice|e2e-s-tester-resumed-new').should('not.exist');
    cy.chatRow('d:dm:e2e-s-tester-resumed-new|e2e-s-invoice').should('not.exist');
    // The old conversation is still its own, with what it held.
    cy.chatRow(DM).should('exist').find('button.ch-row').click();
    cy.tid('chat-message').should('have.length', 4);
  });
});

describe('chat: an agent launched and not yet used (#1112)', () => {
  // The run's server keeps an ended session for two hours; here it leaves two seconds after it ends, as a card does.
  before(() => cy.resetServer({ seedArgs: '--talk', env: ['LINGER_MS=2000'] }));

  it('joins People and agents on an open page without a reload, and leaves the same way when it ends', () => {
    const ID = 'launch-e2e0001';
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(`a:${seeded().sessions.invoice}`).should('exist');
    cy.chatRow(`a:${ID}`).should('not.exist');
    // The agent has done nothing: no cost, tokens, context, plan or agent. The wall's stream says nothing of it, and the open page is told its list changed.
    cy.task('fleet:launch', { id: ID, name: 'launched-folder' }, { log: false });
    cy.chatRow(`a:${ID}`).should('exist').and('contain.text', 'launched-folder');
    // It ends: it fades for the wall's leave time and is gone from the same open page's list.
    cy.task('fleet:launch', { id: ID, name: 'launched-folder', end: true }, { log: false });
    cy.chatRow(`a:${ID}`).should('not.exist');
    cy.chatRow(`a:${seeded().sessions.invoice}`).should('exist');
  });

  it('has no card on the Fleet wall while it is listed', () => {
    const ID = 'launch-e2e0002';
    cy.signIn('Ed');
    cy.task('fleet:launch', { id: ID, name: 'quiet-folder' }, { log: false });
    cy.openConsole('#/chat');
    showRow(`a:${ID}`);
    cy.chatRow(`a:${ID}`).should('exist').and('contain.text', 'quiet-folder');
    cy.openConsole('#/');
    cy.card('invoice').should('exist');
    cy.get(`button.card.sc[data-session="${ID}"]`).should('not.exist');
  });
});

describe('chat: the menu on a sender\'s avatar (#1235)', () => {
  const ASK = 'Please run the unit tests on invoice-v2.';
  // Alex's message in General is the one with another person's avatar; Ed reads it. Each test signs in again, so none depends on another.
  before(() => {
    cy.resetServer({ seedArgs: '--talk' });
    cy.signIn('Alex');
    cy.openConsole('#/chat');
    cy.chatRow(GENERAL).find('button.ch-row').click();
    cy.tid('chat-box').type(`@invoice-v2@ed-mbp ${ASK}{enter}`);
    cy.tid('chat-message').last().should('contain.text', ASK);
  });
  const asEd = () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(GENERAL).find('button.ch-row').click();
    return cy.tid('chat-message').last().should('contain.text', ASK);
  };

  it('offers Message and Mention on a right-click of a person\'s avatar, and Message opens New direct message with the name searched', () => {
    asEd().find('.ch-gut').rightclick();
    cy.tid('chat-menu').should('be.visible').and('have.class', 'at').find('[role=menuitem]').should(($i) => expect([...$i].map((i) => i.textContent.trim())).to.deep.eq(['Message Alex', 'Mention Alex']));
    cy.tid('chat-menu').contains('[role=menuitem]', 'Message Alex').click();
    cy.get('[role=dialog]').should('contain.text', 'New direct message').find('input[type=search]').should('have.value', 'Alex');
  });

  it('writes the address in the message box on Mention, and puts it at the caret', () => {
    asEd().find('.ch-gut').rightclick();
    cy.tid('chat-menu').contains('[role=menuitem]', 'Mention Alex').click();
    cy.tid('chat-box').should('be.focused').and(($b) => expect($b.val()).to.match(/^@Alex@\S+ $/));
  });

  it('opens from the keyboard (Enter) on a focused message, moves, and closes on Escape with the focus back on the message', () => {
    asEd().focus().type('{enter}');
    cy.tid('chat-menu').should('be.visible');
    cy.focused().should('have.attr', 'role', 'menuitem');
    cy.focused().type('{downArrow}');
    cy.focused().type('{esc}');
    cy.tid('chat-menu').should('not.exist');
    cy.focused().should('have.attr', 'data-testid', 'chat-message');
  });

  it('gives your own avatar no sender menu: a right-click there opens the menu of your own message (#1269), with no Message or Mention', () => {
    asEd();
    cy.tid('chat-box').type('A line of my own{enter}');
    cy.tid('chat-message').last().should('contain.text', 'A line of my own').find('.ch-gut').rightclick();
    cy.tid('chat-menu').should('have.attr', 'aria-label', 'Your message').and('not.contain.text', 'Mention').and('not.contain.text', 'Message the');
    cy.tid('chat-menu').find('[role=menuitem]').should(($i) => expect([...$i].map((i) => i.dataset.act)).to.deep.eq(['edit-message', 'delete-message']));
  });
});

describe('chat: People and agents is paged (#1272)', () => {
  // Ten agents are launched on top of the seeded ones, so the list is longer than one page. The spec reads the total from the footer and does not depend on their order.
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('shows ten rows with the standard footer, pages with Previous and Next, and opens New direct message from its +', () => {
    for (let i = 0; i < 10; i += 1) cy.task('fleet:launch', { id: `page-e2e-${String(i).padStart(2, '0')}`, name: `paged-${String(i).padStart(2, '0')}` }, { log: false });
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.get('#list-pe > li').should('have.length', 10);
    cy.contains('#sec-pe', 'People and agents').closest('section').as('pe');
    cy.get('@pe').contains(/^Showing 1–10 of \d+$/);
    cy.get('@pe').find('nav[aria-label="People and agents pages"] button[aria-label="Previous page"]').should('be.disabled');
    cy.get('@pe').contains(/^Showing 1–10 of \d+$/).invoke('text').then((t) => {
      const total = Number(t.match(/of (\d+)$/)[1]);
      const pages = Math.ceil(total / 10);
      expect(total).to.be.greaterThan(10);
      cy.get('@pe').find('nav[aria-label="People and agents pages"]').contains(`1 of ${pages}`);
      for (let i = 1; i < pages; i += 1) cy.get('@pe').find('button[aria-label="Next page"]').click();
      cy.get('@pe').contains(`Showing ${(pages - 1) * 10 + 1}–${total} of ${total}`);
      cy.get('#list-pe > li').should('have.length', total - (pages - 1) * 10);
      cy.get('@pe').find('button[aria-label="Next page"]').should('be.disabled');
      for (let i = 1; i < pages; i += 1) cy.get('@pe').find('button[aria-label="Previous page"]').click();
      cy.get('#list-pe > li').should('have.length', 10);
    });
    cy.get('@pe').find('h2 button[aria-label="New direct message"]').click();
    cy.get('[role=dialog][aria-labelledby="dm-h"]').should('contain.text', 'New direct message');
    cy.focused().type('{esc}');
  });
});

describe('chat: two live agents never share a name (#1284)', () => {
  const TWIN = 'twin-e2e0001';
  const RESPOND = { 'X-Podium-Respond': '1' };
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('lists the later of two same-named agents of one owner as "<name> 2", and leaves the first with its name', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(`a:${seeded().sessions.invoice}`).should('exist').and('contain.text', 'invoice-v2').and('not.contain.text', 'invoice-v2 2');
    cy.task('fleet:launch', { id: TWIN, name: 'invoice-v2' }, { log: false });
    // The twin joins the open list, on its first page beside the first agent.
    cy.chatRow(`a:${TWIN}`).should('exist').and('contain.text', 'invoice-v2 2');
    cy.chatRow(`a:${seeded().sessions.invoice}`).should('not.contain.text', 'invoice-v2 2');
  });

  it('reaches the first agent by @name@machine and refuses nothing as ambiguous, because the second is not called by that name', () => {
    cy.signIn('Ed');
    cy.request({ method: 'POST', url: '/api/fleet/respond/chat/channels/general/messages', headers: RESPOND, body: { text: '@invoice-v2@ed-mbp are you there?' }, log: false }).then((r) => {
      expect(r.status).to.eq(201);
      expect(r.body.message.mentions).to.have.length(1);
      expect(r.body.message.mentions[0].sessionId).to.eq(seeded().sessions.invoice);
    });
  });
});
