// SPEC 8.1 Admin > Security, Certificates, Data, Stored activity, Admin log.
// Order: the tests below run in order on one server. "Data" saves the Keep-everything policy, which "Stored activity" then reads (nothing is stored under it yet).
describe('admin: server pages', () => {
  before(() => cy.resetServer({ seedArgs: '--recording' }));

  context('Security', () => {
    beforeEach(() => cy.openAdmin('Security'));
    it('has the switch that lets reporters use the admin secret, and says what protects the tokens', () => {
      cy.get('h2#admin-leg-h').should('have.text', 'Reporting with the admin secret');
      cy.get('[role=switch]').should('have.attr', 'aria-checked', 'true');
      cy.contains('Tokens are stored hashed. Podium cannot show one again.');
      cy.contains('Wrong guesses at the admin secret are limited and logged in the Admin log.');
    });
    it('turns the admin-secret path off and on', () => {
      cy.get('[role=switch]').click().should('have.attr', 'aria-checked', 'false');
      cy.reload();
      cy.adminPage('Security');
      cy.get('[role=switch]').should('have.attr', 'aria-checked', 'false').click().should('have.attr', 'aria-checked', 'true');
    });
  });

  context('Certificates', () => {
    it('says TLS is off and what to do', () => {
      cy.openAdmin('Certificates');
      cy.contains('TLS is off. Start Podium with built-in TLS to manage certificates here.');
    });
  });

  context('Data', () => {
    beforeEach(() => cy.openAdmin('Data'));
    it('lists the rollup tables and the detail rows with how long each is kept', () => {
      cy.contains('usage_daily').parent().should('contain.text', '395 days');
      cy.contains('td', 'samples').parent().should('contain.text', '24 hours');
      cy.contains('td', 'admin_log').parent().should('contain.text', '90 days');
      cy.contains('RETAIN_SAMPLES_MS');
      cy.contains('Activity history').should('exist');
    });
    it('offers the four activity-history policies, with a warning bar once one that keeps is chosen', () => {
      cy.get('select[aria-labelledby="ah-policy-n"]').find('option').then(($o) => expect([...$o].map((o) => o.textContent)).to.deep.eq(['Not stored (default)', 'Purge after a set time', 'Purge when the session ends', 'Keep everything']));
      cy.get('select[aria-labelledby="ah-policy-n"]').select('Keep everything');
      cy.get('[role=note]').should('contain.text', 'Podium will ask every reporter to send the activity of each running loop');
      cy.contains('button', 'Cancel').click();
    });
    it('saves a keep policy, and writes it to the Admin log', () => {
      cy.get('select[aria-labelledby="ah-policy-n"]').select('Keep everything');
      cy.contains('button', 'Save').click();
      cy.reload();
      cy.adminPage('Data');
      cy.get('select[aria-labelledby="ah-policy-n"]').find(':selected').should('have.text', 'Keep everything');
      cy.contains('Activity history').parent().should('not.contain.text', 'Not stored (default)');
      cy.adminPage('Admin log');
      cy.contains('td', /activity history|Activity history/i).should('exist');
    });
  });

  context('Stored activity', () => {
    beforeEach(() => cy.openAdmin('Stored activity'));
    it('shows the totals, the filters and the empty state', () => {
      cy.contains('What is stored');
      cy.contains('button', 'Delete everything…').should('be.disabled');
      cy.contains('Source');
      cy.get('table[aria-label="Stored activity by session"] tbody tr').should('not.exist');
      cy.contains('.empty', 'Nothing has been captured yet. Activity appears here once a session runs under this policy.');
    });
    it('switches the source to Recordings and lists the recorded sessions', () => {
      cy.get('#stored-src').select('Recordings');
      cy.contains('tr', 'invoice-v2').should('exist');
    });
  });

  context('Admin log', () => {
    it('lists the entry made last before the one made first', () => {
      cy.addPerson('LogFirst');
      cy.addPerson('LogSecond');
      cy.openAdmin('Admin log');
      cy.get('table tbody tr').should(($r) => {
        const texts = [...$r].map((r) => r.textContent);
        const second = texts.findIndex((t) => t.includes('LogSecond'));
        const first = texts.findIndex((t) => t.includes('LogFirst'));
        expect(second, 'the later entry is listed').to.be.greaterThan(-1);
        expect(second, 'the later entry comes before the earlier one').to.be.lessThan(first);
      });
    });
    beforeEach(() => cy.openAdmin('Admin log'));
    it('lists what happened, with who, what and from where, and how long entries are kept', () => {
      cy.get('h1').should('have.text', 'Admin log');
      cy.contains('th', 'When');
      cy.contains('th', 'Who');
      cy.contains('th', 'What happened');
      cy.contains('th', 'From');
      cy.contains('td', 'Admin unlocked').should('exist');
      cy.contains('Entries are kept for 90 days.');
      cy.contains('td', 'Ed chose to record 3 loops in invoice-v2').should('exist');
    });
  });
});
