// Accessibility with axe-core, in a real browser, with the rules jsdom cannot run: color-contrast and target-size (WCAG 2.2 AA). The six pages, light and dark,
// at 1440 and at 400 px. axe-core is mounted from the repo's node_modules (a frontend dev dependency); nothing is installed.
describe('accessibility (axe)', () => {
  before(() => cy.resetServer({ seedArgs: '--talk --recording' }));

  // Violations axe found on first run: real, not fixed, and listed here so the suite is green and the list is honest. Each entry is let through only while
  // axe still reports it (see checkA11y). They are for the maintainer to file and fix; fixing one means removing its line here.
  const CONTRAST = (target, html) => ({ rule: 'color-contrast', target, html });
  const KNOWN = {
    // #794: the modified-files count on a card, light theme.
    'the wall light': [CONTRAST(/^button\[data-session="[^"]+"\] > \.z1 > \.git > \.dirty\[title="Modified files"\]$/, /^<span class="dirty" title="Modified files"/)],
    // #795: a board card's wait line (.kb-wait), light theme.
    'the board light 1440': [CONTRAST(/^a\[data-key="[^"]+:waiting"\] > \.kb-wait$/, /class="kb-wait"/)],
    // #796: Traffic's table sub-lines at 400 px.
    'Traffic light 400': [CONTRAST(/^td:nth-child\(1\) > \.sub$/), CONTRAST(/^\.muted$/)],
    'Traffic dark 400': [CONTRAST(/^td:nth-child\(1\) > \.sub$/), CONTRAST(/^\.muted$/)],
    // #797: the hint in a request on My reporters, dark theme.
    'My reporters dark': [CONTRAST(/^div\[aria-label="(A change an Admin proposes|A request for access)"\] > \.q > \.hint$/, /class="hint"/)],
  };
  const PAGES = [
    { name: 'the wall', hash: '#/', ready: () => cy.cards().should('have.length.greaterThan', 5) },
    { name: 'the board', hash: '#/board', ready: () => cy.get('section.kb-col a.kb-card').should('have.length.greaterThan', 5) },
    { name: 'My reporters', hash: '#/me/reporters', // The requests and the table load after the heading, so the page is read once they are there.
    ready: () => cy.get('[role=group][aria-label="A request for access"]').should('exist').then(() => cy.get('table.ptab tbody tr').should('have.length', 3)), signIn: 'Ed' },
    { name: 'Traffic', hash: '#/traffic', ready: () => cy.get('h2#map-h').should('exist').then(() => cy.contains('4 messages').should('exist')) },
    { name: 'History', hash: '#/history', ready: () => cy.get('table.htable tbody tr').should('have.length.greaterThan', 0) },
    { name: 'Admin', hash: '#/admin', ready: () => cy.get('nav[aria-label="Admin sections"]').should('exist').then(() => cy.get('table.ptab tbody tr').should('have.length.greaterThan', 0)), admin: true },
  ];

  for (const mode of ['light', 'dark']) {
    for (const width of [1440, 400]) {
      for (const page of PAGES) {
        it(`${page.name}, ${mode}, ${width} px has no axe violation`, () => {
          cy.atWidth(width);
          if (page.signIn) cy.signIn(page.signIn);
          if (page.admin) cy.unlockAdmin();
          cy.visit(`/${page.hash}`, { onBeforeLoad: (win) => win.localStorage.setItem('podium.theme', JSON.stringify({ theme: 'podium', mode })) });
          cy.get('html').should('have.attr', 'data-theme', mode);
          page.ready();
          const known = [...(KNOWN[`${page.name} ${mode}`] ?? []), ...(KNOWN[`${page.name} ${mode} ${width}`] ?? [])];
          cy.checkA11y({ known });
        });
      }
    }
  }
});
