// More of Traffic and My reporters: who may act on a link, what a failed save says, declining a request, limits the server refuses, and the Board view's Move to.
// Order: the tests below run in order on one server, and a later one reads what an earlier one left (named where it matters); the file resets the server once, in `before`.
describe('traffic: who may act on a link', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));

  it('lets another signed-in person see the map but not read the text or act on Ed\'s link', () => {
    cy.signIn('Alex');
    cy.openConsole('#/traffic');
    cy.contains('4 messages');
    cy.contains('Please run the unit tests').should('not.exist');
    cy.contains('button', 'Pause link').should('not.exist');
  });

  it('lets the Admin read a conversation but not pause or remove it: that is the owner\'s', () => {
    cy.signIn('Admin');
    cy.openConsole('#/traffic');
    cy.contains('Please run the unit tests on this branch.');
    cy.contains('button', 'Pause link').should('not.exist');
    cy.contains("Only Ed can pause or remove it.");
  });

  it('says so, and changes nothing, when Pause fails', () => {
    cy.signIn('Ed');
    cy.intercept('PUT', '**/peers/links*', { statusCode: 500, body: { ok: false } });
    cy.openConsole('#/traffic');
    cy.contains('button', 'Pause link').click();
    cy.get('[role=alert]').invoke('text').should('match', /^Could not pause the link: .+\. The link is still active\. Try again\.$/);
    cy.contains('button', 'Pause link').should('be.visible');
    cy.contains('button', 'Resume link').should('not.exist');
  });

  it('says so, and keeps the link, when Remove fails', () => {
    cy.signIn('Ed');
    cy.intercept({ method: /PUT|DELETE|POST/, url: '**/peers/**' }, (req) => {
      if (/links|rights/.test(req.url)) req.reply({ statusCode: 500, body: { ok: false } });
    });
    cy.openConsole('#/traffic');
    cy.contains('button', 'Remove link…').click();
    cy.get('[role=group][aria-label="Remove the link"]').contains('button', /^Remove link$/).click();
    cy.get('[role=alert]').invoke('text').should('match', /^Could not remove the link: .+\. Nothing changed\. Try again\.$/);
    cy.contains('Please run the unit tests on this branch.');
  });
});

describe('my reporters: answers, limits and failed saves', () => {
  before(() => cy.resetServer({ seedArgs: '--talk' }));
  beforeEach(() => {
    cy.signIn('Ed');
    cy.openConsole('#/me/reporters');
    cy.get('h1').should('have.text', 'My reporters');
    cy.get('table.ptab tbody tr').should('have.length', 3);
  });

  it('declines a request for access and says so', () => {
    cy.get('[role=group][aria-label="A request for access"]').contains('button', 'Decline').click();
    cy.get('[role=group][aria-label="A request for access"]').should('not.exist');
    cy.contains('Declined.');
  });

  it('declines an Admin\'s proposal and leaves the right as it was', () => {
    cy.get('[role=group][aria-label="A change an Admin proposes"]').contains('button', 'Decline').click();
    cy.get('[role=group][aria-label="A change an Admin proposes"]').should('not.exist');
    cy.get('select[id="g-e2e0000pi001-e2e0000mbp01"]').find(':selected').should('not.have.text', 'Can send, with approval');
  });

  it('refuses a limit above the Admin\'s, in words, and keeps the saved value', () => {
    cy.get('#pm-lim-roundTrips').clear().type('500').blur();
    cy.get('#pm-lim-roundTrips').closest('.srow').invoke('text').should('contain', "500 is above the Admin's limit, 10. Enter a whole number from 1 to 10. Nothing was saved.");
    cy.reload();
    cy.get('#pm-lim-roundTrips').should('have.value', '10');
  });

  it('puts the control back and says nothing changed when a rights change cannot be saved', () => {
    cy.intercept('PUT', '**/peers/rights*', { statusCode: 500, body: { ok: false } });
    cy.get('select[id="g-e2e0000ci001-e2e0000mbp01"]').find(':selected').invoke('text').then((was) => {
      cy.get('select[id="g-e2e0000ci001-e2e0000mbp01"]').select('Can see');
      cy.contains('Could not save the change');
      cy.contains('Nothing changed.');
      cy.get('select[id="g-e2e0000ci001-e2e0000mbp01"]').find(':selected').should('have.text', was);
    });
  });

  it('shows the Board view with a card per pair and a Move to list on each', () => {
    cy.get('[role=radiogroup][aria-label=View]').contains('[role=radio]', 'Board').click();
    cy.contains('Drag a card to another column, or use its Move to list.');
    // The Move to list is a select named by its label ("Move ci-runner-01 to"). Choosing a level moves the card to the column of that level and changes that reporter's right.
    const column = (level) => cy.get(`.pm-col[aria-label^="${level},"]`);
    const count = ($col) => Number(/, (\d+) reporters?$/.exec($col.attr('aria-label'))[1]);
    cy.contains('label', 'Move ci-runner-01 to').invoke('attr', 'for').then((id) => {
      cy.get(`[id="${id}"]`).find('option').then(($o) => {
        // The first option is the label; the choices after it that are not the current level are the ones that move the card.
        const level = [...$o].map((o) => o.textContent.replace(/^Move to: /, '')).find((t, i) => i > 0 && !$o[i].disabled && !$o[i].selected);
        expect(level, 'a level to move to').to.be.a('string');
        column(level).then(($to) => {
          const had = count($to);
          column(level).should('not.contain.text', 'ci-runner-01');
          cy.get(`[id="${id}"]`).select(`Move to: ${level}`);
          column(level).should('contain.text', 'ci-runner-01').and(($c) => expect(count($c), `the ${level} column now holds one more`).to.eq(had + 1));
        });
      });
    });
  });
});
