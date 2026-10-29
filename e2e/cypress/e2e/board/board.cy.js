// SPEC 8.1 Kanban board (#346): columns, cards, the strip of sessions without steps, the switches, the KPI rows, narrow tabs and live movement.
// Order: the tests below run in order on one server, and a later one reads what an earlier one left (named where it matters); the file resets the server once, in `before`.
describe('board', () => {
  before(() => cy.resetServer());
  beforeEach(() => cy.openConsole('#/board'));

  const col = (name) => cy.get(`section.kb-col[aria-label^="${name},"]`);

  it('opens with both side panes collapsed and the top bar open', () => {
    cy.get('button.edge-tab-left').should('have.attr', 'aria-expanded', 'false');
    cy.get('button.edge-tab-right').should('have.attr', 'aria-expanded', 'false');
    cy.get('#podium-top').should('be.visible');
    cy.window().its('localStorage').invoke('getItem', 'podium.collapsed').should('be.null');
  });

  it('lists the five columns in order, each with its count', () => {
    cy.get('section.kb-col h3').then(($h) => expect([...$h].map((h) => h.textContent)).to.deep.eq(['Pending', 'In progress', 'Review', 'Blocked', 'Done']));
    col('Pending').should('have.attr', 'aria-label', 'Pending, 1 step');
    col('In progress').should('have.attr', 'aria-label', 'In progress, 1 step');
    col('Review').should('have.attr', 'aria-label', 'Review, 6 steps');
    col('Blocked').should('have.attr', 'aria-label', 'Blocked, 1 step');
    col('Done').should('have.attr', 'aria-label', 'Done, 1 step');
  });

  it('puts each plan step in the column of its state, with the live wording and the agent that owns it', () => {
    col('Pending').contains('a.kb-card', 'Write rollout notes');
    col('In progress').contains('a.kb-card', 'Porting invoice endpoints').and('contain.text', 'fork · Opus xhigh');
    col('Blocked').contains('a.kb-card', 'Run staging backfill');
    col('Done').contains('a.kb-card', 'Map invoice call sites').and('contain.text', 'Explore · Haiku low');
  });

  it('puts a waiting session in Review and says why it waits', () => {
    col('Review').within(() => {
      cy.contains('a.kb-card', 'claude-dashboard').and('contain.text', 'Waiting for your input').and('contain.text', 'AskUserQuestion: 3 questions');
      cy.contains('a.kb-card', 'push-branch').and('contain.text', 'Waiting for your approval').and('contain.text', 'Tool: Bash');
      cy.contains('a.kb-card', 'history-paging').and('contain.text', 'Waiting for your approval');
      cy.contains('a.kb-card', 'alex-session');
    });
  });

  it('opens that orchestrator\'s page from a card, and keeps the plain click in this tab', () => {
    col('In progress').contains('a.kb-card', 'Porting invoice endpoints').click();
    cy.get('main#podium-main h1').should('have.text', 'invoice-v2');
    cy.tid('page-pill').should('have.text', 'Orchestrator');
  });

  it('names a card by what it shows and its state', () => {
    col('Blocked').find('a.kb-card').first().invoke('text').should('match', /invoice-v2\s*Run staging backfill.*blocked/s);
  });

  it('lists sessions without open steps in a strip, with an (i) note that opens and closes', () => {
    cy.get('section[aria-label="Sessions with no open steps"]').within(() => {
      cy.contains('sessions have no open steps');
      cy.contains('a', 'api-gateway').and('contain.text', 'no plan');
      cy.contains('a', 'docs-sweep').and('contain.text', 'all done');
      cy.get('[role=note]').should('not.be.visible');
      cy.get('button[aria-label="How to get steps here"]').click().should('have.attr', 'aria-expanded', 'true');
      cy.get('[role=note]').should('be.visible').and('contain.text', 'CLAUDE_CODE_ENABLE_TODO_TOOLS=1');
    });
    cy.get('body').type('{esc}');
    cy.get('[role=note]').should('not.be.visible');
  });

  it('shows only the columns on Plans, and remembers the choice in podium.board', () => {
    cy.get('[aria-label="Sessions shown"]').contains('button', 'Plans').click();
    cy.get('section[aria-label="Sessions with no open steps"]').should('not.exist');
    // A session with no plan has no Review card on Plans.
    col('Review').should('not.contain.text', 'claude-dashboard');
    cy.window().its('localStorage').invoke('getItem', 'podium.board').then((raw) => expect(JSON.parse(raw).view).to.eq('plans'));
    cy.reload();
    cy.get('[aria-label="Sessions shown"] button[aria-pressed=true], [aria-label="Sessions shown"] [aria-checked=true]').should('contain.text', 'Plans');
    cy.get('[aria-label="Sessions shown"]').contains('button', /^All$/).click();
    cy.get('section[aria-label="Sessions with no open steps"]').should('exist');
  });

  it('puts a lane label before each orchestrator\'s cards under By orchestrator and drops the name from the card', () => {
    cy.get('[aria-label="Layout"]').contains('button', 'By orchestrator').click();
    cy.get('.kb-lane').should('contain.text', 'invoice-v2');
    col('In progress').find('a.kb-card .kb-title').should('not.exist');
    cy.window().its('localStorage').invoke('getItem', 'podium.board').then((raw) => expect(JSON.parse(raw).group).to.eq(true));
    cy.get('[aria-label="Layout"]').contains('button', 'Mixed').click();
    cy.get('.kb-lane').should('not.exist');
  });

  it('offers a Group dropdown once a session has a group, and narrows the cards to that group', () => {
    cy.get('select[aria-label="Group"]').select('Platform');
    col('Review').find('a.kb-card').should('have.length', 1).and('contain.text', 'alex-session');
    cy.get('select[aria-label="Group"]').select('All groups');
    col('Review').find('a.kb-card').should('have.length', 6);
  });

  it('has no "Whose sessions" switch until someone signs in, then narrows to the signed-in person\'s sessions', () => {
    cy.get('[aria-label="Whose sessions"]').should('not.exist');
    cy.signIn('Alex');
    cy.openConsole('#/board');
    cy.get('[aria-label="Whose sessions"]').contains('button', 'My orchestrators').click();
    col('Review').find('a.kb-card').should('have.length', 1).and('contain.text', 'alex-session');
    cy.get('[aria-label="Whose sessions"]').contains('button', 'Everyone').click();
    col('Review').find('a.kb-card').should('have.length', 6);
  });

  it('shows the eight running-count tiles for the whole fleet', () => {
    const tile = (label) => cy.contains('.kpis .kpi .k', label).parent();
    tile('Orchestrators live').find('.v').should('have.text', '12');
    tile('Orchestrators live').find('.kpi-cap').should('have.text', 'forks excluded');
    tile('Orchestrators running').find('.v').should('have.text', '4');
    tile('Orchestrators waiting').find('.v').should('have.text', '6');
    tile('Orchestrators with plans').find('.v').should('have.text', '1');
    tile('Orchestrators with plans').find('.kpi-cap').should('have.text', 'of 12 live');
    tile('Subagents live').find('.v').should('have.text', '4');
    tile('Subagents running').find('.v').should('have.text', '2');
    tile('Subagents waiting').find('.kpi-cap').should('have.text', 'queued');
    tile('Total cards').find('.v').should('have.text', '4');
    cy.get('.kpis').should('have.attr', 'aria-label', 'Orchestrators and subagents, plans and cards, whole fleet');
  });

  it('says "whole fleet" in every caption while a Group narrows the board', () => {
    cy.get('select[aria-label="Group"]').select('Platform');
    cy.get('.kpis .kpi-cap').each(($c) => expect($c.text()).to.eq('whole fleet'));
  });

  it('hides and shows the KPI rows and remembers it in podium.collapsed.board.kpis', () => {
    cy.get('button[aria-label="Hide KPI rows"]').should('have.attr', 'aria-expanded', 'true').click();
    cy.get('.kpis').should('not.be.visible');
    cy.window().its('localStorage').invoke('getItem', 'podium.collapsed.board.kpis').should('eq', 'true');
    cy.reload();
    cy.get('button[aria-label="Show KPI rows"]').click();
    cy.get('.kpis').should('be.visible');
  });

  it('keeps its own collapsed flags apart from the wall\'s', () => {
    cy.get('button.edge-tab-left').click();
    cy.window().its('localStorage').invoke('getItem', 'podium.collapsed.board').then((raw) => expect(JSON.parse(raw).left).to.eq(false));
    cy.window().its('localStorage').invoke('getItem', 'podium.collapsed').should('be.null');
  });

  it('turns the columns into one-at-a-time tabs at 640 px or less, with the counts kept', () => {
    cy.atWidth(600);
    cy.get('[role=tablist][aria-label="Board columns"]').should('be.visible');
    cy.get('[role=tab]').contains('Review').invoke('text').should('match', /^Review\s*6$/);
    cy.get('[role=tab]').contains('Blocked').click().should('have.attr', 'aria-selected', 'true');
    cy.get('section.kb-col.on').should('contain.text', 'Run staging backfill');
    cy.get('section.kb-col:not(.on)').should('not.be.visible');
  });

  it('moves a card to its new column without a reload and announces it politely', () => {
    col('In progress').contains('a.kb-card', 'Porting invoice endpoints');
    cy.reportAgain('invoice', {}, null, { 2: 'done' });
    col('Done').contains('a.kb-card', 'Port invoice endpoints', { timeout: 15000 });
    col('In progress').find('a.kb-card').should('have.length', 0);
    col('In progress').should('contain.text', 'Nothing in progress. Sessions are idle or between steps.');
    cy.get('[role=status][aria-label="Board updates"]').should('contain.text', 'moved to Done');
  });

  it('takes a finished plan\'s open work off the board: a done session with every step done leaves, and a running one keeps its done cards', () => {
    const all = { 1: 'done', 2: 'done', 3: 'done', 4: 'done' };
    cy.reportAgain('invoice', {}, null, all);
    col('Done').find('a.kb-card').should('have.length', 4);
    cy.reportAgain('invoice', { status: 'done', endReason: 'prompt_input_exit' }, null, all);
    col('Done').find('a.kb-card', { timeout: 15000 }).should('have.length', 0);
    cy.get('section.kb-col a.kb-card').filter(':contains("invoice-v2")').should('have.length', 0);
  });
});
