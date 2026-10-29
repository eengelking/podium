// SPEC 8.1 Orchestrator page > agent tree rows, Right panel > Agent detail, Report group, Tools used, Activity section.
describe('agent panel', () => {
  before(() => cy.resetServer());
  beforeEach(() => {
    cy.openConsole('#/');
    cy.card('invoice').click();
    cy.get('main#podium-main h1').should('have.text', 'invoice-v2');
  });
  const side = () => cy.get('#podium-side-body');
  const row = (id) => cy.get(`#row-${id}`);

  it('opens an agent panel from its tree row, with a Back button to the activity list', () => {
    row('e2e-a-port').click();
    side().within(() => {
      cy.contains('h3', 'Port invoice endpoints');
      cy.contains('Kind').parent().should('contain.text', 'Fork');
      cy.contains('Model').parent().should('contain.text', 'inherited');
      cy.contains('Launched by').parent().should('contain.text', 'the orchestrator');
      cy.contains('Tools used (12 calls)');
      cy.contains('Read').parent().invoke('text').should('match', /Read\s*8/);
      cy.contains('button', 'Back to activity').click();
    });
    side().contains('h2', 'Activity · invoice-v2');
  });

  it('shows a failed agent\'s failure box: class, call, output tail, evidence and what happened next', () => {
    row('e2e-a-fail').click();
    side().within(() => {
      cy.contains('Tool error');
      cy.contains('Failing call').parent().should('contain.text', 'Bash').and('contain.text', 'exit 1');
      cy.contains('npm run backfill:dry -- --env=staging');
      cy.contains('ECONNREFUSED 127.0.0.1:5432');
      cy.contains('same call failed 3 times');
      cy.contains('No retry is queued. The orchestrator carried on without this result.');
    });
  });

  it('opens the first failure from the red "1 failed" button in the Agents cell', () => {
    cy.contains('main#podium-main button', '1 failed').click();
    side().contains('h3', 'Backfill dry run');
  });

  it('shows a blowout box for an agent whose context overflowed', () => {
    row('e2e-a-pdf').click();
    side().within(() => {
      cy.contains('Context exceeded 2 times');
      cy.contains('Overflow #1 at 1.00M tokens, compacted to about 30%');
      cy.contains('1 overflow reported before Podium saw the details');
      cy.contains('Launched by').parent().should('contain.text', 'Port invoice endpoints');
    });
  });

  it('lists the agents an agent launched and opens one', () => {
    row('e2e-a-port').click();
    side().contains('button', 'Rewrite PDF renderer').click();
    side().contains('h3', 'Rewrite PDF renderer');
  });

  it('opens the orchestrator\'s own panel with its tools and skills', () => {
    cy.get('button.trow.root').click();
    side().within(() => {
      cy.contains('Role').parent().should('contain.text', 'Orchestrator');
      cy.contains('Tools used (19 calls)');
      cy.contains('Skills loaded').parent().should('contain.text', 'frontend-design').and('contain.text', 'code-review');
      cy.contains('Steps').parent().should('contain.text', '23 model requests');
    });
  });

  it('opens the Task prompt and the Final answer as a dialog with markdown, closes it three ways and returns focus', () => {
    row('e2e-a-map').click();
    side().contains('button.docbtn', 'Final answer').should('contain.text', 'excerpt only').click();
    cy.get('[role=dialog][aria-modal=true]').should('contain.text', 'Found 42 call sites across 9 modules.').and('contain.text', 'Showing the first 400 characters');
    cy.focused().closest('[role=dialog]').should('exist');
    cy.get('body').type('{esc}');
    cy.get('[role=dialog]').should('not.exist');
    cy.focused().should('contain.text', 'Final answer');
    side().contains('button.docbtn', 'Task prompt').click();
    cy.get('[role=dialog] button[aria-label*="Close"]').click();
    cy.get('[role=dialog]').should('not.exist');
    side().contains('button.docbtn', 'Task prompt').click();
    cy.get('.scrim').click('topLeft');
    cy.get('[role=dialog]').should('not.exist');
  });

  it('copies the raw text from the report dialog', () => {
    cy.grantClipboard();
    row('e2e-a-map').click();
    side().contains('button.docbtn', 'Final answer').click();
    cy.get('[role=dialog]').contains('button', 'Copy').click();
    cy.window().then((w) => w.navigator.clipboard.readText()).should('eq', 'Found 42 call sites across 9 modules.');
  });

  it('dims a report button that has no text and says why', () => {
    row('e2e-a-fail').click();
    side().contains('button.docbtn', 'Final answer').should('contain.text', 'not reported').and('be.disabled');
    row('e2e-a-port').click();
    side().contains('button.docbtn', 'Final answer').should('contain.text', 'not finished');
  });

  it('keeps the agent activity feed empty until entries arrive after the panel opened, then shows them', () => {
    row('e2e-a-port').click();
    side().contains('Watching from now. Earlier activity is not kept, and nothing is kept after you close this.');
    side().contains('Nothing yet');
    cy.reportAgain('invoice', {}, { 'e2e-a-port': { activity: [{ at: Date.now(), kind: 'tool', text: 'Edit src/invoice/totals.ts' }, { at: Date.now() + 1, kind: 'text', text: 'Renamed sum to total.' }] } });
    side().contains('Edit src/invoice/totals.ts', { timeout: 15000 });
    side().contains('Renamed sum to total.');
    side().contains('Last 2 of 2 since you started watching');
    side().contains('Kept only while someone is watching.');
  });

  it('says a finished agent has no more updates and offers no dropdown', () => {
    row('e2e-a-fail').click();
    side().contains('Agent finished, no more updates');
    side().find('select[aria-label="Refresh interval"]').should('not.exist');
  });

  it('expands the feed into a dialog', () => {
    row('e2e-a-port').click();
    side().contains('button', 'Expand').click();
    cy.get('[role=dialog]').should('contain.text', 'Watching from now');
    cy.get('body').type('{esc}');
    cy.get('[role=dialog]').should('not.exist');
  });

  it('remembers the feed refresh choice in podium.activityEvery', () => {
    row('e2e-a-port').click();
    side().find('select[aria-label="Refresh interval"]').select('20s');
    cy.window().its('localStorage').invoke('getItem', 'podium.activityEvery').should('eq', '20');
  });

  it('lists the events newest first and selects the agent a failure row is about', () => {
    side().within(() => {
      cy.contains('h2', 'Activity · invoice-v2');
      cy.get('button.evb').should('have.length', 3);
      cy.get('button.evb').first().should('contain.text', 'blowout #2').and('contain.text', 'Show context history');
      cy.contains('button.evb', 'Show root cause').click();
    });
    side().contains('h3', 'Backfill dry run');
  });

  it('shows the count footer and the memory note under the event list', () => {
    side().contains('Showing 3 of 3');
    side().contains('Only the latest 150 events are kept in memory.');
  });
});
