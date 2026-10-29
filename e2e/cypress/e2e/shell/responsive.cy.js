// SPEC 8.1 Shell > Columns, Wall (#145), Legend and Accessibility and responsiveness: what only a browser's layout can check. Nothing here is a unit-test duplicate:
// jsdom does no layout.
describe('responsive layout', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  const noPageScroll = () => cy.document().then((doc) => expect(doc.documentElement.scrollWidth, 'the page does not scroll sideways').to.be.at.most(doc.documentElement.clientWidth));

  // Each page is measured only once its real content is on it, so a half-loaded page cannot pass.
  const PAGES = {
    '#/': () => cy.cards().should('have.length', 12),
    '#/board': () => cy.get('section.kb-col a.kb-card').should('have.length.greaterThan', 5),
    '#/history': () => cy.get('table.htable tbody tr').should('have.length.greaterThan', 0),
    '#/traffic': () => cy.contains('4 messages').should('exist'),
    '#/me/reporters': () => cy.get('table.ptab tbody tr').should('have.length', 3),
    '#/?open=e2e-s-invoice': () => cy.contains('.fact', 'Est. cost').should('exist'),
  };
  for (const [hash, ready] of Object.entries(PAGES)) {
    it(`${hash} has no horizontal page scroll at 400 px`, () => {
      cy.atWidth(400);
      cy.signIn('Ed');
      cy.visit(`/${hash}`);
      ready();
      noPageScroll();
    });
  }

  it('Admin has no horizontal page scroll at 400 px', () => {
    cy.atWidth(400);
    cy.openAdmin('Settings');
    cy.get('[role=switch]').should('have.length.greaterThan', 5);
    noPageScroll();
    cy.adminPage('Reporters');
    cy.get('table tbody tr').should('have.length', 4);
    noPageScroll();
  });

  it('does not let the top bar\'s collapse tab overlap its buttons at any width below 1040 px (#787)', () => {
    for (const w of [400, 520, 640, 760, 900, 1039]) {
      cy.atWidth(w);
      cy.openConsole('#/');
      cy.get('button.edge-tab-top').then(($tab) => {
        const t = $tab[0].getBoundingClientRect();
        cy.get('#podium-top > a, #podium-top > button:not(.edge-tab), #podium-top > .pill').each(($el) => {
          const r = $el[0].getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return;
          const overlap = r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top;
          expect(overlap, `${$el[0].textContent.trim() || $el[0].className} overlaps the collapse tab at ${w} px`).to.eq(false);
        });
      });
    }
  });

  it('stacks the panes at 1040 px and below: no resize handles, no wall mode button, the legend last', () => {
    cy.atWidth(1000);
    cy.openConsole('#/');
    cy.get('.rz').should('not.be.visible');
    cy.get('button[aria-label="Enter wall mode"]').should('not.be.visible');
    cy.get('#podium-rail-body').then(($r) => cy.get('#podium-main').then(($m) => expect($r[0].getBoundingClientRect().top).to.be.lessThan($m[0].getBoundingClientRect().top)));
    cy.contains('Square color is the model').then(($l) => cy.cards().last().then(($c) => expect($l[0].getBoundingClientRect().top).to.be.greaterThan($c[0].getBoundingClientRect().bottom - 1)));
  });

  it('shows resize handles from 1041 px', () => {
    cy.atWidth(1100);
    cy.openConsole('#/');
    cy.get('.rz-rail').should('be.visible');
    cy.get('.rz-side').should('be.visible');
  });

  // The columns are worked out in the browser from the wall's width, so each check retries until the layout has settled.
  const columnsAre = (n) => cy.cards().should(($c) => expect(new Set([...$c].map((c) => Math.round(c.getBoundingClientRect().left))).size).to.eq(n));

  it('draws one card column on a phone, two on a 1440 px window and three with both panes collapsed', () => {
    cy.atWidth(400);
    cy.openConsole('#/');
    columnsAre(1);
    cy.atWidth(1440);
    columnsAre(2);
    cy.get('button.edge-tab-left').click();
    cy.get('button.edge-tab-right').click();
    columnsAre(3);
  });

  it('keeps every card at least 360 px wide where the wall has room', () => {
    cy.atWidth(1440);
    cy.openConsole('#/');
    cy.cards().each(($c) => expect($c[0].getBoundingClientRect().width).to.be.at.least(360));
  });

  it('lays the Board\'s eight tiles four across, and two across at 640 px', () => {
    cy.atWidth(1440);
    cy.openConsole('#/board');
    cy.get('.kpis .kpi').then(($k) => expect(new Set([...$k].map((k) => Math.round(k.getBoundingClientRect().left))).size).to.eq(4));
    cy.atWidth(600);
    cy.get('.kpis .kpi').then(($k) => expect(new Set([...$k].map((k) => Math.round(k.getBoundingClientRect().left))).size).to.eq(2));
  });

  it('puts the orchestrator page\'s facts in six columns, and in two at 640 px', () => {
    cy.atWidth(1440);
    cy.openConsole('#/?open=e2e-s-invoice');
    cy.contains('.fact', 'Est. cost').then(($f) => {
      const row = [...$f[0].parentElement.children].filter((e) => Math.abs(e.getBoundingClientRect().top - $f[0].getBoundingClientRect().top) < 4);
      expect(row.length).to.eq(6);
    });
    cy.atWidth(600);
    cy.contains('.fact', 'Est. cost').then(($f) => {
      const row = [...$f[0].parentElement.children].filter((e) => Math.abs(e.getBoundingClientRect().top - $f[0].getBoundingClientRect().top) < 4);
      expect(row.length).to.eq(2);
    });
  });

  it('fills the wall to the legend in wall mode with no page scroll', () => {
    cy.atWidth(1440);
    cy.openConsole('#/');
    cy.window().then((win) => {
      win.document.documentElement.requestFullscreen = () => Promise.resolve();
    });
    cy.get('button[aria-label="Enter wall mode"]').click();
    cy.get('.podium').should('have.class', 'wall-on');
    noPageScroll();
    cy.document().then((doc) => expect(doc.documentElement.scrollHeight).to.be.at.most(doc.documentElement.clientHeight + 1));
  });
});
