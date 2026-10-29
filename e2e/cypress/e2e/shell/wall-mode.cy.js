// SPEC 8.1 Shell > Wall mode. The real Fullscreen API is tried first: the browser in the Cypress image refuses a request that does
// not come from a real user gesture (Cypress clicks are synthetic) and the app is inside Cypress's iframe, so the first test checks
// that a refusal changes nothing. The other tests stub requestFullscreen and the fullscreen state so the app's own wall-mode
// handling is asserted. That the real browser goes fullscreen is checked by hand (docs/e2e/COVERAGE.md).
describe('wall mode', () => {
  before(() => cy.resetServer());

  const stubFullscreen = () =>
    cy.window().then((win) => {
      let element = null;
      Object.defineProperty(win.document, 'fullscreenElement', { configurable: true, get: () => element });
      win.document.documentElement.requestFullscreen = cy.stub().callsFake(() => {
        element = win.document.documentElement;
        win.document.dispatchEvent(new win.Event('fullscreenchange'));
        return Promise.resolve();
      }).as('requestFullscreen');
      win.document.exitFullscreen = cy.stub().callsFake(() => {
        element = null;
        win.document.dispatchEvent(new win.Event('fullscreenchange'));
        return Promise.resolve();
      }).as('exitFullscreen');
      win.__leaveFullscreen = () => {
        element = null;
        win.document.dispatchEvent(new win.Event('fullscreenchange'));
      };
    });
  const enter = () => cy.get('button[aria-label="Enter wall mode"]').click();
  const wallOn = () => cy.get('.podium').should('have.class', 'wall-on');
  const wallOff = () => cy.get('.podium').should('not.have.class', 'wall-on');

  it('still enters wall mode when the browser refuses real fullscreen (a refusal changes nothing)', () => {
    cy.openConsole('#/');
    cy.window().then((win) => cy.spy(win.document.documentElement, 'requestFullscreen').as('real'));
    enter();
    cy.get('@real').should('have.been.calledOnce');
    wallOn();
    cy.get('button[aria-label="Exit wall mode"]').should('exist');
    cy.get('body').type('{esc}');
    wallOff();
  });

  it('collapses the left pane, the right pane and the top bar, asks for fullscreen from that click, and Exit restores them', () => {
    cy.openConsole('#/');
    stubFullscreen();
    enter();
    cy.get('@requestFullscreen').should('have.been.calledOnce');
    wallOn();
    cy.get('#podium-top').should('not.be.visible');
    cy.get('#podium-rail-body').should('not.be.visible');
    cy.get('#podium-side-body').should('not.be.visible');
    cy.contains('Square color is the model').should('be.visible');
    cy.get('button[aria-label="Exit wall mode"]:visible').first().click();
    wallOff();
    cy.get('@exitFullscreen').should('have.been.called');
    cy.get('#podium-top').should('be.visible');
    cy.get('#podium-rail-body').should('be.visible');
    cy.get('#podium-side-body').should('be.visible');
  });

  it('leaves wall mode with Escape and when the browser leaves fullscreen', () => {
    cy.openConsole('#/');
    stubFullscreen();
    enter();
    wallOn();
    cy.get('body').type('{esc}');
    wallOff();
    enter();
    wallOn();
    cy.window().then((win) => win.__leaveFullscreen());
    wallOff();
  });

  it('returns each pane to its state from before, and does not remember wall mode over a reload', () => {
    cy.openConsole('#/');
    cy.get('button.edge-tab-left').click();
    stubFullscreen();
    enter();
    wallOn();
    cy.get('button[aria-label="Exit wall mode"]:visible').first().click();
    cy.get('#podium-rail-body').should('not.be.visible');
    cy.get('#podium-side-body').should('be.visible');
    enter();
    wallOn();
    cy.reload();
    wallOff();
  });

  it('hides the cursor and the wall mode buttons after 4 seconds without activity, and brings them back on movement', () => {
    cy.openConsole('#/');
    stubFullscreen();
    enter();
    cy.get('.podium.wall-on').should('not.have.class', 'idle');
    cy.get('.podium', { timeout: 10000 }).should('have.class', 'idle');
    cy.get('body').trigger('pointermove', 50, 50);
    cy.get('.podium').should('not.have.class', 'idle');
  });

  it('offers wall mode with the w key only while the Shortcuts switch is on', () => {
    cy.openConsole('#/');
    cy.get('body').type('w');
    cy.get('.podium').should('not.have.class', 'wall-on');
    cy.get('[role=switch]').click();
    stubFullscreen();
    cy.get('body').type('w');
    wallOn();
    cy.get('@requestFullscreen').should('not.have.been.called');
    cy.get('body').type('{esc}');
    wallOff();
  });

  it('puts the Wall mode button in the corner when the top bar is collapsed', () => {
    cy.openConsole('#/');
    cy.get('button.edge-tab-top').click();
    cy.get('.wall-ctl button[aria-label="Enter wall mode"]').should('be.visible');
  });

  it('offers wall mode on the board, and none on History', () => {
    cy.visit('/#/history');
    cy.get('button[aria-label="Enter wall mode"]').should('not.exist');
    cy.visit('/#/board');
    cy.get('button[aria-label="Enter wall mode"]').should('exist');
  });
});
