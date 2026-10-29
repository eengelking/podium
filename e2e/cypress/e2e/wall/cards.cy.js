// SPEC 8.1 Fleet wall > Session cards, status band, KPI tiles. The seed (scripts/e2e-seed.mjs) puts twelve sessions on the wall.
describe('wall: cards and KPI tiles', () => {
  before(() => {
    cy.resetServer();
  });
  beforeEach(() => cy.openConsole('#/'));

  it('shows the six KPI tiles with the seeded figures', () => {
    const tile = (label) => cy.contains('.kpi .k', label).parent();
    tile('Orchestrators live').find('.v').should('have.text', '12');
    tile('Orchestrators live').should('contain.text', '4 running · 6 waiting · 0 stale');
    tile('Subagents running').find('.v').should('have.text', '2');
    tile('Context blowouts').find('.v').should('have.text', '2');
    tile('Plan steps done').find('.v').should('have.text', '2/5');
    tile('Est. cost today').find('.v').invoke('text').should('match', /^\$\d/);
    tile('Tokens, last minute');
  });

  it('writes one status band per card in its own words', () => {
    cy.card('api').should('contain.text', 'Running');
    cy.card('docs').should('contain.text', 'Done');
    cy.card('question').should('contain.text', 'Waiting for your input.');
    cy.card('plan').should('contain.text', 'Waiting for your approval.');
    cy.card('tool').should('contain.text', 'Waiting for your approval.');
    cy.card('bg').should('contain.text', 'Waiting for 1 background shell to finish.');
    cy.card('invoice').should('contain.text', 'Delegating to 1 agent.');
  });

  it('shows the model chip, the machine, the project path, the branch and the git state', () => {
    cy.card('api').within(() => {
      cy.contains('Sonnet 5.5');
      cy.contains('ed-mbp');
      cy.contains('/Users/dev/api-gateway');
      cy.contains('feature/rate-limits');
      cy.contains('main checkout');
      cy.contains('1 modified');
      cy.get('.git span[title="Commits ahead of origin"]').invoke('text').should('match', /^\s*2\s*ahead\s*$/);
    });
    cy.card('invoice').within(() => {
      cy.contains('worktree · invoice-v2');
      cy.get('.git span[title="Commits ahead of origin"]').invoke('text').should('match', /^\s*7\s*ahead\s*$/);
    });
  });

  it('shows the plan title and current step, progress and the agent strip counts', () => {
    cy.card('invoice').within(() => {
      cy.contains('Migrate invoices to v2 schema · Port invoice endpoints');
      cy.contains('1/4');
      cy.contains('3 running · 1 done · 1 failed');
    });
    cy.card('api').should('contain.text', 'No plan reported. Agents were launched ad hoc.');
  });

  it('shows cost, tokens and context, with a level-2 blowout marked on the card', () => {
    cy.card('invoice').within(() => {
      cy.contains('$12.84');
      cy.contains('1.84M');
      cy.contains('41%');
      cy.contains('2×');
      cy.get('[aria-label="Effort: xhigh"]');
      cy.get('[role=img][aria-label="Context 41%"]');
    });
    cy.card('invoice').should('have.class', 'risk');
    cy.card('api').should('not.have.class', 'risk');
  });

  it('shows the effort meter with its level in the accessible name', () => {
    cy.card('api').find('[aria-label="Effort: medium"]').should('exist');
    cy.card('docs').find('[aria-label="Effort: high"]').should('exist');
  });

  it('cuts a very long name and branch without widening the card', () => {
    cy.card('long').then(($c) => {
      const card = $c[0].getBoundingClientRect();
      expect(card.width).to.be.lessThan(500);
      cy.wrap($c).find('*').each(($el) => {
        const r = $el[0].getBoundingClientRect();
        if (r.width > 0) expect(r.right, `${$el[0].className} stays inside its card`).to.be.at.most(card.right + 1);
      });
    });
  });

  it('copies the whole session id from the id button, and does not open the card', () => {
    cy.grantClipboard();
    cy.card('api').parent().find('button.sid').first().as('sid');
    cy.get('@sid').should('contain.text', 'e2e-s-ap').click();
    cy.get('@sid').should('contain.text', 'Copied');
    cy.window().then((win) => win.navigator.clipboard.readText()).should('eq', 'e2e-s-api-gateway');
    cy.get('main#podium-main h1').should('not.contain.text', 'api-gateway');
    cy.get('@sid').should('contain.text', 'e2e-s-ap');
  });

  it('opens the orchestrator page when a card is clicked', () => {
    cy.card('docs').click();
    cy.get('main#podium-main h1').should('have.text', 'docs-sweep');
    cy.location('hash').should('include', 'open=');
  });

  it('pins a card to its place with the pin button and unpins it', () => {
    cy.card('docs').parent().find('button.pin').as('pin');
    cy.get('@pin').click();
    cy.window().its('localStorage').invoke('getItem', 'podium.pins').should('include', 'e2e-s-docs-sweep');
    cy.get('@pin').should('have.attr', 'aria-pressed', 'true');
    cy.get('@pin').click();
    cy.window().its('localStorage').invoke('getItem', 'podium.pins').should('not.include', 'e2e-s-docs-sweep');
  });
});
