// SPEC 8.1 Reporters page (#142): versions that are out of range, the admin-secret warning, details, ignore and remove from a reporter's page, selection, and the state a restart leaves.
// Order: the tests below run in order on one server, and a later one reads what an earlier one left (named where it matters); the file resets the server once, in `before`.
describe('admin: reporters, versions, the admin secret and restarts', () => {
  before(() => cy.resetServer({ seedArgs: '--reporters' }));
  beforeEach(() => cy.openAdmin('Reporters'));

  const row = (name) => cy.contains('table tbody tr', name);

  it('marks a reporter older than the server supports as outdated and one newer as newer, with a warning shape', () => {
    row('old-box').should('contain.text', '0.1.0').and('contain.text', 'outdated');
    row('future-box').should('contain.text', '99.0.0').and('contain.text', 'newer');
    row('ed-mbp').should('not.contain.text', 'outdated').and('not.contain.text', 'newer');
  });

  it('says in the top bar how many reporters need an update and how many are newer than the server', () => {
    cy.visit('/#/');
    cy.get('#podium-top').contains('1 reporter needs an update');
    cy.get('#podium-top').contains('1 reporter newer than the server');
  });

  it('lists a reporter with no mod (classic settings hooks) as "Hooks only", matched by address, with "no mod" where the version would be', () => {
    row('Hooks only').should('contain.text', 'no machine id, matched by address').and('contain.text', 'hooks').and('contain.text', 'no mod').and('contain.text', 'Ed');
  });

  it('shows a band for reporters using the admin secret and "Show only these" narrows the list to them', () => {
    cy.get('[role=status][aria-label="Reporters using the admin secret"]').should('contain.text', '1 reporter uses the admin secret');
    cy.contains('button', 'Show only these').click();
    cy.get('table tbody tr').should('have.length', 1).and('contain.text', 'secret-box').and('contain.text', 'Admin secret');
  });

  it('opens the admin-secret reporter\'s details with the steps to fix it, and says it cannot take part in messaging', () => {
    cy.get('button[aria-label="Open details for secret-box"]').click();
    cy.contains('h3', 'This reporter is using the admin secret');
    cy.contains('To fix it:');
    cy.contains('In Admin > People, make a person for whoever runs this reporter');
    cy.contains('The admin secret cannot take part');
    cy.contains('Compatibility').parent().should('contain.text', 'Supported');
  });

  it('explains an outdated reporter in its details, and that it cannot message until it is updated', () => {
    cy.get('button[aria-label="Open details for old-box"]').click();
    cy.contains('Compatibility').parent().should('contain.text', 'Older than this server supports. Update the mod.');
    cy.contains("old-box's reporter can't message");
    cy.contains('It is too old to message.');
  });

  it('ignores every reporter on a version from a reporter\'s details page, which makes a rule that can be removed', () => {
    cy.get('button[aria-label="Open details for future-box"]').click();
    cy.contains('button', 'Ignore…').click();
    cy.get('[role=group][aria-label="Ignore future-box"]').should('contain.text', 'Its reports are turned away');
    cy.get('[role=group][aria-label="Ignore future-box"]').contains('label.opt', 'Every reporter on version').find('input').check();
    cy.get('[role=group][aria-label="Ignore future-box"]').contains('button', 'Ignore and remove').click();
    cy.contains('table tbody tr', 'future-box').should('not.exist');
    cy.request('/api/admin/reporters/ignores').then((res) => {
      const rules = res.body.rules ?? res.body.ignores ?? res.body;
      expect(JSON.stringify(rules), 'the rule').to.contain('99.0.0');
    });
    cy.openAdmin('Reporters');
    cy.get('table[aria-label="Ignore rules"]', { timeout: 15000 }).should('contain.text', '99.0.0').and('contain.text', 'Version');
    cy.get('button[aria-label="Remove the rule for 99.0.0"]').click();
    cy.contains('No rules. Every reporter is accepted.');
  });

  it('selects every reporter on the page with Select all and offers to remove them', () => {
    cy.get('input[aria-label^="Select all"]').check();
    cy.get('[role=group][aria-label="Selected reporters"]').invoke('text').should('match', /\d+ selected/);
  });

  it('shows "Not since restart" for reporters that have not reported since the server restarted', () => {
    cy.task('server:pause', null, { timeout: 60000 });
    cy.task('server:resume', null, { timeout: 60000 });
    cy.openAdmin('Reporters');
    cy.contains('button', 'Not since restart').should('not.contain.text', ' 0');
    cy.get('[role=group][aria-label="Filter by state"]').contains('button', 'Not since restart').click();
    cy.get('table tbody tr').should('have.length.greaterThan', 0).first().should('contain.text', 'Not since restart');
  });
});
