// SPEC 8.1 Feature flags and Admin > Settings: every flag on, off and on again, and what each one changes in the console; wall notices; the wall settings;
// forget old reporters; messaging limits; recording limits.
describe('admin: settings', () => {
  before(() => cy.resetServer());
  beforeEach(() => cy.openAdmin('Settings'));

  const FLAGS = ['activity-feed', 'activity-output', 'respond', 'file-diff', 'peer-messaging', 'session-recording', 'update-check'];
  // Whatever a test turned off is turned on again here, so a failing test cannot leave a flag off for the next one.
  afterEach(() => cy.setFlags(Object.fromEntries(FLAGS.map((f) => [f, true]))));

  it('has one switch row per feature flag, with its name, its id in mono and a description', () => {
    cy.get('h2#admin-features-h').should('have.text', 'Feature flags');
    for (const id of FLAGS) cy.settingSwitch(`feature-${id}`).should('exist');
    cy.contains('.srow', 'Agent activity feed').should('contain.text', 'activity-feed').and('contain.text', "Shows an agent's recent tool calls and text in its panel");
    cy.contains('.srow', 'Release check').should('contain.text', 'update-check');
  });

  it('shows the seeded state of each flag (all on)', () => {
    for (const id of FLAGS) cy.settingSwitch(`feature-${id}`).should('have.attr', 'aria-checked', 'true');
  });

  it('turns a flag off and on again, and the server keeps it', () => {
    cy.settingSwitch('feature-update-check').click().should('have.attr', 'aria-checked', 'false');
    cy.reload();
    cy.adminPage('Settings');
    cy.settingSwitch('feature-update-check').should('have.attr', 'aria-checked', 'false').click().should('have.attr', 'aria-checked', 'true');
  });

  for (const id of FLAGS) {
    it(`${id}: off, kept over a reload, and on again`, () => {
      cy.settingSwitch(`feature-${id}`).click().should('have.attr', 'aria-checked', 'false');
      cy.request('/api/fleet/state').its('body.features').should((features) => expect(features[id]).to.eq(false));
      cy.reload();
      cy.adminPage('Settings');
      cy.settingSwitch(`feature-${id}`).should('have.attr', 'aria-checked', 'false').click().should('have.attr', 'aria-checked', 'true');
      cy.request('/api/fleet/state').its('body.features').should((features) => expect(features[id]).to.eq(true));
    });
  }

  it('shows the warning bars under Bash output and Session recording while they are on', () => {
    cy.contains('[role=note]', 'Output holds whatever a command printed').should('exist');
    cy.contains('[role=note]', 'A recording holds whole prompts, file contents, command output and tool results.').should('exist');
    cy.settingSwitch('feature-activity-output').click();
    cy.contains('[role=note]', 'Output holds whatever a command printed').should('not.exist');
  });

  it('writes a flag change to the Admin log', () => {
    cy.settingSwitch('feature-file-diff').click();
    cy.settingSwitch('feature-file-diff').click();
    cy.adminPage('Admin log');
    cy.contains('td', /file-diff|File diff/).should('exist');
  });

  it('shows the messaging limits only while messaging is on, and the recording form only while recording is on', () => {
    cy.get('h2#admin-peer-h').should('exist');
    cy.get('h2#a-rs').should('exist');
    cy.settingSwitch('feature-peer-messaging').click();
    cy.get('h2#admin-peer-h').should('not.exist');
    cy.settingSwitch('feature-session-recording').click();
    cy.get('h2#a-rs').should('not.exist');
  });

  it('saves a lower messaging limit and refuses a bad one in words', () => {
    cy.get('#lim-roundTrips').should('have.value', '10');
    cy.get('#lim-roundTrips').clear().type('8').blur();
    cy.reload();
    cy.adminPage('Settings');
    cy.get('#lim-roundTrips').should('have.value', '8');
    cy.get('#lim-roundTrips').clear().type('0').blur();
    cy.get('#lim-roundTrips').closest('.srow').invoke('text').should('contain', 'Round trips must be a whole number from 1 to 100. Nothing was saved. The saved value, 8, still applies.');
    cy.get('#lim-roundTrips').clear().type('10').blur();
  });

  it('refuses a recording limit that is out of range, in words, and saves nothing', () => {
    cy.get('#rec-n').clear().type('0');
    cy.get('#rec-n').closest('form').contains('button', 'Save').click();
    cy.get('#rec-n').closest('form').should('contain.text', 'Enter a whole number of hours or days, from 1 hour to 7 days.');
    cy.get('#rec-n').clear().type('6');
    cy.get('#rec-b').clear().type('0');
    cy.get('#rec-n').closest('form').contains('button', 'Save').click();
    cy.get('#rec-n').closest('form').should('contain.text', 'The disk budget is from');
    cy.reload();
    cy.adminPage('Settings');
    cy.get('#rec-b').should('have.value', '4');
  });

  it('saves the recording limits: keep for, disk budget and one-session limit', () => {
    cy.get('#rec-n').should('have.value', '6');
    cy.get('#rec-u').should('have.value', 'hours');
    cy.get('#rec-b').should('have.value', '4');
    cy.get('#rec-c').should('have.value', '512');
    cy.get('#rec-n').clear().type('12');
    cy.get('#rec-n').closest('form').contains('button', 'Save').click();
    cy.reload();
    cy.adminPage('Settings');
    cy.get('#rec-n').should('have.value', '12');
  });

  it('has a switch for each wall notice, the background sessions and the machine in card titles', () => {
    cy.settingSwitch('notice-background-sessions').should('exist');
    cy.settingSwitch('background').should('have.attr', 'aria-checked', 'false');
    cy.settingSwitch('card-title-machine').should('have.attr', 'aria-checked', 'false');
  });

  it('titles every card with the machine when that switch is on', () => {
    cy.settingSwitch('card-title-machine').click().should('have.attr', 'aria-checked', 'true');
    cy.visit('/#/');
    cy.card('api').should('contain.text', 'ed-mbp | api-gateway');
    cy.visit('/#/admin');
    cy.adminPage('Settings');
    cy.settingSwitch('card-title-machine').click();
  });

  it('turns "Forget old reporters" on with a number of days', () => {
    cy.settingSwitch('forget-reporters').should('have.attr', 'aria-checked', 'false').click().should('have.attr', 'aria-checked', 'true');
    cy.get('#forget-days').should('have.value', '30');
    cy.settingSwitch('forget-reporters').click();
  });
});

// Turning the session-recording flag off drops what the server holds for recordings, so the recordings table is checked on a server of its own.
describe('admin: settings > recordings', () => {
  before(() => cy.resetServer({ seedArgs: '--recording' }));
  beforeEach(() => cy.openAdmin('Settings'));

  it('lists every recording with its session, owner, state, size and Stop and Delete', () => {
    cy.get('h2#a-lg').should('have.text', 'Recordings');
    for (const name of ['invoice-v2', 'old-run']) {
      cy.contains('tr', name).should('contain.text', 'Ed').and('contain.text', 'Recording').within(() => {
        cy.contains('button', 'Stop').should('be.visible');
        cy.contains('button', 'Delete').should('be.visible');
      });
    }
  });

  it('asks before it stops a recording; Keep recording changes nothing and Stop recording keeps what was recorded', () => {
    cy.contains('tr', 'invoice-v2').contains('button', 'Stop').click();
    cy.contains('h3', 'Stop recording invoice-v2?').should('be.visible');
    cy.contains('button', 'Keep recording').click();
    cy.contains('h3', 'Stop recording invoice-v2?').should('not.exist');
    cy.contains('tr', 'invoice-v2').should('contain.text', 'Recording');
    cy.contains('tr', 'invoice-v2').contains('button', 'Stop').click();
    cy.contains('button', 'Stop recording').click();
    cy.contains('Stopped the recording of invoice-v2. What was recorded is kept.');
    cy.contains('tr', 'invoice-v2').should('contain.text', 'Stopped');
    cy.contains('tr', 'invoice-v2').contains('button', 'Stop').should('not.exist');
  });
});
