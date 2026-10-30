// SPEC 8.1 Admin: the lock screen, who may open Admin, the menu and Lock Admin. The idle lock (10 minutes) is in idle-lock.cy.js and the lockout in lockout.cy.js (#791).
import { seeded } from '../../../support/commands';

describe('admin: access', () => {
  before(() => cy.resetServer());

  it('shows the lock screen with a Name and a Token field and the top bar of the other pages', () => {
    cy.visit('/#/admin');
    cy.get('main[aria-label=Admin] h1').should('have.text', 'Admin');
    cy.get('#admin-name').should('be.visible').and('be.focused');
    cy.get('#admin-secret').should('have.attr', 'type', 'password');
    cy.contains('button', 'Unlock Admin');
    cy.tid('page-pill').should('have.text', 'Admin');
    cy.get('#podium-top').contains('a.btn', 'Fleet');
    cy.get('#podium-top').contains('a.btn', 'Admin').should('not.exist');
    cy.contains('Theme credits');
  });

  it('asks for both fields, and says only that the pair is wrong when it is', () => {
    cy.visit('/#/admin');
    cy.contains('button', 'Unlock Admin').click();
    cy.get('[role=alert]').should('contain.text', 'Enter your name and your token.');
    cy.get('#admin-name').type('Admin');
    cy.get('#admin-secret').type('not-the-secret', { log: false });
    cy.contains('button', 'Unlock Admin').click();
    cy.get('[role=alert]').should('contain.text', 'That name and token do not open Admin.');
    cy.get('#admin-secret').should('have.value', '');
  });

  it('does not open for a person who is not in Administrators, even with their own correct token', () => {
    const { token } = seeded().people.Ed;
    cy.visit('/#/admin');
    cy.get('#admin-name').type('Ed');
    cy.get('#admin-secret').type(token, { log: false });
    cy.contains('button', 'Unlock Admin').click();
    cy.get('[role=alert]').should('contain.text', 'That name and token do not open Admin.');
  });

  it('opens for a person in Administrators with their own name and token, and shows the Admin button to them', () => {
    const { token } = seeded().people.Alex;
    cy.unlockAdmin();
    cy.request('/api/admin/groups').then((res) => {
      const admins = res.body.rows.find((g) => g.builtIn);
      cy.request({ method: 'PUT', url: `/api/admin/people/${seeded().people.Alex.id}/group`, headers: { 'X-Podium-Admin': '1' }, body: { groupId: admins.id } }).its('status').should('eq', 200);
    });
    cy.clearCookies();
    cy.visit('/#/admin');
    cy.get('#admin-name').type('Alex');
    cy.get('#admin-secret').type(token, { log: false });
    cy.contains('button', 'Unlock Admin').click();
    cy.get('nav[aria-label="Admin sections"]').should('be.visible');
  });

  it('opens by itself for someone signed in to respond as the Admin', () => {
    cy.signIn('Admin');
    cy.visit('/#/admin');
    cy.get('nav[aria-label="Admin sections"]', { timeout: 15000 }).should('be.visible');
  });

  it('groups the menu in four, marks the current page, and puts Lock Admin and the footer at the bottom', () => {
    cy.openAdmin();
    cy.get('nav[aria-label="Admin sections"] [role=group]').then(($g) => expect([...$g].map((g) => g.getAttribute('aria-label'))).to.deep.eq(['People and access', 'Server', 'Reporting', 'Activity']));
    cy.get('nav[aria-label="Admin sections"] button.navbtn').then(($b) => expect([...$b].map((b) => b.childNodes[0].textContent)).to.deep.eq(['People', 'Groups', 'Reporters', 'Settings', 'Model prices', 'Security', 'Certificates', 'Data', 'Stored activity', 'Usage', 'Spend', 'People and groups', 'Sessions', 'Failures', 'Admin activity', 'Admin log']));
    cy.get('nav [aria-current=page]').should('have.text', 'People2');
    cy.contains('Locks after 10 minutes without activity.');
    cy.contains('Podium v');
  });

  it('shows a count badge on a list page once it has loaded', () => {
    cy.openAdmin();
    cy.contains('button.navbtn', 'People').find('.n').should('have.text', '2');
    // A page's count shows once that page has loaded.
    cy.adminPage('Groups');
    cy.contains('button.navbtn', 'Groups').find('.n').should('have.text', '2');
    cy.adminPage('Reporters');
    cy.contains('button.navbtn', 'Reporters').find('.n').should('have.text', '4');
  });

  it('locks again with Lock Admin, and shows the lock screen', () => {
    cy.openAdmin();
    cy.contains('button', 'Lock Admin').click();
    cy.get('#admin-name').should('be.visible');
    cy.request({ url: '/api/admin/settings', failOnStatusCode: false }).its('status').should('eq', 401);
  });

  it('puts the menu in a scrolling strip above the page below 760 px', () => {
    cy.atWidth(700);
    cy.openAdmin();
    cy.get('nav[aria-label="Admin sections"]').should(($n) => {
      const r = $n[0].getBoundingClientRect();
      expect(r.width).to.be.greaterThan(600);
      expect(r.height).to.be.lessThan(120);
    });
  });
});

describe('admin: a server with no token', () => {
  before(() => cy.resetServer({ env: ['PODIUM_TOKEN='], noSeed: true }));
  it('says Admin is off and what to do', () => {
    cy.visit('/#/admin');
    cy.get('main[aria-label=Admin] h1').should('have.text', 'Admin is off');
    cy.contains('This server is running without a token');
    cy.get('#admin-name').should('not.exist');
  });
});
