// SPEC 8.1 Chat page (#1067): the "Chat with Agent" button on an orchestrator's page opens the person's own direct conversation with that agent in Chat.
// Order: the tests run in order on one server, and a later one reads what an earlier one left (named where it matters); the flag is restored after each test.
const ARM = 'e2e-s-arm64-check';
const DM = `d:dm:${ARM}|person:ed`;

const openPage = () => {
  cy.signIn('Ed');
  cy.openConsole(`#/?open=${ARM}`);
  cy.get('main#podium-main h1').should('have.text', 'arm64-check');
};

describe('chat: Chat with Agent on an orchestrator page', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));
  afterEach(() => cy.setFlags({ 'peer-messaging': true }));

  it('opens a conversation ready to start when there is no earlier one', () => {
    openPage();
    cy.contains('a.btn', 'Chat with Agent')
      .should('have.attr', 'href', `#/chat?with=${ARM}`)
      .and('have.attr', 'title', 'Open your direct chat with arm64-check in Chat')
      .click();
    cy.location('hash').should('eq', `#/chat?with=${ARM}`);
    cy.get('#th-h').should('have.text', 'arm64-check');
    cy.get('label').contains('Message arm64-check');
    cy.contains('No messages yet. Write the first one below.');
    cy.chatRow(DM).should('not.exist');
    // Opening one's own conversation raises no Admin notice.
    cy.tid('chat-reading-banner').should('not.exist');
    cy.tid('chat-box').type('Is the arm64 build ready?{enter}');
    cy.tid('chat-message').should('have.length', 1).first().should('contain.text', 'Is the arm64 build ready?');
    cy.chatRow(DM).should('exist');
  });

  it('opens the existing Direct Message with that agent (the one the test above started)', () => {
    openPage();
    cy.contains('a.btn', 'Chat with Agent').click();
    cy.get('#th-h').should('have.text', 'arm64-check');
    cy.tid('chat-message').should('have.length', 1).first().should('contain.text', 'Is the arm64 build ready?');
    cy.chatRow(DM).should('exist');
  });

  it('falls back to General for an id Chat does not list', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat?with=e2e-no-such-session');
    cy.get('#th-h').should('have.text', 'General');
  });

  it('is left off the page while orchestrator messaging is off', () => {
    cy.setFlags({ 'peer-messaging': false });
    openPage();
    cy.contains('a.btn', 'Chat with Agent').should('not.exist');
    // It comes back without a reload when messaging is turned on.
    cy.setFlags({ 'peer-messaging': true });
    cy.contains('a.btn', 'Chat with Agent', { timeout: 20000 });
  });
});
