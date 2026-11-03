// Harness badge, neutral labels and capability-driven fields (#853). One sequence on one server: a wall of one harness first, then the same
// new session reported by OpenCode (a report v2 with a harness block) so the wall holds two harnesses. A session never changes harness, so it is a new id.
describe('harness badge and neutral labels', () => {
  before(() => cy.resetServer());

  const OC = 'e2e-s-opencode';
  const oc = () => cy.get(`button.card.sc[data-session="${OC}"]`);
  const opencode = { harness: { id: 'opencode', name: 'OpenCode', version: '1.0.0', surface: null }, capabilities: {} };

  it('draws no harness badge on a wall of one harness', () => {
    cy.openConsole('#/');
    cy.cards().should('have.length', 12);
    cy.get('.chip.hx').should('not.exist');
  });

  it('shows the badge on every card once a second harness reports, and drops Context from the OpenCode card', () => {
    cy.reportAgain('api', { id: OC, name: 'oc-session', harness: 'opencode', costSource: 'harness', costUsd: 2.5 }, undefined, undefined, opencode);
    cy.openConsole('#/');
    cy.cards().should('have.length', 13);
    oc().find('.chip.hx').should('contain.text', 'OpenCode');
    oc().find('.chip.hx svg').should('have.attr', 'data-shape', 'diamond');
    oc().find('.z3').should('have.class', 'three');
    oc().find('.z3 .c.ctx').should('not.exist');
    oc().contains('.src', 'from OpenCode');
    cy.card('api').find('.chip.hx').should('contain.text', 'Claude Code');
    cy.card('api').find('.chip.hx svg').should('have.attr', 'data-shape', 'square');
    cy.card('api').find('.z3 .c.ctx').should('exist');
    cy.card('api').find('.src').should('not.exist');
  });

  it('names the harness on the orchestrator page: no context size, a plain Cost label, Fork not available', () => {
    cy.openConsole('#/');
    oc().click();
    cy.get('main#podium-main h1').should('contain.text', 'oc-session');
    cy.grantClipboard();
    cy.get('button[aria-label="Copy resume command"]').click();
    cy.window().then((w) => w.navigator.clipboard.readText()).should('match', /opencode .*--session e2e-s-opencode/s);
    cy.get('main#podium-main').within(() => {
      cy.get('.chip.hx').should('contain.text', 'OpenCode');
      cy.contains('OpenCode does not report context size.');
      cy.contains('.fact .k', /^Cost$/).should('exist');
      cy.contains('.fact .k', 'Est. cost').should('not.exist');
      cy.get('button[aria-label="Copy fork command"]').should('not.exist');
      cy.contains('.fact .k', 'Fork').parent().find('.v').should('have.text', 'Not available');
    });
  });

  // What a harness declares in its report (#940) wins over the console's table of known harnesses, field by field. Acme is in no table (so the table
  // would show its Context cell; the note names it by its id, all the console knows of an unlisted harness); the OpenCode session below declares context where the table says it has none. One story: declared, then
  // the server restarted on the same data, then the session ended and opened from History.
  const NC = 'e2e-s-acme';
  const CT = 'e2e-s-opencode-ctx';
  const nc = () => cy.get(`button.card.sc[data-session="${NC}"]`);
  const ct = () => cy.get(`button.card.sc[data-session="${CT}"]`);
  const acme = { harness: { id: 'acme', name: 'Acme', version: '1.0.0', surface: null }, capabilities: { context: false } };
  const ocContext = { harness: { id: 'opencode', name: 'OpenCode', version: '1.0.0', surface: null }, capabilities: { context: true } };
  const gpt = { model: 'gpt-5.1', modelLabel: 'GPT-5.1', modelProvider: 'OpenAI' };

  it('hides Context when the harness declares context false, shows it when it declares true, and reads the model label', () => {
    cy.reportAgain('api', { id: NC, name: 'acme-session', harness: 'acme', ...gpt }, undefined, undefined, acme);
    cy.reportAgain('api', { id: CT, name: 'oc-context', harness: 'opencode' }, undefined, undefined, ocContext);
    cy.openConsole('#/');
    cy.cards().should('have.length', 15);
    nc().find('.z3 .c.ctx').should('not.exist');
    nc().find('.mdl .chip').not('.hx').should('have.text', 'GPT-5.1').and('have.attr', 'title', 'gpt-5.1');
    ct().find('.z3 .c.ctx').should('exist');
    cy.card('api').find('.z3 .c.ctx').should('exist');
    cy.card('api').find('.mdl .chip').not('.hx').should('contain.text', 'Sonnet').and('have.attr', 'title', 'claude-sonnet-5-5');
  });

  it('says on the orchestrator page that the declaring harness reports no context size, and not for one that declares it', () => {
    cy.openConsole('#/');
    nc().click();
    cy.get('main#podium-main h1').should('contain.text', 'acme-session');
    cy.contains('main#podium-main', 'acme does not report context size.');
    cy.get('main#podium-main').contains('.chip', 'GPT-5.1').should('have.attr', 'title', 'gpt-5.1');
    cy.openConsole('#/');
    ct().click();
    cy.get('main#podium-main h1').should('contain.text', 'oc-context');
    cy.contains('main#podium-main', 'does not report context size').should('not.exist');
  });

  it('keeps the declarations after the server restarts on the same data', () => {
    cy.task('server:pause');
    cy.task('server:resume');
    cy.openConsole('#/');
    cy.cards().should('have.length', 15);
    nc().find('.z3 .c.ctx').should('not.exist');
    nc().find('.mdl .chip').not('.hx').should('have.text', 'GPT-5.1').and('have.attr', 'title', 'gpt-5.1');
    ct().find('.z3 .c.ctx').should('exist');
    nc().click();
    cy.contains('main#podium-main', 'acme does not report context size.');
  });

  it('keeps them in History after the session ends', () => {
    cy.reportAgain('api', { id: NC, name: 'acme-session', harness: 'acme', ...gpt, status: 'done', endReason: 'prompt_input_exit', endedAt: Date.now() }, undefined, undefined, acme);
    cy.visit('/#/history');
    cy.get('#podium-day').invoke('val').should('match', /^\d{4}-\d{2}-\d{2}$/).then((day) => {
      cy.contains('tr', 'acme-session').and('contain.text', 'GPT-5.1');
      cy.visit(`/#/history?day=${day}&page=1&size=50&open=${NC}`);
    });
    cy.get('main h1').should('have.text', 'acme-session');
    cy.contains('main', 'acme does not report context size.');
    cy.get('main').contains('.chip', 'GPT-5.1').should('have.attr', 'title', 'gpt-5.1');
  });

  // An agent's own modelLabel (#945) reads on its tree row and in its panel, the model id as the chip's title; an agent without one shows its family name.
  it('reads an agent\'s model label on its tree row and panel, and the family name when it has none', () => {
    cy.reportAgain('invoice', {}, { 'e2e-a-port': { model: 'gpt-5.1', modelLabel: 'GPT-5.1' } }, undefined, true);
    cy.openConsole('#/');
    cy.card('invoice').click();
    cy.get('main#podium-main h1').should('contain.text', 'invoice-v2');
    cy.get('#row-e2e-a-port .chip').should('have.text', 'GPT-5.1').and('have.attr', 'title', 'gpt-5.1');
    cy.get('#row-e2e-a-map .chip').should('contain.text', 'Haiku').and('have.attr', 'title', 'claude-haiku-5-5');
    cy.get('#row-e2e-a-port').click();
    cy.get('#podium-side-body').contains('dt', 'Model').next('dd').find('.chip').should('have.text', 'GPT-5.1').and('have.attr', 'title', 'gpt-5.1');
    cy.get('#row-e2e-a-map').click();
    cy.get('#podium-side-body').contains('dt', 'Model').next('dd').find('.chip').should('contain.text', 'Haiku').and('have.attr', 'title', 'claude-haiku-5-5');
  });
});
