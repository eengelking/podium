// SPEC 8.1 Model prices (#117): the table of prices by model, editing one, adding a model.
describe('admin: model prices', () => {
  before(() => cy.resetServer());
  beforeEach(() => cy.openAdmin('Model prices'));

  it('lists the built-in models with their five prices each', () => {
    cy.get('h2#admin-prices-h').should('have.text', 'Prices by model');
    cy.get('input[aria-label="Opus 5.5 input"]').should('have.value', '4');
    cy.get('input[aria-label="Opus 5.5 output"]').should('have.value', '20');
    cy.get('input[aria-label="Opus 5.5 cache read"]').should('have.value', '0.2');
    cy.get('input[aria-label="Opus 5.5 cache write 5 minutes"]').should('have.value', '5');
    cy.get('input[aria-label="Opus 5.5 cache write 1 hour"]').should('have.value', '8');
  });

  it('changes a price with Save, tags the row Changed, and keeps it over a reload', () => {
    cy.get('input[aria-label="Sonnet 5.5 output"]').clear().type('20');
    cy.get('button[aria-label="Cancel Sonnet 5.5"]').should('be.visible');
    cy.get('input[aria-label="Sonnet 5.5 output"]').closest('tr').contains('button', 'Save').click();
    cy.contains('Changed').should('exist');
    cy.reload();
    cy.adminPage('Model prices');
    cy.get('input[aria-label="Sonnet 5.5 output"]').should('have.value', '20');
  });

  it('cancels an edit and restores the saved price', () => {
    cy.get('input[aria-label="Haiku 5.5 input"]').clear().type('9');
    cy.get('button[aria-label="Cancel Haiku 5.5"]').click();
    cy.get('input[aria-label="Haiku 5.5 input"]').should('have.value', '0.1');
  });

  it('refuses a price that is not a number, in words', () => {
    cy.get('input[aria-label="Haiku 5.5 output"]').clear().type('abc');
    cy.get('input[aria-label="Haiku 5.5 output"]').closest('tr').contains('button', 'Save').click();
    cy.get('input[aria-label="Haiku 5.5 output"]').closest('table').parent().invoke('text').should('contain', 'Output must be a number.');
    cy.get('button[aria-label="Cancel Haiku 5.5"]').click();
  });

  it('adds a model and lists it', () => {
    cy.get('#mp-new').type('claude-example-1');
    cy.contains('button', 'Add model').click();
    cy.get('input[aria-label*="claude-example-1 input"]').should('exist');
  });

  it('tags a changed built-in price "Changed", says what the built-in was, and Reset to built-in restores it', () => {
    cy.get('input[aria-label="Opus 5.5 input"]').clear().type('7');
    cy.get('input[aria-label="Opus 5.5 input"]').closest('tr').contains('button', 'Save').click();
    cy.get('input[aria-label="Opus 5.5 input"]').closest('tr').should('contain.text', 'Changed').and('contain.text', 'Built-in input is 4');
    cy.get('button[aria-label="Reset Opus 5.5 to built-in"]').click();
    cy.get('input[aria-label="Opus 5.5 input"]').should('have.value', '4');
    cy.contains('tr', 'Opus 5.5').should('not.contain.text', 'Changed');
  });

  const fillPrices = (name) => {
    for (const f of ['input', 'output', 'cache read', 'cache write 5 minutes', 'cache write 1 hour']) cy.get(`input[aria-label*="${name} ${f}"]`).clear().type('1.5');
  };

  it('tags a saved added model "Added by you" and Remove takes it away again', () => {
    cy.get('#mp-new').type('claude-example-2');
    cy.contains('button', 'Add model').click();
    fillPrices('claude-example-2');
    cy.contains('tr', 'claude-example-2').contains('button', 'Save').click();
    cy.contains('tr', 'claude-example-2').should('contain.text', 'Added by you').and('contain.text', 'Podium has no built-in price for this model');
    cy.contains('tr', 'claude-example-2').contains('button', 'Remove').click();
    cy.contains('tr', 'claude-example-2').should('not.exist');
  });

  it('refuses a model that is already in the table, in words', () => {
    cy.get('#mp-new').type('claude-example-3');
    cy.contains('button', 'Add model').click();
    cy.get('#mp-new').type('claude-example-3');
    cy.contains('button', 'Add model').click();
    cy.contains('claude-example-3 is already in the table.').should('be.visible');
  });

  it('marks the price field that is wrong with aria-invalid and says which', () => {
    cy.get('input[aria-label="Haiku 5.5 output"]').clear().type('-3');
    cy.get('input[aria-label="Haiku 5.5 output"]').closest('tr').contains('button', 'Save').click();
    cy.get('input[aria-label="Haiku 5.5 output"]').should('have.attr', 'aria-invalid', 'true');
    cy.get('input[aria-label="Haiku 5.5 output"]').closest('table').parent().invoke('text').should('contain', 'Output must be zero or more.');
    cy.get('button[aria-label="Cancel Haiku 5.5"]').click();
    cy.get('input[aria-label="Haiku 5.5 output"]').should('not.have.attr', 'aria-invalid');
  });
});

// Earlier tests in this file change prices, so the cost check starts from a server of its own.
describe('admin: model prices change costs', () => {
  before(() => cy.resetServer());
  it('changes what a session costs: api-gateway reports 150,000 input and 12,000 output tokens on Sonnet 5.5, $0.42 at $2 and $10 per million', () => {
    cy.visit('/#/');
    cy.card('api').should('contain.text', '$0.42');
    cy.openAdmin('Model prices');
    for (const f of ['input', 'output', 'cache read', 'cache write 5 minutes', 'cache write 1 hour']) cy.get(`input[aria-label="Sonnet 5.5 ${f}"]`).clear().type('100');
    cy.get('input[aria-label="Sonnet 5.5 input"]').closest('tr').contains('button', 'Save').click();
    cy.contains('tr', 'Sonnet 5.5').should('contain.text', 'Changed');
    // $100 per million on 162,000 tokens is $16.20 on the card, and Ed's Spend today goes from $30.31 to $46.09.
    cy.visit('/#/');
    cy.card('api').should('contain.text', '$16.20').and('not.contain.text', '$0.42');
    cy.openAdmin('Spend');
    cy.get('main').should(($m) => expect($m[0].innerText).to.contain('$46.09'));
  });
});
