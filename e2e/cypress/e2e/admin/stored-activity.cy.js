// SPEC 8.1 Data and Stored activity (#432): the Activity history kept by the server. The seed turns on "Keep everything" and stores 60 entries for stored-run and 5 for stored-two.
describe('activity history: the feed and Admin > Stored activity', () => {
  // Tests here run in order on one server: the deletes at the end remove what the first tests read, and the policy test puts it back.
  before(() => cy.resetServer({ seedArgs: '--stored' }));
  afterEach(() => cy.putSettings({ activityHistory: { policy: 'all', n: 7, unit: 'days', capGb: null } }));

  context('the feed of a session whose history is kept', () => {
    const openFeed = () => {
      cy.openConsole('#/?open=e2e-s-stored-run');
      cy.get('button.trow.root').click();
    };
    const side = () => cy.get('#podium-side-body');

    it('shows the newest 20 stored entries to the owner, with "Show older" and the stored count and date', () => {
      cy.signIn('Ed');
      openFeed();
      side().contains('Showing the newest 20', { timeout: 15000 });
      side().contains('Read src/file58.ts');
      side().contains('Read src/file38.ts').should('not.exist');
      side().invoke('text').should('match', /60 stored entries since \d{4}-\d{2}-\d{2}/);
    });

    it('prepends older entries with Show older, the whole history at last', () => {
      cy.signIn('Ed');
      openFeed();
      side().contains('button', 'Show older', { timeout: 15000 }).click();
      side().contains('Showing the newest 40');
      side().contains('Read src/file38.ts');
      side().contains('button', 'Show older').click();
      side().contains('Read src/file0.ts');
      side().contains('button', 'Show older').should('not.exist');
    });

    it('says how long entries are kept under each policy, and who can read them', () => {
      cy.signIn('Ed');
      openFeed();
      side().contains('Kept until the session is removed from Podium. Only the owner and the Admin can open it.', { timeout: 15000 });
      cy.putSettings({ activityHistory: { policy: 'end', n: 7, unit: 'days', capGb: null } });
      cy.reload();
      cy.get('button.trow.root').click();
      side().contains('Kept until the session ends, then removed. Only the owner and the Admin can open it.', { timeout: 15000 });
      cy.putSettings({ activityHistory: { policy: 'after', n: 7, unit: 'days', capGb: null } });
      cy.reload();
      cy.get('button.trow.root').click();
      side().invoke('text').should('match', /Kept until \d{4}-\d{2}-\d{2}, then purged\. Only the owner and the Admin can open it\./);
    });

    it('does not show the entries to a viewer who may not read them, and says who can', () => {
      openFeed();
      cy.get('#podium-side-body').contains('Sign in as Ed or an Admin to open it.', { timeout: 15000 });
      cy.get('#podium-side-body').should('not.contain.text', 'Read src/file58.ts');
      cy.get('#podium-side-body').contains('Nothing to show');
    });
  });

  context('Stored activity', () => {
    beforeEach(() => cy.openAdmin('Stored activity'));
    const rows = () => cy.get('table[aria-label="Stored activity by session"] tbody tr');
    // innerText, with the whitespace between the page's separate figures made one space; it retries until the page has them.
    const expectText = (re) => cy.get('main').should(($m) => expect($m[0].innerText.replace(/\s+/g, ' ')).to.match(re));

    it('shows the totals, the policy and one row per session with its entries and size', () => {
      cy.contains('Policy: keep everything.');
      expectText(/65 entries stored/);
      expectText(/2 sessions/);
      rows().should('have.length', 2);
      // Name, project, owner, state, entries, size, oldest entry: the entries column is the fifth cell.
      cy.contains('table[aria-label="Stored activity by session"] tr', 'stored-run').find('td').eq(4).should('have.text', '60');
      cy.contains('table[aria-label="Stored activity by session"] tr', 'stored-run').find('td').eq(2).should('contain.text', 'Ed');
      cy.contains('table[aria-label="Stored activity by session"] tr', 'stored-run').find('td').eq(3).should('contain.text', 'Live');
      cy.contains('table[aria-label="Stored activity by session"] tr', 'stored-two').find('td').eq(4).should('have.text', '5');
    });

    it('filters by project, owner and age, and the match count follows', () => {
      cy.get('#stored-project').select('acme/stored-two');
      rows().should('have.length', 1).and('contain.text', 'stored-two');
      expectText(/1 match the filter/);
      cy.get('#stored-project').select('All projects');
      cy.get('#stored-owner').select('Ed');
      rows().should('have.length', 2);
      // "Older than 7 days" matches nothing: every entry is an hour old.
      cy.get('#stored-age').select('7 days');
      rows().should('not.exist');
      cy.contains('.empty', 'No stored session matches. Clear a filter or widen the dates.');
      expectText(/0 match the filter/);
      cy.get('#stored-age').select('Any age');
      rows().should('have.length', 2);
      cy.get('#stored-q').type('no-such-session');
      rows().should('not.exist');
      cy.contains('.empty', 'No stored session matches. Clear a filter or widen the dates.');
      expectText(/0 match the filter/);
    });

    it('selects a session, names what a delete removes, and Keep them changes nothing', () => {
      cy.get('input[aria-label="Select stored-two"]').check();
      expectText(/1 selected, 5 entries/);
      cy.contains('button', /^Delete 1…/).click();
      cy.contains('h3', 'Delete the stored activity of 1 session?');
      cy.contains('5 entries,');
      cy.contains('button', 'Keep them').click();
      cy.contains('h3', 'Delete the').should('not.exist');
      rows().should('have.length', 2);
    });

    it('deletes the selected session\'s entries and says how many went and that the Admin log has it', () => {
      cy.get('input[aria-label="Select stored-two"]').check();
      cy.contains('button', /^Delete 1…/).click();
      cy.contains('button', 'Delete 5 entries').click();
      cy.contains('[role=status]', 'Deleted 5 entries').should('contain.text', 'Written to the Admin log.');
      rows().should('have.length', 1).and('not.contain.text', 'stored-two');
      expectText(/60 entries stored/);
    });

    it('deletes everything that matches a filter, and the table is then empty', () => {
      cy.get('#stored-q').type('stored-run');
      cy.contains('button', /^Delete all 1 that match…/).click();
      cy.contains('h3', 'that matches');
      cy.contains('60 entries,');
      cy.contains('button', 'Delete 60 entries').click();
      cy.contains('[role=status]', 'Deleted 60 entries');
      rows().should('not.exist');
      // The test before deleted stored-two, so the store is empty, not only the filter's match.
      cy.contains('.empty', 'Nothing has been captured yet. Activity appears here once a session runs under this policy.');
      expectText(/0 match the filter/);
    });
  });
});

describe('activity history: delete everything', () => {
  before(() => cy.resetServer({ seedArgs: '--stored' }));
  afterEach(() => cy.putSettings({ activityHistory: { policy: 'all', n: 7, unit: 'days', capGb: null } }));
  it('asks naming all the entries and sessions, then empties the store and says so', () => {
    cy.openAdmin('Stored activity');
    cy.contains('button', 'Delete everything…').click();
    cy.contains('h3', 'Delete all').should('contain.text', 'for all 2 sessions');
    cy.contains('65 entries,');
    cy.contains('button', 'Delete 65 entries').click();
    cy.contains('[role=status]', 'Deleted 65 entries');
    cy.get('table[aria-label="Stored activity by session"] tbody tr').should('not.exist');
    cy.contains('.empty', 'Nothing has been captured yet. Activity appears here once a session runs under this policy.');
    cy.get('main').should(($m) => expect($m[0].innerText.replace(/\s+/g, ' ')).to.match(/0 entries stored/).and.match(/0 sessions/));
    cy.contains('button', 'Delete everything…').should('be.disabled');
  });
});

describe('activity history: the policy form and its size cap', () => {
  before(() => cy.resetServer({ seedArgs: '--stored' }));
  // The size-cap test saves a cap of 2 GB; the policy goes back to what the seed set.
  afterEach(() => cy.putSettings({ activityHistory: { policy: 'all', n: 7, unit: 'days', capGb: null } }));
  beforeEach(() => cy.openAdmin('Data'));

  it('adds the period row for "Purge after a set time" and the size cap row for any keep policy', () => {
    cy.get('select[aria-labelledby="ah-policy-n"]').select('Purge after a set time');
    cy.get('input[aria-label="Number"]').should('be.visible');
    cy.get('select[aria-label="Unit"]').should('be.visible');
    cy.get('input[aria-label="Use a size cap"]').should('be.visible');
  });

  it('saves a size cap, keeps it over a reload, and refuses one that is out of range', () => {
    cy.get('select[aria-labelledby="ah-policy-n"]').select('Keep everything');
    cy.get('input[aria-label="Use a size cap"]').check();
    cy.get('input[aria-label="Size in gigabytes"]').clear().type('0');
    cy.contains('button', 'Save').click();
    cy.get('input[aria-label="Size in gigabytes"]').closest('form, .panel, section').invoke('text').should('contain', 'Enter a whole number from 1 to 1000 for the size cap.');
    cy.get('input[aria-label="Size in gigabytes"]').clear().type('2');
    cy.contains('button', 'Save').click();
    cy.reload();
    cy.adminPage('Data');
    cy.get('input[aria-label="Use a size cap"]').should('be.checked');
    cy.get('input[aria-label="Size in gigabytes"]').should('have.value', '2');
  });

  it('shows the stored total and the last purge under the form', () => {
    cy.contains('Last purge');
    cy.contains('65 entries');
  });
});
