// SPEC 8.1 Admin > People and Groups: creating a person (token shown once), search, group, the actions menu, deleting; creating and deleting a group.
// The row menu closes when the page scrolls, and Cypress scrolls an element into view before it clicks, so the summary is scrolled to first.
const openMenu = (name) => {
  cy.contains('tr', name).find('summary').scrollIntoView().click();
  cy.contains('tr', name).find('details').should('have.attr', 'open');
};
// The menu box is position: fixed inside the table's scroll area, which Cypress reads as clipped and scrolls to reach; that scroll closes the menu.
// So an item is clicked with force, after the menu is checked open and the item is checked to exist.
const choose = (label) => cy.get('details[open] .mi').contains(label).click({ force: true });

// Order: the tests below run in order on one server, and a later one reads what an earlier one left (named where it matters); the file resets the server once, in `before`.
describe('admin: people and groups', () => {
  before(() => cy.resetServer());
  beforeEach(() => cy.openAdmin());

  context('People', () => {
    it('lists the seeded people with their machines, token badge and group', () => {
      cy.get('h1').should('have.text', 'People');
      cy.contains('tr', 'Ed').should('contain.text', 'ed-mbp').and('contain.text', 'active').and('contain.text', 'TLS is off');
      cy.contains('tr', 'Alex').find('select').find(':selected').should('have.text', 'Platform');
      cy.contains('.apager', 'Showing 1 to 2 of 2');
    });

    it('creates a person and shows the token once, until it is saved', () => {
      cy.get('#admin-new-name').type('Priya');
      cy.contains('button', 'Create user').click();
      cy.contains('Token for Priya');
      cy.contains('button', 'Copy token settings');
      cy.contains('button', 'I have saved it').click();
      cy.contains('Token for Priya').should('not.exist');
      cy.contains('tr', 'Priya').should('contain.text', 'none yet');
      cy.contains('button.navbtn', 'People').find('.n').should('have.text', '3');
    });

    it('refuses a name that is taken', () => {
      cy.get('#admin-new-name').type('Ed');
      cy.contains('button', 'Create user').click();
      cy.get('[role=alert]').should('have.text', 'That name is already taken');
    });

    it('searches people by name', () => {
      cy.get('#admin-search').type('ale');
      cy.get('table.ptab tbody tr').should('have.length', 1).and('contain.text', 'Alex');
      cy.get('#admin-search').clear();
      cy.get('table.ptab tbody tr').should('have.length.greaterThan', 1);
    });

    it('assigns a group from the select under the name', () => {
      cy.contains('tr', 'Priya').find('select').select('Platform');
      cy.contains('tr', 'Priya').find('select').find(':selected').should('have.text', 'Platform');
      cy.reload();
      cy.adminPage('People');
      cy.contains('tr', 'Priya').find('select').find(':selected').should('have.text', 'Platform');
    });

    it('asks before it rotates a token, and shows the new one once', () => {
      openMenu('Priya');
      choose('Rotate token');
      cy.contains('Rotate Priya’s token?');
      cy.contains('button', 'Cancel').click();
      cy.contains('Rotate Priya’s token?').should('not.exist');
      openMenu('Priya');
      choose('Rotate token');
      cy.contains('.callout button', 'Rotate token').click();
      cy.contains('Token for Priya');
    });

    it('revokes a token, then offers to issue a new one; certificate actions are disabled while TLS is off', () => {
      openMenu('Priya');
      cy.contains('button.mi', 'Download certificate').should('be.disabled');
      cy.contains('button.mi', 'Reissue config…').should('be.disabled');
      choose('Revoke token');
      cy.contains('.callout', 'Revoke Priya’s token?').contains('button', 'Revoke token').click();
      cy.contains('tr', 'Priya').should('contain.text', 'revoked');
      openMenu('Priya');
      cy.contains('button.mi', 'Issue new token').should('be.enabled');
    });

    it('opens a menu with the keyboard, moves with Down, Up, Home and End, skips what is disabled, and closes it with Escape', () => {
      const K = Cypress.Keyboard.Keys;
      // Tab from the group select to the row's Actions button, as a keyboard user would.
      const tabToActions = (n = 0) => {
        cy.focused().then(($f) => {
          if ($f.attr('aria-label') === 'Actions for Alex') return;
          expect(n, 'tab stops before the Actions button').to.be.lessThan(12);
          cy.press(K.TAB);
          tabToActions(n + 1);
        });
      };
      cy.contains('tr', 'Alex').find('select').focus();
      tabToActions();
      cy.press(K.SPACE);
      cy.contains('tr', 'Alex').find('details').should('have.attr', 'open');
      const item = () => cy.focused().invoke('text');
      // A key is pressed only after the page has drawn the focus move of the one before (a frame), so none can arrive mid-update.
      const press = (key) => {
        cy.window({ log: false }).then((win) => new Promise((done) => win.requestAnimationFrame(() => win.requestAnimationFrame(() => done()))));
        cy.press(key);
      };
      // Opening the menu puts focus on its first enabled item.
      item().should('eq', 'Rotate token');
      press(K.DOWN);
      item().should('eq', 'Revoke token');
      press(K.UP);
      item().should('eq', 'Rotate token');
      press(K.END);
      item().should('eq', 'Delete…');
      press(K.HOME);
      item().should('eq', 'Rotate token');
      // With TLS off the certificate actions are disabled, so Down from Revoke token skips them and lands on Delete.
      press(K.DOWN);
      item().should('eq', 'Revoke token');
      press(K.DOWN);
      item().should('eq', 'Delete…');
      press(K.DOWN);
      item().should('eq', 'Rotate token');
      cy.press(K.ESC);
      cy.contains('tr', 'Alex').find('details').should('not.have.attr', 'open');
      cy.focused().should('have.attr', 'aria-label', 'Actions for Alex');
    });

    it('deletes a person in a dialog that names them', () => {
      openMenu('Priya');
      choose('Delete…');
      cy.get('[role=dialog]').should('contain.text', 'Delete Priya?');
      cy.get('[role=dialog]').contains('button', 'Cancel').click();
      cy.contains('tr', 'Priya').should('exist');
      openMenu('Priya');
      choose('Delete…');
      cy.get('[role=dialog]').contains('button', /^Delete$/).click();
      cy.contains('tr', 'Priya').should('not.exist');
    });

    it('deletes the selected people in one go, naming how many', () => {
      cy.get('#admin-new-name').type('Bulk One');
      cy.contains('button', 'Create user').click();
      cy.contains('button', 'I have saved it').click();
      cy.get('#admin-new-name').type('Bulk Two');
      cy.contains('button', 'Create user').click();
      cy.contains('button', 'I have saved it').click();
      cy.get('input[aria-label="Select Bulk One"]').check();
      cy.get('input[aria-label="Select Bulk Two"]').check();
      cy.get('[role=group][aria-label="Selected people"]').should('contain.text', '2 selected').and('contain.text', 'Delete 2…');
      cy.contains('button', 'Delete 2…').click();
      cy.get('[role=dialog]').should('contain.text', 'Delete 2 people?');
      cy.get('[role=dialog]').contains('button', 'Delete 2 people').click();
      cy.contains('tr', 'Bulk One').should('not.exist');
      cy.contains('tr', 'Bulk Two').should('not.exist');
      cy.contains('tr', 'Ed').should('exist');
    });
  });

  context('Groups', () => {
    beforeEach(() => cy.adminPage('Groups'));

    it('shows the built-in Administrators group, which cannot be renamed or deleted, and Platform', () => {
      cy.contains('tr', 'Administrators').should('contain.text', 'built in').and('contain.text', 'Admin (secret)').and('contain.text', 'Built in. It cannot be renamed or deleted.');
      cy.contains('tr', 'Administrators').find('button').should('be.disabled');
      cy.contains('tr', 'Platform').should('contain.text', 'Alex');
    });

    it('creates a group, lists it, and deletes it after asking', () => {
      cy.get('#admin-new-group').type('Frontend');
      cy.contains('button', 'Create group').click();
      cy.contains('tr', 'Frontend').should('contain.text', 'No one yet.');
      cy.contains('tr', 'Frontend').contains('button', /^Delete$/).click();
      cy.contains('tr', 'Frontend').should('contain.text', 'Delete? No one is in it.');
      cy.contains('tr', 'Frontend').contains('button', 'Delete group').click();
      cy.contains('tr', 'Frontend').should('not.exist');
    });

    it('limits a group name to 24 characters', () => {
      cy.get('#admin-new-group').should('have.attr', 'maxlength', '24');
    });

    it('shows the group on the wall as a band', () => {
      cy.visit('/#/');
      cy.get('[aria-label="Group by"]').contains('button', 'Group').click();
      cy.contains('button.bh', 'Platform');
    });
  });
});

// Moving Alex out of Platform changes what the other tests in this file read, so it runs on a server of its own.
describe('admin: a person leaving a group', () => {
  before(() => cy.resetServer());
  beforeEach(() => cy.openAdmin());
  it('moves a person out of a group: the wall puts them under Unassigned', () => {
    cy.contains('tr', 'Alex').find('select').select('No group');
    cy.contains('tr', 'Alex').find('select').find(':selected').should('have.text', 'No group');
    cy.visit('/#/');
    cy.get('[aria-label="Group by"]').contains('button', 'Group').click();
    cy.contains('button.bh', 'Unassigned').should('contain.text', '11 live');
    cy.contains('button.bh', 'Platform').should('not.exist');
  });
});
