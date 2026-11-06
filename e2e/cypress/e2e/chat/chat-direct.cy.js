// SPEC 8.1 Chat page (#1034), Direct Messages: the controls Traffic had, now in the menu on each Direct Message (Pause link, Resume link, Remove link…, Delete conversation…), who may
// use them, what a failure says, messaging an agent from People and agents, an agent's menu, and a conversation that leaves the list when its agents have ended.
// Order: in each describe the tests run in order on one server, and a later one reads what an earlier one left (named where it matters); each describe resets the server once, in `before`.
import { seeded } from '../../../support/commands';

const DM = 'd:e2e-s-invoice+e2e-s-tester';
const GENERAL = 'c:general';
const NAME = 'Actions for invoice-v2, Tester';

const openMenu = (row) => {
  cy.chatRow(row).find('button.ch-more').click();
  return cy.tid('chat-menu').should('be.visible');
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
    cy.tid('chat-menu').find('[role=menuitem]').then(($i) => expect([...$i].map((i) => i.textContent.trim())).to.deep.eq(['Pause link', 'Remove link…', 'Delete conversation…']));
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
    // And the server refuses its text to them.
    cy.request({ url: '/api/fleet/respond/chat/dm/e2e-s-invoice/e2e-s-tester/messages?limit=50', failOnStatusCode: false }).its('status').should('eq', 403);
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
    openMenu(DM).find('[role=menuitem]').then(($i) => expect([...$i].map((i) => i.textContent.trim())).to.deep.eq(['Delete conversation…']));
    cy.tid('chat-menu').contains('[role=menuitem]', 'Delete conversation…').click();
    cy.tid('chat-confirm').should('have.attr', 'aria-label', 'Delete conversation').and('contain.text', 'messages are removed for you and an Admin, and it leaves your list.');
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

  it('offers Message and Open orchestration page on an agent, from the "..." button and a right-click', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    openMenu('a:e2e-s-invoice').should('have.attr', 'aria-label', 'Actions for invoice-v2');
    cy.tid('chat-menu').find('[role=menuitem]').then(($i) => expect([...$i].map((i) => i.textContent.trim())).to.deep.eq(['Message invoice-v2', 'Open orchestration page']));
    cy.tid('chat-menu').contains('a[role=menuitem]', 'Open orchestration page').should('have.attr', 'href', '#/?open=e2e-s-invoice');
    cy.focused().type('{esc}');
    cy.tid('chat-menu').should('not.exist');
    cy.chatRow('a:e2e-s-invoice').rightclick();
    cy.tid('chat-menu').find('[role=menuitem]').should('have.length', 2);
    cy.get('body').click(0, 0);
  });

  it('starts a Direct Message with an agent, which joins the list once the first message is sent', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow('d:e2e-s-arm64-check').should('not.exist');
    cy.chatRow('a:e2e-s-arm64-check').find('button.ch-row').should('have.attr', 'title', 'Message arm64-check').click();
    cy.get('#th-h').should('have.text', 'arm64-check');
    cy.get('label').contains('Message arm64-check');
    cy.contains('No messages yet. Write the first one below.');
    cy.tid('chat-box').should('have.attr', 'placeholder', 'Write a message.').type('Is the arm64 build ready?{enter}');
    cy.tid('chat-message').should('have.length', 1).first().should('contain.text', 'You').and('contain.text', 'Is the arm64 build ready?').and('contain.text', 'Waiting:');
    cy.chatRow('d:e2e-s-arm64-check').should('contain.text', 'arm64-check').and('contain.text', 'You and one agent');
    // A conversation with one agent has no link to pause: only Delete is offered.
    openMenu('d:e2e-s-arm64-check').find('[role=menuitem]').then(($i) => expect([...$i].map((i) => i.textContent.trim())).to.deep.eq(['Delete conversation…']));
    cy.focused().type('{esc}');
  });

  it('opens an agent\'s orchestration page from its menu among the people in a thread', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow(DM).find('button.ch-row').click();
    cy.get('[aria-label="In this conversation"] button.m').first().click();
    cy.tid('chat-menu').find('[role=menuitem]').then(($i) => expect([...$i].map((i) => i.textContent.trim())).to.deep.eq(['Open orchestration page']));
    cy.tid('chat-menu').contains('a[role=menuitem]', 'Open orchestration page').click();
    cy.location('hash').should('match', /^#\/\?open=e2e-s-(invoice|tester)$/);
    cy.get('main#podium-main h1').should('have.text', 'invoice-v2');
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
});
