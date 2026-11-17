// SPEC 6.2 The report (Background items) and Right panel > Activity section (#897, DECISIONS 68): the Activity modal's Output and Background tabs, the
// shells and monitors one loop started, in the feed's own rows, and the Admin flag `background-output` that lets the whole command and the output out.
const AT = 4102444800000; // 2100-01-01, a fixed moment later than any clock: a running item's time reads 0:00 and its last output "0 s ago"
const LONG_AGO = 1700000000000; // 2023-11-14, a fixed moment long before now: an item whose last output is this has been quiet for a very long time
describe('activity modal: Background tab', () => {
  before(() => cy.resetServer());
  // An agent's whole text and live activity are the owner's and the Admin's (#1082): Ed owns invoice-v2.
  beforeEach(() => {
    cy.signIn('Ed');
  });
  afterEach(() => cy.setFlags({ 'background-output': false }));

  const item = (id, over = {}) => ({ id, kind: 'shell', state: 'running', startedAt: AT, startedKnown: true, label: 'npm', ...over });
  const items = [
    item('bg-run', { label: 'npm', command: 'npm run watch -- --poll', output: 'watching 14 files', lastOutputAt: AT }),
    item('bg-ok', { label: 'tar', state: 'exited', exitCode: 0, endedAt: AT + 65000, command: 'tar czf out.tgz dist', output: 'dist/index.js' }),
    item('bg-bad', { label: 'make', state: 'exited', exitCode: 2, endedAt: AT + 5000, command: 'make test', output: 'make: *** [test] Error 2' }),
    item('bg-end', { label: 'sleep', state: 'exited', command: 'sleep 600', output: '' }),
    item('bg-quiet', { label: 'tail', kind: 'monitor', command: 'tail -f build.log', output: 'compiling', lastOutputAt: LONG_AGO }),
  ];
  const push = (over, list) => cy.reportAgain('invoice', over, { 'e2e-a-port': list === undefined ? {} : { backgroundItems: list } });
  const openModal = () => {
    cy.openConsole('#/');
    cy.card('invoice').click();
    cy.get('main#podium-main h1').should('have.text', 'invoice-v2');
    cy.get('#row-e2e-a-port').click();
    cy.get('#podium-side-body').contains('button', 'Expand').click();
    return cy.get('[role=dialog]');
  };
  const background = () => cy.get('[role=dialog]').find('[role=tab]').contains('Background');
  const rows = () => cy.get('[role=dialog]').find('[data-testid="bg-row"]');

  it('says an older reporter does not send background items, and the Output tab is the one open', () => {
    // The seed's reporter sends no backgroundOutput option, as a reporter before 1.7.0 does not.
    openModal().find('[role=tab][aria-selected=true]').should('have.text', 'Output');
    background().click();
    cy.get('[role=dialog]').contains('This reporter does not send background items.');
    cy.get('[role=dialog]').find('[role=tabpanel]').should('have.attr', 'aria-labelledby').and('match', /-tab-background$/);
  });

  it('says nothing is running when the reporter sends an empty list', () => {
    push({ backgroundOutput: true }, []);
    openModal();
    background().click();
    cy.get('[role=dialog]').contains('No background shells or monitors', { timeout: 20000 });
    rows().should('not.exist');
  });

  it('lists each item with its state, run time and last output, a quiet one with a warning, and opens a row to its command and output', () => {
    cy.setFlags({ 'background-output': true });
    push({ backgroundOutput: true });
    openModal();
    background().click();
    push({ backgroundOutput: true }, items);
    rows().should('have.length', 5);
    // The tab carries the count of its items.
    background().should('contain.text', '5');
    rows().eq(0).should('contain.text', 'npm run watch -- --poll').and('contain.text', 'Running').and('contain.text', 'last output 0 s ago');
    rows().eq(1).should('contain.text', 'Finished, exit 0').and('contain.text', '1:05');
    rows().eq(2).should('contain.text', 'Failed, exit 2');
    rows().eq(3).should('contain.text', 'Ended without an exit code');
    rows().eq(4).should('contain.text', 'Monitor').and('contain.text', 'Running').invoke('text').should('match', /Quiet for \d+ min/);
    rows().eq(0).should('not.contain.text', 'Quiet for');

    // A row opens to its whole command and its output, with the three controls.
    rows().eq(2).find('button.tgl').click().should('have.attr', 'aria-expanded', 'true');
    rows().eq(2).find('pre[aria-label="Whole command"]').should('contain.text', 'make test');
    rows().eq(2).find('pre[aria-label="Output"]').should('contain.text', 'make: *** [test] Error 2');
    rows().eq(2).contains('button', 'Copy command').should('exist');
    rows().eq(2).contains('button', 'Copy output').should('exist');
    rows().eq(2).contains('button', 'Collapse').click();
    rows().eq(2).find('button.tgl').should('have.attr', 'aria-expanded', 'false');
    rows().eq(2).find('pre[aria-label="Output"]').should('not.exist');

    // A command that printed nothing says so.
    rows().eq(3).find('button.tgl').click();
    rows().eq(3).contains('The command printed nothing.');
  });

  it('with the Admin flag off, lists state and times only and says output is off in an opened row', () => {
    push({ backgroundOutput: true });
    openModal();
    background().click();
    push({ backgroundOutput: true }, items);
    rows().should('have.length', 5);
    rows().eq(1).should('contain.text', 'Finished, exit 0');
    rows().eq(1).find('button.tgl').click();
    rows().eq(1).contains('Output is off.');
    rows().eq(1).contains('An Admin has not turned on Background shell output in Admin > Settings.');
    rows().eq(1).find('pre[aria-label="Output"]').should('not.exist');
    rows().eq(1).find('pre[aria-label="Whole command"]').should('not.exist');
    rows().eq(1).contains('Only the first word is shown.');
  });

  it('with the flag on and the reporter\'s backgroundOutput option off, names the option', () => {
    cy.setFlags({ 'background-output': true });
    push({ backgroundOutput: false });
    openModal();
    background().click();
    push({ backgroundOutput: false }, items);
    rows().should('have.length', 5);
    rows().eq(0).find('button.tgl').click();
    rows().eq(0).contains('Output is off.');
    rows().eq(0).contains('backgroundOutput');
  });
});
