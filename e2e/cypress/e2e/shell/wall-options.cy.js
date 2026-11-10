// SPEC 8.1 Shell > the banner's display controls, folded into one Wall options drawer (#1129, mockup/podium-wall-options.html): shut on every page load as one
// "Wall options" pill; open, the pill is the collapse button at the drawer's left end, then Refresh every, Shortcuts, Theme and the Mode radios; it closes on the
// pill, a press outside and Escape (which puts focus back on the pill), and stays open for clicks inside. Every page that shows the banner renders it, and each
// control keeps its one stored setting, so a value set on one page shows on the others.
describe('wall options', () => {
  before(() => cy.resetServer());

  const pill = () => cy.displaySettings().find('.wallopts > button.edge-tab-opts');
  const body = () => cy.displaySettings().find('.wallopts-body');
  const shut = () => {
    pill().should('have.attr', 'aria-expanded', 'false').and('have.attr', 'aria-label', 'Wall options');
    body().should('not.be.visible');
  };
  const open = () => {
    pill().should('have.attr', 'aria-expanded', 'true').and('have.attr', 'aria-label', 'Hide wall options');
    body().should('be.visible');
  };

  // Every page that shows the banner. Traffic's address is retired and opens Chat (#1034), so it is checked at that address too.
  const PAGES = [
    { name: 'Live fleet', go: () => cy.openConsole('#/') },
    { name: 'Board', go: () => cy.openConsole('#/board') },
    {
      name: 'My reporters',
      go: () => {
        cy.signIn('Ed');
        cy.openConsole('#/me/reporters');
      },
    },
    {
      name: 'Traffic (opens Chat)',
      go: () => {
        cy.signIn('Ed');
        cy.openConsole('#/traffic');
        cy.location('hash').should('eq', '#/chat');
      },
    },
    {
      name: 'Chat',
      go: () => {
        cy.signIn('Ed');
        cy.openConsole('#/chat');
      },
    },
    { name: 'History', go: () => cy.openConsole('#/history') },
    { name: 'Admin', go: () => cy.openAdmin() },
  ];

  for (const page of PAGES) {
    it(`${page.name}: shows one Wall options pill, opens to the four controls in order, and the collapse button shuts it`, () => {
      page.go();
      // Shut: the one visible control in the banner is the pill, and it names the drawer it opens.
      shut();
      pill().should('have.attr', 'data-tip', 'Wall options');
      body().invoke('attr', 'id').then((id) => pill().should('have.attr', 'aria-controls', id));
      cy.displaySettings().find('button, select').filter(':visible').should('have.length', 1);
      pill().click();
      open();
      pill().should('have.attr', 'data-tip', 'Hide wall options');
      // The collapse button sits at the drawer's left end, before Refresh every.
      cy.displaySettings().find('.wallopts').children().first().should('have.class', 'edge-tab-opts');
      body().within(() => {
        cy.contains('label.field', 'Refresh every').find('select').should('be.visible');
        cy.get('[role=switch]').should('be.visible');
        cy.contains('label.field', 'Theme').find('select').should('be.visible');
        cy.get('[role=radiogroup][aria-label=Mode] [role=radio]').should('have.length', 3).and('be.visible');
      });
      body().invoke('text').should('match', /^Refresh every[\s\S]*Shortcuts[\s\S]*Theme[\s\S]*Light\s*Dark\s*System$/);
      pill().click();
      shut();
    });
  }

  it('closes on a press outside it, on the wall and on the banner\'s own text', () => {
    cy.openConsole('#/');
    cy.openWallOptions();
    cy.contains('Square color is the model').click();
    shut();
    cy.openWallOptions();
    cy.displaySettings().contains('b', 'Live fleet.').click();
    shut();
  });

  it('stays open for clicks inside it, a change of theme and mode included, and the change applies at once', () => {
    cy.openConsole('#/');
    cy.openWallOptions();
    cy.contains('label.field', 'Refresh every').find('select').select('5s');
    open();
    cy.shortcutsSwitch().click().should('have.attr', 'aria-checked', 'true');
    open();
    cy.contains('label.field', 'Theme').find('select').select('Nord');
    cy.get('html').should('have.attr', 'data-theme-name', 'nord');
    open();
    cy.get('[role=radiogroup][aria-label=Mode]').contains('[role=radio]', 'Dark').click();
    cy.get('html').should('have.attr', 'data-theme', 'dark');
    open();
  });

  it('closes on Escape and puts focus back on the pill', () => {
    cy.openConsole('#/');
    cy.openWallOptions();
    cy.get('[role=radiogroup][aria-label=Mode] [role=radio][aria-checked=true]').focus().type('{esc}');
    shut();
    cy.focused().should('have.attr', 'aria-label', 'Wall options').and('have.class', 'edge-tab-opts');
  });

  it('starts shut on every page load', () => {
    cy.openConsole('#/');
    cy.openWallOptions();
    cy.reload();
    shut();
  });

  it('shares each setting across pages: Refresh every and Shortcuts set on Admin show on Live fleet and History', () => {
    cy.openAdmin();
    cy.openWallOptions();
    cy.contains('label.field', 'Refresh every').find('select').should('have.value', '2').select('20s');
    cy.shortcutsSwitch().click().should('have.attr', 'aria-checked', 'true');
    cy.window().its('localStorage').invoke('getItem', 'podium.updateEvery').should('eq', '20');
    cy.window().its('localStorage').invoke('getItem', 'podium.shortcuts').should('eq', 'true');
    cy.openConsole('#/');
    cy.openWallOptions();
    cy.contains('label.field', 'Refresh every').find('select').should('have.value', '20');
    cy.shortcutsSwitch().should('have.attr', 'aria-checked', 'true');
    cy.visit('/#/history');
    cy.openWallOptions();
    cy.contains('label.field', 'Refresh every').find('select').should('have.value', '20');
    cy.shortcutsSwitch().should('have.attr', 'aria-checked', 'true');
  });

  it('fits at 400 px when open: no sideways page scroll, and every control and the banner text inside the window', () => {
    cy.atWidth(400);
    cy.openConsole('#/');
    cy.openWallOptions();
    cy.document().then((doc) => expect(doc.documentElement.scrollWidth, 'the page does not scroll sideways').to.be.at.most(doc.documentElement.clientWidth));
    cy.displaySettings().find('b, .edge-tab-opts, select, [role=switch], [role=radio]').each(($el) => {
      const r = $el[0].getBoundingClientRect();
      expect(r.left, `${$el[0].textContent.trim() || $el[0].tagName} starts inside the window`).to.be.at.least(0);
      expect(r.right, `${$el[0].textContent.trim() || $el[0].tagName} ends inside the window`).to.be.at.most($el[0].ownerDocument.documentElement.clientWidth);
    });
  });

  for (const mode of ['light', 'dark']) {
    for (const width of [1440, 400]) {
      it(`has no axe violation open, ${mode}, ${width} px`, () => {
        cy.atWidth(width);
        cy.openConsole('#/', { onBeforeLoad: (win) => win.localStorage.setItem('podium.theme', JSON.stringify({ theme: 'podium', mode })) });
        cy.get('html').should('have.attr', 'data-theme', mode);
        cy.openWallOptions();
        cy.checkA11y({ context: '[role=region][aria-label="Display settings"]' });
      });
    }
  }
});
