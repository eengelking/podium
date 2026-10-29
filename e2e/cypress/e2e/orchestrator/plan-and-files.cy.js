// SPEC 8.1 Plan section and agent tree: plan order (#454), plan complete, plan paging, Files paging, nested agents, Tools used, the activity list's paging.
describe('plan, files, agents and activity at size', () => {
  before(() => cy.resetServer({ seedArgs: '--rich' }));

  const open = (key = 'rich') => {
    cy.openConsole('#/');
    cy.card(key).click();
    cy.get('main#podium-main h1').should('have.text', key === 'rich' ? 'rich-plan' : 'many-steps');
  };
  const panel = () => cy.get('[role=tabpanel]').filter(':visible');

  it('lists open work first: in progress, then blocked, then pending in plan order, with the done steps last', () => {
    open();
    panel().find('li').first().should('contain.text', 'Step 10 of the migration').and('contain.text', 'in progress');
    panel().find('li').eq(1).should('contain.text', 'Step 11 of the migration').and('contain.text', 'blocked');
    panel().find('li').eq(2).should('contain.text', 'Step 12 of the migration').and('contain.text', 'not started');
    panel().find('li').eq(9).should('contain.text', 'Step 19 of the migration');
    cy.get('[role=tab]').contains('Plan').parent().should('contain.text', '9/23');
  });

  it('pages a plan of more than ten steps and keeps the done steps, oldest finish first, on the last page', () => {
    open();
    panel().contains('Showing 1–10 of 23');
    panel().contains('button', /^3$/).click();
    panel().contains('Showing 21–23 of 23');
    // Open work (14 steps) fills the first page and most of the second; the nine done steps follow in the order they finished.
    panel().find('li').first().should('contain.text', 'Step 7 of the migration').and('contain.text', 'done');
    panel().find('li').eq(2).should('contain.text', 'Step 9 of the migration');
    panel().contains('button', /^2$/).click();
    panel().find('li').eq(4).should('contain.text', 'Step 1 of the migration').and('contain.text', 'done');
    panel().contains('Showing 11–20 of 23');
    panel().find('li').first().should('contain.text', 'Step 20 of the migration');
  });

  it('says "plan complete" once every step is done, with the count at 23/23', () => {
    open();
    const all = Object.fromEntries(Array.from({ length: 23 }, (_, i) => [String(i + 1), 'done']));
    cy.reportAgain('rich', {}, null, all);
    cy.contains('plan complete', { timeout: 15000 }).should('exist');
    cy.get('[role=tab]').contains('Plan').parent().should('contain.text', '23/23');
  });

  it('pages the Files list 20 at a time with the totals above it', () => {
    open();
    cy.get('[role=tab]').contains('Files').click();
    panel().should('contain.text', '47 files');
    panel().contains('Showing 1–20 of 47');
    panel().contains('src/module01/');
    panel().contains('button', /^2$/).click();
    panel().contains('Showing 21–40 of 47');
    panel().contains('src/module21/');
    panel().contains('button', /^3$/).click();
    panel().contains('Showing 41–47 of 47');
    panel().contains('src/module47/');
  });

  it('nests agents under the agent that launched them, to any depth, and says how many were launched by others', () => {
    open();
    cy.contains('3 launched, 2 by other agents');
    cy.get('button.trow').then(($r) => {
      const ids = [...$r].map((r) => r.id || 'root');
      expect(ids).to.deep.eq(['root', 'row-e2e-r-a', 'row-e2e-r-b', 'row-e2e-r-c']);
    });
    // Each level of nesting starts its name further right: the orchestrator, then Level one, two and three.
    const nameLeft = (row, name) => cy.contains(row, name).then(($r) => {
      const w = $r[0].ownerDocument.createTreeWalker($r[0], NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent.includes(name)) { const r = $r[0].ownerDocument.createRange(); r.selectNodeContents(n); return r.getBoundingClientRect().left; }
      throw new Error(`no text ${name}`);
    });
    nameLeft('button.trow.root', 'rich-plan').then((root) => nameLeft('#row-e2e-r-a', 'Level one').then((one) => nameLeft('#row-e2e-r-b', 'Level two').then((two) => nameLeft('#row-e2e-r-c', 'Level three').then((three) => {
      expect(one, 'level one starts right of the orchestrator').to.be.greaterThan(root);
      expect(two).to.be.greaterThan(one);
      expect(three).to.be.greaterThan(two);
    }))));
    cy.get('#row-e2e-r-c').click();
    cy.get('#podium-side-body').should('contain.text', 'Level three').and('contain.text', 'Level two');
    cy.contains('Launched by').parent().should('contain.text', 'Level two');
  });

  it('shows the five most used tools and "Show all 8" for the rest, then "Show fewer"', () => {
    open();
    cy.get('button.trow.root').click();
    const side = () => cy.get('#podium-side-body');
    side().contains('Tools used (45 calls)');
    side().contains('button', 'Show all 8').should('have.attr', 'aria-expanded', 'false').click().should('have.attr', 'aria-expanded', 'true');
    side().contains('WebFetch');
    side().contains('button', 'Show fewer').click();
    side().contains('WebFetch').should('not.exist');
    side().contains('Read');
  });

  it('lists 12 events, then 12 more, then fewer, with the count in the footer', () => {
    open();
    cy.get('button.trow.root').click();
    cy.get('button[aria-label="Back to activity"], button.back').first().click({ force: true });
    const side = () => cy.get('#podium-side-body');
    side().contains('Showing 12 of 30');
    side().find('button.evb').should('have.length', 12);
    side().contains('button', 'Show 12 more').click();
    side().contains('Showing 24 of 30');
    side().find('button.evb').should('have.length', 24);
    side().contains('button', 'Show fewer').click();
    side().find('button.evb').should('have.length', 12);
  });
});
