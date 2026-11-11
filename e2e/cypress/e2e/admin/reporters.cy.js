// SPEC 8.1 Reporters page (#142): the list, the state filters, search, details, ignore rules and removal.
// Order: the tests below run in order on one server, and a later one reads what an earlier one left (named where it matters); the file resets the server once, in `before`.
describe('admin: reporters', () => {
  before(() => cy.resetServer());
  beforeEach(() => cy.openAdmin('Reporters'));

  it('lists every machine that reported, with its person and its state', () => {
    cy.get('h1').should('have.text', 'Reporters');
    cy.get('h2#admin-reporters-h').should('have.text', 'Heard from');
    cy.get('table tbody tr').should('have.length', 4);
    cy.contains('tr', 'ed-mbp').should('contain.text', 'Ed');
    cy.contains('tr', 'alex-laptop').should('contain.text', 'Alex');
    cy.readFile('/repo/package.json').then((pkg) => cy.contains('tr', 'build-pi').should('contain.text', pkg.version));
  });

  it('counts the reporters in each state filter', () => {
    cy.get('[role=group][aria-label="Filter by state"]').within(() => {
      // The button's text retries until the count has rendered, so a busy machine cannot read it too early.
      const count = (name, want) => cy.contains('button', name).should(($b) => expect($b.text().trim(), `${name} count`).to.match(new RegExp(`(^|\\D)${want}\\s*$`)));
      count('All reporters', 4);
      count('Reporting', 4);
      count('Idle', 0);
      count('Silent', 0);
      count('Not since restart', 0);
      cy.contains('button', 'Idle').click();
    });
    cy.get('table tbody tr').should('not.exist');
  });

  it('searches by machine, person or version', () => {
    cy.get('#reporters-search').type('alex');
    cy.get('table tbody tr').should('have.length', 1).and('contain.text', 'alex-laptop');
    cy.get('#reporters-search').clear().type('build');
    cy.get('table tbody tr').should('have.length', 1).and('contain.text', 'build-pi');
  });

  it('sorts by a column header', () => {
    cy.contains('button.thbtn', 'Machine').click();
    cy.get('table tbody tr').first().should('contain.text', 'alex-laptop');
    cy.contains('button.thbtn', 'Machine').click();
    cy.get('table tbody tr').first().should('contain.text', 'ed-mbp');
  });

  // #1144: a sort click moves no column. Each heading's left edge (from the table's own, since a wide table scrolls under the click) and width is read before and after every click.
  it('moves no column when a heading is clicked to sort', () => {
    const table = () => cy.get('table.ptab').first();
    table().find('tbody tr').should('have.length.greaterThan', 1);
    cy.columnEdges(table).then(({ edges, now: before }) => {
      const clicks = [];
      for (let i = 1; i < before.length; i += 1) clicks.push(i, i);
      cy.wrap(clicks).each((i) => {
        table().find('thead th').eq(i).find('button.thbtn').click();
        table().should(($u) => expect(edges($u), `after clicking heading ${i}`).to.deep.eq(before));
      });
    });
  });

  it('opens a reporter\'s details: where it comes from, its sessions and what the server turned away', () => {
    cy.get('button[aria-label="Open details for ed-mbp"]').click();
    cy.get('h3#rep-h1').should('have.text', 'Reporter');
    cy.contains('h3', 'Where it comes from');
    cy.contains('h2', 'Recent sessions');
    cy.contains('h2', 'Reports the server turned away');
    cy.contains('None lately.');
    cy.contains('Machine id').parent().should('contain.text', 'e2e0000mbp01');
  });

  it('makes and removes an ignore rule', () => {
    cy.get('h2#rules-h').should('have.text', 'Ignore rules');
    cy.contains('No rules. Every reporter is accepted.');
    cy.get('select#rule-kind').select('Version');
    cy.get('input[aria-label=Pattern]').type('9.*');
    cy.contains('button', 'Ignore matching reporters').click();
    cy.contains('table[aria-label="Ignore rules"] tr', '9.*');
    cy.get('button[aria-label="Remove the rule for 9.*"]').click();
    cy.contains('No rules. Every reporter is accepted.');
  });

  it('asks before it removes a reporter, then removes it', () => {
    cy.get('input[aria-label="Select build-pi"]').check();
    cy.get('[role=group][aria-label="Selected reporters"]').should('contain.text', '1 selected');
    cy.get('[role=group][aria-label="Selected reporters"] button').contains(/Remove/).click();
    cy.get('[role=group][aria-label="Confirm removal"]').should('exist').contains('button', /Cancel|Keep/).click();
    cy.get('table tbody tr').should('have.length', 4);
    cy.get('input[aria-label="Select build-pi"]').check();
    cy.get('[role=group][aria-label="Selected reporters"] button').contains(/Remove/).click();
    cy.get('[role=group][aria-label="Confirm removal"]').contains('button', /Remove/).click();
    cy.get('table tbody tr').should('have.length', 3);
    cy.contains('tr', 'build-pi').should('not.exist');
  });
});
