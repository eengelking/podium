// SPEC 8.1 Shell > Theme picker: the dropdown, the Light/Dark/System radios, the stored choice and the first paint.
// Chrome's own emulation of the operating system's color scheme, through the DevTools protocol Cypress already holds.
const emulateScheme = (value) => cy.then(() => Cypress.automation('remote:debugger:protocol', { command: 'Emulation.setEmulatedMedia', params: { media: '', features: [{ name: 'prefers-color-scheme', value }] } }));

describe('theme picker', () => {
  before(() => cy.resetServer());

  const root = () => cy.get('html');

  it('defaults to Podium in System mode and follows the operating system', () => {
    cy.openConsole('#/');
    root().should('have.attr', 'data-theme-name', 'podium').and('have.attr', 'data-mode', 'system');
    cy.contains('label.field', 'Theme').find('select').should('have.value', 'podium');
    cy.get('[role=radiogroup][aria-label=Mode] [role=radio][aria-checked=true]').should('have.text', 'System');
  });

  it('switches mode with the radios, remembers it in podium.theme and applies it again after a reload', () => {
    cy.openConsole('#/');
    cy.contains('[role=radio]', 'Dark').click();
    root().should('have.attr', 'data-theme', 'dark').and('have.attr', 'data-mode', 'dark');
    cy.window().its('localStorage').invoke('getItem', 'podium.theme').then((raw) => expect(JSON.parse(raw)).to.deep.eq({ theme: 'podium', mode: 'dark' }));
    cy.reload();
    root().should('have.attr', 'data-theme', 'dark');
    cy.contains('[role=radio]', 'Light').click();
    root().should('have.attr', 'data-theme', 'light');
  });

  it('moves through the radios with the arrow keys', () => {
    cy.openConsole('#/');
    cy.contains('[role=radio]', 'Light').click().focus().type('{rightarrow}');
    cy.contains('[role=radio]', 'Dark').should('have.attr', 'aria-checked', 'true');
    cy.focused().should('have.text', 'Dark').type('{rightarrow}');
    cy.contains('[role=radio]', 'System').should('have.attr', 'aria-checked', 'true');
  });

  it('changes the palette with the Theme dropdown', () => {
    cy.openConsole('#/');
    cy.contains('label.field', 'Theme').find('select').select('Nord');
    root().should('have.attr', 'data-theme-name', 'nord');
    cy.contains('label.field', 'Theme').find('select').select('Podium');
    root().should('have.attr', 'data-theme-name', 'podium');
  });

  it('applies the stored choice before the app code runs (first paint)', () => {
    cy.visit('/', {
      onBeforeLoad(win) {
        win.localStorage.setItem('podium.theme', JSON.stringify({ theme: 'gruvbox', mode: 'dark' }));
        // The page script runs before React; read the attributes at DOMContentLoaded, which is before the bundle's module executes.
        win.document.addEventListener('DOMContentLoaded', () => {
          win.__earlyTheme = { ...win.document.documentElement.dataset };
        });
      },
    });
    cy.window().its('__earlyTheme').should('deep.include', { themeName: 'gruvbox', theme: 'dark', mode: 'dark' });
  });

  it('follows prefers-color-scheme while the mode is System', () => {
    cy.visit('/', {
      onBeforeLoad(win) {
        win.localStorage.clear();
      },
    });
    emulateScheme('dark');
    cy.get('html').should('have.attr', 'data-theme', 'dark');
    emulateScheme('light');
    cy.get('html').should('have.attr', 'data-theme', 'light');
  });

  it('shows the same picker on History and Traffic', () => {
    cy.visit('/#/history');
    cy.get('[role=radiogroup][aria-label=Mode]').should('be.visible');
    cy.visit('/#/traffic');
    cy.get('[role=radiogroup][aria-label=Mode]').should('be.visible');
  });
});
