// SPEC 8.1 Chat page (#1282, an @ in a Direct Message with an agent in it): Ed starts a conversation with Maya and two of his own agents (invoice-v2 on ed-mbp, Tester on ci-runner-01).
// Its header names the people and the number of agents and no longer says an Admin can read it; an @ (typed, or the Mention button) opens a list of its members alone; a message with no @
// is for every agent, one that names a member is for that member alone, and each shows a "For" line and a delivery line that name only the agents it was handed to; a name that is not a
// member, @group and @everyone are refused with 422 in words and store nothing; an agent that was written to answers in the conversation with its reporter token (#1299) and a
// conversation it was not written to in, or one that does not exist, is refused.
// Order: the tests are one story on one server (reset once, in `before`): each reads what the one before it left, and the conversation's id is read from the list once.

const API = '/api/fleet/respond/chat';
const H = { 'X-Podium-Respond': '1' };
const ROW = '[data-testid^="chat-row-v:"]';
const FIRST = 'Anyone on the release notes? mention-first-5e2a';
const NAMED = 'Please look at this one mention-named-9b4c';

let convo;

const open = () => {
  cy.signIn('Ed');
  cy.openConsole('#/chat');
  cy.get(ROW).find('button.ch-row').click();
  cy.tid('chat-conversation').should('exist');
};
const call = (method, url, body) => cy.request({ method, url: `${API}${url}`, headers: H, body, failOnStatusCode: false, log: false });

describe('chat: an @ in a conversation with an agent', () => {
  before(() => {
    cy.resetServer({ seedArgs: '--talk' });
    cy.addPerson('Maya');
  });

  it('starts a conversation with Maya and two agents, and its header names who is in it and says nothing of an Admin', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.chatRow('p:Maya').find('button.ch-row').click();
    cy.get('[role=dialog]').should('contain.text', 'New direct message');
    cy.tid('dm-form').find('input[type=checkbox][value="a:e2e-s-invoice"]').check();
    cy.tid('dm-form').find('input[type=checkbox][value="a:e2e-s-tester"]').check();
    cy.tid('dm-form').find('textarea').type(FIRST);
    cy.contains('[role=dialog] button', 'Send message').click();
    cy.get('[role=dialog]').should('not.exist');
    cy.tid('chat-conversation-privacy').should('have.text', ' You, Maya and 2 agents.').and('not.contain.text', 'Admin');
    cy.get(ROW).should('have.length', 1).find('button.ch-row').click();
    cy.request({ url: API, log: false }).its('body.conversations', { log: false }).should('have.length', 1).then((c) => {
      convo = c[0].id;
    });
  });

  it('hands a message with no @ to every agent and says it was for everyone', () => {
    open();
    cy.tid('chat-message').should('have.length', 1).first().should('contain.text', FIRST);
    cy.tid('chat-message').first().find('[data-testid=chat-for]').should('have.text', 'For everyone in this conversation');
    cy.tid('chat-message').first().find('[data-testid=chat-delivery]').should('contain.text', 'invoice-v2').and('contain.text', 'Tester');
  });

  it('narrows the @ list to the conversation\'s members, from the keyboard and from the Mention button', () => {
    open();
    cy.tid('chat-box').type('@');
    cy.tid('chat-listbox').should('be.visible').find('[role=option]').should('have.length', 3);
    cy.tid('chat-listbox').should('contain.text', '@invoice-v2@ed-mbp').and('contain.text', '@Tester@ci-runner-01').and('contain.text', '@Maya@console').and('not.contain.text', '@group').and('not.contain.text', 'arm64-check');
    cy.tid('chat-box').type('{esc}').clear();
    cy.tid('chat-tool-at').click();
    cy.tid('chat-box').should('have.value', '@');
    cy.tid('chat-listbox').should('be.visible').find('[role=option]').should('have.length', 3);
    cy.tid('chat-box').type('inv').type('{enter}');
    cy.tid('chat-box').should('have.value', '@invoice-v2@ed-mbp ');
    cy.tid('chat-box').clear();
  });

  it('opens the @ list again after each picked address, so three recipients go into one draft (#1343)', () => {
    open();
    cy.tid('chat-box').type('@');
    cy.tid('chat-listbox').should('be.visible').find('[role=option]').should('have.length', 3);
    cy.tid('chat-box').type('inv{enter}').should('have.value', '@invoice-v2@ed-mbp ');
    cy.tid('chat-box').type('@');
    cy.tid('chat-listbox').should('be.visible').find('[role=option]').should('have.length', 3);
    cy.tid('chat-box').type('Test{enter}').should('have.value', '@invoice-v2@ed-mbp @Tester@ci-runner-01 ');
    cy.tid('chat-box').type('@');
    cy.tid('chat-listbox').should('be.visible').find('[role=option]').should('have.length', 3);
    cy.tid('chat-box').type('Maya{enter}').should('have.value', '@invoice-v2@ed-mbp @Tester@ci-runner-01 @Maya@console ');
    cy.tid('chat-box').clear();
  });

  it('hands a message that names a member only to it, and shows who it was for and where it went', () => {
    open();
    cy.tid('chat-box').type(`@invoice-v2@ed-mbp ${NAMED}{enter}`);
    cy.tid('chat-message').should('have.length', 2).last().should('contain.text', NAMED);
    cy.tid('chat-message').last().find('[data-testid=chat-for]').should('have.text', 'For invoice-v2');
    cy.tid('chat-message').last().find('[data-testid=chat-delivery]').should('contain.text', 'invoice-v2').and('not.contain.text', 'Tester');
  });

  it('shows a person named with an @ the same way, and says no agent received it', () => {
    open();
    cy.tid('chat-box').type('@Maya@console are you free? mention-person-1d6e{enter}');
    cy.tid('chat-message').should('have.length', 3).last().find('[data-testid=chat-for]').should('have.text', 'For Maya. No agent received it.');
    cy.tid('chat-message').last().find('[data-testid=chat-delivery]').should('not.exist');
  });

  it('refuses a name that is not a member, @group and @everyone with 422 in words, and stores nothing', () => {
    expect(convo, 'the conversation id read earlier').to.be.a('string');
    cy.signIn('Ed');
    const refused = (text, words) => call('POST', `/conversations/${convo}/messages`, { text }).then((r) => {
      expect(r.status).to.eq(422);
      expect(r.body.error).to.contain(words);
    });
    refused('@arm64-check@build-pi hello', 'is not in this conversation, so nothing was sent');
    refused('@group hello', '@group and @everyone are not available in a Direct Message, so nothing was sent');
    refused('@everyone hello', '@group and @everyone are not available in a Direct Message, so nothing was sent');
    call('GET', `/conversations/${convo}/messages?limit=50`).its('body.messages', { log: false }).should('have.length', 3);
    open();
    cy.tid('chat-message').should('have.length', 3);
  });

  it('lets an agent that was written to answer in the conversation, shows it as the agent\'s, and refuses one that does not exist', () => {
    expect(convo, 'the conversation id read earlier').to.be.a('string');
    const ANSWER = 'All green here, answered by the agent convo-answer-7c3d';
    const post = (id, text) => cy.task('mod:post', { who: 'Ed', path: `/sessions/e2e-s-invoice/chat/conversations/${id}/messages`, body: { text } }, { log: false });
    post('cnv_nope', 'hi').its('status', { log: false }).should('eq', 404);
    post(convo, ANSWER).its('status', { log: false }).should('eq', 201);
    open();
    cy.tid('chat-message').should('have.length', 4).last().should('contain.text', ANSWER).and('contain.text', 'invoice-v2');
  });

  it('sends a message that names all three members, each picked from the list, and shows it for each (#1343)', () => {
    const MANY = 'All three of you, please mention-many-4f1a';
    open();
    for (const [find, name] of [['inv', 'invoice-v2@ed-mbp'], ['Test', 'Tester@ci-runner-01'], ['Maya', 'Maya@console']]) {
      cy.tid('chat-box').type('@');
      cy.tid('chat-listbox').should('be.visible').find('[role=option]').should('have.length', 3);
      cy.tid('chat-box').type(`${find}{enter}`).should('contain.value', `@${name} `);
    }
    cy.tid('chat-box').type(`${MANY}{enter}`);
    cy.tid('chat-message').should('have.length', 5).last().should('contain.text', MANY);
    cy.tid('chat-message').last().find('[data-testid=chat-for]').should('contain.text', 'invoice-v2').and('contain.text', 'Tester').and('contain.text', 'Maya');
  });
});
