// Small things only a browser shows: the page title following the route, reduced motion, the effort meter's levels, and the People view's order by Spend.
describe('the page title and motion', () => {
  before(() => cy.resetServer());

  it('names the tab after the page: the wall, the board, an orchestrator, History and Admin', () => {
    cy.openConsole('#/');
    cy.title().should('eq', 'Podium');
    cy.visit('/#/board');
    cy.title().should('eq', 'Podium board');
    cy.visit('/#/traffic');
    cy.title().should('eq', 'Podium traffic');
    cy.visit('/#/?open=e2e-s-api-gateway');
    cy.title().should('eq', 'api-gateway - Podium');
    cy.visit('/#/history');
    cy.title().should('eq', 'Podium history');
    cy.openAdmin('Settings');
    cy.title().should('eq', 'Settings - Podium admin');
    cy.adminPage('Reporters');
    cy.title().should('eq', 'Reporters - Podium admin');
  });

  const emulate = (value) => cy.then(() => Cypress.automation('remote:debugger:protocol', { command: 'Emulation.setEmulatedMedia', params: { media: '', features: [{ name: 'prefers-reduced-motion', value }] } }));
  afterEach(() => emulate('reduce')); // the suite's own default (the browser is launched with reduced motion)

  it('uses the app\'s own transition on the edge tab unless the reader prefers reduced motion', () => {
    cy.openConsole('#/');
    // The run injects a style that zeroes every transition, so the page's own CSS is read from the stylesheet rules, not from the computed style.
    const edgeTabTransitions = () => cy.document().then((doc) => {
      const rules = [];
      for (const sheet of doc.styleSheets) {
        const walk = (list) => {
          for (const r of list) {
            if (r.cssRules && r.conditionText !== undefined) {
              if (win(doc).matchMedia(r.conditionText).matches) walk(r.cssRules);
            } else if (r.selectorText && /\.edge-tab::after/.test(r.selectorText) && /transition/.test(r.cssText)) rules.push(r.style.getPropertyValue('transition'));
          }
        };
        try { walk(sheet.cssRules); } catch { /* a cross-origin sheet */ }
      }
      return rules;
    });
    const win = (doc) => doc.defaultView;
    emulate('no-preference');
    edgeTabTransitions().then((rules) => expect(rules.some((r) => r && r !== 'none'), 'a transition applies').to.eq(true));
    emulate('reduce');
    edgeTabTransitions().then((rules) => expect(rules[rules.length - 1], 'the last matching rule is "none" under reduced motion').to.eq('none'));
  });
});

describe('the effort meter', () => {
  before(() => cy.resetServer());
  beforeEach(() => cy.openConsole('#/'));

  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    it(`reads "Effort: ${level}" on a card and in the orchestrator's row`, () => {
      cy.reportAgain('api', { effort: level });
      cy.card('api').find(`[role=img][aria-label="Effort: ${level}"]`).should('exist').and('have.class', `eff-${level}`);
      cy.card('api').click();
      cy.get('button.trow.root').find(`[aria-label="Effort: ${level}"]`).should('exist');
    });
  }
});

describe('People view: order by Spend', () => {
  before(() => cy.resetServer());
  it('puts the person who spent most first, and Name puts the groups apart', () => {
    cy.openConsole('#/');
    cy.get('[aria-label="Order by"]').contains('button', 'Spend').click().should('have.attr', 'aria-pressed', 'true');
    cy.get('button.bh').first().should('contain.text', 'Ed');
    cy.get('[aria-label="Group by"]').contains('button', 'Group').click();
    cy.get('button.bh').then(($b) => expect([...$b].map((b) => b.textContent)).to.satisfy((t) => t.some((x) => x.includes('Platform')) && t.some((x) => x.includes('Unassigned'))));
  });
});
