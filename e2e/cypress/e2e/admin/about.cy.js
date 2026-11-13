// SPEC 8.1 Admin > About (#862): what the server and its reporters are running. Read-only. Values that change with the release, the
// machine or the clock (versions, uptime, Node.js, the database engine's version and size) are asserted by shape, not by number.
const facts = (label) => cy.get(`[aria-label="${label}"] tbody tr`);
const fact = (label, item) => cy.contains(`[aria-label="${label}"] tbody tr`, new RegExp(`^${item}`)).find('td').eq(1);

describe('admin: About, with reporters of other versions', () => {
  before(() => cy.resetServer({ seedArgs: '--reporters' }));
  beforeEach(() => cy.openAdmin('About'));

  it('is the last page of the Server group, after Stored activity', () => {
    cy.get('nav[aria-label="Admin sections"] [role=group][aria-label="Server"] button.navbtn').should(($b) => {
      expect([...$b].map((b) => b.childNodes[0].textContent).slice(-2)).to.deep.eq(['Stored activity', 'About']);
    });
    cy.get('nav [aria-current=page]').should('have.text', 'About');
    cy.get('main h1').should('have.text', 'About');
  });

  it('shows the server: version, running as a container, when it started and the system, and no Build row on a release', () => {
    cy.contains('h2', 'Podium server');
    facts('Podium server').should(($r) => expect([...$r].map((r) => r.querySelector('td').textContent)).to.deep.eq(['Version', 'Running as', 'Started', 'System']));
    fact('Podium server', 'Version').invoke('text').should('match', /^\d+\.\d+\.\d+$/);
    fact('Podium server', 'Running as').should('have.text', 'Container');
    fact('Podium server', 'Started').invoke('text').should('match', / · up \d+ (min|h)|· up \d+ days? \d+ h/);
    fact('Podium server', 'System').invoke('text').should('match', /^\w+ \w+$/);
  });

  it('lists what it is built with', () => {
    cy.contains('h2', 'Built with');
    facts('Runtime and libraries').should(($r) => expect([...$r].map((r) => r.querySelector('td').textContent)).to.deep.eq(['Node.js', 'Express', 'React', 'TypeScript']));
    fact('Runtime and libraries', 'Node.js').invoke('text').should('match', /^v\d+\.\d+\.\d+$/);
    fact('Runtime and libraries', 'Express').invoke('text').should('match', /^\d+\.\d+\.\d+/);
    fact('Runtime and libraries', 'React').invoke('text').should('match', /^\d+\.\d+\.\d+/);
    fact('Runtime and libraries', 'TypeScript').invoke('text').should('match', /^\d+\.\d+\.\d+/);
  });

  it('names the database in use, with its engine and schema version', () => {
    cy.contains('h2', 'Database');
    fact('Database', 'Adapter').invoke('text').should('match', /^(SQLite|PostgreSQL|MariaDB)$/);
    fact('Database', 'Engine version').invoke('text').should('match', /\d/);
    fact('Database', 'Schema version').invoke('text').should('match', /^\d+$/);
    fact('Database', 'Size').invoke('text').should('match', /\d/);
  });

  it('lists the reporters by version, newest first, with the outdated and the newer flagged and the range this server reads', () => {
    cy.contains('h2', 'Reporters');
    cy.get('[aria-label="Reporter versions"] thead th').should(($h) => expect([...$h].map((h) => h.textContent)).to.deep.eq(['Reporter', 'Version', 'This server reads', 'Machines']));
    const rows = () => cy.get('[aria-label="Reporter versions"] tbody tr');
    rows().should('have.length', 3);
    rows().each(($r) => {
      expect($r.find('td').eq(0).text()).to.eq('Claude Code reporter');
      expect($r.find('td').eq(2).text()).to.match(/^\d+\.\d+ to \d+\.\d+$/);
    });
    rows().eq(0).find('td').eq(1).should('contain.text', '99.0.0').and('contain.text', 'newer');
    rows().eq(0).find('td').eq(3).should('have.text', '1');
    rows().eq(1).find('td').eq(1).should('not.contain.text', 'outdated').and('not.contain.text', 'newer');
    rows().eq(2).find('td').eq(1).should('contain.text', '0.1.0').and('contain.text', 'outdated');
    rows().eq(2).find('td').eq(3).should('have.text', '1');
  });

  it('copies the details as plain text and says so', () => {
    cy.grantClipboard();
    cy.contains('button', 'Copy details').click();
    cy.contains('button', 'Copied');
    cy.window().then((w) => w.navigator.clipboard.readText()).should('match', /^Podium \d+\.\d+\.\d+\nRunning as: container/);
    cy.window().then((w) => w.navigator.clipboard.readText()).should('contain', 'Reporters (').and('contain', 'Claude Code reporter 0.1.0 x1 (outdated;').and('contain', 'Claude Code reporter 99.0.0 x1 (newer;');
  });
});

describe('admin: About, with no reporter connected', () => {
  before(() => cy.resetServer({ noSeed: true }));

  it('says no reporter is connected, and still shows the server', () => {
    cy.openAdmin('About');
    cy.contains('No reporter is connected');
    cy.get('[aria-label="Reporter versions"]').should('not.exist');
    fact('Podium server', 'Running as').should('have.text', 'Container');
  });
});
