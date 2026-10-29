// SPEC 8.1 Reporters page > Detail > Messaging (#416): the owner's rights drawn on a reporter's page, changes sent to the owner as proposals, Pause all links.
describe('admin: a reporter\'s Messaging section', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));
  const open = (machine = 'ed-mbp') => {
    cy.openAdmin('Reporters');
    cy.get(`button[aria-label="Open details for ${machine}"]`).click();
    cy.get('h3#rep-h1').should('exist');
  };
  const grid = () => cy.get('table.pm-grid');

  it('draws the owner\'s rights between their reporters, with the warnbar that a change is a proposal', () => {
    open();
    cy.contains('What Ed\'s reporters may do with each other. Only one person\'s own reporters can be linked.');
    cy.get('.warnbar').should('have.length', 1).and('contain.text', 'A change you make here is sent to Ed to accept.');
    grid().should('exist').and('contain.text', 'build-pi').and('contain.text', 'ci-runner-01').and('contain.text', 'ed-mbp');
  });

  it('shows a right the Admin proposed as Proposed, waiting for the owner', () => {
    open();
    grid().should('contain.text', 'Proposed: Can send, with approval, waiting for Ed');
  });

  it('proposes a change from a select: the page says it was sent to the owner and shows it as Proposed', () => {
    open();
    cy.get('select[id="g-e2e0000ci001-e2e0000pi001"]').select('Can see');
    cy.contains('Proposed to Ed: ci-runner-01 to build-pi, Can see.');
    grid().should('contain.text', 'Proposed: Can see, waiting for Ed');
  });

  it('switches between Grid and Board', () => {
    open();
    cy.get('[role=radiogroup][aria-label=View]').contains('[role=radio]', 'Board').click().should('have.attr', 'aria-checked', 'true');
    cy.get('table.pm-grid').should('not.exist');
    cy.get('[role=radiogroup][aria-label=View]').contains('[role=radio]', 'Grid').click();
    grid().should('exist');
  });

  it('pauses every link of the reporter at once and resumes them, with no answer needed', () => {
    open();
    cy.contains('button', 'Pause all links').click();
    cy.contains('button', 'Resume all links').should('be.visible');
    grid().contains('Paused').should('exist');
    cy.contains('button', 'Resume all links').click();
    cy.contains('button', 'Pause all links').should('be.visible');
  });

  it('shows a second warnbar and locks the choices while the owner has "Trust my own reporters" on', () => {
    cy.signIn('Ed');
    cy.request({ method: 'PUT', url: '/api/fleet/respond/peers/defaults', headers: { 'X-Podium-Respond': '1' }, body: { trust: true } }).its('status').should('eq', 200);
    open();
    cy.get('.warnbar').should('have.length', 2);
    cy.contains('.warnbar', 'Trust my own reporters is on for Ed.').should('contain.text', 'these choices are locked until Ed turns it off on My reporters.');
    cy.get('table.pm-grid select').each(($s) => expect($s).to.be.disabled);
  });

  it('says why a reporter that cannot message has nothing to set', () => {
    cy.resetServer({ seedArgs: '--talk --reporters' });
    open('old-box');
    cy.contains("old-box's reporter can't message");
  });
});
