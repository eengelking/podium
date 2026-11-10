// SPEC 8.1 Reporters page: a reporter that stops reporting moves from Reporting to Idle (2 minutes without a report) with no reload. The seed reports once and stops, so this
// waits for the server's own 2-minute threshold with a retrying assertion (no fixed sleep). Silent (over an hour) is out of reach and is a stated gap in docs/e2e/COVERAGE.md.
describe('admin: reporters going idle', () => {
  before(() => cy.resetServer());

  it('moves every reporter from Reporting to Idle once two minutes pass without a report', () => {
    cy.openAdmin('Reporters');
    const counts = () => cy.get('[role=group][aria-label="Filter by state"]');
    // A button's count is `–` until the list loads, so the count is matched inside should(), which retries, and never read once with then() (#1070, #1137).
    const count = (name, want) => counts().contains('button', name).should(($b) => expect($b.text().trim(), `${name} count`).to.match(new RegExp(`(^|\\D)${want}\\s*$`)));
    count('Reporting', 4);
    count('Idle', 0);
    // The timeout is on the query that finds the button by its text, so the retry lasts as long as the server's threshold plus a margin.
    counts().contains('button', /^Idle\s*4$/, { timeout: 200000 });
    count('Reporting', 0);
    counts().contains('button', 'Idle').click();
    cy.get('table tbody tr').should('have.length', 4);
    cy.contains('table tbody tr', 'ed-mbp').should('contain.text', 'Idle');
  });
});
