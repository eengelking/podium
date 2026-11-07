// SPEC 8.1 Chat page (#1034), a conversation with another person's agent: Alex addresses Ed's agent in General, the first message waits for Ed in My reporters (Allow opens a link,
// Decline delivers nothing), either of them can then pause or remove the link, only the one who paused it can resume it, only Ed opens a removed one, and the agent can answer.
// Order: the tests below run in order on one server, and a later one reads what an earlier one left (named where it matters); the file resets the server once, in `before`.
import { seeded } from '../../../support/commands';

const GENERAL = 'c:general';
const AGENT = 'd:e2e-s-invoice';
const ASK = 'Please run the unit tests on invoice-v2.';
const REQUEST = '[role=group][aria-label="A person\'s message waiting for approval"]';

const openMenu = (row) => {
  cy.chatRow(row).find('button.ch-more').click();
  return cy.tid('chat-menu').should('be.visible');
};
const item = (label) => cy.tid('chat-menu').contains('[role=menuitem]', label);
const menuItems = () => cy.tid('chat-menu').find('[role=menuitem]').then(($i) => [...$i].map((i) => i.textContent.trim()));
/** Alex writes to Ed's agent in General. */
const alexAsks = (text) => {
  cy.signIn('Alex');
  cy.openConsole('#/chat');
  cy.chatRow(GENERAL).find('button.ch-row').click();
  cy.tid('chat-box').type(`@invoice-v2@ed-mbp ${text}{enter}`);
  cy.tid('chat-message').last().should('contain.text', text);
};
const asAlex = () => {
  cy.signIn('Alex');
  cy.openConsole('#/chat');
  cy.chatRow(AGENT).find('button.ch-row').click();
};
const asEd = () => {
  cy.signIn('Ed');
  cy.openConsole('#/chat');
  cy.chatRow(AGENT).find('button.ch-row').click();
};

describe('chat: a person writes to another person\'s agent', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('puts the first message to Ed\'s agent in a Direct Message that waits for Ed\'s approval', () => {
    alexAsks(ASK);
    cy.chatRow(AGENT).should('contain.text', 'Waiting for approval').and('contain.text', "You and Ed's agent");
    cy.chatRow(AGENT).find('button.ch-row').click();
    cy.tid('chat-thread').should('contain.text', "Alex (a person using Chat) writes to Ed's agent invoice-v2. Only Alex, Ed and an Admin can read this.");
    cy.tid('chat-message').should('have.length', 1).first().should('contain.text', ASK).and('contain.text', 'Waiting for Ed to approve it.');
    cy.contains('Waiting for Ed to approve your message. It is delivered once Ed allows it.');
    // Ed's own agents and conversations are not in Alex's lists.
    cy.chatRow('d:e2e-s-invoice+e2e-s-tester').should('not.exist');
    cy.chatRow('a:e2e-s-invoice').should('not.exist');
  });

  it('tells Ed in the sidebar and in My reporters, with Allow and Decline, and Decline delivers nothing', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.contains('a.ch-notice', '1 message from another person waits for your approval in My reporters.').should('have.attr', 'href', '#/me/reporters').click();
    cy.get('h1').should('have.text', 'My reporters');
    cy.get(REQUEST).should('have.length', 1).and('contain.text', 'Alex (a person using Chat) wants to send invoice-v2 a message.').and('contain.text', ASK).and('contain.text', 'Allow opens a link: Alex can message this agent until you pause or remove it. Decline delivers nothing.');
    cy.get(REQUEST).contains('button', 'Decline').click();
    cy.get(REQUEST).should('not.exist');
    // Alex hears it: the message is declined, and nothing was delivered.
    asAlex();
    cy.tid('chat-message').first().should('contain.text', 'Declined').and('contain.text', 'Ed declined it').and('contain.text', 'It was not delivered.');
  });

  it('opens a link when Ed allows the next message, and Alex may then write to the agent', () => {
    alexAsks('Second try: the unit tests, please.');
    cy.signIn('Ed');
    cy.openConsole('#/me/reporters');
    cy.get(REQUEST).should('have.length', 1).and('contain.text', 'Second try: the unit tests, please.');
    cy.get(REQUEST).contains('button', 'Allow').click();
    cy.get(REQUEST).should('not.exist');
    asAlex();
    cy.tid('chat-thread').should('not.contain.text', 'Waiting for Ed to approve');
    cy.chatRow(AGENT).should('not.contain.text', 'Waiting for approval').and('not.contain.text', 'Paused');
    cy.tid('chat-box').should('not.be.disabled').type('And the lint run too.{enter}');
    cy.tid('chat-message').last().should('contain.text', 'And the lint run too.');
    // The agent's owner reads the same conversation, named for the person first, and can only watch it.
    asEd();
    cy.chatRow(AGENT).should('contain.text', 'Alex, invoice-v2').and('contain.text', 'Alex and your agent');
    cy.tid('chat-thread').should('contain.text', 'And the lint run too.');
    cy.tid('chat-box').should('be.disabled').and('have.attr', 'placeholder', 'Read only');
    cy.contains('Only Alex writes in this conversation. You can pause or remove its link from the menu.');
  });

  it('lets the one who paused the link resume it, and nobody else', () => {
    asAlex();
    openMenu(AGENT);
    menuItems().should('deep.eq', ['Pause link', 'Remove link…', 'Delete conversation…']);
    cy.tid('chat-menu').contains('[role=menuitem]', 'Pause link').click();
    cy.chatRow(AGENT).should('contain.text', 'Paused');
    cy.tid('chat-box').should('be.disabled').and('have.attr', 'placeholder', 'Paused');
    // Ed sees Resume link, which says who paused it and does nothing.
    asEd();
    cy.chatRow(AGENT).should('contain.text', 'Paused');
    openMenu(AGENT);
    item('Resume link').should('contain.text', 'Paused by Alex. Only Alex can resume it.');
    item('Resume link').should('have.attr', 'aria-disabled', 'true');
    item('Resume link').click();
    cy.chatRow(AGENT).should('contain.text', 'Paused');
    cy.get('body').click(0, 0);
    asAlex();
    openMenu(AGENT);
    item('Resume link').should('not.have.attr', 'aria-disabled');
    item('Resume link').click();
    cy.chatRow(AGENT).should('not.contain.text', 'Paused');
    cy.tid('chat-box').should('not.be.disabled');
    // The owner pauses it too, and now only the owner can resume.
    asEd();
    openMenu(AGENT).contains('[role=menuitem]', 'Pause link').click();
    cy.chatRow(AGENT).should('contain.text', 'Paused');
    asAlex();
    openMenu(AGENT);
    item('Resume link').should('contain.text', 'Paused by Ed. Only Ed can resume it.');
    item('Resume link').should('have.attr', 'aria-disabled', 'true');
    cy.get('body').click(0, 0);
    cy.contains('Paused by Ed: messages are held. Only Ed can resume it.');
    asEd();
    openMenu(AGENT);
    item('Resume link').should('not.have.attr', 'aria-disabled');
    item('Resume link').click();
    cy.chatRow(AGENT).should('not.contain.text', 'Paused');
  });

  it('answers a person with the agent\'s own words, counted as new for them', () => {
    cy.signIn('Alex');
    cy.openConsole('#/chat');
    cy.chatRow(AGENT).find('.unread').should('not.exist');
    // The agent answers through its reporter's route, as podium_send to the person does.
    cy.request({ method: 'POST', url: '/api/fleet/sessions/e2e-s-invoice/peers/messages', headers: { 'X-Podium-Token': seeded().people.Ed.token }, body: { to: 'person:alex', text: 'Unit tests pass: 14 of 14.' }, log: false }).its('status', { log: false }).should('eq', 202);
    cy.chatRow(AGENT).find('.unread').should('have.text', '1').and('have.attr', 'aria-label', '1 new');
    cy.chatRow(AGENT).find('button.ch-row').click();
    cy.tid('chat-message').last().should('contain.text', 'invoice-v2').and('contain.text', 'Unit tests pass: 14 of 14.').and('not.contain.text', 'You');
    cy.chatRow(AGENT).find('.unread').should('not.exist');
  });

  it('lets either side remove the link, which only Ed opens again', () => {
    asAlex();
    openMenu(AGENT).contains('[role=menuitem]', 'Remove link…').click();
    cy.tid('chat-confirm').should('contain.text', 'Remove the link between Alex and invoice-v2?').and('contain.text', 'only Ed can open it again');
    cy.tid('chat-confirm').contains('button', /^Remove link$/).click();
    cy.chatRow(AGENT).should('contain.text', 'Link removed');
    cy.tid('chat-box').should('be.disabled').and('have.attr', 'placeholder', 'Link removed');
    cy.contains('The link was removed, so nothing can be sent. Only Ed can open it again.');
    openMenu(AGENT);
    menuItems().should('deep.eq', ['Delete conversation…']);
    cy.get('body').click(0, 0);
    // The conversation stays for both, and Ed has Allow again.
    asEd();
    cy.chatRow(AGENT).should('contain.text', 'Link removed');
    cy.tid('chat-thread').should('contain.text', 'Unit tests pass: 14 of 14.');
    openMenu(AGENT);
    menuItems().should('deep.eq', ['Allow again', 'Delete conversation…']);
    cy.tid('chat-menu').contains('[role=menuitem]', 'Allow again').click();
    cy.chatRow(AGENT).should('not.contain.text', 'Link removed');
    asAlex();
    cy.chatRow(AGENT).should('not.contain.text', 'Link removed');
    cy.tid('chat-box').should('not.be.disabled');
  });
});
