// Helpers every spec uses. Each one is a retrying query or a quiet request: none waits a fixed time.
let manifest = null;

/** The seed manifest (fake tokens, session ids, machine ids) after cy.resetServer(). */
export const seeded = () => {
  if (!manifest) throw new Error('call cy.resetServer() in before() first');
  return manifest;
};

const H_ADMIN = { 'X-Podium-Admin': '1' };
const H_RESPOND = { 'X-Podium-Respond': '1' };

/** Restarts the server on a wiped database and reseeds it; yields the manifest. Options: env ['NAME=VALUE'], seedArgs, history, noSeed. */
Cypress.Commands.add('resetServer', (opts) =>
  cy.task('server:reset', opts ?? null, { timeout: 130000, log: false }).then((m) => {
    manifest = m;
    Cypress.session.clearAllSavedSessions();
    return m;
  }),
);

/** Signs the browser in as a seeded person (cookie only, no typing). 'Admin' signs in with the admin secret. */
Cypress.Commands.add('signIn', (name) => {
  cy.env(['ADMIN_SECRET']).then(({ ADMIN_SECRET }) => {
    const token = name === 'Admin' ? ADMIN_SECRET : seeded().people[name]?.token;
    if (!token) throw new Error(`no seeded person "${name}"`);
    cy.session(
      // A seeded token is fake and new for each database, so a reset makes a new id; the admin secret is never part of one (Admin has a fixed label).
      name === 'Admin' ? ['respond', 'Admin'] : ['respond', name, token],
      () => {
        cy.request({ method: 'POST', url: '/api/fleet/respond/sign-in', headers: H_RESPOND, body: { name, token }, log: false }).its('status', { log: false }).should('eq', 200);
      },
      {
        // A spec that signs out ends the saved session on the server, so it is checked before it is reused.
        validate: () => {
          cy.request({ url: '/api/fleet/respond/me', log: false }).its('body.signedIn', { log: false }).should('eq', true);
        },
        cacheAcrossSpecs: false,
      },
    );
  });
});

/** Unlocks Admin in the browser (the cookie, no typing). */
Cypress.Commands.add('unlockAdmin', () => {
  cy.env(['ADMIN_SECRET']).then(({ ADMIN_SECRET }) => {
    cy.session(
      'admin', // a fixed label: the secret is never part of a session's id
      () => {
        cy.request({ method: 'POST', url: '/api/admin/unlock', headers: H_ADMIN, body: { name: 'Admin', token: ADMIN_SECRET }, log: false }).its('status', { log: false }).should('eq', 200);
      },
      {
        validate: () => {
          cy.request({ url: '/api/admin/settings', log: false }).its('status', { log: false }).should('eq', 200);
        },
        cacheAcrossSpecs: false,
      },
    );
  });
});

/** Visits a hash route and waits until the stream is live. */
Cypress.Commands.add('openConsole', (hash = '#/', opts = {}) => {
  cy.visit(`/${hash}`, opts);
  cy.get('[data-testid="connection-pill"]', { timeout: 15000 }).should('have.attr', 'data-state', 'live');
});

/** One seeded card on the wall, by its key in SESSIONS (scripts/e2e-seed.mjs). */
Cypress.Commands.add('card', (key) => cy.get(`button.card.sc[data-session="${seeded().sessions[key]}"]`));

/** The element with this data-testid. */
Cypress.Commands.add('tid', (id, opts) => cy.get(`[data-testid="${id}"]`, opts));

/** Sets the feature flags (and other settings) through Admin's route. The admin secret stays in Node's env, never in a log. */
Cypress.Commands.add('putSettings', (body) => {
  cy.env(['ADMIN_SECRET']).then(({ ADMIN_SECRET }) => {
    cy.request({ method: 'POST', url: '/api/admin/unlock', headers: H_ADMIN, body: { name: 'Admin', token: ADMIN_SECRET }, log: false });
    cy.request({ method: 'PUT', url: '/api/admin/settings', headers: H_ADMIN, body, log: false }).its('status', { log: false }).should('eq', 200);
  });
});
Cypress.Commands.add('setFlags', (flags) => cy.putSettings({ features: flags }));

/** Reports a seeded session again as a reporter would: `over` merges into its session, `agents` maps an agent id to changed fields, `steps` maps a plan step id to its new state. */
Cypress.Commands.add('reportAgain', (key, over, agents, steps) => cy.task('fleet:report', { key, over, agents, steps }, { log: false }));

/**
 * Runs axe-core on the page with the WCAG 2.0 to 2.2 A and AA rules, color-contrast and target-size included, and fails with a readable list.
 * `known` lists violations that are real, not yet fixed and tracked: each is { rule, target: RegExp, html?: RegExp (the element's own markup, to be exact) } and is let through only while axe still
 * reports it, so the list cannot go stale (a known violation that is gone fails the test until it is removed from the list).
 */
Cypress.Commands.add('checkA11y', (opts = {}) => {
  const known = opts.known ?? [];
  cy.task('axe:source', null, { log: false }).then((source) => {
    cy.window({ log: false }).then(async (win) => {
      if (!win.axe) win.eval(source);
      const result = await win.axe.run(opts.context ?? win.document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
        rules: { 'color-contrast': { enabled: true }, 'target-size': { enabled: true } },
      });
      const nodes = result.violations.flatMap((v) => v.nodes.map((n) => ({ rule: v.id, impact: v.impact, help: v.help, target: n.target.join(' '), html: n.html })));
      const matches = (k, n) => k.rule === n.rule && k.target.test(n.target) && (!k.html || k.html.test(n.html));
      const isKnown = (n) => known.some((k) => matches(k, n));
      const unknown = nodes.filter((n) => !isKnown(n));
      const lines = unknown.map((n) => `${n.rule} (${n.impact}): ${n.help}: ${n.target}`);
      expect(lines, `axe violations:\n${lines.join('\n')}`).to.have.length(0);
      const stale = known.filter((k) => !nodes.some((n) => matches(k, n)));
      expect(stale.map((k) => `${k.rule} ${k.target}`), 'known violations that axe no longer reports (remove them from the list)').to.have.length(0);
    });
  });
});

/** Lets the page read and write the clipboard (Chrome asks for a permission a headless run cannot answer). */
Cypress.Commands.add('grantClipboard', () => {
  cy.then(() => Cypress.automation('remote:debugger:protocol', { command: 'Browser.grantPermissions', params: { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: Cypress.config('baseUrl') } }));
});

/** The cards on the wall, in the order shown. */
Cypress.Commands.add('cards', () => cy.get('button.card.sc'));

/** Sets the browser's viewport to a named width the suite checks: 400 (phone), 760, 1040 (the stacked-layout edge) or 1440. */
Cypress.Commands.add('atWidth', (w) => cy.viewport(w, w <= 500 ? 800 : 900));

/** Adds a person through Admin's route and yields { name, token } (the token is a fake one the server just made). */
Cypress.Commands.add('addPerson', (name) => {
  cy.env(['ADMIN_SECRET']).then(({ ADMIN_SECRET }) => {
    cy.request({ method: 'POST', url: '/api/admin/unlock', headers: H_ADMIN, body: { name: 'Admin', token: ADMIN_SECRET }, log: false });
    cy.request({ method: 'POST', url: '/api/admin/people', headers: H_ADMIN, body: { name }, log: false }).then((res) => {
      expect(res.status).to.be.oneOf([200, 201]);
      return { name, token: res.body.token };
    });
  });
});

/** Signs in as a person made with cy.addPerson. */
Cypress.Commands.add('signInAs', ({ name, token }) => {
  cy.session(['respond', name, token], () => {
    cy.request({ method: 'POST', url: '/api/fleet/respond/sign-in', headers: H_RESPOND, body: { name, token }, log: false }).its('status', { log: false }).should('eq', 200);
  }, { cacheAcrossSpecs: false });
});

/** The Admin menu button with this name (as it reads, without its count badge). */
Cypress.Commands.add('adminPage', (name) => {
  cy.get('nav[aria-label="Admin sections"]').contains('button.navbtn', new RegExp(`^${name}`)).click();
  cy.get('nav[aria-label="Admin sections"] [aria-current=page]').should('contain.text', name);
});

/** The on/off switch of a Settings row, by the row's id: feature-<flag>, notice-<id>, background, card-title-machine, forget-reporters. */
Cypress.Commands.add('settingSwitch', (id) => cy.get(`[role=switch][aria-labelledby^="set-${id}-n"]`));

/** Opens Admin on a page, already unlocked (by cookie, no typing). */
Cypress.Commands.add('openAdmin', (page) => {
  cy.unlockAdmin();
  cy.visit('/#/admin');
  cy.get('nav[aria-label="Admin sections"]', { timeout: 15000 });
  if (page) cy.adminPage(page);
});
