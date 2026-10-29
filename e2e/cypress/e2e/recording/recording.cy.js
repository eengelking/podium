// SPEC 8.1 Session recording (#353): choosing what to record, the notice that cannot be hidden, stop and delete, and replay.
describe('session recording', () => {
  before(() => cy.resetServer({ seedArgs: '--recording' }));

  const open = (key) => {
    cy.openConsole('#/');
    cy.card(key).click();
    cy.get('main#podium-main h1').should('exist');
  };
  const dialog = () => cy.get('[role=dialog]');
  const recordCell = () => cy.get('.fact.rec button[aria-haspopup="dialog"]');

  context('the notice that cannot be hidden', () => {
    it('puts a recording band on a recorded card, with no X and no switch', () => {
      cy.signIn('Ed');
      cy.openConsole('#/');
      cy.card('invoice').should('contain.text', 'Recording 3 of 5 loops');
      cy.card('invoice').parent().find('button.x, [role=switch]').should('not.exist');
    });

    it('shows the layer on the orchestrator page: what is kept, who started it, which loops are and are not recorded', () => {
      cy.signIn('Ed');
      open('invoice');
      cy.contains('This session is being recorded.');
      cy.contains('Recording: Orchestrator, Explore and fork.');
      cy.contains('Not recorded: general-purpose and pdf.');
      cy.contains('Ed started it at');
      cy.contains('The oldest part is deleted at');
      cy.contains('button', 'Stop recording');
      cy.contains('a, button', 'Open replay');
      cy.contains('button', 'Delete recording');
    });

    it('shows the layer to a stranger without any button', () => {
      open('invoice');
      cy.contains('This session is being recorded.');
      cy.contains('button', 'Stop recording').should('not.exist');
      cy.contains('a, button', 'Open replay').should('not.exist');
      cy.contains('button', 'Delete recording').should('not.exist');
    });
  });

  context('the Record picker', () => {
    it('asks a signed-out viewer to sign in', () => {
      open('api');
      recordCell().click();
      dialog().should('contain.text', 'Sign in to choose what to record.');
    });

    it('says the owner has not allowed recording when the reporter option is off, and offers nothing to press', () => {
      cy.signIn('Ed');
      open('api');
      recordCell().click();
      dialog().should('contain.text', "This session's reporter does not allow recording.").and('contain.text', 'sessionRecording');
      dialog().contains('button', 'Start recording').should('be.disabled');
      dialog().find('input[type=checkbox]').should('be.disabled');
    });

    it('says only the owner or an Admin can choose, to another signed-in person', () => {
      cy.signIn('Alex');
      open('api');
      recordCell().click();
      dialog().should('contain.text', "Only the session's owner or an Admin can choose what to record.");
    });

    it('says an ended session was not recorded, and offers no Record button', () => {
      cy.signIn('Ed');
      open('docs');
      cy.get('.fact.rec').should('contain.text', 'Not recorded').and('have.attr', 'title', 'This session ended without being recorded.');
      cy.get('.fact.rec button[aria-haspopup="dialog"]').should('not.exist');
    });

    it('starts a recording of the loops picked, and the wall card and the orchestrator page then say so', () => {
      cy.signIn('Ed');
      cy.reportAgain('arm', { sessionRecording: true });
      open('arm');
      recordCell().click();
      dialog().should('contain.text', 'Recording starts when you press Start. Nothing before it is kept.');
      dialog().find('input[type=checkbox]').should('have.length', 1).and('be.checked');
      dialog().contains('button', 'Start recording').click();
      dialog().should('contain.text', 'Recording started at').and('contain.text', 'Nothing before now was kept.');
      dialog().contains('button', 'Close').click();
      cy.contains('This session is being recorded.');
      cy.contains('button', 'Stop recording');
      cy.visit('/#/');
      cy.card('arm').should('contain.text', 'Recording everything');
    });

  });

  context('stop and delete', () => {
    it('asks before it stops, and Cancel changes nothing', () => {
      cy.signIn('Ed');
      open('invoice');
      cy.contains('button', 'Stop recording').click();
      cy.contains('Stop recording this session?');
      cy.contains('button', 'Cancel').click();
      cy.contains('Stop recording this session?').should('not.exist');
    });

    it('stops the recording and keeps what was recorded, with Open replay and Delete recording', () => {
      cy.signIn('Ed');
      open('invoice');
      cy.contains('button', 'Stop recording').click();
      cy.contains('.confirm, [role=group]', 'Stop recording this session?').contains('button', 'Stop recording').click();
      cy.contains('Ed stopped the recording at');
      cy.contains('What was recorded,').and('contain.text', 'is kept for troubleshooting');
      cy.contains('a, button', 'Open replay');
      cy.contains('button', 'Delete recording');
      cy.contains('button', 'Stop recording').should('not.exist');
    });
  });

  context('replay', () => {
    const openReplay = () => {
      cy.signIn('Ed');
      open('invoice');
      cy.contains('a, button', 'Open replay').click();
      cy.location('hash').should('match', /open=e2e-s-invoice&replay$/);
    };

    it('opens at the address with a back link, the rows oldest first and the loop name before each', () => {
      openReplay();
      cy.get('h1').should('have.text', 'invoice-v2');
      cy.contains('Replay of a recording');
      cy.contains('h2', 'Recorded activity');
      cy.contains('button.back', 'Back to invoice-v2');
      // Stopped in the test before this one, so the last row says who stopped it.
      cy.get('.feed li').last().should('contain.text', 'Recording stopped by Ed. Everything up to here was kept.');
      cy.contains('button', 'Show older');
    });

    it('survives a reload at the same address', () => {
      openReplay();
      cy.reload();
      cy.contains('Replay of a recording');
    });

    it('filters by loop, moves with the slider, and jumps to the next failure', () => {
      openReplay();
      cy.get('select[id$="-loop"]').find('option').then(($o) => expect([...$o].map((o) => o.textContent)).to.include.members(['All loops', 'Orchestrator']));
      // The loop filter narrows the rows: an agent's loop has far fewer than all loops, and the position text follows.
      cy.get('.scrub [role=status]').invoke('text').then((all) => {
        const total = Number(/of (\d+)/.exec(all)[1]);
        cy.get('select[id$="-loop"]').select('fork');
        cy.get('.scrub [role=status]').invoke('text').should((t) => expect(Number((/of (\d+)/.exec(t) || [])[1] ?? Infinity)).to.be.lessThan(total));
        cy.get('.feed li').each(($li) => expect($li.text()).to.contain('fork'));
        cy.get('select[id$="-loop"]').select('All loops');
      });
      // The slider moves the current row: the position text follows it.
      cy.get('input[type=range]').then(($i) => {
        // React ignores a plain assignment to a controlled input, so the value is set through the native setter, as a drag would.
        const win = $i[0].ownerDocument.defaultView;
        Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set.call($i[0], '3');
        $i[0].dispatchEvent(new win.Event('input', { bubbles: true }));
      });
      cy.get('.scrub [role=status]').should('not.contain.text', 'Row 1 of').and('contain.text', 'Row ');
      let before = '';
      cy.get('.scrub [role=status]').invoke('text').then((t) => {
        before = t;
      });
      // The newest rows hold no failed call; the button says so until older rows are loaded.
      cy.contains('button', 'Jump to next failure').should('be.disabled').and('have.attr', 'title').and('contain', 'No call failed in the rows loaded');
      cy.contains('button', 'Show older').click();
      cy.contains('button', 'Jump to next failure').should('be.enabled').click();
      // It lands on the failed call: the current row is the Bash call whose result failed, and the position moved.
      cy.get('.scrub [role=status]').should(($s) => expect($s.text()).not.to.eq(before));
      cy.contains('.feed li', 'expected currency USD').should('be.visible');
      cy.contains('Thinking: text is not available');
    });

    it('marks a compaction as its own row, apart from the row that says who stopped the recording', () => {
      openReplay();
      cy.contains('button', 'Show older').click();
      cy.get('.feed li.mark').contains('The conversation was compacted to fit the context window.');
      cy.get('.feed li.mark').contains('Recording stopped by Ed').should('exist');
      cy.get('.feed li.mark').filter(':contains("compacted")').should('have.length', 1);
    });

    it('goes back to the orchestrator page', () => {
      openReplay();
      cy.contains('button.back', 'Back to invoice-v2').click();
      cy.get('main#podium-main h1').should('have.text', 'invoice-v2');
      cy.location('hash').should('not.include', 'replay');
    });

    it('is refused to a signed-out viewer and to another person, at the same address', () => {
      cy.visit('/#/?open=e2e-s-invoice&replay');
      cy.contains('Sign in to open this recording');
      cy.signIn('Alex');
      cy.visit('/#/?open=e2e-s-invoice&replay');
      cy.contains('This session was recorded');
      cy.contains('Only Ed or an Admin can open the recording.');
    });

    it('opens for an Admin', () => {
      cy.signIn('Admin');
      cy.visit('/#/?open=e2e-s-invoice&replay');
      cy.contains('Replay of a recording');
    });
  });

  context('History and delete', () => {
    it('lists an ended session\'s recording as kept for its owner only', () => {
      cy.visit('/#/history');
      cy.contains('tr', 'old-run').should('not.contain.text', 'recording kept');
      cy.signIn('Ed');
      cy.visit('/#/history');
      cy.contains('tr', 'old-run').should('contain.text', 'recording kept until');
    });

    it('deletes a recording after asking, and the history row loses its line', () => {
      cy.signIn('Ed');
      cy.visit('/#/?open=e2e-s-old-run&replay');
      cy.contains('button', 'Delete recording').click();
      cy.contains('Delete this recording?');
      cy.contains('[role=group], .confirm', 'Delete this recording?').contains('button', 'Delete recording').click();
      cy.visit('/#/history');
      cy.contains('tr', 'old-run').should('not.contain.text', 'recording kept');
      cy.visit('/#/?open=e2e-s-old-run&replay');
      cy.contains('There is no recording to open');
    });
  });
});

// Turning the flag off drops what the server holds for recordings, so this runs on a server of its own.
describe('session recording: the Admin flag', () => {
  before(() => cy.resetServer({ seedArgs: '--recording' }));

  it('shows "Not recorded" with the reason and no Record button while the flag is off', () => {
    cy.signIn('Ed');
    cy.setFlags({ 'session-recording': false });
    cy.openConsole('#/');
    cy.card('api').click();
    cy.get('.fact.rec').should('contain.text', 'Not recorded').and('have.attr', 'title', 'Session recording is off on this server.');
    cy.get('.fact.rec button[aria-haspopup="dialog"]').should('not.exist');
  });
});

describe('session recording: choosing a subset of loops', () => {
  before(() => cy.resetServer({ seedArgs: '--rich' }));

  it('records only the loops picked: the card says "Recording 3 of 4 loops" and the layer names the one left out', () => {
    cy.signIn('Ed');
    cy.reportAgain('rich', { sessionRecording: true });
    cy.openConsole('#/?open=e2e-s-rich-plan');
    cy.get('.fact.rec button[aria-haspopup="dialog"]').click();
    cy.get('[role=dialog] input[type=checkbox]').should('have.length', 4).and('be.checked');
    cy.get('[role=dialog] input[type=checkbox]').last().uncheck();
    cy.get('[role=dialog]').contains('button', 'Start recording').click();
    cy.get('[role=dialog]').contains('Recording started at');
    cy.get('[role=dialog]').contains('button', 'Close').click();
    cy.contains('Not recorded:');
    cy.visit('/#/');
    cy.card('rich').should('contain.text', 'Recording 3 of 4 loops');
  });
});
