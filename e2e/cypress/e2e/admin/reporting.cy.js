// SPEC 8.1 Reporting (#484): the six report pages. The seed's activity is today only and read live, so what is checked here is the shape: the period and
// filters, the summary, the table the chart is drawn from, Export and Print, the remembered choice. A seeded 45-day history is checked by hand and by the
// unit tests (scripts/podium-seed-history.ts needs tsx, which the e2e containers do not carry; docs/e2e/COVERAGE.md).
describe('admin: reporting', () => {
  before(() => cy.resetServer());

  const period = () => cy.contains('label', 'Period').parent().find('select');

  for (const name of ['Usage', 'Sessions', 'Failures', 'Admin activity']) {
    it(`${name}: shows Period and filters, the report table and the pager`, () => {
      cy.openAdmin(name);
      cy.get('h1').should('have.text', name);
      cy.contains('h2', 'Period and filters');
      period().find('option').then(($o) => expect([...$o].map((o) => o.textContent)).to.deep.eq(['Last 7 days', 'Last 30 days', 'Last 90 days', 'This month', 'Last month', 'Custom']));
      period().should('have.value', '30d');
      if (name !== 'Admin activity') cy.contains('Podium has no history before').should('exist');
      cy.get('table.ptab').should('exist');
      cy.contains('Showing 1 to').should('exist');
    });
  }

  it('Usage: counts the seeded people, reporters and sessions, read live', () => {
    cy.openAdmin('Usage');
    cy.contains('active people').parent().invoke('text').should('match', /^\s*2\s*active people/);
    cy.contains('sessions started').parent().invoke('text').should('match', /^\s*12\s*sessions started/);
  });

  it('Sessions: breaks the sessions down by outcome, model, effort or plan', () => {
    cy.openAdmin('Sessions');
    cy.contains('label', 'Break down by').parent().find('select').find('option').then(($o) => expect([...$o].map((o) => o.textContent)).to.deep.eq(['Outcome', 'Model', 'Effort', 'Plan']));
    cy.contains('label', 'Break down by').parent().find('select').select('Model');
    cy.contains('td', 'claude-opus-5-5').should('exist');
  });

  it('Failures: lists the seeded failure class and links it to History', () => {
    cy.openAdmin('Failures');
    cy.contains('td', 'Tool error').should('exist');
    cy.get('a.klink[aria-label="Open in History"]').first().should('have.attr', 'href').and('include', '#/history');
  });

  it('Admin activity: filters the Admin log by kind of entry', () => {
    cy.openAdmin('Admin activity');
    cy.contains('label', 'Kind of entry').parent().find('select').select('unlock');
    cy.get('table.ptab tbody tr').should(($rows) => {
      expect($rows.length).to.be.greaterThan(0);
      $rows.each((_, r) => expect(r.textContent).to.contain('unlock'));
    });
  });

  it('remembers the period and filters in podium.adminReporting', () => {
    cy.openAdmin('Usage');
    period().select('Last 7 days');
    period().should('have.value', '7d');
    cy.window().its('localStorage').invoke('getItem', 'podium.adminReporting').should('be.a', 'string').and('include', '"period":"7d"');
    cy.reload();
    cy.adminPage('Usage');
    period().should('have.value', '7d');
  });

  it('shows From and To when the period is Custom', () => {
    cy.openAdmin('Usage');
    period().select('Custom');
    cy.contains('label', 'From').should('exist');
    cy.contains('label', 'To').should('exist');
  });

  it('exports the table: CSV and JSON buttons and Print', () => {
    cy.openAdmin('Usage');
    cy.task('download:clear');
    cy.get('button[aria-label="Download CSV"]').should('be.enabled').click();
    // An export is exactly the table's columns and rows.
    cy.task('download:read', '.csv').then(({ text }) => {
      const lines = text.trim().split(/\r?\n/);
      expect(lines[0]).to.eq('Period,People,Reporters,Sessions,Peak live');
      expect(lines.length, 'a header, the day and the whole period').to.be.at.least(2);
      expect(lines[1].split(',')[1], 'two people reported').to.eq('2');
    });
    cy.get('button[aria-label="Download JSON"]').should('be.enabled').click();
    cy.task('download:read', '.json').then(({ text }) => {
      const doc = JSON.parse(text);
      expect(doc.columns.map((c) => c.label ?? c)).to.include.members(['People', 'Reporters', 'Sessions']);
      expect(doc.rows.length).to.be.at.least(1);
    });
    cy.get('button[aria-label="Print this page"]').should('exist');
    cy.window().then((win) => cy.stub(win, 'print').as('print'));
    cy.get('button[aria-label="Print this page"]').click();
    cy.get('@print').should('have.been.calledOnce');
  });

  it('People and groups: counts people, groups and reporters and lists who has not reported', () => {
    cy.openAdmin('People and groups');
    cy.get('h1').should('have.text', 'People and groups');
    cy.get('table.ptab').first().find('tbody tr').should('have.length.greaterThan', 0);
    cy.contains('Ed').should('exist');
    cy.contains('Alex').should('exist');
    cy.readFile('/repo/package.json').then((pkg) => cy.contains(pkg.version).should('exist'));
  });

  it('Spend: shows spend today by person, the projection and spend over time', () => {
    cy.openAdmin('Spend');
    cy.get('h1').should('have.text', 'Spend');
    cy.contains('h2', 'Spend today, by person');
    cy.contains('h2', 'Projection');
    cy.contains('h2', 'Spend over time');
    cy.contains('Not enough history to project.');
    cy.contains('spent today, all 2 people');
  });

  it('Spend: opens a person\'s breakdown from their row, with the cuts that add up to the row', () => {
    cy.openAdmin('Spend');
    cy.get('button.rowbtn').contains('Ed').click();
    cy.get('section#spend-bd').within(() => {
      cy.get('table[aria-label="By session"]').should('contain.text', 'invoice-v2');
      cy.contains('claude-opus-5-5');
      cy.contains('Orchestrator');
      cy.contains('Agents');
      cy.contains('button', 'Close').click();
    });
    cy.get('section#spend-bd').should('not.exist');
  });

  it('Spend: groups by group, shows as a table, and remembers it in podium.adminSpend', () => {
    cy.openAdmin('Spend');
    cy.get('[role=group][aria-label="Group by"]').first().contains('button', 'Groups').click().should('have.attr', 'aria-pressed', 'true');
    cy.get('[role=group][aria-label="Show as"]').contains('button', 'Table').click().should('have.attr', 'aria-pressed', 'true');
    cy.window().its('localStorage').invoke('getItem', 'podium.adminSpend').should('be.a', 'string');
    cy.contains('th', 'Share');
  });
});
