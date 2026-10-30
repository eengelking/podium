// SPEC 8.1 Orchestrator page: address, header, facts grid, status band, plan and files tabs, fold.
describe('orchestrator page', () => {
  before(() => cy.resetServer());

  const open = (key) => {
    cy.openConsole('#/');
    cy.card(key).click();
    cy.get('main#podium-main h1').should('exist');
  };

  it('keeps the open orchestrator in the address and reopens it on reload', () => {
    open('invoice');
    cy.location('hash').should('eq', '#/?open=e2e-s-invoice');
    cy.reload();
    cy.get('main#podium-main h1').should('have.text', 'invoice-v2');
  });

  it('goes back to the wall with the browser Back button', () => {
    open('invoice');
    cy.go('back');
    cy.location('hash').should('eq', '#/');
    cy.cards().should('have.length', 12);
    cy.go('forward');
    cy.get('main#podium-main h1').should('have.text', 'invoice-v2');
  });

  it('lands on the wall with a message for a session that is not in the fleet', () => {
    cy.visit('/#/?open=e2e-s-nope');
    cy.contains('That session is not in the fleet. Sessions that ended are listed in History.');
    cy.cards().should('have.length', 12);
  });

  it('shows the header: name, goal, directory, repository and git line', () => {
    open('invoice');
    cy.get('main#podium-main').within(() => {
      cy.get('h1').should('have.text', 'invoice-v2');
      cy.contains('Migrate invoices to v2 schema · now: Port invoice endpoints');
      cy.contains('/Users/dev/invoice-v2');
      cy.contains('acme/invoice-v2');
      cy.contains('refactor/invoice-v2');
      cy.contains('worktree · invoice-v2');
      cy.contains('3 modified');
    });
  });

  it('draws the three charts with their readouts', () => {
    open('invoice');
    for (const title of ['Tokens per second', 'Peak context, any loop', 'Subagents running']) {
      cy.contains(title).should('be.visible');
      cy.get(`svg[role=img][aria-label^="${title}, last 60 seconds"]`).should('be.visible');
    }
    cy.get('svg[role=img][aria-label^="Peak context, any loop"]').invoke('attr', 'aria-label').should('match', /peak \d+%/);
    cy.contains('60s ago');
  });

  it('fills the twelve facts cells', () => {
    open('invoice');
    cy.get('main#podium-main').within(() => {
      for (const label of ['Agents', 'Est. cost', 'Tokens', 'Running for', 'Agent time', 'Blowouts', 'Machine', 'System', 'Reporter', 'Session', 'Resume', 'Fork']) cy.contains(label);
      cy.contains('$12.84');
      cy.contains('1.84M');
      cy.contains('ed-mbp');
      cy.contains('macOS 26.1');
      cy.readFile('/repo/package.json').then((pkg) => cy.contains(pkg.version));
      cy.contains('1 failed');
    });
  });

  it('opens and closes the blowout detail from the Blowouts cell', () => {
    open('invoice');
    cy.contains('button.fact.blowcell', 'Blowouts').as('cell');
    cy.get('@cell').should('have.attr', 'aria-expanded', 'false').click().should('have.attr', 'aria-expanded', 'true');
    cy.get('@cell').invoke('attr', 'aria-controls').then((id) => cy.get(`[id="${id}"]`).should('be.visible').and('contain.text', 'Rewrite PDF renderer'));
    cy.get('@cell').click().should('have.attr', 'aria-expanded', 'false');
  });

  it('copies the session id from the Session cell and the resume and fork commands', () => {
    open('invoice');
    cy.grantClipboard();
    cy.get('button[aria-label="Session e2e-s-in, copy the full id"], button.cellbtn').contains('Session').click();
    cy.window().then((w) => w.navigator.clipboard.readText()).should('eq', 'e2e-s-invoice');
    cy.get('button[aria-label="Copy resume command"]').click();
    cy.window().then((w) => w.navigator.clipboard.readText()).should('match', /^cd .*claude --resume e2e-s-invoice/s);
    cy.get('button[aria-label="Copy fork command"]').click();
    cy.window().then((w) => w.navigator.clipboard.readText()).should('match', /--fork-session/);
  });

  it('shows the Resume popup on keyboard focus and closes it with Escape', () => {
    open('invoice');
    cy.get('button[aria-label="Copy resume command"]').focus();
    cy.contains('[role=tooltip]', 'Continues this same session in a new terminal').should('be.visible');
    cy.get('button[aria-label="Copy resume command"]').type('{esc}');
    cy.contains('[role=tooltip]', 'Continues this same session in a new terminal').should('not.be.visible');
  });

  it('writes the status band for the delegating session and for a waiting one', () => {
    open('invoice');
    cy.get('main#podium-main').contains('Delegating to 1 agent.');
    cy.contains('Delegating to 1 agent.').closest('div').should('contain.text', 'Port invoice endpoints');
    open('question');
    cy.get('main#podium-main').contains('Waiting for your input.');
  });

  it('lists the plan steps in order with their states and owners', () => {
    open('invoice');
    cy.get('[role=tabpanel]').first().within(() => {
      cy.contains('Migrate invoices to v2 schema');
      cy.contains('Port invoice endpoints').should('contain.text', 'in progress');
      cy.contains('Run staging backfill').should('contain.text', 'blocked');
      cy.contains('Write rollout notes').should('contain.text', 'not started');
      cy.contains('Map invoice call sites').should('contain.text', 'done');
      cy.contains('fork · Opus xhigh');
      cy.contains('Explore · Haiku low');
    });
    cy.get('[role=tab]').contains('Plan').parent().should('contain.text', '1/4');
  });

  it('switches between Plan and Files with the arrow keys and shows the file count', () => {
    open('invoice');
    cy.get('[role=tab]').contains('Files').invoke('text').should('match', /^Files\s*8$/);
    cy.get('[role=tab]').contains('Plan').focus().type('{rightarrow}');
    cy.get('[role=tab]').contains('Files').should('have.attr', 'aria-selected', 'true');
    cy.get('[role=tab]').contains('Files').type('{home}');
    cy.get('[role=tab]').contains('Plan').should('have.attr', 'aria-selected', 'true');
  });

  it('folds the plan and files column and remembers it in podium.planFiles.collapsed', () => {
    open('invoice');
    cy.get('button[aria-label="Hide plan and files"]').click();
    cy.window().its('localStorage').invoke('getItem', 'podium.planFiles.collapsed').should('eq', 'true');
    cy.get('button[aria-label="Show plan and files"]').should('exist');
    cy.reload();
    cy.get('button[aria-label="Show plan and files"]').click();
    cy.get('button[aria-label="Hide plan and files"]').should('exist');
  });

  it('shows the Files list with statuses, counts and a summary line', () => {
    open('invoice');
    cy.get('[role=tab]').contains('Files').click();
    cy.get('[role=tabpanel]').filter(':visible').within(() => {
      cy.contains('8 files');
      cy.contains('export.ts');
      cy.contains('binary');
      cy.contains('Sign in to open diffs.');
    });
  });

  it('shows the agent tree and sorts it by a column header, reverses it, and keeps children under their parent', () => {
    open('invoice');
    cy.contains('h2', 'Agents');
    cy.contains('4 launched, 1 by other agents');
    cy.get('button.trow').should('have.length', 5);
    const ids = () => cy.get('button.trow').then(($r) => [...$r].map((r) => r.id || 'root'));
    cy.contains('.trow.hd button', 'Context').click();
    ids().then((first) => {
      // The fork's child stays right under it, whatever the sort.
      expect(first[first.indexOf('row-e2e-a-port') + 1]).to.eq('row-e2e-a-pdf');
      cy.contains('.trow.hd button', 'Context').click();
      ids().then((second) => {
        expect(second[second.indexOf('row-e2e-a-port') + 1]).to.eq('row-e2e-a-pdf');
        expect(second.slice(1), 'the second click reverses the order').not.to.deep.eq(first.slice(1));
      });
    });
  });
});
