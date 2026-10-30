// SPEC 8.1 People view (#34): bands per person or group, order, collapse, and what the rail and activity panel follow.
describe('wall: people view', () => {
  before(() => cy.resetServer());
  beforeEach(() => cy.openConsole('#/'));

  const by = (label) => cy.get('[aria-label="Group by"]').contains('button', label);

  it('groups the wall in a band per person by default, with counts and the share of spend', () => {
    cy.get('button.bh').should('have.length', 2);
    cy.contains('button.bh', 'Ed').and('contain.text', 'ed-mbp, build-pi, ci-runner-01').and('contain.text', '10 live').and('contain.text', '5 waiting').and('contain.text', "Share of today's spend");
    cy.contains('button.bh', 'Alex').and('contain.text', 'Platform').and('contain.text', '1 live');
  });

  it('collapses and expands a band, and keeps that in podium.people', () => {
    cy.contains('button.bh', 'Alex').as('band').click();
    cy.get('#band-p_Alex').should('not.be.visible');
    cy.get('@band').should('have.attr', 'aria-expanded', 'false');
    cy.window().its('localStorage').invoke('getItem', 'podium.people').should('be.a', 'string');
    cy.reload();
    cy.contains('button.bh', 'Alex').should('have.attr', 'aria-expanded', 'false').click();
    cy.get('#band-p_Alex').should('exist');
  });

  it('groups by group and flat, and orders by name', () => {
    by('Group').click();
    cy.contains('button.bh', 'Platform');
    cy.contains('button.bh', 'Unassigned').should('exist');
    by('All').click();
    cy.get('button.bh').should('not.exist');
    cy.get('[aria-label="Order by"]').should('not.exist');
  });

  it('orders the bands by name or by what needs attention', () => {
    cy.get('button.bh').first().should('contain.text', 'Ed');
    cy.get('[aria-label="Order by"]').contains('button', 'Name').click();
    cy.get('button.bh').first().should('contain.text', 'Alex');
  });

  it('marks the person with sessions that need attention in the rail and narrows the wall from a rail header', () => {
    cy.get('#podium-rail-body').contains('button.rgh', 'Ed').and('contain.text', 'need attention');
    cy.get('#podium-rail-body').contains('button.rgh', 'Ed').click();
    cy.cards().should('have.length', 11);
    cy.get('#podium-rail-body').contains('button.ritem.all', 'All orchestrators').click();
    cy.cards().should('have.length', 12);
  });

  it('shows "Me" once signed in and narrows to the signed-in person\'s sessions', () => {
    cy.signIn('Ed');
    cy.openConsole('#/');
    cy.get('[aria-label="Group by"]').contains('button', 'Me').click();
    cy.cards().should('have.length', 11);
  });
});
