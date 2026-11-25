// SPEC 8.1 Chat page (#1278, DECISIONS 74), Direct Messages as conversations of people and agents: Ed messages a person who has no orchestrator running (Maya) from People and agents,
// the first message is in his thread (its privacy line, and Edit message and Delete message in the menu a right-click on his own message opens, with no button for either, #1345), Maya sees the conversation in her list with an unread count and reading it
// clears the count, the same two members reuse one conversation (the dialog says so), a third person (Sam) added from the members panel reads it, a stranger and an Admin are answered 404
// for a conversation of people alone and an Admin browsing Ed's Chat is not shown it, and Leave conversation, in the "..." menu of its row in the list and as a button in the header, takes it out of the leaver's list.
// Order: the tests below are one story on one server (the file resets the server once, in `before`, and adds Maya and Sam): each reads what the one before it left, and the conversation's id
// is read from the list once the page has shown its row.

const API = '/api/fleet/respond/chat';
const H = { 'X-Podium-Respond': '1' };
const FIRST = 'Hello Maya, are you around for the review? conv-first-3d7a';
const SECOND = 'And a second line in the same conversation conv-second-8c1f';
const ROW = '[data-testid^="chat-row-v:"]';

let maya;
let sam;
let convo;

const openChat = (who) => {
  cy.signIn(who);
  cy.openConsole('#/chat');
  cy.chatRow('c:general').should('exist');
};
const openAs = (person) => {
  cy.signInAs(person);
  cy.openConsole('#/chat');
  cy.chatRow('c:general').should('exist');
};
/** A request as the signed-in browser's person; failOnStatusCode is off so a refusal can be read. */
const call = (method, url, body) => cy.request({ method, url: `${API}${url}`, headers: H, body, failOnStatusCode: false, log: false });
const send = (text) => {
  cy.tid('dm-form').find('textarea').type(text);
  cy.contains('[role=dialog] button', 'Send message').click();
  cy.get('[role=dialog]').should('not.exist');
};

describe('chat: a conversation of people', () => {
  before(() => {
    cy.resetServer({ seedArgs: '--talk' });
    cy.addPerson('Maya').then((p) => { maya = p; });
    cy.addPerson('Sam').then((p) => { sam = p; });
  });

  it('lets Ed message Maya, who has no orchestrator running, and shows his first message in his thread', () => {
    openChat('Ed');
    cy.chatRow('p:Maya').should('contain.text', 'Person').find('button.ch-row').click();
    cy.get('[role=dialog]').should('contain.text', 'New direct message');
    cy.tid('dm-form').find('input[type=checkbox]:checked').should('have.length', 1).and('have.value', 'p:Maya');
    cy.tid('dm-summary').should('have.text', 'To Maya.');
    cy.tid('dm-agent-warn').should('not.exist');
    cy.tid('dm-exists').should('not.exist');
    send(FIRST);
    cy.tid('chat-conversation').should('exist');
    cy.get('#th-h').should('contain.text', 'Maya');
    cy.tid('chat-conversation-privacy').should('contain.text', 'Only you and Maya can read this. An Admin cannot.');
    // The same menu as every other chat (#1345): a right-click, not a button under the message.
    cy.tid('chat-message').should('have.length', 1).first().should('contain.text', FIRST).and('not.contain.text', 'Edit message').rightclick();
    cy.get('[role=menu][aria-label="Your message"]').within(() => {
      cy.contains('[role=menuitem]', 'Edit message');
      cy.contains('[role=menuitem]', 'Delete message');
    });
    cy.get('#th-h').click();
    cy.get('[role=menu]').should('not.exist');
    cy.contains('button', 'Edit message').should('not.exist');
    cy.get(ROW).should('have.length', 1).find('button.ch-more').should('exist');
    cy.get('.ch-head-top').contains('button', 'Leave conversation').should('exist');
    cy.get('.ch-body').contains('button', 'Leave conversation').should('not.exist');
  });

  it('shows Maya the conversation with an unread count, and reading it clears the count', () => {
    openAs(maya);
    cy.get(ROW).should('have.length', 1).find('.unread').should('have.text', '1');
    cy.get(ROW).find('button.ch-row').click();
    cy.tid('chat-conversation-privacy').should('contain.text', 'Only you and Ed can read this. An Admin cannot.');
    cy.tid('chat-message').should('have.length', 1).first().should('contain.text', FIRST).and('contain.text', 'Ed');
    cy.get(ROW).find('.unread').should('not.exist');
    // The conversation's id, for the requests below: its row is on the page, so the list has it.
    cy.request({ url: API, log: false }).its('body.conversations', { log: false }).should('have.length', 1).then((c) => {
      convo = c[0].id;
    });
  });

  it('reuses the one conversation when Ed messages the same person again, and says so in the dialog', () => {
    openChat('Ed');
    cy.get(ROW).should('have.length', 1);
    cy.chatRow('p:Maya').find('button.ch-row').click();
    cy.tid('dm-exists').should('contain.text', 'You already have a conversation with Maya. Your message goes into it.');
    send(SECOND);
    cy.tid('chat-conversation').should('exist');
    cy.tid('chat-message').should('have.length', 2).last().should('contain.text', SECOND);
    cy.get(ROW).should('have.length', 1);
  });

  it('lets Ed add a third person from the members panel, who then reads it', () => {
    openChat('Ed');
    cy.get(ROW).find('button.ch-row').click();
    cy.tid('chat-message').should('have.length', 2);
    cy.tid('chat-members-toggle').click();
    cy.get('#ch-members').contains('button', 'Add people or agents').click();
    cy.get('[role=dialog]').should('contain.text', 'Add to this conversation');
    cy.tid('dm-form').find('textarea').should('not.exist');
    cy.tid('dm-form').find('input[type=checkbox][value="p:Sam"]').check();
    cy.tid('dm-summary').should('have.text', 'Add Sam to this conversation.');
    cy.contains('[role=dialog] button', /^Add$/).click();
    cy.get('[role=dialog]').should('not.exist');
    cy.tid('chat-conversation-privacy').should('contain.text', 'Only you and these 2 people can read this. An Admin cannot.');
    cy.get('#ch-members').should('contain.text', 'Sam').and('contain.text', 'Added by Ed');
    openAs(sam);
    cy.get(ROW).should('have.length', 1).find('button.ch-row').click();
    cy.tid('chat-message').should('have.length', 2).first().should('contain.text', FIRST);
    cy.tid('chat-message').last().should('contain.text', SECOND);
  });

  it('answers a stranger and an Admin with 404 for a conversation of people alone, and shows an Admin browsing Ed\'s Chat none of it', () => {
    expect(convo, 'the conversation id read earlier').to.be.a('string');
    const refused = (r) => {
      expect(r.status).to.eq(404);
      expect(r.body.error).to.eq('There is no such conversation.');
    };
    cy.signIn('Alex');
    call('GET', `/conversations/${convo}/messages?limit=50`).then(refused);
    call('POST', `/conversations/${convo}/messages`, { text: 'let me in' }).then(refused);
    cy.signIn('Admin');
    call('GET', `/conversations/${convo}/messages?limit=50`).then(refused);
    call('GET', `?owner=Ed`).its('body.conversations', { log: false }).should('have.length', 0);
    cy.openConsole('#/chat');
    cy.tid('chat-read-as').select('Ed');
    cy.chatRow('c:group').should('exist');
    cy.get(ROW).should('not.exist');
    cy.contains('Conversations between people are not shown to an Admin.').should('exist');
  });

  it('takes the conversation out of Ed\'s list when he leaves, and leaves it with the others', () => {
    openChat('Ed');
    cy.get(ROW).should('have.length', 1).find('button.ch-row').click();
    cy.get(ROW).find('button.ch-more').click();
    cy.contains('[role=menuitem]', 'Leave conversation').click();
    cy.get(ROW).should('not.exist');
    call('GET', `/conversations/${convo}/messages?limit=50`).its('status').should('eq', 404);
    openAs(maya);
    cy.get(ROW).should('have.length', 1);
  });
});
