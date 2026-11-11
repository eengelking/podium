// SPEC 7.1 My usage (#726): the Admin's `my-usage` flag, the top bar button, the page `#/me/usage` and what a signed-in person's own figures do and do not hold.
// Order: the tests run in order on one server; each sets the flag it needs first, and the file resets the server once, in `before`.
describe('my usage', () => {
  before(() => cy.resetServer());

  const USAGE = '/api/fleet/respond/usage';
  const bar = () => cy.get('#podium-top');
  const myUsageButton = () => bar().contains('a.btn', /^My usage$/);

  // What only Alex has: a project and a tool of his own. Ed's own are the seed's (invoice-v2 and its siblings; Edit, Agent and TaskUpdate beside Read).
  const ALEX_ONLY = { project: 'zorblax-secret-repo', tool: 'ZorblaxTool' };
  const alexLoop = { skills: [], lastTool: ALEX_ONLY.tool, toolCalls: 9, toolCounts: { Read: 4, [ALEX_ONLY.tool]: 5 }, steps: { done: 6, total: null } };

  context('while the Admin setting is off (the default)', () => {
    beforeEach(() => cy.signIn('Ed'));

    it('has no button in the top bar, and the address says the page is not found', () => {
      cy.openConsole('#/');
      cy.get('[data-testid="connection-pill"]').should('have.attr', 'data-state', 'live');
      bar().contains('button', 'Sign in').should('not.exist');
      bar().contains('a.btn', /^My reporters/).should('exist');
      bar().contains('a.btn', 'My usage').should('not.exist');
      cy.visit('/#/me/usage');
      cy.contains('h2, h1', 'Page not found').should('exist');
      cy.contains('Spend by').should('not.exist');
    });

    it('has no route: the server answers as for a report that does not exist', () => {
      cy.request({ url: `${USAGE}/spend`, failOnStatusCode: false }).should((res) => {
        expect(res.status).to.eq(404);
        expect(res.body).to.deep.eq({ ok: false, error: 'no such report' });
      });
      cy.request('/api/fleet/respond/me').its('body.myUsage').should('eq', false);
    });
  });

  context('turned on, with nobody signed in', () => {
    before(() => cy.setFlags({ 'my-usage': true }));

    it('asks to sign in and shows no figure and no button', () => {
      cy.openConsole('#/me/usage');
      cy.contains('Sign in to see your usage').should('exist');
      cy.contains('Spend by').should('not.exist');
      cy.get('table.ptab').should('not.exist');
      bar().contains('a.btn', 'My usage').should('not.exist');
    });

    it('refuses the route and gives no figure', () => {
      cy.request({ url: `${USAGE}/spend`, failOnStatusCode: false }).should((res) => {
        expect(res.status).to.eq(403);
        expect(Object.keys(res.body).sort()).to.deep.eq(['error', 'ok']);
      });
    });
  });

  context('turned on, signed in as Ed', () => {
    before(() => cy.setFlags({ 'my-usage': true }));
    beforeEach(() => cy.signIn('Ed'));

    it('puts My usage in the top bar next to My reporters, on every page but its own', () => {
      cy.openConsole('#/');
      myUsageButton().should('have.attr', 'href', '#/me/usage');
      bar().contains('a.btn', /^My reporters/).should('exist');
      cy.visit('/#/me/reporters');
      cy.get('h1').should('have.text', 'My reporters');
      myUsageButton().should('exist');
      cy.visit('/#/history');
      myUsageButton().should('exist');
      myUsageButton().click();
      cy.location('hash').should('eq', '#/me/usage');
      cy.get('h1').should('have.text', 'My usage');
      bar().contains('a.btn', /^My usage$/).should('not.exist');
      bar().contains('a.btn', /^My reporters/).should('exist');
    });

    it('shows the five sections, the period and filters it has, and none it must not have', () => {
      cy.openConsole('#/me/usage');
      cy.get('h1').should('have.text', 'My usage');
      cy.contains('Only you can see this page.').should('exist');
      cy.contains('h2', 'Period and filters');
      cy.get('h2').filter((_, h) => /^Spend by (day|week|month)$/.test(h.textContent)).should('have.length', 1);
      for (const h of ['Spend by project', 'Sessions by outcome', 'Failures', 'Tool calls']) cy.contains('h2', h).should('exist');
      cy.contains('label', 'Period').should('exist');
      cy.contains('label', 'Break down by').should('exist');
      cy.contains('label', 'Harness').should('exist');
      cy.get('[role=group][aria-label="By"], [aria-label="By"]').should('exist');
      for (const f of ['Person', 'Group', 'Model']) cy.contains('label', new RegExp(`^${f}$`)).should('not.exist');
      cy.get('button[aria-label$="CSV"]').should('exist');
      cy.get('button[aria-label$="JSON"]').should('exist');
      cy.get('button[aria-label="Print this page"]').should('exist');
    });

    it('follows By: the Spend heading names day, week or month', () => {
      cy.openConsole('#/me/usage');
      cy.get('[aria-label="By"]').contains('button', 'Week').click();
      cy.contains('h2', 'Spend by week').should('exist');
      cy.get('[aria-label="By"]').contains('button', 'Month').click();
      cy.contains('h2', 'Spend by month').should('exist');
      cy.get('[aria-label="By"]').contains('button', 'Day').click();
      cy.contains('h2', 'Spend by day').should('exist');
    });

    it('sorts a table by its heading: the Tool calls table, text A to Z then Z to A, a number largest first', () => {
      cy.openConsole('#/me/usage');
      const table = () => cy.get('table[aria-label="Tool calls"]');
      const column = (i) => ($t) => [...$t.find('tbody tr')].map((r) => r.children[i].textContent.trim());
      table().find('thead th').first().should('have.attr', 'aria-sort', 'none');
      table().find('thead th').first().find('button.thbtn').click();
      table().should(($t) => {
        const names = column(0)($t);
        expect(names.length, 'Ed has several tools').to.be.greaterThan(1);
        expect(names, 'A to Z').to.deep.eq([...names].sort((a, b) => a.localeCompare(b)));
      });
      table().find('thead th').first().should('have.attr', 'aria-sort', 'ascending');
      table().find('thead th').first().find('button.thbtn').click();
      table().find('thead th').first().should('have.attr', 'aria-sort', 'descending');
      table().should(($t) => {
        const names = column(0)($t);
        expect(names, 'Z to A').to.deep.eq([...names].sort((a, b) => b.localeCompare(a)));
      });
      table().find('thead th.n').first().find('button.thbtn').click();
      table().find('thead th.n').first().should('have.attr', 'aria-sort', 'descending');
      table().should(($t) => {
        const i = $t.find('thead th').index($t.find('thead th.n').first());
        const nums = column(i)($t).map((v) => Number(v.replace(/[^0-9.-]/g, ''))).filter((n) => !Number.isNaN(n));
        expect(nums, 'largest first').to.deep.eq([...nums].sort((a, b) => b - a));
      });
    });

    it('moves no column when a heading is clicked to sort (#1144): the Tool calls table', () => {
      cy.openConsole('#/me/usage');
      const table = () => cy.get('table[aria-label="Tool calls"]');
      table().find('tbody tr').should('have.length.greaterThan', 1);
      cy.columnEdges(table).then(({ edges, now: before }) => {
        const clicks = [];
        for (let i = 0; i < before.length; i += 1) clicks.push(i, i);
        cy.wrap(clicks).each((i) => {
          table().find('thead th').eq(i).find('button.thbtn').click();
          table().should(($u) => expect(edges($u), `after clicking heading ${i}`).to.deep.eq(before));
        });
      });
    });

    it('serves each of its own reports and refuses the ones that are not one person\'s', () => {
      for (const name of ['spend', 'sessions', 'failures', 'tools']) {
        cy.request(`${USAGE}/${name}`).should((res) => {
          expect(res.status, name).to.eq(200);
          expect(res.body.mine, name).to.eq(true);
        });
      }
      for (const name of ['people', 'usage', 'activity', 'workload']) cy.request({ url: `${USAGE}/${name}`, failOnStatusCode: false }).its('status').should('eq', 404);
    });
  });

  // The key rule: two people each have sessions, and the page holds only the signed-in person's. The Admin's own pages are not changed by this, so the other person's names are
  // searched for on the page, in what the server sends and in an export.
  context('two people with sessions: each sees only their own', () => {
    before(() => {
      cy.setFlags({ 'my-usage': true });
      cy.reportAgain('alex', { projectRoot: `/Users/dev/${ALEX_ONLY.project}`, cwd: `/Users/dev/${ALEX_ONLY.project}`, repoName: `acme/${ALEX_ONLY.project}`, costUsd: 4.25, loop: alexLoop });
    });

    it('as Ed: his own project and tools are there, Alex\'s project and tool are nowhere on the page, in the data or in an export', () => {
      cy.signIn('Ed');
      cy.openConsole('#/me/usage');
      cy.get('table[aria-label="Spend by project"]').should('contain.text', 'invoice-v2');
      cy.get('table[aria-label="Tool calls"]').should('contain.text', 'Edit');
      cy.get('table[aria-label="Tool calls"]').should('not.contain.text', ALEX_ONLY.tool);
      cy.get('main[aria-label="My usage"]').should(($m) => {
        const text = $m.text();
        expect(text).to.not.contain(ALEX_ONLY.project);
        expect(text).to.not.contain(ALEX_ONLY.tool);
        expect(text).to.not.contain('alex-session');
        expect(text).to.not.contain('Alex');
      });
      for (const name of ['spend', 'sessions', 'failures', 'tools']) {
        for (const format of ['json', 'csv']) {
          cy.request(`${USAGE}/${name}?format=${format}`).should((res) => {
            const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
            for (const theirs of [ALEX_ONLY.project, ALEX_ONLY.tool, 'alex-session', 'Alex', 'e2e-s-alex-session']) expect(body, `${name}.${format} holds ${theirs}`).to.not.contain(theirs);
          });
        }
      }
    });

    it('as Ed: asking for another person, group or session in the request changes nothing', () => {
      cy.signIn('Ed');
      cy.request(`${USAGE}/spend?breakdown=project&person=Alex&group=Platform&owner=Alex&session=e2e-s-alex-session`).should((res) => {
        const body = JSON.stringify(res.body);
        expect(res.status).to.eq(200);
        expect(body).to.not.contain(ALEX_ONLY.project);
        expect(body).to.not.contain('Alex');
      });
      cy.request({ url: `${USAGE}/tools?breakdown=tool&person=Alex`, failOnStatusCode: false }).should((res) => {
        expect(JSON.stringify(res.body)).to.not.contain(ALEX_ONLY.tool);
      });
    });

    it('as Alex: his own project and tool are there, and none of Ed\'s sessions', () => {
      cy.signIn('Alex');
      cy.openConsole('#/me/usage');
      cy.get('table[aria-label="Spend by project"]').should('contain.text', ALEX_ONLY.project);
      cy.get('table[aria-label="Tool calls"]').should('contain.text', ALEX_ONLY.tool);
      cy.get('main[aria-label="My usage"]').should(($m) => {
        const text = $m.text();
        expect(text).to.not.contain('invoice-v2');
        expect(text).to.not.contain('api-gateway');
        expect(text).to.not.contain('Edit');
      });
    });

    it('as the Administrator with the admin secret: their own figures, never the fleet\'s', () => {
      cy.signIn('Admin');
      cy.request(`${USAGE}/spend?breakdown=project`).should((res) => {
        expect(res.status).to.eq(200);
        const body = JSON.stringify(res.body);
        expect(body).to.not.contain('invoice-v2');
        expect(body).to.not.contain(ALEX_ONLY.project);
      });
    });
  });

  context('turned off again', () => {
    before(() => cy.setFlags({ 'my-usage': false }));
    beforeEach(() => cy.signIn('Ed'));

    it('takes the button and the page away again', () => {
      cy.openConsole('#/');
      bar().contains('a.btn', /^My reporters/).should('exist');
      bar().contains('a.btn', 'My usage').should('not.exist');
      cy.visit('/#/me/usage');
      cy.contains('Page not found').should('exist');
      cy.request({ url: `${USAGE}/spend`, failOnStatusCode: false }).its('status').should('eq', 404);
    });
  });
});
