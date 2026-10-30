// SPEC 8.1 Fleet wall > Session cards > Cost and health: the Comp pill (#805). A session Claude Code compacted on its own carries it after the
// Context label; it stays for the life of the session, wraps in the narrow cell and is information (blue), not a warning. The seed's
// --compaction puts three sessions on the wall: comp-only (two automatic compactions), comp-blown (one, beside a blowout) and comp-none.
describe('wall: the Comp pill', () => {
  before(() => cy.resetServer({ seedArgs: '--compaction' }));
  beforeEach(() => cy.openConsole('#/'));

  const pill = (key) => cy.card(key).find('.comp');

  it('shows the pill after the Context label, with the word Comp and a title that counts the compactions', () => {
    pill('comp').should('have.length', 1).and('contain.text', 'Comp').and('have.attr', 'title', 'Claude Code compacted this session automatically 2 times');
    pill('comp').find('.vh').should('have.text', 'Compacted automatically 2 times');
    pill('compblow').should('have.attr', 'title', 'Claude Code compacted this session automatically 1 time');
    pill('compblow').find('.vh').should('have.text', 'Compacted automatically 1 time');
  });

  it('leaves it off a session that was never compacted, and off the seeded ones whose compactions are not automatic', () => {
    pill('compnone').should('not.exist');
    pill('api').should('not.exist');
    pill('invoice').should('not.exist');
    cy.get('button.card.sc .comp').should('have.length', 2);
  });

  it('sits beside the blowout badge when the session also blew out, in the same Context label', () => {
    cy.card('compblow').within(() => {
      cy.contains('.k', 'Context').within(() => {
        cy.get('.blow').should('exist');
        cy.get('.comp').should('exist');
      });
    });
    cy.card('comp').contains('.k', 'Context').find('.blow').should('not.exist');
  });

  it('is blue, the delegation color, and not the warning amber of the blowout badge', () => {
    pill('comp').then(($p) => {
      const color = getComputedStyle($p[0]).color;
      const probe = document.createElement('span');
      probe.style.color = 'var(--deleg-text)';
      $p[0].appendChild(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      expect(color).to.eq(want);
    });
  });

  it("shows the pill in the orchestrator's panel too, after the Context readout", () => {
    cy.card('comp').click();
    cy.get('main#podium-main h1').should('have.text', 'comp-only');
    cy.get('button.trow.root').click();
    cy.contains('#podium-side-body dt', 'Context').next('dd').find('.comp').should('contain.text', 'Comp').and('have.attr', 'title', 'Claude Code compacted this session automatically 2 times');
  });

  it('keeps the pill inside the card at 400 px, with or without the blowout badge', () => {
    cy.atWidth(400);
    for (const key of ['comp', 'compblow']) {
      cy.card(key).should(($c) => {
        const card = $c[0].getBoundingClientRect();
        const el = $c[0].querySelector('.comp');
        const r = el.getBoundingClientRect();
        expect(r.width, `${key} pill is drawn`).to.be.greaterThan(10);
        expect(r.left, `${key} pill left edge`).to.be.at.least(card.left);
        expect(r.right, `${key} pill right edge`).to.be.at.most(card.right);
        expect(el.scrollWidth, `${key} pill is not clipped`).to.be.at.most(el.clientWidth + 1);
      });
    }
  });
});

describe('wall: the Comp pill, accessibility (axe)', () => {
  before(() => cy.resetServer({ seedArgs: '--compaction' }));

  for (const mode of ['light', 'dark']) {
    for (const width of [1440, 400]) {
      it(`has no axe violation on the cards with the pill, ${mode}, ${width} px`, () => {
        cy.atWidth(width);
        cy.visit('/#/', { onBeforeLoad: (win) => win.localStorage.setItem('podium.theme', JSON.stringify({ theme: 'podium', mode })) });
        cy.get('html').should('have.attr', 'data-theme', mode);
        cy.card('compblow').find('.comp').should('exist');
        cy.checkA11y({ context: 'button.card.sc[data-session="e2e-s-comp-only"], button.card.sc[data-session="e2e-s-comp-blown"]' });
      });
    }
  }
});
