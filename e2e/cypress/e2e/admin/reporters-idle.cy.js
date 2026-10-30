// SPEC 8.1 Reporters page: a reporter that stops reporting moves from Reporting to Idle (2 minutes without a report) with no reload. The seed reports once and stops, so this
// waits for the server's own 2-minute threshold with a retrying assertion (no fixed sleep). Silent (over an hour) is out of reach and is a stated gap in docs/e2e/COVERAGE.md.
describe('admin: reporters going idle', () => {
  before(() => cy.resetServer());

  it('moves every reporter from Reporting to Idle once two minutes pass without a report', () => {
    cy.openAdmin('Reporters');
    const counts = () => cy.get('[role=group][aria-label="Filter by state"]');
    const count = (name) => counts().contains('button', name).invoke('text').then((t) => Number(/(\d+)\s*$/.exec(t.trim())[1]));
    count('Reporting').should('eq', 4);
    count('Idle').should('eq', 0);
    // The timeout is on the query that finds the button by its text, so the retry lasts as long as the server's threshold plus a margin.
    counts().contains('button', /^Idle\s*4$/, { timeout: 200000 });
    count('Reporting').should('eq', 0);
    counts().contains('button', 'Idle').click();
    cy.get('table tbody tr').should('have.length', 4);
    cy.contains('table tbody tr', 'ed-mbp').should('contain.text', 'Idle');
  });
});
