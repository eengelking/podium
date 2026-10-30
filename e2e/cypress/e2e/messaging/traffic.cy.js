// SPEC 8.1 Traffic page (#347, #417): the map, the table, the range, a conversation and the owner's pause and remove.
describe('traffic', () => {
  context('with eight messages between two orchestrators', () => {
    before(() => cy.resetServer({ seedArgs: '--talk' }));

    it('draws the map for everyone, signed in or not, but does not open the text for a stranger', () => {
      cy.openConsole('#/traffic');
      cy.get('h2#map-h').should('have.text', 'Who is talking');
      cy.contains('ci-runner-01');
      cy.contains('ed-mbp');
      cy.contains('4 messages');
      cy.contains('Please run the unit tests').should('not.exist');
    });

    it('opens the conversation for its owner: messages, delivery state and the round-trip bar', () => {
      cy.signIn('Ed');
      cy.openConsole('#/traffic');
      cy.get('h2#conv-h').should('contain.text', 'invoice-v2').and('contain.text', 'Tester');
      cy.contains('Please run the unit tests on this branch.');
      cy.contains('2 of 14 failed on Ubuntu 24.04.');
      cy.contains('Waiting: Tester is working. It gets this when its turn ends.');
      cy.get('[role=img][aria-label="2 of 10 round trips"]').should('exist');
      cy.contains('Conversations are kept for 30 days after their last message');
    });

    it('switches between Map and Table and between the ranges', () => {
      cy.signIn('Ed');
      cy.openConsole('#/traffic');
      cy.get('[role=radiogroup][aria-label=View]').contains('[role=radio]', 'Table').click();
      cy.get('table').should('exist').and('contain.text', 'Tester');
      cy.get('[role=radiogroup][aria-label=View]').contains('[role=radio]', 'Map').click();
      cy.get('[role=radiogroup][aria-label=Show]').contains('[role=radio]', 'Last 24 hours').click().should('have.attr', 'aria-checked', 'true');
      cy.contains('4 messages');
      cy.get('[role=radiogroup][aria-label=Show]').contains('[role=radio]', 'Last 30 days').click().should('have.attr', 'aria-checked', 'true');
    });

    it('pauses a link and resumes it, keeping the rights', () => {
      cy.signIn('Ed');
      cy.openConsole('#/traffic');
      cy.contains('button', 'Pause link').click();
      cy.contains('button', 'Resume link').should('be.visible');
      cy.contains('Paused');
      // The server holds it: a reload still shows the link paused.
      cy.reload();
      cy.contains('button', 'Resume link').should('be.visible');
      cy.contains('button', 'Resume link').click();
      cy.contains('button', 'Pause link').should('be.visible');
    });

    it('asks before it removes a link, and Keep it keeps it', () => {
      cy.signIn('Ed');
      cy.openConsole('#/traffic');
      cy.contains('button', 'Remove link…').click();
      cy.get('[role=group][aria-label="Remove the link"]').should('contain.text', 'Both directions lose every right');
      cy.contains('button', 'Keep it').click();
      cy.get('[role=group][aria-label="Remove the link"]').should('not.exist');
      cy.contains('button', 'Remove link…').should('be.visible');
    });

    it('removes a link after the owner confirms, and the conversation stays until it expires', () => {
      cy.signIn('Ed');
      cy.openConsole('#/traffic');
      cy.contains('button', 'Remove link…').click();
      cy.get('[role=group][aria-label="Remove the link"]').contains('button', /^Remove link$/).click();
      cy.get('[role=group][aria-label="Remove the link"]').should('not.exist');
      // The conversation stays until it expires; the rights are gone, so the link no longer lets either side send.
      cy.contains('Please run the unit tests on this branch.');
      cy.contains('2 of 14 failed on Ubuntu 24.04.');
      cy.reload();
      cy.contains('Please run the unit tests on this branch.');
      cy.visit('/#/me/reporters');
      cy.get('select[id="g-e2e0000mbp01-e2e0000ci001"]').find(':selected').should('have.text', 'No access');
      cy.get('select[id="g-e2e0000ci001-e2e0000mbp01"]').find(':selected').should('have.text', 'No access');
    });

    it('links to My reporters from the conversation', () => {
      cy.signIn('Ed');
      cy.openConsole('#/traffic');
      cy.contains('a.btn', 'Open My reporters').click();
      cy.get('h1').should('have.text', 'My reporters');
    });

    it('explains what a line means', () => {
      cy.openConsole('#/traffic');
      cy.get('h2#rules-h').should('have.text', 'What a line means');
      cy.contains('Pause link stops delivery at once and keeps the rights.');
    });
  });

  context('with nothing said yet', () => {
    before(() => cy.resetServer());
    it('says no orchestrator has messaged another, and where to choose who can talk', () => {
      cy.openConsole('#/traffic');
      cy.contains('No orchestrator has messaged another yet');
      cy.contains('Choose which reporters can talk in My reporters.');
    });
  });

  context('with orchestrator messaging off', () => {
    before(() => cy.resetServer({ seedArgs: '--flags none' }));
    it('has no Traffic button and says the feature is off on the page', () => {
      cy.openConsole('#/');
      cy.get('#podium-top').contains('a.btn', 'Traffic').should('not.exist');
      cy.visit('/#/traffic');
      cy.contains('Orchestrator messaging is off');
      cy.contains('An Admin turns it on in Admin > Settings > Feature flags.');
    });
  });
});
