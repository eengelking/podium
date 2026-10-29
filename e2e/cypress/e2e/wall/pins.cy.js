// SPEC 8.1 Pinned cards (#496): a pin holds a slot in the wall's reading order while the sort, the filter and the data change.
describe('wall: pinned cards', () => {
  before(() => cy.resetServer());
  beforeEach(() => {
    cy.openConsole('#/');
    cy.contains('.people button', /^All$/).click();
    cy.cards().should('have.length', 12);
  });
  const order = () => cy.cards().then(($c) => [...$c].map((c) => c.getAttribute('data-session')));
  const API = 'e2e-s-api-gateway';
  const pin = () => cy.get(`button.pin[aria-label="Pin api-gateway to its place on the wall"]`);

  it('names the button "Pin <session> to its place on the wall", then "Unpin <session>" with aria-pressed, and stores {id, slot}', () => {
    pin().should('have.attr', 'aria-pressed', 'false').click();
    cy.get('button.pin[aria-label="Unpin api-gateway"]').should('have.attr', 'aria-pressed', 'true');
    cy.window().its('localStorage').invoke('getItem', 'podium.pins').then((raw) => {
      const pins = JSON.parse(raw);
      expect(pins).to.have.length(1);
      expect(pins[0].id).to.eq(API);
      expect(pins[0].slot).to.be.a('number');
    });
  });

  it('keeps the card in the slot it was pinned at while the sort order changes, and unpinning returns it to the usual order', () => {
    cy.get('#podium-sort').select('Status');
    order().then((before) => {
      const slot = before.indexOf(API);
      pin().click();
      cy.get('#podium-sort').select('Cost');
      order().then((cost) => {
        expect(cost.indexOf(API), 'the pinned card holds its slot under Cost').to.eq(slot);
        const others = cost.filter((id) => id !== API);
        expect(others[0], 'the unpinned cards fill the other slots in the usual order').to.eq('e2e-s-invoice');
      });
      cy.get('button.pin[aria-label="Unpin api-gateway"]').click();
      order().then((after) => expect(after.indexOf(API), 'back in the usual Cost order').to.be.greaterThan(slot));
    });
  });

  it('keeps the slot when a report changes the card, and when the filter hides it the others close up with no gap and it returns', () => {
    cy.get('#podium-sort').select('Status');
    order().then((before) => {
      const slot = before.indexOf(API);
      pin().click();
      cy.reportAgain('api', { costUsd: 99, usageByModel: [], status: 'waiting', waitReason: 'input' });
      cy.card('api').should('contain.text', '$99');
      order().then((o) => expect(o.indexOf(API)).to.eq(slot));
      cy.get('input[aria-label="Filter orchestrators"]').type('docs');
      cy.cards().should('have.length', 1).first().should('have.attr', 'data-session', 'e2e-s-docs-sweep');
      cy.get('input[aria-label="Filter orchestrators"]').clear();
      cy.cards().should('have.length', 12);
      order().then((o) => expect(o.indexOf(API), 'it returns to its slot').to.eq(slot));
    });
  });

  it('keeps the pin over a reload', () => {
    pin().click();
    cy.reload();
    cy.get('button.pin[aria-label="Unpin api-gateway"]').should('have.attr', 'aria-pressed', 'true');
  });
});
