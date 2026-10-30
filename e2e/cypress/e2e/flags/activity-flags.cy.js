// SPEC 8.1 Feature flags and Right panel > Activity section: the Agent activity feed and Bash output, each on, off, and on with the machine's option off.
describe('flags: activity feed and Bash output', () => {
  before(() => cy.resetServer());
  // A test that turns a flag off leaves it on for the next one, even when it fails half way.
  afterEach(() => cy.setFlags({ 'activity-feed': true, 'activity-output': true }));

  // A reporter whose activityOutput option is off sends the command and the exit, never the output.
  const bash = (withOutput = true) => ({ at: Date.now(), kind: 'tool', text: 'Bash npm test -- invoice', id: `toolu_e2e_flag_${Date.now()}`, command: 'npm test -- invoice', ...(withOutput ? { output: 'Tests  12 passed' } : {}), done: true, exitCode: 0 });
  const open = () => {
    cy.openConsole('#/');
    cy.card('invoice').click();
    cy.get('main#podium-main h1').should('have.text', 'invoice-v2');
    cy.get('#row-e2e-a-port').click();
  };
  const side = () => cy.get('#podium-side-body');
  const push = (agent, over = {}) => cy.reportAgain('invoice', over, { 'e2e-a-port': agent });

  context('activity-feed', () => {
    it('on: shows the list, the dropdown and Expand', () => {
      open();
      side().find('select[aria-label="Refresh interval"]').should('exist');
      side().contains('button', 'Expand').should('exist');
    });

    it('off: shows the Admin\'s note and no list, no dropdown and no Expand, in the panel and in the dialog', () => {
      cy.setFlags({ 'activity-feed': false });
      open();
      side().contains('The activity feed is turned off by the Admin.');
      side().contains('Someone with Admin access can turn it back on in Admin > Settings > Feature flags.');
      side().find('select[aria-label="Refresh interval"]').should('not.exist');
      side().contains('button', 'Expand').should('not.exist');
    });

    it('on again: the feed comes back without a reload', () => {
      cy.setFlags({ 'activity-feed': false });
      open();
      side().contains('The activity feed is turned off by the Admin.');
      cy.setFlags({ 'activity-feed': true });
      side().contains('button', 'Expand', { timeout: 20000 });
    });

    it('on, with the reporter\'s activityFeed option off: a dashed note names the option', () => {
      cy.reportAgain('invoice', { activityFeed: false });
      open();
      side().contains('Recent tool calls and text appear here while the agent works.');
      side().contains('activityFeed');
      side().find('select[aria-label="Refresh interval"]').should('not.exist');
      cy.reportAgain('invoice', { activityFeed: true });
    });
  });

  context('activity-output', () => {
    const openBashRow = (withOutput = true) => {
      open();
      side().contains('Watching from now');
      // Every report carries the reporter's options, so the one this test sets is sent again with the entry.
      push({ activity: [bash(withOutput)] }, { activityOutput: withOutput });
      side().contains('npm test -- invoice', { timeout: 20000 });
    };

    it('on, with the machine\'s option on: opens the row to the command, its output and its exit', () => {
      cy.setFlags({ 'activity-output': true });
      openBashRow();
      side().contains('npm test -- invoice').closest('li').find('button').first().click();
      side().contains('Tests  12 passed');
    });

    it('off by the Admin: says the output is turned off by the Admin', () => {
      cy.setFlags({ 'activity-output': false });
      openBashRow();
      side().contains('npm test -- invoice').closest('li').find('button').first().click();
      side().contains('Output is turned off by the Admin.');
      side().contains('Someone with Admin access can turn it on in Admin > Settings > Feature flags.');
    });

    it('on, with the machine\'s activityOutput option off: names the option', () => {
      openBashRow(false);
      side().contains('npm test -- invoice').closest('li').find('button').first().click();
      side().should(($s) => expect($s.text()).to.contain('Output is turned off for this machine.'));
      side().contains('activityOutput');
    });
  });
});
