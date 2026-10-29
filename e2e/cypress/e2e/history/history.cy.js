// History (#195; the code is the spec until #792 writes one): the day picker, the table of sessions that ended, paging, and a stored session's read-only page.
describe('history', () => {
  // The address holds the day, the page and the size once any of them changes.
  context('the seeded day', () => {
    // The seeded sessions ended on the day the server's clock showed when they were seeded. The browser's Date is held at the moment the
    // server was reset (cy.clock with only Date faked, so no timer is touched), so the day the page opens on is the day they ended however long
    // the file runs; a run does not depend on crossing midnight after the reset. The one moment left is a reset that itself straddles midnight
    // (the seed takes about a second), which nothing in a browser can hold still; the day is read from the page's own date field either way.
    let day = '';
    let seededAt = 0;
    before(() => {
      cy.resetServer({ seedArgs: '--ended 60' });
      cy.then(() => {
        seededAt = Date.now();
      });
    });
    const today = () => day;
    beforeEach(() => {
      cy.clock(seededAt, ['Date']);
      cy.visit('/#/history');
      cy.get('#podium-day').invoke('val').should('match', /^\d{4}-\d{2}-\d{2}$/).then((v) => {
        day = v;
      });
    });

    it('opens on today with the sessions that ended, newest first, and the count', () => {
      cy.get('#podium-day').should('have.value', today());
      cy.contains('.kpi-cap', /61 sessions ended/);
      cy.get('table.htable thead th').then(($h) => expect([...$h].map((h) => h.textContent)).to.deep.eq(['Session', 'Project', 'Model', 'Ended', 'Duration', 'Est. cost', 'Blowouts', 'Agents', 'End reason']));
      cy.get('table.htable tbody tr').should('have.length', 50);
      cy.contains('tr', 'ended-60').and('contain.text', 'Opus 5.5');
      // The oldest ended session of the seed is on the last page.
      cy.get('#history-next').click();
      cy.contains('tr', 'docs-sweep').and('contain.text', 'prompt_input_exit').and('contain.text', 'Opus 5.5');
    });

    it('pages with Previous and Next, and changes the page size', () => {
      cy.contains('.apager', 'Showing 1 to 50 of 61');
      cy.get('#history-prev').should('be.disabled');
      cy.get('#history-next').click();
      cy.contains('.apager', 'Showing 51 to 61 of 61');
      cy.contains('.apager', 'Page 2 of 2');
      cy.get('table.htable tbody tr').should('have.length', 11);
      cy.location('hash').should('include', 'page=2');
      cy.get('#history-size').select('25');
      cy.contains('.apager', 'Showing 1 to 25 of 61');
      cy.contains('.apager', 'Page 1 of 3');
      cy.location('hash').should('include', 'size=25');
    });

    it('goes back to the last page when the address asks for one past the end', () => {
      cy.visit(`/#/history?day=${today()}&page=99&size=50`);
      cy.contains('.apager', 'Page 2 of 2');
      cy.location('hash').should('include', 'page=2');
    });

    it('shows an empty day with the day named', () => {
      cy.get('#podium-day').type('2020-01-01');
      cy.contains('.none', 'No sessions ended on 2020-01-01.');
      cy.location('hash').should('include', 'day=2020-01-01');
    });

    it('opens a stored session as a read-only orchestrator page and returns with Back', () => {
      cy.get('#history-next').click();
      cy.contains('tr', 'docs-sweep').find('button.lk').first().click();
      cy.location('hash').should('include', 'open=e2e-s-docs-sweep');
      cy.get('main h1').should('have.text', 'docs-sweep');
      cy.contains('button.back', `← Back to ${today()}`);
      // SPEC 8.1 says the read-only page has no Resume and no Fork cell, but the page draws both. Not asserted either way until the maintainer decides (docs/e2e/COVERAGE.md, open question 1).
      cy.go('back');
      cy.get('table.htable').should('exist');
    });

    it('opens an agent of a stored session in a read-only panel', () => {
      cy.visit(`/#/history?day=${today()}&page=1&size=50&open=e2e-s-docs-sweep`);
      cy.get('main h1').should('have.text', 'docs-sweep');
      cy.get('button.trow.root').click();
      cy.get('aside[aria-label="Agent detail"]').should('contain.text', 'Orchestrator');
    });

    it('says a session that is not stored could not be loaded', () => {
      cy.visit(`/#/history?day=${today()}&page=1&size=50&open=e2e-s-nothing`);
      cy.contains('.none', 'Could not load that session (not found).');
    });

    it('draws the same top bar, with Fleet and Board, and no Hide top bar or wall mode', () => {
      cy.tid('page-pill').should('have.text', 'History');
      cy.get('#podium-top').contains('a.btn', 'Fleet');
      cy.get('#podium-top').contains('a.btn', 'Board');
      cy.get('button[aria-label="Enter wall mode"]').should('not.exist');
      cy.get('button.edge-tab-top').should('not.exist');
    });
  });

  context('when the server cannot be reached', () => {
    before(() => cy.resetServer());
    it('says so instead of showing a blank table', () => {
      cy.intercept('GET', '/api/fleet/history*', { forceNetworkError: true });
      cy.visit('/#/history');
      cy.contains('.none', 'Cannot reach the Podium server');
    });
  });
});
