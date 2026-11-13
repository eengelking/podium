// SPEC 8.1 Right panel > Agent detail, Activity section (#1082): an agent's whole prompt and answer (`/api/fleet/sessions/:id/agents/:agentId/text`) and its live Activity
// (`.../activity`) are open to the session's owner and to an Admin, signed in, on every server, including one where no feature offers a sign-in (the Admin who reads another
// person's agent is told to the person: admin-read-notices.cy.js). Not signed in is 401, anyone else 403, and the console says so in place of the text and the entries.
// The tests read only, so they do not depend on each other.
import { seeded } from '../../../support/commands';

const SESSION = 'e2e-s-invoice';
const AGENT = 'e2e-a-map';
const EXCERPT = 'Found 42 call sites across 9 modules.';
const text = (failOnStatusCode = false) => cy.request({ url: `/api/fleet/sessions/${SESSION}/agents/${AGENT}/text`, failOnStatusCode, log: false });
const live = (failOnStatusCode = false) => cy.request({ url: `/api/fleet/sessions/${SESSION}/agents/@orchestrator/activity?every=5`, failOnStatusCode, log: false });
const side = () => cy.get('#podium-side-body');
const row = (id) => cy.get(`#row-${id}`);
const open = () => {
  cy.openConsole(`#/?open=${seeded().sessions.invoice}`);
  cy.get('main#podium-main h1').should('have.text', 'invoice-v2');
};

describe('the whole text and the live activity of an agent are the owner\'s and the Admin\'s', () => {
  before(() => {
    cy.resetServer();
    // The seed's agent has an excerpt only; the reporter's option for full answers sends the text, which the full-text route then serves.
    cy.reportAgain('invoice', {}, { [AGENT]: { answerText: `${EXCERPT} Every one is listed in the full answer.` } });
  });

  it('answers 401 to a request that is not signed in', () => {
    text().its('status').should('eq', 401);
    live().its('status').should('eq', 401);
  });

  it('answers 403 to a person who is neither the owner nor an Admin', () => {
    cy.signIn('Alex');
    text().its('status').should('eq', 403);
    live().its('status').should('eq', 403);
  });

  it('answers the owner and an Admin', () => {
    cy.signIn('Ed');
    text().then((r) => expect(r.status).to.eq(200));
    live().then((r) => expect(r.status).to.eq(200));
    cy.signIn('Admin');
    text().then((r) => expect(r.status).to.eq(200));
    live().then((r) => expect(r.status).to.eq(200));
  });

  it('shows, when not signed in, the excerpt of the Final answer and asks for a sign-in; the feed says it is open to Ed and the Admin', () => {
    open();
    row(AGENT).click();
    side().contains('button.docbtn', 'Final answer').click();
    cy.get('[role=dialog]').should('contain.text', EXCERPT).and('contain.text', 'Sign in as Ed or an Admin to open the full text. Showing the first 400 characters.');
    cy.get('body').type('{esc}');
    row('e2e-a-port').click();
    side().contains('The live activity is open to Ed and the Admin. Sign in as Ed or an Admin to see it.');
    side().contains('Nothing to show');
    side().contains('Not shown');
  });

  it('says, to another person, that only Ed and the Admin can open them', () => {
    cy.signIn('Alex');
    open();
    row(AGENT).click();
    side().contains('button.docbtn', 'Final answer').click();
    cy.get('[role=dialog]').should('contain.text', EXCERPT).and('contain.text', 'Only Ed and the Admin can open the full text. Showing the first 400 characters.');
    cy.get('body').type('{esc}');
    row('e2e-a-port').click();
    side().contains('The live activity is open to Ed and the Admin only.');
    side().contains('Not shown');
  });

  it('shows the owner the full text in the report dialog, with no refusal, and the feed waiting for entries', () => {
    cy.signIn('Ed');
    open();
    row(AGENT).click();
    side().contains('button.docbtn', 'Final answer').click();
    cy.get('[role=dialog]').should('contain.text', EXCERPT).and('contain.text', 'Every one is listed in the full answer.').and('not.contain.text', 'Sign in as').and('not.contain.text', 'Only Ed and the Admin');
    cy.get('body').type('{esc}');
    row('e2e-a-port').click();
    side().contains('Watching from now');
    side().contains('The live activity is open to').should('not.exist');
  });
});
