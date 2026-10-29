// SPEC 8.1 Responding > The modal and The feed: answering for real. The answer goes through the server to the (simulated) reporter's next check-in, and the feed shows
// the entry Podium wrote, "You, from Podium:". What the console says when Podium cannot send is checked by making the route fail.
describe('respond: answering', () => {
  before(() => cy.resetServer());
  const open = (key) => {
    cy.signIn('Ed');
    cy.openConsole('#/');
    cy.card(key).parent().find('button.respond').click();
    cy.get('[role=dialog]').should('be.visible');
  };
  const dialog = () => cy.get('[role=dialog]');
  // The hook of the session's mod reads an ask's answer from the server (its long poll); this reads what that hook would be handed.
  const handedToHook = (interception, sessionKey) => {
    const askId = new URL(interception.request.url).pathname.split('/').at(-2);
    return cy.task('mod:get', { path: `/sessions/${sessionKey}/asks/${askId}/answer?wait=1` }).then((res) => {
      expect(res.status).to.eq(200);
      return res.body.delivery;
    });
  };

  beforeEach(() => {
    cy.intercept('POST', '**/asks/*/answer').as('answer');
    cy.intercept('POST', '**/messages').as('message');
  });

  it('approves a plan: the request carries the choice, the feed says so and the panel says it is sending', () => {
    open('plan');
    dialog().contains('button', 'Approve plan').click();
    cy.wait('@answer').then((i) => {
      expect(i.request.body).to.deep.include({ kind: 'plan-approve' });
      handedToHook(i, 'e2e-s-history-paging').then((d) => expect(d).to.deep.include({ kind: 'plan-approve', by: 'Ed' }));
    });
    dialog().should('contain.text', 'You, from Podium: approved the plan (and use auto mode)');
    dialog().should('contain.text', 'Sending to history-paging.');
    dialog().should('contain.text', 'If the terminal answers first, that answer stands and this one is dropped.');
  });

  it('allows a tool once', () => {
    open('tool');
    dialog().contains('button', /^Allow once$/).click();
    cy.wait('@answer').then((i) => {
      expect(i.request.body).to.deep.include({ kind: 'allow-once' });
      handedToHook(i, 'e2e-s-push-branch').then((d) => expect(d).to.deep.include({ kind: 'allow-once', by: 'Ed' }));
    });
    dialog().should('contain.text', 'You, from Podium: allowed once: git push -u origin issue/195-history-pages');
    dialog().should('contain.text', 'Sending to push-branch.');
  });

  it('denies a tool', () => {
    // The ask was answered by the test before, so the server starts again for a fresh one.
    cy.resetServer();
    open('tool');
    dialog().contains('label.opt', 'Deny').click();
    dialog().find('textarea[aria-label="Tell Claude why"]').type('not now');
    dialog().contains('button', /^Deny$/).click();
    // The reason goes to the reporter with the refusal.
    cy.wait('@answer').then((i) => {
      expect(i.request.body).to.deep.eq({ kind: 'deny', text: 'not now' });
      handedToHook(i, 'e2e-s-push-branch').then((d) => expect(d).to.deep.include({ kind: 'deny', text: 'not now', by: 'Ed' }));
    });
    dialog().should('contain.text', 'You, from Podium:').and('contain.text', 'denied');
  });

  it('submits the answers to a question, all of them at once', () => {
    open('question');
    dialog().contains('label.opt', '25/50/100').click();
    dialog().contains('button', 'Next').click();
    dialog().contains('label.opt', 'Keep it').click();
    dialog().contains('button', 'Next').click();
    dialog().contains('label.opt', 'The page number').click();
    dialog().contains('button', 'Next').click();
    dialog().contains('Submitting sends all three at once, as Claude Code does.');
    dialog().contains('button', 'Back').click();
    dialog().contains('What should Back restore?');
    dialog().contains('button', 'Next').click();
    dialog().contains('button', 'Submit answers').click();
    // One answer per question, each the option picked (all first options here).
    cy.wait('@answer').then((i) => {
      expect(i.request.body).to.deep.eq({ kind: 'question', answers: [{ options: [0] }, { options: [0] }, { options: [0] }] });
      // What the session's hook is handed is the same answer, from Ed.
      handedToHook(i, 'e2e-s-claude-dashboard').then((d) => {
        expect(d).to.deep.include({ kind: 'question', by: 'Ed' });
        expect(d.answers).to.deep.eq([{ options: [0] }, { options: [0] }, { options: [0] }]);
      });
    });
    dialog().should('contain.text', 'You, from Podium:');
    dialog().should('contain.text', 'Sending to claude-dashboard.');
  });

  it('sends a message to a session whose turn has ended, and shows it in the feed as the signed-in person\'s', () => {
    open('idle');
    dialog().find('textarea[aria-label="Message to turn-ended"]').type('hello there');
    dialog().contains('button', /^Send$/).click();
    cy.wait('@message').its('request.body').should('deep.eq', { text: 'hello there' });
    dialog().should('contain.text', 'You, from Podium: hello there');
    dialog().find('textarea').should('have.value', '');
    // The reporter's next check-in carries it, from Ed.
    cy.reportAgain('idle').then((checkIn) => {
      expect(checkIn.deliveries).to.have.length(1);
      expect(checkIn.deliveries[0]).to.deep.include({ by: 'Ed', kind: 'message', text: 'hello there' });
    });
  });

  it('sends /clear and /compact as commands, and the check-in carries them', () => {
    open('idle');
    dialog().find('textarea[aria-label="Message to turn-ended"]').type('/');
    dialog().contains('/clear').click();
    dialog().contains('button', /^Send$/).click();
    dialog().contains('Clear the conversation?').should('be.visible');
    dialog().contains('button', 'Clear conversation').click();
    cy.wait('@message').then((i) => {
      expect(i.request.body).to.deep.eq({ command: 'clear' });
      cy.reportAgain('idle').then((checkIn) => {
        // An unanswered earlier delivery is handed over again until the reporter says what it did with it, so the command is picked out.
        expect(checkIn.deliveries.filter((d) => d.kind === 'command')).to.have.length(1);
        expect(checkIn.deliveries.find((d) => d.kind === 'command')).to.deep.include({ by: 'Ed', command: 'clear' });
        // The reporter says it took the command: the feed notes the clear.
        cy.task('mod:post', { path: `/sessions/e2e-s-turn-ended/deliveries/${i.response.body.deliveryId}/result`, body: { result: 'took' } });
      });
    });
    dialog().contains('You, from Podium: /clear');
    dialog().contains('(the conversation was cleared; a new session id follows)', { timeout: 20000 });
  });

  it('sends /compact as a command with no confirmation, and the check-in carries it', () => {
    open('idle');
    dialog().find('textarea[aria-label="Message to turn-ended"]').type('/compact');
    dialog().contains('button', /^Send$/).click();
    dialog().contains('Clear the conversation?').should('not.exist');
    cy.wait('@message').its('request.body').should('deep.eq', { command: 'compact' });
    dialog().contains('You, from Podium: /compact');
    cy.reportAgain('idle').then((checkIn) => {
      expect(checkIn.deliveries.find((d) => d.kind === 'command' && d.command === 'compact')).to.deep.include({ by: 'Ed' });
    });
  });

  it('shows another person\'s message as "<Name>, from Podium:" in the owner\'s open feed', () => {
    open('idle');
    cy.task('respond:as', { as: 'Admin', path: '/sessions/e2e-s-turn-ended/messages', body: { text: 'from the admin' } }).its('status').should('eq', 202);
    dialog().contains('Admin, from Podium: from the admin', { timeout: 20000 });
  });

  it('says a message to a running session is queued until it is idle', () => {
    cy.signIn('Ed');
    cy.openConsole('#/?open=e2e-s-api-gateway');
    cy.get('button.trow.root').click();
    cy.get('#podium-side-body').contains('button', 'Expand').click();
    dialog().find('textarea').type('keep going');
    dialog().contains('button', /^Send$/).click();
    cy.wait('@message').then((i) => {
      expect(i.request.body).to.deep.eq({ text: 'keep going' });
      expect(i.response.body.queued, 'the server says it is queued: the session is running').to.eq(true);
      // The reporter says it queued it; the feed then carries the note.
      cy.task('mod:post', { path: `/sessions/e2e-s-api-gateway/deliveries/${i.response.body.deliveryId}/result`, body: { result: 'queued' } });
    });
    dialog().contains('(queued until the session is idle)', { timeout: 20000 });
  });

  it('shows an Admin their own message to someone else\'s session as "You, from Podium:", and the check-in names the Admin as its sender', () => {
    cy.signIn('Admin');
    cy.openConsole('#/');
    cy.card('idle').parent().find('button.respond').click();
    dialog().find('textarea').type('from the admin');
    dialog().contains('button', /^Send$/).click();
    dialog().should('contain.text', 'You, from Podium: from the admin');
    cy.reportAgain('idle').then((checkIn) => {
      expect(checkIn.deliveries.find((d) => d.text === 'from the admin')).to.deep.include({ by: 'Admin', kind: 'message' });
    });
  });

  const refused = (status, words) => {
    it(`says what happened when Podium cannot send (HTTP ${status})`, () => {
      cy.intercept('POST', '**/messages', { statusCode: status, body: { ok: false, error: 'no' } });
      open('idle');
      dialog().find('textarea').type('hello');
      dialog().contains('button', /^Send$/).click();
      dialog().should('contain.text', words);
      dialog().should('not.contain.text', 'You, from Podium: hello');
    });
  };
  refused(500, "Podium couldn't send that. Try again.");
  refused(422, "This session doesn't take that from Podium now. Answer it in the terminal.");
  refused(429, '20 messages are already waiting for this session. Send more once it has caught up.');
  refused(403, "Podium won't take this from you: it isn't your session, or responding was turned off.");
});
