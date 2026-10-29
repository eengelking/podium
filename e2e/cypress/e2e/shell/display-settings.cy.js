// SPEC 8.1 Shell > Refresh every, Shortcuts switch, Legend, panes, resizing and collapsing.
describe('display settings', () => {
  before(() => cy.resetServer());

  const shortcutSwitch = () => cy.get('[role=switch]');

  it('offers Refresh every 2s to 60s, defaults to 2s and remembers a change in podium.updateEvery', () => {
    cy.openConsole('#/');
    cy.contains('label.field', 'Refresh every').find('select').as('every');
    cy.get('@every').find('option').then(($o) => expect([...$o].map((o) => o.textContent)).to.deep.eq(['2s', '5s', '10s', '20s', '30s', '60s']));
    cy.get('@every').should('have.value', '2');
    cy.get('@every').select('10s');
    cy.window().its('localStorage').invoke('getItem', 'podium.updateEvery').should('eq', '10');
    cy.reload();
    cy.contains('label.field', 'Refresh every').find('select').should('have.value', '10');
  });

  it('ignores a stored refresh value that is not one of the six', () => {
    cy.visit('/', { onBeforeLoad: (win) => win.localStorage.setItem('podium.updateEvery', '7') });
    cy.contains('label.field', 'Refresh every').find('select').should('have.value', '2');
  });

  it('leaves the single-key shortcuts off until the Shortcuts switch is on', () => {
    cy.openConsole('#/');
    shortcutSwitch().should('have.attr', 'aria-checked', 'false');
    cy.get('body').type('[');
    cy.get('#podium-rail-body').should('be.visible');
    cy.get('button.edge-tab-left').should('have.attr', 'data-tip', 'Collapse the left pane');
    shortcutSwitch().click().should('have.attr', 'aria-checked', 'true');
    cy.window().its('localStorage').invoke('getItem', 'podium.shortcuts').should('eq', 'true');
    cy.get('body').type('[');
    cy.get('button.edge-tab-left').should('have.attr', 'aria-label', 'Expand the left pane').and('have.attr', 'data-tip', 'Expand the left pane ([)');
    cy.get('body').type('[');
    cy.get('button.edge-tab-left').should('have.attr', 'data-tip', 'Collapse the left pane ([)');
  });

  it('collapses and expands each pane and the top bar from its edge tab and remembers it in podium.collapsed', () => {
    cy.openConsole('#/');
    cy.get('button.edge-tab-left').click().should('have.attr', 'aria-expanded', 'false');
    cy.get('#podium-rail-body').should('not.be.visible');
    cy.get('button.edge-tab-right').click();
    cy.get('#podium-side-body').should('not.be.visible');
    cy.get('button.edge-tab-top').click();
    cy.get('#podium-top').should('not.be.visible');
    cy.get('button[aria-label="Show top bar"]').should('exist');
    cy.window().its('localStorage').invoke('getItem', 'podium.collapsed').then((raw) => expect(JSON.parse(raw)).to.deep.eq({ left: true, right: true, top: true }));
    cy.reload();
    cy.get('#podium-top').should('not.be.visible');
    cy.get('#podium-rail-body').should('not.be.visible');
    cy.get('button[aria-label="Show top bar"]').click();
    cy.get('button[aria-label="Expand the left pane"]').click();
    cy.get('button[aria-label="Expand the right pane"]').click();
    cy.get('#podium-top').should('be.visible');
    cy.get('#podium-rail-body').should('be.visible');
    cy.get('#podium-side-body').should('be.visible');
  });

  it('collapses the right pane with ] and the top bar with \\ once Shortcuts is on, and ignores both while typing in a field', () => {
    cy.openConsole('#/');
    cy.get('[role=switch]').click();
    cy.get('input[aria-label="Filter orchestrators"]').type('[]\\');
    cy.get('#podium-rail-body').should('be.visible');
    cy.get('#podium-side-body').should('be.visible');
    cy.get('#podium-top').should('be.visible');
    cy.get('input[aria-label="Filter orchestrators"]').should('have.value', '[]\\').clear().blur();
    cy.get('body').type(']');
    cy.get('#podium-side-body').should('not.be.visible');
    cy.get('button.edge-tab-right').should('have.attr', 'data-tip', 'Expand the right pane (])');
    cy.get('body').type('\\');
    cy.get('#podium-top').should('not.be.visible');
    cy.get('body').type('\\]');
    cy.get('#podium-top').should('be.visible');
    cy.get('#podium-side-body').should('be.visible');
  });

  it('keeps the legend under the middle column', () => {
    cy.openConsole('#/');
    cy.contains('Square color is the model').should('be.visible');
    cy.contains('Square color is the model').closest('div').should('contain.text', 'Opus').and('contain.text', 'Sonnet').and('contain.text', 'Haiku').and('contain.text', 'Fable');
    cy.contains('subagent (blank slate)').should('be.visible');
    cy.contains('fork (keeps context)').should('be.visible');
    cy.contains('queued').should('be.visible');
    // It sits under the middle column: between the rail and the right pane, not inside either.
    cy.contains('Square color is the model').then(($l) => {
      const l = $l[0].getBoundingClientRect();
      const rail = Cypress.$('#podium-rail-body')[0].getBoundingClientRect();
      const side = Cypress.$('#podium-side-body')[0].getBoundingClientRect();
      expect(l.left, 'right of the rail').to.be.at.least(rail.right - 1);
      expect(l.right, 'left of the right pane').to.be.at.most(side.left + 1);
    });
  });

  it('remembers a dragged pane width in the browser, apart from the collapsed flags, and brings it back after a reload and a collapse', () => {
    cy.openConsole('#/');
    cy.get('.rz-rail').focus().type('{rightarrow}{rightarrow}');
    cy.get('#podium-rail-body').should(($e) => expect($e.outerWidth()).to.be.closeTo(284, 1));
    // The width is kept in podium.panels, and podium.collapsed holds no width.
    cy.window().its('localStorage').invoke('getItem', 'podium.panels').then((raw) => expect(JSON.parse(raw).rail, 'saved rail width').to.be.closeTo(284, 1));
    cy.window().its('localStorage').invoke('getItem', 'podium.collapsed').should('be.null');
    cy.reload();
    cy.get('#podium-rail-body').should(($e) => expect($e.outerWidth()).to.be.closeTo(284, 1));
    cy.get('button.edge-tab-left').click();
    cy.get('button.edge-tab-left').click();
    cy.get('#podium-rail-body').should(($e) => expect($e.outerWidth(), 'its saved width comes back when it opens').to.be.closeTo(284, 1));
  });

  it('resets a dragged pane width with a double-click on its handle and moves it with the arrow keys', () => {
    cy.openConsole('#/');
    cy.get('.rz-rail').as('handle').focus().type('{rightarrow}');
    cy.get('#podium-rail-body').should(($e) => expect($e.outerWidth()).to.be.closeTo(268, 1));
    cy.get('@handle').type('{home}');
    cy.get('#podium-rail-body').should(($e) => expect($e.outerWidth()).to.be.closeTo(252, 1));
    cy.get('@handle').type('{shift}{rightarrow}');
    cy.get('#podium-rail-body').should(($e) => expect($e.outerWidth()).to.be.closeTo(300, 1));
    cy.get('@handle').dblclick();
    cy.get('#podium-rail-body').should(($e) => expect($e.outerWidth()).to.be.closeTo(252, 1));
  });

  it('lists the footer rows in the rail: credits, license, version and copyright', () => {
    cy.openConsole('#/');
    cy.get('#podium-rail-body').parent().within(() => {
      cy.contains('a', 'Theme credits').should('have.attr', 'href').and('include', 'THIRD_PARTY_NOTICES');
      cy.contains('a', 'License');
      cy.contains(/Podium v\d+\.\d+\.\d+/);
      cy.contains('Ed Engelking');
    });
  });
});
