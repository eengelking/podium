#!/usr/bin/env node
// Fixed-data seed for the end-to-end suite (e2e/, #782, DECISIONS 49). It plays the Admin and the reporters over the server's own
// HTTP routes, so the server derives everything it shows, and it puts the same ids, names, models, costs, plans and people in every
// time. Nothing here is random and no value is read from the clock except the report timestamps the server requires to be recent.
//
// Never point it at a server you use: it changes the Admin's settings and adds people.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const HELP = `Usage: node scripts/e2e-seed.mjs --url <server> [--secret <admin secret>] [options]

Seeds a throwaway Podium server with a fixed set of people, machines and sessions for the end-to-end suite.
The secret is PODIUM_E2E_SECRET or PODIUM_TOKEN when --secret is not given. The server must be on this machine or a podium-e2e-* container.

  --url URL        the throwaway Podium server, such as http://127.0.0.1:4410 (required)
  --secret S       its admin secret
  --out FILE       write the manifest (people, tokens, session ids, machine ids) to FILE as JSON
  --flags LIST     which feature flags to turn on: "all" (default), "none", or a comma list of
                   activity-output,respond,file-diff,peer-messaging,session-recording; "defaults" leaves every flag as the
                   server starts it (five off, the activity feed and the release check on)
  --bulk N         also report N filler sessions (bulk-01 ...), for the rail's paging (default 0)
  --ended N        also report N sessions that have ended (ended-01 ...), for History's paging (default 0)
  --recording      also record the invoice session (its orchestrator, two agents and a fork left out) with about 240 rows,
                   and record an ended session, old-run, whose recording is kept (needs session-recording)
  --rich           also report rich-plan (a 23-step plan, 47 changed files, eight tools, nested agents, 30 events) and many-steps
                   (30 pending steps), for plan order and paging, Files paging, Tools used, the activity list and Board paging
  --reporters      also report sessions from reporters of other versions (old-box 0.1.0, future-box 99.0.0) and one that reports
                   with the admin secret, for Admin > Reporters
  --stored         also turn the Admin's Activity history to "Keep everything" and report stored-run (60 distinct activity entries over
                   three reports) and stored-two (5), so the history is stored (needs a token; the feed's Show older, Stored activity)
  --compaction     also report comp-only (two automatic compactions), comp-blown (one, beside a blowout) and comp-none, for the
                   Comp pill on the wall card (#805)
  --talk           also put eight messages between the orchestrators on Traffic (needs peer-messaging)
  -h, --help       show this help

Fixed values: people Ed and Alex, group Platform (Alex), machines ed-mbp, ci-runner-01 and build-pi, and the session ids in
SESSIONS below (they start with "e2e-"). Tokens are issued by the server, so they are fake and fresh for each database; they
are in the manifest and nowhere else.`;

/** The sessions the seed reports, by key. The ids are fixed so a spec selects a card without a random suffix. */
export const SESSIONS = {
  invoice: 'e2e-s-invoice', // delegating orchestrator: plan, agents, failure, blowouts, files, events, activity
  api: 'e2e-s-api-gateway', // plain running, no plan
  docs: 'e2e-s-docs-sweep', // done
  bg: 'e2e-s-nightly-build', // waiting on a background shell
  question: 'e2e-s-claude-dashboard', // waiting: a question with three questions
  plan: 'e2e-s-history-paging', // waiting: a plan to approve
  tool: 'e2e-s-push-branch', // waiting: a tool permission
  idle: 'e2e-s-turn-ended', // waiting on a message (turn ended), takes /clear and /compact
  long: 'e2e-s-long-name', // a very long name and branch
  alex: 'e2e-s-alex-session', // owned by Alex, waiting on a question
  tester: 'e2e-s-tester', // on ci-runner-01, for Traffic and My reporters
  arm: 'e2e-s-arm64-check', // on build-pi
  rich: 'e2e-s-rich-plan', // --rich: a 23-step plan, 47 files, nested agents, 30 events
  many: 'e2e-s-many-steps', // --rich: 30 pending steps
};

export const MACHINES = {
  mbp: { name: 'ed-mbp', id: 'e2e0000mbp01', os: 'macOS 26.1' },
  ci: { name: 'ci-runner-01', id: 'e2e0000ci001', os: 'Ubuntu 24.04' },
  pi: { name: 'build-pi', id: 'e2e0000pi001', os: 'Debian 12, arm64' },
  alex: { name: 'alex-laptop', id: 'e2e0000alx01', os: 'Fedora 42' },
};

const ALL_KINDS = ['question', 'plan-approve', 'plan-feedback', 'permission', 'message', 'command'];
const ALL_FLAGS = ['activity-output', 'respond', 'file-diff', 'peer-messaging', 'session-recording'];

/** Changed files with a fixed `rev`: one of each kind a diff can be (the diff answers are in e2e/support/diffs.ts). */
export const FILES = [
  { path: 'src/invoice/export.ts', status: 'modified', added: 24, removed: 6, from: null, rev: 'a1' },
  { path: 'src/invoice/export.test.ts', status: 'added', added: 58, removed: 0, from: null, rev: 'a2' },
  { path: 'src/invoice/legacy.ts', status: 'deleted', added: 0, removed: 112, from: null },
  { path: 'src/invoice/totals.ts', status: 'renamed', added: 3, removed: 1, from: 'src/invoice/sum.ts', rev: 'a3' },
  { path: 'assets/logo.png', status: 'modified', added: null, removed: null, from: null, rev: 'a4' },
  { path: 'packages/billing-service/src/deeply/nested/directory/structure/with/many/levels/invoice-line-item-serializer.ts', status: 'modified', added: 2, removed: 2, from: null, rev: 'a5' },
  { path: 'data/fixtures/huge.json', status: 'modified', added: 90000, removed: 0, from: null, rev: 'a6' },
  { path: 'config/secrets.env', status: 'modified', added: 1, removed: 1, from: null, rev: 'a7' },
];

export function parseArgs(argv) {
  const get = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  return {
    help: argv.includes('-h') || argv.includes('--help'),
    url: get('--url', ''),
    secret: get('--secret', process.env.PODIUM_E2E_SECRET || process.env.PODIUM_TOKEN || ''),
    out: get('--out', ''),
    flags: get('--flags', 'all'),
    bulk: Number(get('--bulk', '0')),
    ended: Number(get('--ended', '0')),
    talk: argv.includes('--talk'),
    recording: argv.includes('--recording'),
    rich: argv.includes('--rich'),
    reporters: argv.includes('--reporters'),
    stored: argv.includes('--stored'),
    compaction: argv.includes('--compaction'),
  };
}

export function flagList(text) {
  if (text === 'all') return [...ALL_FLAGS];
  if (text === 'defaults') return null;
  if (text === 'none' || text === '') return [];
  const list = text.split(',').map((s) => s.trim()).filter(Boolean);
  for (const f of list) if (!ALL_FLAGS.includes(f)) throw new Error(`unknown flag "${f}"; use one of ${ALL_FLAGS.join(', ')}`);
  return list;
}

/** A tiny HTTP client that keeps cookies per path family, like a browser would. */
export function client(origin) {
  const jar = { admin: '', respond: '' };
  async function call(method, path, headers, body) {
    const res = await fetch(new URL(path, origin), { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie?.() ?? [];
    const pairs = set.map((c) => c.split(';')[0]).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]);
    const keep = (old) => [...new Map([...old.split('; ').filter(Boolean).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]), ...pairs.filter(([, v]) => v)]).entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    if (set.length && path.startsWith('/api/admin')) jar.admin = keep(jar.admin);
    if (set.length && path.startsWith('/api/fleet/respond')) jar.respond = keep(jar.respond);
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }
  return {
    call,
    admin: (m, p, b) => call(m, `/api/admin${p}`, { 'X-Podium-Admin': '1', cookie: jar.admin }, b),
    browser: (m, p, b) => call(m, `/api/fleet/respond${p}`, { 'X-Podium-Respond': '1', cookie: jar.respond }, b),
    mod: (token, m, p, b) => call(m, `/api/fleet${p}`, { 'X-Podium-Token': token }, b),
  };
}

const must = (r, what) => {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
};

const ZERO_TOKENS = { input: 300_000, output: 30_000, cacheRead: 0, cacheWrite: 0 };

/** One session report, as the reporter mod sends it. `over` replaces fields of `session`. */
export function sessionReport(who, machine, id, name, over = {}, extra = {}) {
  const now = Date.now();
  return {
    v: 1,
    sentAt: now,
    reporter: { name: 'podium-reporter', version: extra.reporterVersion ?? VERSION, engineVersion: '2.1.301', hostSurface: 'terminal' },
    userName: who,
    machine,
    session: {
      id, name, status: 'running', waitReason: null, waitNote: null, endReason: null, resumeId: null,
      startedAt: now - 3_000_000, cwd: `/Users/dev/${name}`, projectRoot: `/Users/dev/${name}`, repoName: `acme/${name}`,
      git: { branch: 'development', detached: false, isWorktree: false, worktreePath: null, ahead: 0, behind: 0, dirty: 0 },
      model: 'claude-opus-5-5', effort: 'high', context: { tokens: 120_000, window: 1_000_000, percent: 12 }, costUsd: 1.55,
      tokens: ZERO_TOKENS, rateLimits: [], blowouts: 0, plan: null,
      loop: { skills: [], lastTool: 'Read', toolCalls: 4, toolCounts: { Read: 4 }, steps: { done: 6, total: null } },
      files: null, attached: true, activityFeed: true,
      respond: { level: 'everything', accepts: ALL_KINDS, limits: [] },
      ...over,
    },
    agents: extra.agents ?? [],
    events: extra.events ?? [],
  };
}

const agent = (id, over) => ({
  id, parentId: null, kind: 'subagent', type: 'general-purpose', name: null, description: id, model: 'claude-sonnet-5-5', effort: 'medium', effortSource: 'requested',
  status: 'running', startedAt: Date.now() - 600_000, endedAt: null, context: { tokens: 60_000, window: 1_000_000, percent: 6 },
  tokens: { input: 9000, output: 4100, cacheRead: 140_000, cacheWrite: 22_000 }, costUsdEst: 0.2, skills: [], lastTool: 'Read', toolCalls: 12,
  toolCounts: { Read: 8, Grep: 4 }, blowouts: 0, steps: { done: 5, total: null }, promptExcerpt: `${id} prompt`, answerExcerpt: null, failure: null, ...over,
});

const EVENT_ID = (sid, aid, kind, n) => `${sid}:${aid}:${kind}:${n}`;

/** The reports of the whole fleet. */
export function fleetReports(manifest, opts = {}) {
  const now = Date.now();
  const ed = 'Ed';
  const out = [];
  const add = (who, machine, key, name, over, extra) => out.push({ who, key, body: sessionReport(who, machine, SESSIONS[key], name, over, extra) });

  const iv = SESSIONS.invoice;
  add(ed, MACHINES.mbp, 'invoice', 'invoice-v2', {
    effort: 'xhigh', costUsd: 12.84, context: { tokens: 410_000, window: 1_000_000, percent: 41 },
    git: { branch: 'refactor/invoice-v2', detached: false, isWorktree: true, worktreePath: '/Users/dev/billing/.claude/worktrees/invoice-v2', ahead: 7, behind: 0, dirty: 3 },
    peers: true, fileDiff: true, fileDiffPreload: true, activityOutput: true, sessionRecording: true,
    rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-10T18:00:00Z' }],
    plan: {
      title: 'Migrate invoices to v2 schema', source: 'TaskCreate',
      steps: [
        { id: '1', text: 'Map invoice call sites', state: 'done', activeText: 'Mapping invoice call sites', ownerAgentId: 'e2e-a-map', ownerLabel: 'Explore · Haiku low' },
        { id: '2', text: 'Port invoice endpoints', state: 'active', activeText: 'Porting invoice endpoints', ownerAgentId: 'e2e-a-port', ownerLabel: 'fork · Opus xhigh' },
        { id: '3', text: 'Run staging backfill', state: 'blocked', activeText: null, ownerAgentId: null, ownerLabel: null },
        { id: '4', text: 'Write rollout notes', state: 'pending', activeText: null, ownerAgentId: null, ownerLabel: null },
      ],
    },
    loop: { skills: ['frontend-design', 'code-review'], lastTool: 'Agent', toolCalls: 19, toolCounts: { Agent: 4, Read: 8, Edit: 5, TaskUpdate: 2 }, steps: { done: 23, total: null } },
    activity: [
      { at: now - 120_000, kind: 'tool', text: 'Agent Port invoice endpoints' },
      { at: now - 90_000, kind: 'text', text: 'The staging backfill failed on a database connection; I am checking the endpoint port first.' },
    ],
    files: { files: FILES, total: FILES.length, added: 90090, removed: 122, since: 'start' },
  }, {
    agents: [
      agent('e2e-a-map', { kind: 'subagent', type: 'Explore', description: 'Map invoice call sites', model: 'claude-haiku-5-5', effort: 'low', status: 'done', endedAt: now - 300_000, answerExcerpt: 'Found 42 call sites across 9 modules.' }),
      agent('e2e-a-port', { kind: 'fork', type: 'fork', description: 'Port invoice endpoints', model: 'claude-opus-5-5', effort: 'xhigh', effortSource: 'inherited', costUsdEst: 2.11, context: { tokens: 380_000, window: 1_000_000, percent: 38 },
        activity: [
          { at: now - 60_000, kind: 'tool', text: 'Edit src/invoice/export.ts' },
          { at: now - 50_000, kind: 'tool', text: 'Bash npm test -- invoice', id: 'toolu_e2e_bash', command: 'npm test -- invoice', output: 'Tests  12 passed', done: true, exitCode: 0 },
        ] }),
      agent('e2e-a-fail', { description: 'Backfill dry run', status: 'failed', endedAt: now - 200_000, lastTool: 'Bash', toolCounts: { Bash: 6 },
        failure: { class: 'Tool error', at: now - 200_000, tool: 'Bash', call: 'npm run backfill:dry -- --env=staging', exitCode: 1, outputTail: ['Error: connect ECONNREFUSED 127.0.0.1:5432', 'backfill: could not open a database connection'], evidence: ['same call failed 3 times'], explanation: null, retriedAs: null } }),
      agent('e2e-a-pdf', { parentId: 'e2e-a-port', description: 'Rewrite PDF renderer', model: 'claude-opus-5-5', effort: 'high', effortSource: 'observed', name: 'pdf', blowouts: 2, context: { tokens: 930_000, window: 1_000_000, percent: 93 } }),
    ],
    events: [
      { id: EVENT_ID(iv, 'e2e-a-port', 'spawn', 1), t: now - 500_000, kind: 'spawn', agentId: 'e2e-a-port', text: 'forked fork (inherits Opus xhigh): Port invoice endpoints', data: null },
      { id: EVENT_ID(iv, 'e2e-a-fail', 'fail', 2), t: now - 200_000, kind: 'fail', agentId: 'e2e-a-fail', text: 'failed: Backfill dry run (Tool error)', data: { class: 'Tool error' } },
      { id: EVENT_ID(iv, 'e2e-a-pdf', 'blow', 3), t: now - 100_000, kind: 'blow', agentId: 'e2e-a-pdf', text: 'context window exceeded (blowout #2) in "Rewrite PDF renderer"', data: { kind: 'auto-compact', tokensBefore: 1_004_000, tokensAfter: 300_000 } },
    ],
  });

  add(ed, MACHINES.mbp, 'api', 'api-gateway', { effort: 'medium', model: 'claude-sonnet-5-5', costUsd: 0.42, usageByModel: [{ model: 'claude-sonnet-5-5', tier: 'std', tokens: { input: 150000, output: 12000, cacheRead: 0, cacheWrite: 0 } }], git: { branch: 'feature/rate-limits', detached: false, isWorktree: false, worktreePath: null, ahead: 2, behind: 0, dirty: 1 } });
  add(ed, MACHINES.mbp, 'docs', 'docs-sweep', { status: 'done', endReason: 'prompt_input_exit', costUsd: 3.1, plan: { title: 'Docs sweep', source: 'TaskCreate', steps: [{ id: '1', text: 'Fix the install page', state: 'done', activeText: null, ownerAgentId: null, ownerLabel: null }] } });
  add(ed, MACHINES.mbp, 'bg', 'nightly-build', { status: 'waiting', waitReason: null, background: { tasks: [{ type: 'shell', description: 'nightly build', status: 'running' }], wakeAt: null } });
  add(ed, MACHINES.mbp, 'question', 'claude-dashboard', {
    status: 'waiting', waitReason: 'input', waitNote: 'AskUserQuestion: 3 questions about History paging',
    asks: [{
      id: 'toolu_e2e_q', kind: 'question', agentId: null, openedAt: now - 42_000,
      questions: [
        { question: 'How many History rows per page?', header: 'Page size', multiSelect: false, options: [{ label: '25/50/100, default 50 (Recommended)', description: 'Same pager as Admin.', preview: null }, { label: 'Fixed 50, no choice', description: 'Previous and Next only.', preview: null }] },
        { question: 'Keep the day selector once it is paged?', header: 'Day selector', multiSelect: false, options: [{ label: 'Keep it, page within the day', description: 'The pager restarts at page 1.', preview: null }, { label: 'One paged list, newest first', description: 'Drop the day selector.', preview: null }] },
        { question: 'What should Back restore?', header: 'Back state', multiSelect: true, options: [{ label: 'The page number', description: 'Return to page 3.', preview: null }, { label: 'The scroll position', description: 'Land on the row.', preview: null }] },
      ],
    }],
  });
  add(ed, MACHINES.mbp, 'plan', 'history-paging', {
    status: 'waiting', waitReason: 'permission', waitNote: 'ExitPlanMode',
    asks: [{ id: 'toolu_e2e_p', kind: 'plan', agentId: null, openedAt: now - 42_000, plan: { text: '# Paginate the History page\n\nHistory loads every session for a day at once.\n\n## Steps\n\n1. Add `page` and `pageSize`.\n2. Reuse the Pager.', filePath: '~/.claude/plans/e2e-plan.md' } }],
  });
  add(ed, MACHINES.mbp, 'tool', 'push-branch', {
    status: 'waiting', waitReason: 'permission', waitNote: 'Bash(git push -u origin issue/195-history-pages)',
    asks: [{ id: 'toolu_e2e_t', kind: 'permission', agentId: null, openedAt: now - 54_000, tool: { name: 'Bash', input: { command: 'git push -u origin issue/195-history-pages', description: 'Push the branch to GitHub' }, cut: false } }],
  });
  add(ed, MACHINES.mbp, 'idle', 'turn-ended', { status: 'waiting', waitReason: 'input', waitNote: null });
  add(ed, MACHINES.mbp, 'long', 'a-very-long-session-name-that-keeps-going-to-test-how-cards-and-the-rail-cut-long-names-without-breaking',
    { git: { branch: 'feature/a-very-long-branch-name-for-testing-truncation-in-the-card-and-the-rail-and-the-header', detached: false, isWorktree: false, worktreePath: null, ahead: 0, behind: 0, dirty: 0 } });
  add('Alex', MACHINES.alex, 'alex', 'alex-session', {
    status: 'waiting', waitReason: 'input', waitNote: null,
    asks: [{ id: 'toolu_e2e_alexq', kind: 'question', agentId: null, openedAt: now - 30_000, questions: [{ question: 'Ship it?', header: 'Ship', multiSelect: false, options: [{ label: 'Yes', description: 'Ship.', preview: null }, { label: 'No', description: 'Hold.', preview: null }] }] }],
  });
  add(ed, MACHINES.ci, 'tester', 'Tester', { status: 'waiting', waitReason: 'input', peers: true });
  add(ed, MACHINES.pi, 'arm', 'arm64-check', { peers: true });

  for (let i = 1; i <= (opts.bulk ?? 0); i++) {
    const n = String(i).padStart(2, '0');
    const who = i % 2 ? ed : 'Alex';
    add(who, who === ed ? MACHINES.mbp : MACHINES.alex, `bulk${n}`, `bulk-${n}`, { costUsd: i / 10, status: i % 5 === 0 ? 'waiting' : 'running', waitReason: i % 5 === 0 ? 'input' : null });
    SESSIONS[`bulk${n}`] = `e2e-s-bulk-${n}`;
    out[out.length - 1].body.session.id = SESSIONS[`bulk${n}`];
  }
  if (opts.rich) {
    const steps = Array.from({ length: 23 }, (_, i) => {
      const n = i + 1;
      const state = n <= 9 ? 'done' : n === 10 ? 'active' : n === 11 ? 'blocked' : 'pending';
      return { id: String(n), text: `Step ${n} of the migration`, state, activeText: state === 'active' ? 'Running step 10' : null, ownerAgentId: null, ownerLabel: null, ...(state === 'done' ? { doneSeq: n } : {}) };
    });
    const files = Array.from({ length: 47 }, (_, i) => ({ path: `src/module${String(i + 1).padStart(2, '0')}/file.ts`, status: 'modified', added: i + 1, removed: 1, from: null, rev: `r${i}` }));
    const nested = [
      agent('e2e-r-a', { description: 'Level one', status: 'running' }),
      agent('e2e-r-b', { parentId: 'e2e-r-a', description: 'Level two', status: 'running' }),
      agent('e2e-r-c', { parentId: 'e2e-r-b', description: 'Level three', status: 'done', endedAt: now - 1000 }),
    ];
    const events = Array.from({ length: 30 }, (_, i) => ({ id: `e2e-s-rich-plan:e2e-r-a:spawn:${i + 1}`, t: now - (40 - i) * 1000, kind: 'spawn', agentId: 'e2e-r-a', text: `launched helper ${i + 1}`, data: null }));
    add(ed, MACHINES.mbp, 'rich', 'rich-plan', {
      costUsd: 2.5, plan: { title: 'Big migration', source: 'TaskCreate', steps },
      files: { files, total: 47, added: 1128, removed: 47, since: 'start' },
      loop: { skills: [], lastTool: 'Read', toolCalls: 45, toolCounts: { Read: 9, Edit: 8, Bash: 7, Grep: 6, Glob: 5, Write: 4, TaskUpdate: 3, WebFetch: 2 }, steps: { done: 12, total: null } },
    }, { agents: nested, events });
    const many = Array.from({ length: 30 }, (_, i) => ({ id: String(i + 1), text: `Queued task ${i + 1}`, state: 'pending', activeText: null, ownerAgentId: null, ownerLabel: null }));
    add(ed, MACHINES.mbp, 'many', 'many-steps', { plan: { title: 'Thirty queued tasks', source: 'TaskCreate', steps: many } });
  }
  if (opts.reporters) {
    const old = { id: 'e2e0000old01', name: 'old-box', os: 'Debian 11' };
    const future = { id: 'e2e0000fut01', name: 'future-box', os: 'Fedora 45' };
    const sec = { id: 'e2e0000sec01', name: 'secret-box', os: 'Ubuntu 22.04' };
    out.push({ who: ed, key: 'oldbox', body: sessionReport(ed, old, 'e2e-s-old-box', 'old-session', {}, { reporterVersion: '0.1.0' }) });
    out.push({ who: ed, key: 'futurebox', body: sessionReport(ed, future, 'e2e-s-future-box', 'future-session', {}, { reporterVersion: '99.0.0' }) });
    out.push({ who: 'Admin', key: 'secretbox', body: sessionReport('Admin', sec, 'e2e-s-secret-box', 'secret-session', {}) });
    SESSIONS.oldbox = 'e2e-s-old-box';
    SESSIONS.futurebox = 'e2e-s-future-box';
    SESSIONS.secretbox = 'e2e-s-secret-box';
  }
  if (opts.compaction) {
    // Automatic compactions are stored `compact` events with trigger auto; the server counts them into the session view (#805).
    const compact = (sid, n, percent) => ({ id: EVENT_ID(sid, 'main', 'compact', n), t: now - 600_000 + n * 1000, kind: 'compact', agentId: null, text: `auto-compacted at ${percent}% on the orchestrator`, data: { trigger: 'auto', window: 1_000_000, percent, idleMs: 312_000, tokensBefore: percent * 10_000, tokensAfter: 29_000 } });
    SESSIONS.comp = 'e2e-s-comp-only';
    SESSIONS.compblow = 'e2e-s-comp-blown';
    SESSIONS.compnone = 'e2e-s-comp-none';
    add(ed, MACHINES.mbp, 'comp', 'comp-only', {}, { events: [compact(SESSIONS.comp, 1, 22), compact(SESSIONS.comp, 2, 25)] });
    add(ed, MACHINES.mbp, 'compblow', 'comp-blown', { blowouts: 1 }, {
      agents: [agent('e2e-c-a', { description: 'Overflowing helper', blowouts: 1, context: { tokens: 910_000, window: 1_000_000, percent: 91 } })],
      events: [compact(SESSIONS.compblow, 1, 22), { id: EVENT_ID(SESSIONS.compblow, 'e2e-c-a', 'blow', 2), t: now - 100_000, kind: 'blow', agentId: 'e2e-c-a', text: 'context window exceeded (blowout #1) in "Overflowing helper"', data: { kind: 'auto-compact', tokensBefore: 1_004_000, tokensAfter: 300_000 } }],
    });
    add(ed, MACHINES.mbp, 'compnone', 'comp-none', {});
  }
  const reasons = ['prompt_input_exit', 'logout', 'other'];
  for (let i = 1; i <= (opts.ended ?? 0); i++) {
    const n = String(i).padStart(2, '0');
    add(ed, MACHINES.mbp, `ended${n}`, `ended-${n}`, { status: 'done', endReason: reasons[i % reasons.length], costUsd: i / 4 });
    SESSIONS[`ended${n}`] = `e2e-s-ended-${n}`;
    out[out.length - 1].body.session.id = SESSIONS[`ended${n}`];
  }
  return out;
}

/** Runs the whole seed against `origin` and returns the manifest. */
export async function seed({ url, secret, flags = 'all', bulk = 0, ended = 0, talk = false, recording = false, rich = false, reporters = false, stored = false, compaction = false }) {
  const origin = new URL(url).origin;
  const host = new URL(origin).hostname;
  // This machine, or a throwaway server container made by scripts/e2e-up.sh (its name starts with podium-e2e-).
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host) && !/^podium-e2e-[a-z0-9-]+$/.test(host)) throw new Error(`refusing ${origin}: --url must be a throwaway server on this machine or a podium-e2e-* container`);
  const c = client(origin);
  must(await c.admin('POST', '/unlock', { name: 'Admin', token: secret }), 'unlock');
  const listed = flagList(flags);
  const on = listed ?? [];
  if (listed) {
    const features = { 'activity-feed': true };
    for (const f of ALL_FLAGS) features[f] = on.includes(f);
    must(await c.admin('PUT', '/settings', { features }), 'flags');
  }

  const people = {};
  for (const name of ['Ed', 'Alex']) {
    const made = must(await c.admin('POST', '/people', { name }), `person ${name}`);
    people[name] = { id: made.body.person.id, name: made.body.person.name, token: made.body.token };
  }
  const group = must(await c.admin('POST', '/groups', { name: 'Platform' }), 'group');
  must(await c.admin('PUT', `/people/${people.Alex.id}/group`, { groupId: group.body.id }), 'group member');

  for (const r of fleetReports({}, { bulk, ended, rich, reporters, compaction })) must(await c.mod(r.who === 'Admin' ? secret : people[r.who].token, 'POST', '/report', r.body), `report ${r.key}`);

  if (on.includes('peer-messaging')) await seedPeers(c, people, talk);
  if (recording) await seedRecording(c, people);
  if (stored) await seedStored(c, people);
  if (reporters) must(await c.call('POST', '/api/fleet/hook', { 'X-Podium-Token': people.Ed.token }, { hook_event_name: 'SessionStart', session_id: 'e2e-s-hook-only', transcript_path: '/Users/dev/.claude/projects/x/hook.jsonl', cwd: '/Users/dev/hooky', permission_mode: 'default', source: 'startup', model: 'claude-sonnet-5-5' }), 'hook-only session');

  const manifest = { url: origin, people, sessions: { ...SESSIONS }, machines: MACHINES, group: { id: group.body.id, name: 'Platform' }, flags: listed ? on : 'defaults', version: VERSION };
  return manifest;
}

/** Keeps the Activity history (policy "all") and stores 60 distinct entries for one session, then 5 for another, as reports carrying 20 entries each. */
async function seedStored(c, people) {
  must(await c.admin('PUT', '/settings', { activityHistory: { policy: 'all', n: 7, unit: 'days', capGb: null } }), 'activity history policy');
  const ed = people.Ed;
  const base = Date.now() - 3_600_000;
  const post = async (key, id, name, from, count) => {
    const entries = Array.from({ length: count }, (_, i) => ({ at: base + (from + i) * 1000, kind: i % 5 === 4 ? 'text' : 'tool', text: i % 5 === 4 ? `Thought ${from + i}` : `Read src/file${from + i}.ts` }));
    const r = sessionReport('Ed', MACHINES.mbp, id, name, { activity: entries });
    must(await c.mod(ed.token, 'POST', '/report', r), `stored report ${key}`);
  };
  SESSIONS.stored = 'e2e-s-stored-run';
  SESSIONS.stored2 = 'e2e-s-stored-two';
  for (const from of [0, 20, 40]) await post('stored-run', SESSIONS.stored, 'stored-run', from, 20);
  await post('stored-two', SESSIONS.stored2, 'stored-two', 100, 5);
}

/** The recording rows one session's story holds, as the mod sends them (`loop` names the orchestrator "@orchestrator" or an agent id). */
export function recordingRows(loops, { filler = 0 } = {}) {
  const MAIN = '@orchestrator';
  const seq = {};
  let clock = Date.now() - 50 * 60_000;
  const entry = (loop, kind, text, extra = {}) => {
    seq[loop] = (seq[loop] ?? 0) + 1;
    clock += 4000;
    return { loop, seq: seq[loop], at: clock, kind, text, ...extra };
  };
  const out = [];
  const call = (loop, name, input, result, failed = false) => {
    const c = entry(loop, 'tool', input, { name });
    out.push(c, entry(loop, 'result', result, { name, callSeq: c.seq, ...(failed ? { failed: true } : {}) }));
  };
  out.push(entry(MAIN, 'prompt', 'Migrate invoices to the v2 schema.'), entry(MAIN, 'thinking', ''), entry(MAIN, 'text', 'I will read the current schema before changing anything.'));
  call(MAIN, 'Read', 'server/src/invoices/schema.ts', 'export const schema = z.object({});');
  if (loops[1]) out.push(entry(loops[1], 'prompt', 'Port the invoice endpoints to the v2 schema.'));
  if (loops[1]) call(loops[1], 'Bash', 'npm test -w server -- invoices', 'FAIL list.test.ts: expected currency USD', true);
  out.push(entry(MAIN, 'compact', ''));
  for (let i = 0; i < filler; i++) call(MAIN, 'Read', `server/src/invoices/file${i}.ts`, `// file ${i}`);
  out.push(entry(MAIN, 'text', 'The port is done and the tests pass.'));
  return out;
}

async function sendRows(c, token, id, rows) {
  for (let i = 0; i < rows.length; i += 150) must(await c.mod(token, 'POST', `/sessions/${id}/recording`, { v: 1, sentAt: Date.now(), entries: rows.slice(i, i + 150) }), `recording rows of ${id}`);
}

async function seedRecording(c, people) {
  const ed = people.Ed;
  must(await c.browser('POST', '/sign-in', { name: ed.name, token: ed.token }), 'sign in Ed');
  // The invoice session records its orchestrator and two agents; its fork-built agent e2e-a-fail is left out, so the layer names a loop that is not recorded.
  const loops = ['@orchestrator', 'e2e-a-port', 'e2e-a-map'];
  must(await c.browser('PUT', `/sessions/${SESSIONS.invoice}/recording`, { loops }), 'start recording the invoice session');
  await sendRows(c, ed.token, SESSIONS.invoice, recordingRows(loops, { filler: 110 }));
  // An ended session whose recording is kept: History lists it.
  const old = 'e2e-s-old-run';
  SESSIONS.oldrun = old;
  const r = sessionReport('Ed', MACHINES.mbp, old, 'old-run', { sessionRecording: true });
  must(await c.mod(ed.token, 'POST', '/report', r), 'report old-run');
  must(await c.browser('PUT', `/sessions/${old}/recording`, { loops: ['@orchestrator'] }), 'start recording old-run');
  await sendRows(c, ed.token, old, recordingRows(['@orchestrator']));
  const ended = sessionReport('Ed', MACHINES.mbp, old, 'old-run', { status: 'done', endReason: 'prompt_input_exit', sessionRecording: true });
  must(await c.mod(ed.token, 'POST', '/report', ended), 'end old-run');
}

async function seedPeers(c, people, talk) {
  const ed = people.Ed;
  must(await c.browser('POST', '/sign-in', { name: ed.name, token: ed.token }), 'sign in Ed');
  const { mbp, ci, pi } = MACHINES;
  for (const [from, to, level] of [[mbp, mbp, 'send'], [mbp, ci, 'send'], [ci, mbp, 'send'], [mbp, pi, 'ask'], [pi, mbp, 'see']]) {
    must(await c.browser('PUT', '/peers/rights', { from: from.id, to: to.id, level }), `right ${from.name} to ${to.name}`);
  }
  must(await c.browser('PUT', '/peers/links', { a: mbp.id, b: mbp.id, paused: true }), 'pause');
  must(await c.admin('POST', `/reporters/${pi.id}/peers/propose`, { to: mbp.id, level: 'ask' }), 'proposal');
  must(await c.mod(ed.token, 'POST', `/sessions/${SESSIONS.tester}/peers/access`, { to: pi.name, right: 'send', reason: 'I need the arm64 build tested on a Raspberry Pi before the release.' }), 'access request');
  if (talk) {
    must(await c.admin('PUT', '/settings', { peerMessaging: { perMinute: 60 } }), 'limits');
    const send = (from, to, text) => c.mod(ed.token, 'POST', `/sessions/${from}/peers/messages`, { to, text });
    const exchange = [
      [SESSIONS.invoice, `Tester@${ci.name}`, 'Please run the unit tests on this branch.'],
      [SESSIONS.tester, `invoice-v2@${mbp.name}`, '2 of 14 failed on Ubuntu 24.04.'],
      [SESSIONS.invoice, `Tester@${ci.name}`, 'Pushed the fix. Rerun the two units.'],
      [SESSIONS.tester, `invoice-v2@${mbp.name}`, 'All 14 pass.'],
    ];
    for (const [from, to, text] of exchange) must(await send(from, to, text), `message ${text}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (!a.url || !a.secret) {
    console.error(HELP);
    process.exit(2);
  }
  try {
    const manifest = await seed(a);
    if (a.out) writeFileSync(a.out, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    console.log(`seeded ${Object.keys(manifest.sessions).length} sessions and ${Object.keys(manifest.people).length} people on ${manifest.url}`);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err).replaceAll(/[\r\n]+/g, " "));
    process.exit(1);
  }
}
