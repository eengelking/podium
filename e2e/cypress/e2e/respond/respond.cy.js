// SPEC 8.1 Responding (#206): the Respond button on the band and its gating, the modal for each kind of ask, and the feed entry an answer leaves.
describe('respond', () => {
  before(() => cy.resetServer());
  const respondBtn = (key) => cy.card(key).parent().find('button.respond');
  const dialog = () => cy.get('[role=dialog]');

  context('the button', () => {
    beforeEach(() => cy.openConsole('#/'));
    // A test that narrows what the reporter accepts leaves the full set for the next one.
    afterEach(() => cy.reportAgain('question', { respond: { level: 'everything', accepts: ['question', 'plan-approve', 'plan-feedback', 'permission', 'message', 'command'], limits: [] } }));

    it('is live on every waiting card that has an ask or an idle turn, for a signed-out viewer', () => {
      respondBtn('question').invoke('text').should('match', /^Respond\s*3$/);
      respondBtn('plan').should('exist');
      respondBtn('tool').should('exist');
      respondBtn('idle').should('exist');
      respondBtn('alex').should('exist');
    });

    it('is not on a running card, a done card or a card waiting on background work', () => {
      respondBtn('api').should('not.exist');
      respondBtn('docs').should('not.exist');
      respondBtn('bg').should('not.exist');
    });

    it('is gone when the reporter cannot answer', () => {
      cy.reportAgain('question', { respond: null });
      respondBtn('question').should('not.exist');
      cy.reportAgain('question', { respond: { level: 'everything', accepts: ['question', 'plan-approve', 'plan-feedback', 'permission', 'message', 'command'], limits: [] } });
      respondBtn('question').should('exist');
    });

    it('is gone for an ask whose kind the reporter does not accept (its limits), and stays for the kinds it does', () => {
      cy.reportAgain('question', { respond: { level: 'everything', accepts: ['plan-approve', 'permission', 'message'], limits: [] } });
      respondBtn('question').should('not.exist');
      respondBtn('plan').should('exist');
      respondBtn('tool').should('exist');
    });

    it('leads a signed-out viewer to the sign-in form', () => {
      respondBtn('question').click();
      dialog().should('contain.text', 'Sign in to respond').and('contain.text', "the same ones as your podium-reporter's userName and token options");
      dialog().find('input[type=password]').should('exist');
      dialog().find('textarea').should('not.exist');
    });

    it('is dimmed on someone else\'s session when signed in, with the owner named', () => {
      cy.signIn('Ed');
      cy.openConsole('#/');
      cy.card('alex').parent().within(() => {
        cy.contains("Alex's session");
        cy.get('button.respond').should('have.attr', 'title').and('contain', 'Only Alex, who owns this session, or an Admin can respond.');
      });
      respondBtn('question').should('not.have.class', 'dimmed');
    });

    it('is live on every waiting card for the Admin', () => {
      cy.signIn('Admin');
      cy.openConsole('#/');
      respondBtn('alex').should('exist');
      cy.card('alex').parent().should('not.contain.text', "Alex's session");
    });

    it('also opens from the orchestrator page\'s status band', () => {
      cy.signIn('Ed');
      cy.openConsole('#/');
      cy.card('question').click();
      cy.get('main#podium-main').contains('button', 'Respond').click();
      dialog().should('contain.text', 'How many History rows per page?');
    });
  });

  context('the modal', () => {
    beforeEach(() => {
      cy.signIn('Ed');
      cy.openConsole('#/');
    });

    it('answers a question: tabs, options, a typed answer, a review step and Send', () => {
      respondBtn('question').click();
      dialog().find('[role=tablist][aria-label=Questions] [role=tab]').then(($t) => expect([...$t].map((t) => t.textContent)).to.deep.eq(['Page size', 'Day selector', 'Back state', 'Review']));
      dialog().contains('How many History rows per page?');
      dialog().contains('label.opt', '25/50/100, default 50').click();
      dialog().contains('button', 'Next').click();
      dialog().contains('Keep the day selector once it is paged?');
      dialog().contains('label.opt', 'Type something').find('input[type=radio]').click({ force: true });
      dialog().find('input[aria-label="Your own answer"]').type('Keep it');
      dialog().contains('button', 'Next').click();
      dialog().contains('Pick any that apply.');
      dialog().contains('label.opt', 'The page number').click();
      dialog().contains('button', 'Next').click();
      dialog().contains('Review your answers');
      dialog().contains('dt', 'How many History rows per page?').next().should('contain.text', '25/50/100, default 50');
      dialog().contains('dt', 'Keep the day selector once it is paged?').next().should('contain.text', 'Keep it');
      dialog().contains('dt', 'What should Back restore?').next().should('contain.text', 'The page number');
      dialog().contains('button', /^Submit answers$/).should('exist');
    });

    it('shows a plan to approve with three ways to approve it and a way to keep planning', () => {
      respondBtn('plan').click();
      dialog().should('contain.text', 'Ready to code?').and('contain.text', 'Paginate the History page').and('contain.text', '/.claude/plans/e2e-plan.md');
      dialog().should('contain.text', 'Yes, and use auto mode').and('contain.text', 'Yes, auto-accept edits').and('contain.text', 'Yes, manually approve edits').and('contain.text', 'No, keep planning');
      dialog().contains('button', 'Approve plan').should('exist');
      dialog().contains('Editing the plan text (Ctrl+G) is only in the terminal.');
    });

    it('shows a tool permission with the command, Allow once and Deny, and says "Always allow" is terminal only', () => {
      respondBtn('tool').click();
      dialog().should('contain.text', 'Bash wants to run a command').and('contain.text', 'git push -u origin issue/195-history-pages').and('contain.text', 'Push the branch to GitHub');
      dialog().should('contain.text', 'Allow once').and('contain.text', 'Runs this command now. The next one asks again.');
      dialog().should('contain.text', 'Deny').and('contain.text', 'Claude is told no and keeps going.');
      dialog().should('contain.text', '"Always allow" changes the session\'s rules, so it is only in the terminal.');
    });

    it('offers a message box for a session whose turn has ended, and sends a message', () => {
      respondBtn('idle').click();
      dialog().find('textarea[aria-label="Message to turn-ended"]').type('Please continue with the tests.');
      dialog().contains('button', /^Send$/).click();
      dialog().should('contain.text', 'You, from Podium:').and('contain.text', 'Please continue with the tests.');
    });

    it('lists the commands /clear and /compact for an idle session', () => {
      respondBtn('idle').click();
      dialog().find('textarea[aria-label="Message to turn-ended"]').type('/');
      dialog().should('contain.text', '/clear').and('contain.text', '/compact');
    });

    it('closes with Esc, the X and a click on the dimmed area', () => {
      respondBtn('idle').click();
      cy.get('body').type('{esc}');
      dialog().should('not.exist');
      respondBtn('idle').click();
      dialog().find('button.x').click();
      dialog().should('not.exist');
      respondBtn('idle').click();
      cy.get('.scrim').click('topLeft');
      dialog().should('not.exist');
    });
  });

  context('when the Admin has turned respond off', () => {
    it('shows no Respond button anywhere', () => {
      cy.setFlags({ respond: false });
      cy.openConsole('#/');
      cy.get('button.respond').should('not.exist');
    });
    afterEach(() => cy.setFlags({ respond: true }));
  });
});
