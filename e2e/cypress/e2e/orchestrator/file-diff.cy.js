// SPEC 8.1 Orchestrator page > Files: the diff dialog (#319, #623, #630, #631). The suite plays the reporter mod that answers the
// console's diff requests (e2e/support/diffs.cjs). The Admin flag, the signed-in owner and the session's fileDiff option decide whether a row opens.
describe('file diff dialog', () => {
  before(() => cy.resetServer());

  const openFiles = () => {
    cy.openConsole('#/');
    cy.card('invoice').click();
    cy.get('main#podium-main h1').should('have.text', 'invoice-v2');
    cy.get('[role=tab]').contains('Files').click();
  };
  const rowFor = (path) => cy.get(`button[aria-label="Open diff of ${path}"]`);

  context('signed in as the owner', () => {
    beforeEach(() => {
      // Each test starts from the reporter's default: preload on, and the diff option on.
      cy.reportAgain('invoice', { fileDiffPreload: true, fileDiff: true });
      cy.intercept('GET', '**/files/diff*').as('diffReq');
      cy.task('diffs:start');
      cy.signIn('Ed');
      openFiles();
    });
    afterEach(() => cy.task('diffs:stop'));

    it('opens a row as a dialog titled with the path and shows the old and new file side by side', () => {
      rowFor('src/invoice/export.ts').click();
      cy.get('[role=dialog]').within(() => {
        cy.get('h2').should('have.text', 'src/invoice/export.ts');
        cy.contains('export const header = "invoice-v2";', { timeout: 15000 });
        cy.contains('export const rows = (list) => list.map(row);');
        cy.contains('1 value hidden as possible secrets');
        cy.contains('Showing file 1 of 8');
      });
    });

    it('steps through every file with Next and Previous and names the file each opens', () => {
      rowFor('src/invoice/export.ts').click();
      cy.get('[role=dialog]').within(() => {
        cy.get('button[aria-label^="Previous file"]').should('be.disabled');
        cy.get('button[aria-label="Next file: src/invoice/export.test.ts"]').click();
        cy.get('h2').should('have.text', 'src/invoice/export.test.ts');
        cy.contains('Showing file 2 of 8');
        cy.contains('test("header"', { timeout: 15000 });
        cy.get('button[aria-label="Previous file: src/invoice/export.ts"]').click();
        cy.get('h2').should('have.text', 'src/invoice/export.ts');
      });
    });

    it('explains a binary, a withheld, a too-large and a deleted file in plain words', () => {
      rowFor('assets/logo.png').click();
      cy.get('[role=dialog]').contains('No text diff for a binary file.', { timeout: 15000 });
      cy.get('body').type('{esc}');
      rowFor('config/secrets.env').click();
      cy.get('[role=dialog]').contains('Podium never reads the diff of files that usually hold secrets', { timeout: 15000 });
      cy.get('body').type('{esc}');
      rowFor('data/fixtures/huge.json').click();
      cy.get('[role=dialog]').contains('This diff is over 5 MB, so it is not shown.', { timeout: 15000 });
      cy.get('body').type('{esc}');
      rowFor('src/invoice/legacy.ts').click();
      cy.get('[role=dialog]').contains('export const legacy = true;', { timeout: 15000 });
    });

    it('keeps the Wrap lines choice in podium.diffWrap', () => {
      rowFor('src/invoice/export.ts').click();
      cy.get('[role=dialog]').contains('invoice-v2', { timeout: 15000 });
      cy.get('[role=dialog] [role=switch]').should('have.attr', 'aria-checked', 'true').click().should('have.attr', 'aria-checked', 'false');
      cy.window().its('localStorage').invoke('getItem', 'podium.diffWrap').should('eq', 'false');
      cy.get('[role=dialog] [role=switch]').click().should('have.attr', 'aria-checked', 'true');
    });

    it('says a diff the reporter cut was cut, with how many lines of how many', () => {
      rowFor('src/invoice/export.test.ts').click();
      cy.get('[role=dialog]').should('contain.text', 'Showing the first 3 lines of 900.');
    });

    it('shows a renamed file with the R mark and its old name in the row, and in the dialog\'s sub line', () => {
      rowFor('src/invoice/totals.ts').find('.st.R').should('have.attr', 'title', 'renamed').and('have.text', 'R');
      rowFor('src/invoice/totals.ts').find('.fn i').should('contain.text', '← src/invoice/sum.ts');
      rowFor('src/invoice/totals.ts').click();
      cy.get('[role=dialog] .sub2').should('contain.text', 'R · from src/invoice/sum.ts');
      cy.get('[role=dialog]').should('contain.text', 'export const total = (a, b) => a + b;').and('contain.text', 'export const sum = (a, b) => a + b;');
    });

    it('shows a deleted file with the D mark and all its lines removed', () => {
      rowFor('src/invoice/legacy.ts').find('.st.D').should('have.attr', 'title', 'deleted');
      rowFor('src/invoice/legacy.ts').find('.cnt').should('contain.text', '+0').and('contain.text', '−112');
      rowFor('src/invoice/legacy.ts').click();
      cy.get('[role=dialog] .sub2').should('contain.text', 'D');
      cy.get('[role=dialog]').should('contain.text', 'export const legacy = true;');
    });

    it('asks for every file\'s diff before any row is clicked when the reporter preloads', () => {
      cy.get('@diffReq.all', { timeout: 15000 }).should('have.length.greaterThan', 0);
      cy.get('@diffReq.all').then((calls) => expect(new Set(calls.map((c) => new URL(c.request.url).searchParams.get('path'))).size, 'files asked for').to.be.greaterThan(1));
    });

    it('asks for nothing until a row is opened when preload is off, then for that file only', () => {
      // The reporter the suite plays reports every 200 ms, so it is the one told to turn preload off.
      cy.task('diffs:stop');
      cy.task('diffs:start', { fileDiffPreload: false });
      cy.reportAgain('invoice', { fileDiffPreload: false });
      // The page is loaded only once the server's view of the session says preload is off, so the page never starts from the old value.
      cy.request('/api/fleet/sessions/e2e-s-invoice').its('body.fileDiffPreload').should('eq', false);
      // A hash change alone would keep the page of the test's start (and its preloader), so the page is loaded afresh.
      cy.visit('/#/');
      cy.reload();
      cy.intercept('GET', '**/files/diff*').as('late');
      cy.card('invoice').click();
      cy.get('[role=tab]').contains('Files').click();
      rowFor('src/invoice/export.ts').should('exist');
      cy.get('@late.all').should('have.length', 0);
      rowFor('src/invoice/export.ts').click();
      cy.get('[role=dialog]').contains('export const header = "invoice-v2";', { timeout: 15000 });
      cy.get('@late.all').should('have.length', 1);
    });

    it('steps to the last file, where Next is disabled and Previous names the file before it', () => {
      rowFor('config/secrets.env').click();
      cy.get('[role=dialog]').within(() => {
        cy.contains('Showing file 8 of 8');
        cy.get('button[aria-label="Next file"]').should('be.disabled');
        cy.get('button[aria-label^="Previous file: "]').should('be.enabled');
      });
    });

    it('loads only the file in view when the reporter\'s fileDiffPreload option is off, and the dialog still opens and steps', () => {
      cy.task('diffs:stop');
      cy.task('diffs:start', { fileDiffPreload: false });
      rowFor('src/invoice/export.ts').click();
      cy.get('[role=dialog]').contains('export const header = "invoice-v2";', { timeout: 15000 });
      cy.get('[role=dialog] button[aria-label^="Next file"]').click();
      cy.get('[role=dialog] h2').should('have.text', 'src/invoice/export.test.ts');
      cy.get('[role=dialog]').contains('test("header"', { timeout: 15000 });
    });

    it('is one column with both line numbers in a dialog narrower than 720 px', () => {
      cy.atWidth(600);
      cy.openConsole('#/?open=e2e-s-invoice');
      cy.get('[role=tab]').contains('Files').click();
      rowFor('src/invoice/export.ts').click();
      cy.get('[role=dialog]').contains('export const header = "invoice-v2";', { timeout: 15000 });
      cy.get('[role=dialog]').should(($d) => expect($d[0].getBoundingClientRect().width).to.be.lessThan(600));
      cy.document().then((doc) => expect(doc.documentElement.scrollWidth).to.be.at.most(doc.documentElement.clientWidth));
    });

    it('closes with Esc and returns focus to the row', () => {
      rowFor('src/invoice/totals.ts').click();
      cy.get('[role=dialog]').should('exist');
      cy.get('body').type('{esc}');
      cy.get('[role=dialog]').should('not.exist');
      cy.focused().should('have.attr', 'aria-label', 'Open diff of src/invoice/totals.ts');
    });
  });

  context('when the server cannot get the diff', () => {
    const fails = (status, words) => {
      it(`says so in words (HTTP ${status}) and the file is asked for again when it is opened again`, () => {
        cy.signIn('Ed');
        cy.reportAgain('invoice', { fileDiffPreload: false });
        cy.intercept('GET', '**/files/diff*', { statusCode: status, body: { ok: false } }).as('diff');
        openFiles();
        rowFor('src/invoice/export.ts').click();
        cy.get('[role=dialog]').should('contain.text', words);
        cy.get('[role=dialog] button[aria-label^="Next file"]').should('be.enabled');
        cy.get('@diff.all').should('have.length', 1);
        cy.get('body').type('{esc}');
        rowFor('src/invoice/export.ts').click();
        cy.get('[role=dialog]').should('contain.text', words);
        cy.get('@diff.all').should('have.length', 2);
      });
    };
    fails(504, "The diff is not available. The session's machine did not answer in 15 seconds");
    fails(429, 'Too many diffs are waiting for this session.');
  });

  context('who may open a diff', () => {
    afterEach(() => cy.setFlags({ 'file-diff': true }));

    it('tells a signed-out viewer to sign in, and rows are not buttons', () => {
      openFiles();
      cy.contains('Sign in to open diffs.');
      cy.get('button[aria-label^="Open diff of"]').should('not.exist');
    });

    it('says only the owner can open diffs when someone else is signed in', () => {
      cy.signIn('Alex');
      openFiles();
      cy.contains('Only Ed can open diffs.');
      cy.get('button[aria-label^="Open diff of"]').should('not.exist');
    });

    it('shows nothing about diffs, and no buttons, when the Admin turned the file-diff flag off', () => {
      cy.setFlags({ 'file-diff': false });
      cy.signIn('Ed');
      openFiles();
      cy.get('button[aria-label^="Open diff of"]').should('not.exist');
      cy.contains('Sign in to open diffs.').should('not.exist');
      cy.contains('Only Ed can open diffs.').should('not.exist');
    });

    it('asks for the fileDiff option when the reporter has it off', () => {
      cy.signIn('Ed');
      cy.reportAgain('invoice', { fileDiff: false });
      openFiles();
      cy.contains('Turn on the fileDiff option of podium-reporter on this machine to open diffs.');
      cy.get('button[aria-label^="Open diff of"]').should('not.exist');
    });
  });
});
