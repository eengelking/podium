// The suite never depends on the internet (#1363). The page links Google Fonts, and its `load` event waits for that stylesheet. The e2e containers have no outside
// network, so a request that is not answered by the stub waits for a connection time-out of about 30 s, which is the page-load limit. support/e2e.js answers the font
// hosts with an empty stylesheet before every visit, in a `before()` hook as much as in a test (a route made in `beforeEach` does not exist in a `before()` hook).
// A real answer adds an @font-face for each weight to `document.fonts` (a cross-origin sheet's own rules cannot be read), so a request that got out is seen here
// on a machine with internet, and is the 30 s wait on one without.
const fontsFromTheHosts = (doc) => [...doc.fonts].filter((f) => /JetBrains Mono|Schibsted Grotesk/.test(f.family)).map((f) => `${f.family} ${f.weight}`);

describe('a page opened in a before() hook', () => {
  before(() => {
    cy.resetServer();
    cy.openConsole('#/');
  });

  it('never reaches the font hosts: their stylesheet is the empty one the suite answers with', () => {
    cy.document().then((doc) => {
      expect(doc.querySelector('link[rel=stylesheet][href*="fonts.googleapis.com"]'), 'the page links the font stylesheet').to.not.equal(null);
      expect(fontsFromTheHosts(doc), 'fonts the hosts answered with').to.deep.eq([]);
    });
  });
});

describe('a page opened in a test', () => {
  before(() => cy.resetServer());

  it('never reaches the font hosts either', () => {
    cy.openConsole('#/');
    cy.document().then((doc) => expect(fontsFromTheHosts(doc), 'fonts the hosts answered with').to.deep.eq([]));
  });
});
