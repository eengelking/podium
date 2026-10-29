// SPEC 8.1 Fleet wall > Toolbar: status segments, Sort, the text filter and the shown/cleared count.
describe('wall: toolbar', () => {
  before(() => cy.resetServer());
  beforeEach(() => cy.openConsole('#/'));

  it('shows "N shown, M cleared today"', () => {
    cy.get('button.info').should('have.attr', 'aria-label', '12 shown, 0 cleared today');
  });

  it('narrows the wall with the status segments', () => {
    cy.contains('[aria-label="Filter by status"] button', 'Waiting').click();
    cy.cards().should('have.length', 7).each(($c) => expect($c.text()).to.match(/Waiting for/));
    cy.contains('[aria-label="Filter by status"] button', 'Running').click();
    cy.cards().should('have.length.greaterThan', 0).each(($c) => expect($c.text()).not.to.match(/Waiting for/));
    cy.contains('[aria-label="Filter by status"] button', 'Stale').click();
    cy.get('.none').should('contain.text', 'No orchestrators match. Clear the filter to see all 12.');
    cy.contains('[aria-label="Filter by status"] button', 'Blowouts').click();
    cy.cards().should('have.length', 1);
    cy.card('invoice').should('exist');
    cy.contains('[aria-label="Filter by status"] button', /^All$/).click();
    cy.cards().should('have.length', 12);
  });

  it('filters by name, project or branch', () => {
    cy.get('input[aria-label="Filter orchestrators"]').type('rate-limits');
    cy.cards().should('have.length', 1);
    cy.card('api').should('exist');
    cy.get('input[aria-label="Filter orchestrators"]').clear().type('/Users/dev/docs');
    cy.cards().should('have.length', 1);
    cy.card('docs').should('exist');
    cy.get('input[aria-label="Filter orchestrators"]').clear().type('no-such-thing');
    cy.get('.none').should('contain.text', 'No orchestrators match');
    cy.get('button.info').should('have.attr', 'aria-label', '0 shown, 0 cleared today');
  });

  const flat = () => cy.contains('.people button', /^All$/).click();
  const sortedBy = (label) => {
    flat();
    cy.get('#podium-sort').select(label);
    return cy.cards();
  };

  it('sorts by Cost, Context used and Context blowouts with the biggest first', () => {
    sortedBy('Cost').first().should('have.attr', 'data-session', 'e2e-s-invoice');
    cy.cards().eq(1).should('have.attr', 'data-session', 'e2e-s-docs-sweep');
    sortedBy('Context used').first().should('have.attr', 'data-session', 'e2e-s-invoice');
    sortedBy('Context blowouts').first().should('have.attr', 'data-session', 'e2e-s-invoice');
  });

  it('sorts by Model so the Sonnet session is apart from the Opus ones, and puts waiting sessions together under Status', () => {
    sortedBy('Model').then(($c) => {
      const ids = [...$c].map((c) => c.getAttribute('data-session'));
      const api = ids.indexOf('e2e-s-api-gateway');
      expect(api === 0 || api === ids.length - 1, 'the only Sonnet card is at one end').to.eq(true);
    });
    sortedBy('Status').then(($c) => {
      const waiting = [...$c].map((c) => /Waiting for/.test(c.textContent));
      const first = waiting.indexOf(true);
      const last = waiting.lastIndexOf(true);
      expect(waiting.slice(first, last + 1).every(Boolean), 'waiting cards are one run').to.eq(true);
    });
  });

  it('sorts by Newest and keeps every card, and offers the six sorts in order', () => {
    // Newest puts the session the server saw last first: the seed reports arm64-check last of Ed's, then Tester, and invoice-v2 first of all.
    sortedBy('Newest').should('have.length', 12).first().should('have.attr', 'data-session', 'e2e-s-arm64-check');
    cy.cards().eq(1).should('have.attr', 'data-session', 'e2e-s-tester');
    cy.cards().then(($c) => expect($c[$c.length - 1].getAttribute('data-session')).to.eq('e2e-s-invoice'));
    cy.get('#podium-sort option').then(($o) => expect([...$o].map((o) => o.textContent)).to.deep.eq(['Status', 'Model', 'Context blowouts', 'Context used', 'Cost', 'Newest']));
  });
});
