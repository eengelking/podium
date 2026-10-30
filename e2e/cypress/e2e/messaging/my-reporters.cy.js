// SPEC 8.1 My reporters (#347): requests waiting for you, your reporters, defaults and the rights grid.
// Order: the tests below run in order on one server, and a later one reads what an earlier one left (named where it matters); the file resets the server once, in `before`.
describe('my reporters', () => {
  context('signed in as Ed, with messaging on', () => {
    before(() => cy.resetServer({ seedArgs: '--talk' }));
    beforeEach(() => {
      cy.signIn('Ed');
      cy.openConsole('#/me/reporters');
      cy.get('h1').should('have.text', 'My reporters');
    });

    it('shows the link in the top bar with the number waiting, and leaves it off its own page', () => {
      cy.visit('/#/');
      cy.get('#podium-top').contains('a, button', 'My reporters · 2 waiting').should('exist');
      cy.visit('/#/me/reporters');
      cy.get('#podium-top').contains('a, button', /^My reporters/).should('not.exist');
    });

    it('lists the requests waiting for you: an Admin\'s proposal and a session\'s request for access, with its reason', () => {
      cy.get('h2#pm-req-h').should('have.text', 'Waiting for you');
      cy.contains('2 requests. Nothing changes until you answer.');
      cy.get('[role=group][aria-label="A change an Admin proposes"]').should('contain.text', 'An Admin proposes that build-pi can send to ed-mbp, with approval.').and('contain.text', 'Today build-pi can only see ed-mbp.');
      cy.get('[role=group][aria-label="A request for access"]').should('contain.text', 'Tester on ci-runner-01 asks to send to build-pi.').and('contain.text', 'I need the arm64 build tested on a Raspberry Pi before the release.');
    });

    it('allows a request for access and the request leaves the list', () => {
      cy.get('[role=group][aria-label="A request for access"]').contains('button', 'Allow').click();
      cy.get('[role=group][aria-label="A request for access"]').should('not.exist');
      cy.contains('1 request.');
      // The right now stands in the grid: ci-runner-01 to build-pi, as asked ("Can send, with approval").
      cy.get('select[id="g-e2e0000ci001-e2e0000pi001"]').find(':selected').should('have.text', 'Can send, with approval');
    });

    it('accepts an Admin\'s proposed change', () => {
      cy.get('[role=group][aria-label="A change an Admin proposes"]').contains('button', 'Accept change').click();
      cy.get('[role=group][aria-label="A change an Admin proposes"]').should('not.exist');
      cy.get('select[id="g-e2e0000pi001-e2e0000mbp01"]').should('have.value', 'ask');
    });

    it('lists the three reporters of this person with system, messaging, version and live orchestrators', () => {
      cy.get('table.ptab tbody tr').should('have.length', 3);
      // The cells, in order: State, Machine, System, Messaging, Reporter version, Last report, Live orchestrators.
      cy.readFile('/repo/package.json').then((pkg) => cy.contains('table.ptab tr', 'ed-mbp').find('td').then(($td) => {
        const cell = (i) => $td.eq(i).text().trim();
        expect(cell(0)).to.contain('Reporting');
        expect(cell(2)).to.contain('macOS 26.1');
        expect(cell(3)).to.contain('On');
        expect(cell(4)).to.eq(pkg.version);
        expect(cell(6)).to.eq('8');
      }));
      cy.contains('table.ptab tr', 'build-pi').should('contain.text', 'Debian 12, arm64');
      cy.contains('Showing 1 to 3 of 3');
    });

    it('turns "Trust my own reporters" on and off', () => {
      cy.get('b#pm-trust-n').parent().parent().find('[role=switch]').as('trust');
      cy.get('@trust').should('have.attr', 'aria-checked', 'false').click().should('have.attr', 'aria-checked', 'true');
      cy.reload();
      cy.get('@trust').should('have.attr', 'aria-checked', 'true').click().should('have.attr', 'aria-checked', 'false');
    });

    it('changes what to do when an orchestrator asks for access and the default for a new right', () => {
      cy.get('b#pm-ask-n').parent().parent().contains('[role=radio]', 'Allow').click().should('have.attr', 'aria-checked', 'true');
      cy.get('b#pm-ask-n').parent().parent().contains('[role=radio]', 'Ask me').click().should('have.attr', 'aria-checked', 'true');
      cy.get('b#pm-new-n').parent().parent().contains('[role=radio]', 'Without approval').click().should('have.attr', 'aria-checked', 'true');
      cy.get('b#pm-new-n').parent().parent().contains('[role=radio]', 'With approval').click();
    });

    it('keeps a limit lower than the Admin\'s and says what the Admin allows', () => {
      cy.get('#pm-lim-roundTrips').should('have.value', '10');
      cy.contains("Uses the Admin's limit, 10.");
      cy.get('#pm-lim-roundTrips').clear().type('5').blur();
      cy.reload();
      cy.get('#pm-lim-roundTrips').should('have.value', '5');
      cy.get('#pm-lim-roundTrips').clear().type('10').blur();
    });

    it('changes who can message whom in the grid and keeps it over a reload', () => {
      cy.get('select[id="g-e2e0000ci001-e2e0000mbp01"]').select('Can see');
      cy.reload();
      cy.get('select[id="g-e2e0000ci001-e2e0000mbp01"]').find(':selected').should('contain.text', 'Can see');
    });

    it('switches the rights view between Grid and Board', () => {
      cy.get('[role=radiogroup][aria-label=View]').contains('[role=radio]', 'Board').click().should('have.attr', 'aria-checked', 'true');
      cy.get('table.pm-grid').should('not.exist');
      cy.get('[role=radiogroup][aria-label=View]').contains('[role=radio]', 'Grid').click();
      cy.get('table.pm-grid').should('exist');
    });
  });

  context('without a person to show', () => {
    before(() => cy.resetServer());

    it('is reached only when signed in: the link is not in the bar and the page asks you to sign in', () => {
      cy.openConsole('#/');
      cy.get('#podium-top').contains('a, button', /^My reporters/).should('not.exist');
      cy.visit('/#/me/reporters');
      cy.contains('Sign in to see your reporters');
    });

    it('says the admin secret has no reporters', () => {
      cy.signIn('Admin');
      cy.visit('/#/me/reporters');
      cy.contains('The admin secret has no reporters');
    });

    it('says a person with no machine yet has none', () => {
      cy.addPerson('Newbie').then((p) => cy.signInAs(p));
      cy.visit('/#/me/reporters');
      cy.contains('No reporters yet');
      cy.contains('A machine shows here once it reports with your name and token.');
    });
  });

  context('with orchestrator messaging off', () => {
    before(() => cy.resetServer({ seedArgs: '--flags none' }));
    it('says messaging is off and where to turn it on', () => {
      // With every feature off nothing needs a sign-in, so the server refuses one; the page still says why it is empty.
      cy.visit('/#/me/reporters');
      cy.contains('Orchestrator messaging is off');
      cy.contains('Until then there is nothing to set here.');
    });
  });
});
