// Which reporters the server records (issue #142): every accepted report, never a refused one, never a token.
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openSqliteStorage, type SqliteStorage } from '../storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import { createFleetRouter } from './routes.js';
import { ReporterTransport } from '../tlsHttp.js';
import { fixtureReport } from './testing.js';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

async function setup(adminSecret: string | null = 'admin-secret') {
  const storage = openSqliteStorage(':memory:');
  const fleet = new Fleet(storage, { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' });
  await fleet.init();
  const people = storage.people;
  const reporters = storage.reporters;
  const app = express();
  app.use('/api/fleet', createFleetRouter(fleet, { token: adminSecret, people, reporters, log: () => {} }));
  closers.push(() => fleet.close());
  return { app, people, reporters, fleet };
}

function report(over: Record<string, unknown> = {}, id = 'sess-1') {
  const r = fixtureReport() as unknown as Record<string, unknown> & { session: { id: string } };
  r.session = { ...r.session, id };
  return { ...r, ...over };
}
const list = async (reporters: SqliteStorage['reporters']) => (await reporters.list({}, Date.now())).rows;

describe('recording reporters', () => {
  it('records a named reporter on its machine id, with the key id of its token and never the token', async () => {
    const { app, people, reporters } = await setup();
    const { token, person } = await people.createPerson('Dana');
    const res = await request(app)
      .post('/api/fleet/report')
      .set('X-Podium-Token', token)
      .send(report({ userName: 'Dana', machine: { name: 'studio-m2', id: '9f3a1c7d2e40' } }));
    expect(res.status).toBe(200);
    const d = await reporters.get('9f3a1c7d2e40', Date.now())!;
    expect(d).toMatchObject({ name: 'studio-m2', who: 'Dana', credential: `pdm_${person.keyId}`, sessions: 1 });
    expect(JSON.stringify(d)).not.toContain(token);
  });

  it('lists both accounts that report from one machine id, and an ignore rule on the machine id turns both away (#221)', async () => {
    const { app, people, reporters } = await setup();
    const ana = await people.createPerson('Ana');
    const ben = await people.createPerson('Ben');
    const machine = { name: 'shared-mac', id: 'abababababab' };
    const send = (who: { token: string }, name: string, id: string) =>
      request(app).post('/api/fleet/report').set('X-Podium-Token', who.token).send(report({ userName: name, machine }, id));
    expect((await send(ana, 'Ana', 'a-1')).status).toBe(200);
    expect((await send(ben, 'Ben', 'b-1')).status).toBe(200);
    expect((await send(ana, 'Ana', 'a-2')).status).toBe(200);
    const rows = (await reporters.list({ sort: 'who' }, Date.now())).rows;
    expect(rows.map((r) => [r.who, r.credential, r.sessions])).toEqual([
      ['Ana', `pdm_${ana.person.keyId}`, 2],
      ['Ben', `pdm_${ben.person.keyId}`, 1],
    ]);
    await reporters.addIgnore('key', machine.id, Date.now());
    expect((await send(ana, 'Ana', 'a-3')).status).toBe(403);
    expect((await send(ben, 'Ben', 'b-2')).status).toBe(403);
  });

  it('matches a reporter that sends no machine id by its address, and labels the admin secret', async () => {
    const { app, reporters } = await setup();
    await request(app).post('/api/fleet/report').set('X-Podium-Token', 'admin-secret').send(report());
    const d = (await reporters.get((await list(reporters))[0]!.key, Date.now()))!;
    expect(d.key.startsWith('addr:')).toBe(true);
    expect(d).toMatchObject({ who: 'Admin', credential: 'admin secret', machineId: null });
    expect(JSON.stringify(d)).not.toContain('"admin-secret"');
  });

  it('does not record the simulator (hostSurface "simulator"), but still stores its session (#168)', async () => {
    const { app, reporters, fleet } = await setup();
    const base = report({ machine: { name: 'sim-box', id: 'aaaabbbbcccc' } }) as unknown as { reporter: Record<string, unknown> };
    const res = await request(app)
      .post('/api/fleet/report')
      .set('X-Podium-Token', 'admin-secret')
      .send({ ...base, reporter: { ...base.reporter, hostSurface: 'simulator' } });
    expect(res.status).toBe(200);
    expect(await list(reporters)).toHaveLength(0);
    expect(await fleet.view('sess-1')).toBeTruthy();
  });

  it('records a settings-hooks session as a hooks-only reporter', async () => {
    const { app, reporters } = await setup(null);
    const res = await request(app)
      .post('/api/fleet/hook')
      .send({ session_id: 'hk-1', transcript_path: '/Users/dev/.claude/projects/x/hk-1.jsonl', cwd: '/Users/dev/x', permission_mode: 'default', hook_event_name: 'SessionStart', source: 'startup', model: 'claude-sonnet-5-5' });
    expect(res.status).toBe(200);
    expect(await list(reporters)).toMatchObject([{ name: 'Hooks only', version: 'hooks', compat: 'unknown', who: 'Unassigned' }]);
  });

  it('records nothing for a refused report, and keeps the refusal for its address', async () => {
    const { app, reporters } = await setup();
    expect((await request(app).post('/api/fleet/report').set('X-Podium-Token', 'wrong').send(report())).status).toBe(401);
    expect((await request(app).post('/api/fleet/report').set('X-Podium-Token', 'admin-secret').send({ nope: 1 })).status).toBe(400);
    expect(await list(reporters)).toHaveLength(0);
    await request(app).post('/api/fleet/report').set('X-Podium-Token', 'admin-secret').send(report());
    const d = (await reporters.get((await list(reporters))[0]!.key, Date.now()))!;
    expect(d.rejected.map((x) => x.reason)[1]).toBe('wrong token');
    expect(d.rejected).toHaveLength(2);
  });
});

describe('ignored reporters (issue #167)', () => {
  it('refuses a report from an ignored reporter, stores nothing, and records the refusal', async () => {
    const { app, reporters, fleet } = await setup();
    await reporters.addIgnore('key', '9f3a1c7d2e40', Date.now());
    const res = await request(app)
      .post('/api/fleet/report')
      .set('X-Podium-Token', 'admin-secret')
      .send(report({ machine: { name: 'studio-m2', id: '9f3a1c7d2e40' } }));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'this reporter is ignored by the Admin' });
    expect(await fleet.view('sess-1')).toBeUndefined();
    expect(await list(reporters)).toHaveLength(0);
  });

  it('refuses by version pattern, and lets a reporter through once its rule is removed', async () => {
    const { app, reporters } = await setup();
    const rule = await reporters.addIgnore('version', '*.*.*', Date.now());
    const send = () => request(app).post('/api/fleet/report').set('X-Podium-Token', 'admin-secret').send(report());
    expect((await send()).status).toBe(403);
    await reporters.removeIgnore(rule.id);
    expect((await send()).status).toBe(200);
    expect(await list(reporters)).toHaveLength(1);
  });

  it('refuses a settings hook from an ignored address', async () => {
    const { app, reporters, fleet } = await setup();
    await reporters.addIgnore('address', '*1', Date.now());
    const res = await request(app).post('/api/fleet/hook').set('X-Podium-Token', 'admin-secret').send({ session_id: 'h1', hook_event_name: 'SessionStart', cwd: '/x' });
    expect(res.status).toBe(403);
    expect(await fleet.view('h1')).toBeUndefined();
  });
});

describe('the transport a reporter used (#589)', () => {
  it('counts a report and a hook that came over plain HTTP from beyond loopback, and not one from loopback', async () => {
    const storage = openSqliteStorage(':memory:');
    const fleet = new Fleet(storage, { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' });
    await fleet.init();
    closers.push(() => fleet.close());
    const transport = new ReporterTransport();
    const app = express();
    app.set('trust proxy', true);
    app.use('/api/fleet', createFleetRouter(fleet, { token: null, people: storage.people, reporters: storage.reporters, log: () => {}, transport }));
    // The gate never refuses loopback, so a reporter there is not one the switch would cut off.
    expect((await request(app).post('/api/fleet/report').send(report({ machine: { name: 'local', id: 'aaaa11112222' } }))).status).toBe(200);
    expect(transport.count(Date.now())).toEqual({ overHttp: 0, total: 1 });
    expect((await request(app).post('/api/fleet/report').set('X-Forwarded-For', '10.0.0.5').send(report({ machine: { name: 'studio-m2', id: '9f3a1c7d2e40' } }, 'sess-2'))).status).toBe(200);
    expect(transport.count(Date.now())).toEqual({ overHttp: 1, total: 2 });
    const hook = await request(app).post('/api/fleet/hook').set('X-Forwarded-For', '10.0.0.6').send({ hook_event_name: 'SessionStart', session_id: 'h1', cwd: '/x' });
    expect(hook.status).toBe(200);
    expect(transport.count(Date.now()).total).toBe(3);
    expect(transport.count(Date.now()).overHttp).toBe(2);
  });
});

describe('two harnesses on one machine (#967)', () => {
  const machine = { name: 'studio-m2', id: '9f3a1c7d2e40' };
  const claude = (name: string, id = 'sess-cc') => report({ machine, reporter: { ...fixtureReport().reporter, name } }, id);
  const opencode = () =>
    report({
      v: 2,
      machine,
      reporter: { ...fixtureReport().reporter, name: 'podium-reporter-opencode', version: '1.4.0' },
      harness: { id: 'opencode', name: 'OpenCode', version: '2.2.5', surface: 'tui' },
      capabilities: { commands: [] },
    }, 'sess-oc');

  it('files a Claude Code report and an OpenCode report from one machine as two rows with their own names', async () => {
    const { app, reporters } = await setup();
    expect((await request(app).post('/api/fleet/report').set('X-Podium-Token', 'admin-secret').send(claude('podium-reporter'))).status).toBe(200);
    expect((await request(app).post('/api/fleet/report').set('X-Podium-Token', 'admin-secret').send(opencode())).status).toBe(200);
    const rows = await list(reporters);
    expect(rows.map((r) => [r.key, r.reporterName]).sort()).toEqual([
      ['9f3a1c7d2e40', 'podium-reporter-claudecode'],
      ['9f3a1c7d2e40@podium-reporter-opencode', 'podium-reporter-opencode'],
    ]);
    expect(rows.find((r) => r.reporterName === 'podium-reporter-opencode')!.compat).toBe('ok');
  });

  it('keeps one row and one key when a reporter moves from the legacy name to the new one', async () => {
    const { app, reporters } = await setup();
    await request(app).post('/api/fleet/report').set('X-Podium-Token', 'admin-secret').send(claude('podium-reporter'));
    const before = await list(reporters);
    expect((await request(app).post('/api/fleet/report').set('X-Podium-Token', 'admin-secret').send(claude('podium-reporter-claudecode'))).status).toBe(200);
    const after = await list(reporters);
    expect(after).toHaveLength(1);
    expect(after[0].key).toBe(before[0].key);
    expect(after[0].reporterName).toBe('podium-reporter-claudecode');
  });

  it('accepts only the legacy name in a v1 report, and a name no one knows is a 400 in v2', async () => {
    const { app } = await setup();
    const v1 = await request(app).post('/api/fleet/report').set('X-Podium-Token', 'admin-secret').send(claude('podium-reporter-opencode'));
    expect(v1.status).toBe(400);
    expect(v1.body.path).toBe('$.reporter.name');
    const v2 = { ...opencode(), reporter: { ...fixtureReport().reporter, name: 'something-else' } };
    const res = await request(app).post('/api/fleet/report').set('X-Podium-Token', 'admin-secret').send(v2);
    expect(res.status).toBe(400);
    expect(res.body.path).toBe('$.reporter.name');
  });
});
