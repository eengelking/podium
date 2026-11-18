// SPEC 8.1 Shell > each page's name and description shown once (#1209, mockup/podium-page-title-once.html). The chip in the top bar is the page's name; the banner
// under it holds the page's description alone, with no bold name before it. It is one line, cut only between whole sentences; when a sentence is left out a (i)
// appears, and its modal, under the (i), holds the full description. The Wall options drawer opens over the banner and never makes it taller. The page bodies
// that repeated the name and description (Chat, My reporters, My usage, Traffic) start at their content.
describe('page name and description once', () => {
  before(() => cy.resetServer());

  // The first sentence of each page's description (frontend/src/fleet/pageInfo.ts): the banner shows at least this much.
  const PAGES = [
    { chip: 'Fleet', first: 'Every session on this machine, live.', go: () => cy.openConsole('#/') },
    { chip: 'Board', first: 'The fleet as a board of cards.', go: () => cy.openConsole('#/board') },
    { chip: 'History', first: 'Past sessions, read-only.', go: () => cy.openConsole('#/history') },
    {
      chip: 'My reporters',
      first: 'Your reporters and who may message.',
      go: () => {
        cy.signIn('Ed');
        cy.openConsole('#/me/reporters');
      },
    },
    {
      chip: 'Chat',
      first: 'Talk with orchestrators and agents.',
      go: () => {
        cy.signIn('Ed');
        cy.openConsole('#/chat');
      },
    },
    { chip: 'Admin', first: 'Manage access, settings and reports.', go: () => cy.openAdmin() },
  ];

  for (const page of PAGES) {
    it(`${page.chip}: the chip names the page and the banner holds its description with no name in front of it`, () => {
      page.go();
      cy.get('[data-testid=page-pill]').should('have.text', page.chip);
      cy.displaySettings().find('.bt').should('contain.text', page.first);
      cy.displaySettings().find('b').should('not.exist');
    });
  }

  it('keeps the banner to one line when the Wall options drawer opens over it', () => {
    cy.openConsole('#/');
    // A line of 12 px text with the 24 px pill is about 39 px; two lines would be 55 or more.
    cy.displaySettings().should(($b) => expect($b.outerHeight()).to.be.lessThan(46));
    cy.openWallOptions();
    cy.displaySettings().find('.wallopts-body').should('be.visible');
    cy.displaySettings().should(($b) => expect($b.outerHeight()).to.be.lessThan(46));
  });

  it('opens the full description in a modal under the (i), and gives focus back on Esc', () => {
    cy.openAdmin();
    cy.displaySettings().find('button.info').should('have.attr', 'aria-label', 'Read the full description').and('have.attr', 'aria-haspopup', 'dialog');
    cy.displaySettings().contains('.tip', 'Click to read the full description');
    cy.displaySettings().find('button.info').click();
    cy.get('[role=dialog]').should('be.visible').and('have.class', 'anchor').within(() => {
      cy.contains('h2', 'About Admin');
      cy.contains('p', 'Manage access, settings and reports.');
      cy.contains('p', 'the Admin log lists what happened in Admin');
    });
    // Under the banner, not in the middle of the page.
    cy.get('[role=dialog]').should(($d) => expect($d[0].getBoundingClientRect().top).to.be.lessThan(140));
    cy.get('body').type('{esc}');
    cy.get('[role=dialog]').should('not.exist');
    cy.displaySettings().find('button.info').should('have.focus').and('have.attr', 'aria-expanded', 'false');
  });

  it('never cuts a sentence at 400 px: the banner ends on a full stop and nothing overflows', () => {
    cy.viewport(400, 800);
    cy.openAdmin();
    cy.displaySettings().find('.bt').should(($t) => {
      expect($t.text().trim().endsWith('.')).to.equal(true);
      expect($t[0].scrollWidth).to.be.at.most($t[0].clientWidth + 1);
    });
    cy.displaySettings().should(($b) => expect($b.outerHeight()).to.be.lessThan(46));
  });

  it('starts Chat and My reporters at their content, with no title or description in the body', () => {
    cy.signIn('Ed');
    cy.openConsole('#/chat');
    cy.tid('chat-split').should('exist');
    cy.get('main[aria-label=Chat] h1').should('have.text', 'Chat').and('have.class', 'vh');
    cy.get('main[aria-label=Chat] .page-h').should('not.exist');
    cy.openConsole('#/me/reporters');
    cy.get('main[aria-label="My reporters"] h1').should('have.text', 'My reporters').and('have.class', 'vh');
    cy.get('main[aria-label="My reporters"] .page-h').should('not.exist');
  });

  it('starts the Board at its controls, with its title only for a screen reader', () => {
    cy.openConsole('#/board');
    cy.get('.kb-head h2').should('have.text', 'Board').and('have.class', 'vh');
  });

  it('keeps the title and description Admin pages have of their own, which differ from the chip and banner', () => {
    cy.openAdmin('People');
    cy.get('.apage .page-h h1').should('have.text', 'People');
    cy.get('.apage .page-h .lead').should('contain.text', 'Each person gets a token');
  });
});
