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
    cy.contains('tr', 'build-pi').should('contain.text', '1.3.1');
  });

  it('counts the reporters in each state filter', () => {
    cy.get('[role=group][aria-label="Filter by state"]').within(() => {
      const n = (name) => cy.contains('button', name).invoke('text').then((t) => Number(/(\d+)\s*$/.exec(t.trim())[1]));
      n('All reporters').should('eq', 4);
      n('Reporting').should('eq', 4);
      n('Idle').should('eq', 0);
      n('Silent').should('eq', 0);
      n('Not since restart').should('eq', 0);
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
