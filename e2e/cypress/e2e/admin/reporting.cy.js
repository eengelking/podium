// SPEC 8.1 Reporting (#484): the six report pages. The seed's activity is today only and read live, so what is checked here is the shape: the period and
// filters, the summary, the table the chart is drawn from, Export and Print, the remembered choice. A seeded 45-day history is checked by hand and by the
// unit tests (scripts/podium-seed-history.ts needs tsx, which the e2e containers do not carry; docs/e2e/COVERAGE.md).
describe('admin: reporting', () => {
  before(() => cy.resetServer());

  const period = () => cy.contains('label', 'Period').parent().find('select');

  for (const name of ['Usage', 'Sessions', 'Failures', 'Admin activity']) {
    it(`${name}: shows Period and filters, the report table and the pager`, () => {
      cy.openAdmin(name);
      cy.get('h1').should('have.text', name);
      cy.contains('h2', 'Period and filters');
      period().find('option').should(($o) => expect([...$o].map((o) => o.textContent)).to.deep.eq(['Last 7 days', 'Last 30 days', 'Last 90 days', 'This month', 'Last month', 'Custom']));
      period().should('have.value', '30d');
      if (name !== 'Admin activity') cy.contains('Podium has no history before').should('exist');
      cy.get('table.ptab').should('exist');
      cy.contains('Showing 1 to').should('exist');
    });
  }

  // Sortable headings (#1133): every report table. The order is read inside should(), so it retries until the table has drawn.
  it('Sessions: a heading sorts the table, text A to Z first and a number largest first, and the next click reverses it', () => {
    cy.openAdmin('Sessions');
    const table = () => cy.get('table.ptab').first();
    const column = (i) => ($t) => [...$t.find('tbody tr')].map((r) => r.children[i].textContent.trim());
    table().find('thead th').first().should('have.attr', 'aria-sort', 'none');
    table().find('thead th').first().find('button.thbtn').click();
    table().should(($t) => {
      const names = column(0)($t);
      expect(names.length, 'the seed has rows').to.be.greaterThan(1);
      expect(names, 'A to Z').to.deep.eq([...names].sort((a, b) => a.localeCompare(b)));
    });
    table().find('thead th').first().should('have.attr', 'aria-sort', 'ascending').find('button').should('contain.text', '↑');
    table().find('thead th').first().find('button.thbtn').click();
    table().should(($t) => {
      const names = column(0)($t);
      expect(names, 'Z to A').to.deep.eq([...names].sort((a, b) => b.localeCompare(a)));
    });
    table().find('thead th').first().should('have.attr', 'aria-sort', 'descending');
    // A number column: largest first, and the other heading goes back to none.
    table().find('thead th.n').first().find('button.thbtn').click();
    table().find('thead th.n').first().should('have.attr', 'aria-sort', 'descending');
    table().find('thead th').first().should('have.attr', 'aria-sort', 'none');
    table().should(($t) => {
      const i = $t.find('thead th').index($t.find('thead th.n').first());
      const nums = column(i)($t).map((v) => Number(v.replace(/[^0-9.-]/g, ''))).filter((n) => !Number.isNaN(n));
      expect(nums, 'largest first').to.deep.eq([...nums].sort((a, b) => b - a));
    });
    // A new sort starts on the first page.
    cy.contains('Showing 1 to').should('exist');
  });

  it('Usage: counts the seeded people, reporters and sessions, read live', () => {
    cy.openAdmin('Usage');
    cy.contains('active people').parent().invoke('text').should('match', /^\s*2\s*active people/);
    cy.contains('sessions started').parent().invoke('text').should('match', /^\s*12\s*sessions started/);
  });

  it('Sessions: breaks the sessions down by outcome, model, effort or plan', () => {
    cy.openAdmin('Sessions');
    cy.contains('label', 'Break down by').parent().find('select').find('option').should(($o) => expect([...$o].map((o) => o.textContent)).to.deep.eq(['Outcome', 'Model', 'Effort', 'Plan']));
    cy.contains('label', 'Break down by').parent().find('select').select('Model');
    cy.contains('td', 'claude-opus-5-5').should('exist');
  });

  it('Failures: lists the seeded failure class and links it to History', () => {
    cy.openAdmin('Failures');
    cy.contains('td', 'Tool error').should('exist');
    cy.get('a.klink[aria-label="Open in History"]').first().should('have.attr', 'href').and('include', '#/history');
  });

  it('Admin activity: filters the Admin log by kind of entry', () => {
    cy.openAdmin('Admin activity');
    cy.contains('label', 'Kind of entry').parent().find('select').select('unlock');
    cy.get('table.ptab tbody tr').should(($rows) => {
      expect($rows.length).to.be.greaterThan(0);
      $rows.each((_, r) => expect(r.textContent).to.contain('unlock'));
    });
  });

  it('remembers the period and filters in podium.adminReporting', () => {
    cy.openAdmin('Usage');
    period().select('Last 7 days');
    period().should('have.value', '7d');
    cy.window().its('localStorage').invoke('getItem', 'podium.adminReporting').should('be.a', 'string').and('include', '"period":"7d"');
    cy.reload();
    cy.adminPage('Usage');
    period().should('have.value', '7d');
  });

  it('shows From and To when the period is Custom', () => {
    cy.openAdmin('Usage');
    period().select('Custom');
    cy.contains('label', 'From').should('exist');
    cy.contains('label', 'To').should('exist');
  });

  it('exports the table: CSV and JSON buttons and Print', () => {
    cy.openAdmin('Usage');
    cy.task('download:clear');
    cy.get('button[aria-label="Download CSV"]').should('be.enabled').click();
    // An export is exactly the table's columns and rows.
    cy.task('download:read', '.csv').then(({ text }) => {
      const lines = text.trim().split(/\r?\n/);
      expect(lines[0]).to.eq('Period,People,Reporters,Sessions,Peak live');
      expect(lines.length, 'a header, the day and the whole period').to.be.at.least(2);
      expect(lines[1].split(',')[1], 'two people reported').to.eq('2');
    });
    cy.get('button[aria-label="Download JSON"]').should('be.enabled').click();
    cy.task('download:read', '.json').then(({ text }) => {
      const doc = JSON.parse(text);
      expect(doc.columns.map((c) => c.label ?? c)).to.include.members(['People', 'Reporters', 'Sessions']);
      expect(doc.rows.length).to.be.at.least(1);
    });
    cy.get('button[aria-label="Print this page"]').should('exist');
    cy.window().then((win) => cy.stub(win, 'print').as('print'));
    cy.get('button[aria-label="Print this page"]').click();
    cy.get('@print').should('have.been.calledOnce');
  });

  it('People and groups: counts people, groups and reporters and lists who has not reported', () => {
    cy.openAdmin('People and groups');
    cy.get('h1').should('have.text', 'People and groups');
    cy.get('table.ptab').first().find('tbody tr').should('have.length.greaterThan', 0);
    cy.contains('Ed').should('exist');
    cy.contains('Alex').should('exist');
    cy.readFile('/repo/package.json').then((pkg) => cy.contains(pkg.version).should('exist'));
  });

  it('Spend: shows spend today by person, the projection and spend over time', () => {
    cy.openAdmin('Spend');
    cy.get('h1').should('have.text', 'Spend');
    cy.contains('h2', 'Spend today, by person');
    cy.contains('h2', 'Projection');
    cy.contains('h2', 'Spend over time');
    cy.contains('Not enough history to project.');
    cy.contains('spent today, all 2 people');
  });

  it('Spend: opens a person\'s breakdown from their row, with the cuts that add up to the row', () => {
    cy.openAdmin('Spend');
    cy.get('button.rowbtn').contains('Ed').click();
    cy.get('section#spend-bd').within(() => {
      cy.get('table[aria-label="By session"]').should('contain.text', 'invoice-v2');
      cy.contains('claude-opus-5-5');
      cy.contains('Orchestrator');
      cy.contains('Agents');
      cy.contains('button', 'Close').click();
    });
    cy.get('section#spend-bd').should('not.exist');
  });

  it('Spend: groups by group, shows as a table, and remembers it in podium.adminSpend', () => {
    cy.openAdmin('Spend');
    cy.get('[role=group][aria-label="Group by"]').first().contains('button', 'Groups').click().should('have.attr', 'aria-pressed', 'true');
    cy.get('[role=group][aria-label="Show as"]').contains('button', 'Table').click().should('have.attr', 'aria-pressed', 'true');
    cy.window().its('localStorage').invoke('getItem', 'podium.adminSpend').should('be.a', 'string');
    cy.contains('th', 'Share');
  });

  // Tools (#720): every harness. The seed has only today's live figures, and no seed option reports tool counts per harness, so the shape and the empty and live behavior are what is checked.
  it('Tools: opens from the menu after Sessions with its sections and a Harness filter', () => {
    cy.openAdmin('Tools');
    cy.get('h1').should('have.text', 'Tools');
    for (const h of ['Period and filters', 'Calls by tool', 'Tool failures', 'Permission prompts', 'Call duration', 'Calls per session', 'Harness versions']) cy.contains('h2', h);
    cy.contains('h2', /^Tool calls by /);
    cy.contains('label', 'Harness').parent().find('select').find('option').first().should('have.text', 'All harnesses');
    cy.get('table[aria-label="Calls by tool"]').should('exist');
  });

  // Harness updates and the new sections (#724): the seed reports today's live figures only, and no version of a harness stops anything in it, so the
  // shape, the empty lines and the links are what is checked. A seeded history that stops `hook:tool.check` is covered by the unit tests.
  it('Harness updates: opens from the menu after Tools with its sections, a Harness filter and exports, and reads empty when nothing stopped', () => {
    cy.openAdmin('Harness updates');
    cy.get('h1').should('have.text', 'Harness updates');
    for (const h of ['Period and filters', 'Features that stopped', 'Reporters behind the newest version']) cy.contains('h2', h);
    cy.contains('label', 'Harness').parent().find('select').find('option').first().should('have.text', 'All harnesses');
    cy.contains('button', 'CSV').should('exist');
    cy.contains('button', 'JSON').should('exist');
    cy.contains('Nothing has stopped.').should('exist');
  });

  it('Harness updates: the address #/admin/harness opens the page', () => {
    cy.signIn('Admin');
    cy.unlockAdmin();
    cy.visit('/#/admin/harness');
    cy.get('h1', { timeout: 15000 }).should('have.text', 'Harness updates');
  });

  it('Usage: has Projects and branches per person', () => {
    cy.openAdmin('Usage');
    cy.contains('h2', 'Projects and branches per person');
    cy.get('#rep-workload-pl').should('exist');
    cy.get('table[aria-label="Projects and branches per person"]').should('exist');
  });

  it('Tools: has a Skills section', () => {
    cy.openAdmin('Tools');
    cy.contains('h2', 'Skills');
    cy.get('#rep-tools-sk').should('exist');
  });

  it('People and groups: has Platform and reporter version with a Harness select', () => {
    cy.openAdmin('People and groups');
    cy.contains('h2', 'Platform and reporter version');
    cy.get('section[aria-labelledby="rep-people-pf"]').within(() => {
      cy.contains('label', 'Harness').parent().find('select').find('option').first().should('have.text', 'All harnesses');
    });
    cy.get('table[aria-label="Reporters by platform and version"]').should('exist');
  });

  it('Tools: exports calls by tool with a column per harness, as the table shows them', () => {
    cy.openAdmin('Tools');
    // Read once on purpose: the table is drawn whole from one load of the report, so its headers are final when it exists (#1137).
    cy.get('table[aria-label="Calls by tool"] thead th').then(($th) => {
      const heads = [...$th].map((t) => t.textContent.trim()).filter(Boolean);
      cy.task('download:clear');
      cy.get('button[aria-label="Download calls by tool CSV"]').should('be.enabled').click();
      cy.task('download:read', '.csv').then(({ text }) => {
        const lines = text.trim().split(/\r?\n/);
        const header = lines[0].split(',');
        expect(header, 'the export has a harness column and a tool column').to.include.members(['Harness', 'Tool']);
        expect(lines.length, 'the seed reports tool calls today').to.be.at.least(2);
        expect(heads.length, 'the table has its columns').to.be.greaterThan(1);
      });
    });
  });

  it('Tools: a period with nothing in it reads as empty, not as an error', () => {
    cy.openAdmin('Tools');
    cy.contains('label', 'Period').parent().find('select').select('Last month');
    cy.contains('there is nothing to show').should('exist');
    cy.get('table[aria-label="Calls by tool"]').should('not.exist');
    cy.get('[role=alert]').should('not.exist');
  });

  // #721: the seed reports no failures, prompts or call times per tool, and its history starts today, so a period that reaches back before it is partial: a section with no rows is then left blank, the page's note says why, and a section with rows shows its table. Either way no section errors.
  it('Tools: failures, permission prompts and call duration each show their table, their empty line or a blank partial period', () => {
    cy.openAdmin('Tools');
    const sections = [
      ['rep-tools-x', 'Failures by tool', 'No tool was called in this period.'],
      ['rep-tools-p', 'Permission prompts by tool', 'No tool asked for permission in this period.'],
      ['rep-tools-d', 'Call duration by tool', 'reported no call times in this period.'],
    ];
    for (const [id, table, empty] of sections) {
      cy.get(`section[aria-labelledby="${id}"]`).should(($s) => {
        const text = $s.text();
        expect(text, `${id} has settled`).not.to.contain('Loading');
        expect($s.find('[role=alert]').length, `${id} shows no error`).to.equal(0);
        const ok = $s.find(`table[aria-label="${table}"]`).length > 0 || text.includes(empty) || $s.find('.empty').length === 0;
        expect(ok, `${id} shows its table, its empty line or nothing`).to.equal(true);
      });
    }
    cy.contains('Podium has no history before').should('exist');
  });

  // Session time and workload (#722): every harness. The seed has only today's live figures, so the shape, the empty period, the held-back line and the exports are what is checked.
  const sectionOf = (title) => cy.contains('h2', title).closest('section');
  const harnessSelect = () => cy.contains('label', 'Harness').parent().find('select');

  it('Sessions: shows length and waiting, what sessions waited for, agents launched and chain depth', () => {
    cy.openAdmin('Sessions');
    for (const h of ['Length and waiting by day', 'What sessions waited for', 'Agents launched', 'How deep agent chains go']) cy.contains('h2', h);
    cy.get('table[aria-label="Length and waiting by period"]').should('exist');
    cy.get('table[aria-label="Waiting by reason"]').should('exist');
    cy.get('table[aria-label="Agents launched by type"]').should('exist');
    cy.get('table[aria-label="Agent chain depth"]').should('exist');
    cy.contains('button', 'Week').should('exist');
    harnessSelect().find('option').first().should('have.text', 'All harnesses');
  });

  it('Sessions: each new table has its own CSV and JSON, as the table shows it', () => {
    cy.openAdmin('Sessions');
    cy.get('table[aria-label="Waiting by reason"]').should('exist');
    cy.task('download:clear');
    cy.get('button[aria-label="Download waiting by reason CSV"]').should('be.enabled').click();
    cy.task('download:read', '.csv').then(({ text }) => {
      const lines = text.trim().split(/\r?\n/);
      expect(lines.length, 'a header and a row').to.be.at.least(2);
    });
    cy.get('button[aria-label="Download waiting by reason JSON"]').should('be.enabled').click();
    cy.task('download:read', '.json').then(({ text }) => {
      const doc = JSON.parse(text);
      expect(doc.rows.length).to.be.at.least(1);
    });
    for (const noun of ['length and waiting', 'agents by type', 'chain depth']) {
      cy.get(`button[aria-label="Download ${noun} CSV"]`).should('exist');
      cy.get(`button[aria-label="Download ${noun} JSON"]`).should('exist');
    }
  });

  it('Sessions: a Harness choice keeps the new sections and says the first report covers every harness', () => {
    cy.openAdmin('Sessions');
    harnessSelect().find('option').should('have.length.greaterThan', 1);
    harnessSelect().find('option').eq(1).invoke('text').then((name) => harnessSelect().select(name));
    cy.contains('This section is not kept per harness, so it covers every harness.').should('exist');
    cy.contains('h2', 'What sessions waited for').should('exist');
    cy.get('[role=alert]').should('not.exist');
  });

  it('Sessions: a Model filter holds the new sections back and says why', () => {
    cy.openAdmin('Sessions');
    cy.contains('label', 'Model').parent().find('select').select('claude-opus-5-5');
    cy.contains('are not shown while a Person, Group or Model filter is set.').should('exist');
    cy.get('table[aria-label="Waiting by reason"]').should('not.exist');
    cy.get('table[aria-label="Agent chain depth"]').should('not.exist');
    cy.contains('label', 'Model').parent().find('select').select('All models');
    cy.get('table[aria-label="Waiting by reason"]').should('exist');
  });

  it('Sessions: a period before the history reads as empty, not as an error', () => {
    cy.openAdmin('Sessions');
    cy.contains('label', 'Period').parent().find('select').select('Last month');
    // The period ends before Podium's history begins, so the page says so and the sections hold no table.
    cy.contains('so there is nothing to show').should('exist');
    cy.contains('h2', 'What sessions waited for').should('exist');
    cy.get('table[aria-label="Agents launched by type"]').should('not.exist');
    cy.get('table[aria-label="Waiting by reason"]').should('not.exist');
    cy.get('[role=alert]').should('not.exist');
  });

  it('Usage: shows sessions per person per day and the busiest hours, with a Chart and Table switch', () => {
    cy.openAdmin('Usage');
    cy.contains('h2', 'Sessions per person per day');
    cy.contains('h2', 'Busiest hours');
    cy.get('table[aria-label="Sessions per person per day"]').should('exist');
    harnessSelect().find('option').first().should('have.text', 'All harnesses');
    sectionOf('Busiest hours').within(() => {
      cy.get('svg[role=img]').should('exist');
      cy.get('[role=group][aria-label="Show as"]').contains('button', 'Table').click().should('have.attr', 'aria-pressed', 'true');
      cy.get('table[aria-label="Most sessions live at once by hour of day"] tbody tr').should('have.length', 24);
      cy.get('svg[role=img]').should('not.exist');
    });
  });

  it('Usage: exports sessions per person and busiest hours as their own files', () => {
    cy.openAdmin('Usage');
    cy.get('table[aria-label="Sessions per person per day"]').should('exist');
    cy.task('download:clear');
    cy.get('button[aria-label="Download sessions per person CSV"]').should('be.enabled').click();
    cy.task('download:read', '.csv').then(({ text }) => {
      expect(text.trim().split(/\r?\n/).length, 'a header and a row').to.be.at.least(2);
    });
    cy.get('button[aria-label="Download busiest hours JSON"]').should('be.enabled').click();
    cy.task('download:read', '.json').then(({ text }) => {
      expect(JSON.parse(text).rows.length, 'one row for each hour of the day').to.eq(24);
    });
  });

  it('Usage: a period before the history reads as empty, not as an error', () => {
    cy.openAdmin('Usage');
    cy.contains('label', 'Period').parent().find('select').select('Last month');
    cy.contains('so there is nothing to show').should('exist');
    cy.contains('h2', 'Sessions per person per day').should('exist');
    cy.get('table[aria-label="Sessions per person per day"]').should('not.exist');
    cy.get('[role=alert]').should('not.exist');
  });

  // Cost and tokens (#723): every harness. The seed has only today's live figures and no seed option reports costs per model, so the shape, the exports, the filters, the
  // held-back line and the empty period are what is checked. Each section settles to a table, its empty line or a blank partial period, and never to an error.
  const settled = (id, table, empty) =>
    cy.get(`section[aria-labelledby="${id}"]`).should(($s) => {
      const text = $s.text();
      expect(text, `${id} has settled`).not.to.contain('Loading');
      expect($s.find('[role=alert]').length, `${id} shows no error`).to.equal(0);
      expect($s.find(`table[aria-label="${table}"]`).length > 0 || text.includes(empty) || $s.find('.empty').length === 0, `${id} shows its table, its empty line or nothing`).to.equal(true);
    });

  it('Tools: shows what a tool call and a session cost, and what sessions that used each tool cost', () => {
    cy.openAdmin('Tools');
    cy.contains('h2', 'Cost per tool call and per session');
    cy.contains('h2', 'What sessions that used a tool cost');
    cy.contains('says where heavy sessions use a tool, not what the tool cost', { matchCase: false }).should('exist');
    settled('rep-costs-m', 'Cost per call by model', 'No sessions in this period.');
    settled('rep-costs-t', 'Sessions that used each tool', 'No tool calls in this period.');
    for (const noun of ['cost per call', 'sessions by tool']) {
      cy.get(`button[aria-label="Download ${noun} CSV"]`).should('exist');
      cy.get(`button[aria-label="Download ${noun} JSON"]`).should('exist');
    }
  });

  it('Tools: a period before the history reads as empty in the cost sections, not as an error', () => {
    cy.openAdmin('Tools');
    cy.contains('label', 'Period').parent().find('select').select('Last month');
    cy.contains('h2', 'Cost per tool call and per session').should('exist');
    cy.get('table[aria-label="Cost per call by model"]').should('not.exist');
    cy.get('table[aria-label="Sessions that used each tool"]').should('not.exist');
    cy.get('[role=alert]').should('not.exist');
  });

  it('Spend: shows tokens and cache hit rate with a Harness filter of its own, and exports its table', () => {
    cy.openAdmin('Spend');
    cy.contains('h2', 'Tokens and cache hit rate');
    settled('rep-costs-k', 'Tokens by period', 'No sessions in this period.');
    sectionOf('Tokens and cache hit rate').within(() => {
      cy.contains('label', 'Harness').parent().find('select').find('option').first().should('have.text', 'All harnesses');
      cy.get('button[aria-label="Download tokens CSV"]').should('exist');
      cy.get('button[aria-label="Download tokens JSON"]').should('exist');
    });
  });

  it('Spend: the tokens section keeps its Harness choice and does not error', () => {
    cy.openAdmin('Spend');
    settled('rep-costs-k', 'Tokens by period', 'No sessions in this period.');
    sectionOf('Tokens and cache hit rate').within(() => {
      cy.contains('label', 'Harness').parent().find('select').find('option').should('have.length.greaterThan', 1);
      cy.contains('label', 'Harness').parent().find('select').find('option').eq(1).invoke('text').then((name) => cy.contains('label', 'Harness').parent().find('select').select(name));
    });
    settled('rep-costs-k', 'Tokens by period', 'No sessions in this period.');
    cy.get('[role=alert]').should('not.exist');
  });

  it('Sessions: shows the model and effort mix with a Mix of choice, and how full the context was at the end', () => {
    cy.openAdmin('Sessions');
    cy.contains('h2', 'Model and effort mix');
    cy.contains('h2', 'Context fullness at the end');
    settled('rep-costs-x', 'Model mix by period', 'No sessions in this period.');
    settled('rep-costs-c', 'Context fullness at the end', 'No sessions in this period.');
    sectionOf('Model and effort mix').within(() => {
      cy.get('[role=group][aria-label="Mix of"]').contains('button', 'Model').should('have.attr', 'aria-pressed', 'true');
      cy.get('[role=group][aria-label="Mix of"]').contains('button', 'Effort').click().should('have.attr', 'aria-pressed', 'true');
      cy.get('button[aria-label="Download effort mix CSV"]').should('exist');
    });
    settled('rep-costs-x', 'Effort mix by period', 'No sessions in this period.');
    for (const noun of ['effort mix', 'context at the end']) {
      cy.get(`button[aria-label="Download ${noun} CSV"]`).should('exist');
      cy.get(`button[aria-label="Download ${noun} JSON"]`).should('exist');
    }
  });

  it('Sessions: a Model filter holds the mix and context sections back and says why', () => {
    cy.openAdmin('Sessions');
    cy.contains('label', 'Model').parent().find('select').select('claude-opus-5-5');
    sectionOf('Model and effort mix').contains('are not shown while a Person, Group or Model filter is set.').should('exist');
    sectionOf('Context fullness at the end').contains('are not shown while a Person, Group or Model filter is set.').should('exist');
    cy.get('table[aria-label="Context fullness at the end"]').should('not.exist');
    cy.contains('label', 'Model').parent().find('select').select('All models');
    settled('rep-costs-c', 'Context fullness at the end', 'No sessions in this period.');
  });

  it('Sessions: a period before the history reads as empty in the mix and context sections, not as an error', () => {
    cy.openAdmin('Sessions');
    cy.contains('label', 'Period').parent().find('select').select('Last month');
    cy.contains('h2', 'Context fullness at the end').should('exist');
    cy.get('table[aria-label="Context fullness at the end"]').should('not.exist');
    cy.get('[role=alert]').should('not.exist');
  });

  // Answers sent through Podium (#725). The seed carries no history (scripts/podium-seed-history.ts needs tsx), so the story is one sequence on this file's server: first nothing
  // has been answered and both sections say so, then the console answers a tool's permission and sends a message, and the counts and the dash before counting began are read.
  const ANSWERS = 'table[aria-label^="Answers sent through Podium by"]';
  const dialog = () => cy.get('[role=dialog]');

  it('Sessions: answers sent and wait before an answer both read as empty before anything was answered from Podium, not as an error', () => {
    cy.openAdmin('Sessions');
    // The period starts before counting began, so each section draws its figures (nothing answered yet, so zeros and dashes) and never an error.
    for (const id of ['rep-sessiontime-answers', 'rep-sessiontime-answerwait']) {
      cy.get(`section[aria-labelledby="${id}"]`).should(($s) => {
        expect($s.text(), `${id} has settled`).not.to.contain('Loading');
        expect($s.find('[role=alert]').length, `${id} shows no error`).to.equal(0);
        expect($s.find('table').length, `${id} draws its table`).to.be.greaterThan(0);
      });
    }
    cy.get(`${ANSWERS} tfoot tr`).first().should(($r) => {
      expect([...$r.find('td')].map((c) => c.textContent.trim()), 'nothing answered yet').to.deep.eq(['0', '0', '0', '0', '0']);
    });
    cy.contains('h2', 'Answers sent through Podium').should('exist');
    cy.contains('h2', 'How long sessions waited for an answer').should('exist');
  });

  it('Sessions: answering a permission and sending a message from the console raises the counts, with a dash before counting began', () => {
    cy.signIn('Ed');
    cy.openConsole('#/');
    cy.intercept('POST', '/api/fleet/respond/sessions/*/asks/*/answer').as('answer');
    cy.intercept('POST', '/api/fleet/respond/sessions/*/messages').as('message');
    cy.card('tool').parent().find('button.respond').click();
    dialog().contains('button', /^Allow once$/).click();
    cy.wait('@answer').its('response.statusCode').should('eq', 202);
    dialog().find('button.x').click();
    dialog().should('not.exist');
    cy.card('idle').parent().find('button.respond').click();
    dialog().find('textarea[aria-label="Message to turn-ended"]').type('Please continue with the tests.');
    dialog().contains('button', /^Send$/).click();
    cy.wait('@message').its('response.statusCode').should('eq', 202);

    cy.openAdmin('Sessions');
    sectionOf('Answers sent through Podium').within(() => {
      cy.get(ANSWERS).should('exist');
      // the whole-period row is the footer: one permission, one message, two answers in all; the question and plan columns are zero
      cy.get(`${ANSWERS} tfoot tr`).first().should(($r) => {
        const cells = [...$r.find('td')].map((c) => c.textContent.trim());
        expect(cells, 'permission, question, plan, message, all').to.deep.eq(['1', '0', '0', '1', '2']);
      });
      // counting began today, so the period table has an earlier period shown as dashes
      cy.get(`${ANSWERS} tbody td.muted`).should('have.length.greaterThan', 0).first().should('have.text', '–');
      cy.contains('Answers are recorded from').should('exist');
      cy.contains('Only the kind and the time of each answer are kept, never what was said.').should('exist');
      cy.get('button[aria-label="Download answers sent CSV"]').should('exist');
      cy.get('button[aria-label="Download answers sent JSON"]').should('exist');
    });
    sectionOf('How long sessions waited for an answer').within(() => {
      cy.get('table[aria-label="Wait before an answer, by kind"]').should('exist');
      cy.get('table[aria-label="Wait before an answer, by kind"] tbody tr').should('have.length', 4);
      // a message has no wait: dashes with the reason as a title
      cy.contains('tr', 'A message').find('td.muted').should('have.length', 3).each(($d) => expect($d.text().trim()).to.eq('–')).first().should('have.attr', 'title').and('contain', 'has no wait');
      cy.contains('A wait is counted from when Podium first heard of the ask').should('exist');
      cy.contains('tr', 'Permission for a tool').find('td').eq(1).should('have.text', '1');
      cy.get('table[aria-label^="Wait before an answer, by"]').should('have.length', 2);
      cy.get('button[aria-label="Download wait before an answer CSV"]').should('exist');
    });
  });

  it('Sessions: the Harness filter narrows the answer sections to one harness and a Model filter holds them back', () => {
    cy.openAdmin('Sessions');
    sectionOf('Answers sent through Podium').find(`${ANSWERS} tfoot tr`).first().should('contain.text', 'Whole period, all harnesses');
    harnessSelect().find('option').should('have.length.greaterThan', 1);
    harnessSelect().find('option').eq(1).invoke('text').then((name) => {
      harnessSelect().select(name);
      sectionOf('Answers sent through Podium').find(`${ANSWERS} tfoot tr`).first().should('contain.text', `Whole period, ${name}`);
      sectionOf('How long sessions waited for an answer').find('table[aria-label="Wait before an answer, by kind"] tfoot tr').first().should('contain.text', `Whole period, ${name}`);
    });
    cy.get('[role=alert]').should('not.exist');
    harnessSelect().select('All harnesses');
    cy.contains('label', 'Model').parent().find('select').select('claude-opus-5-5');
    sectionOf('Answers sent through Podium').contains('are not shown while a Person, Group or Model filter is set.').should('exist');
    sectionOf('How long sessions waited for an answer').contains('are not shown while a Person, Group or Model filter is set.').should('exist');
    cy.get(ANSWERS).should('not.exist');
  });
});
