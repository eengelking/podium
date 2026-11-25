// A loop's background shells and monitors in the Activity modal's Background tab (#897), through the Fleet and its router: what is held,
// where the whole command and the output go, and where they must not.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { openSqliteStorage, type SqliteStorage } from '../storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import { LIMITS, MAIN_LOOP, validateReport, type BackgroundItem, type Report } from './protocol.js';
import { createFleetRouter } from './routes.js';
import { Lockout } from './lockout.js';
import { createRespondBridge } from './respondBridge.js';
import { fixtureReport } from './testing.js';
import { createLogger } from '../logging/logger.js';

const ADMIN = 'admin-secret-for-the-background-tab';
const SECRET = 'sk-live-BACKGROUND-SECRET-7c1d';
const T0 = 1_791_648_000_000;
const AID = fixtureReport().agents[0]!.id;
const SID = fixtureReport().session.id;

let dir: string;
let clock: number;
let lines: string[];
let open: Fleet[];
let stores: SqliteStorage[];
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'podium-background-'));
  clock = T0;
  lines = [];
  open = [];
  stores = [];
});
afterEach(async () => {
  for (const f of open) f.close();
  while (stores.length) await stores.pop()!.close();
  rmSync(dir, { recursive: true, force: true });
});

const item = (over: Partial<BackgroundItem> = {}): BackgroundItem => ({
  id: 'b1',
  kind: 'shell',
  state: 'running',
  startedAt: T0 + 1,
  startedKnown: false,
  label: 'npm',
  ...over,
});
const detailed = (over: Partial<BackgroundItem> = {}): BackgroundItem =>
  item({ command: 'npm run test:e2e', output: `line\nTOKEN=${SECRET}\n`, lastOutputAt: T0 + 5, ...over });

async function server(flags: { background?: boolean } = { background: true }) {
  const dbPath = path.join(dir, 'podium.sqlite');
  const logger = createLogger({ level: 'debug', format: 'json', write: (l) => lines.push(l) });
  const storage = openSqliteStorage(dbPath);
  stores.push(storage);
  const fleet = new Fleet(storage, { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath }, () => clock, logger, { authOn: true });
  await fleet.init();
  open.push(fleet);
  if (flags.background) await fleet.features.setFeature('background-output', true);
  // A feature that needs the sign-in is on, so a browser can sign in (the keep policy stores entries, never a background item).
  await fleet.activityHistorySettings.set({ policy: 'after', n: 1, unit: 'days' });
  const app = express();
  app.use('/api/fleet', createFleetRouter(fleet, { token: ADMIN, people: storage.people, lockout: new Lockout(fleet.now), respondBridge: createRespondBridge(), log: (l) => lines.push(l) }));
  /** A report whose orchestrator and first agent carry these items; `opt` is the backgroundOutput option (null: an older reporter). */
  const live = (agent: BackgroundItem[] | undefined, main?: BackgroundItem[], opt: boolean | null = true): Report => {
    const r = fixtureReport();
    r.sentAt = clock;
    r.session.activityFeed = true;
    if (opt !== null) r.session.backgroundOutput = opt;
    if (main) r.session.backgroundItems = main;
    if (agent) r.agents[0]!.backgroundItems = agent;
    return r;
  };
  const send = (r: Report) => request(app).post('/api/fleet/report').set('X-Podium-Token', ADMIN).send(r);
  const viewer = request.agent(app);
  expect((await viewer.post('/api/fleet/respond/sign-in').set('X-Podium-Respond', '1').send({ name: 'Admin', token: ADMIN })).status).toBe(200);
  const feed = (loop = AID) => viewer.get(`/api/fleet/sessions/${encodeURIComponent(SID)}/agents/${encodeURIComponent(loop)}/activity?every=5`);
  return { fleet, app, live, send, feed };
}

/** Every byte of the database files and their write-ahead logs. */
function raw(): string {
  return readdirSync(dir)
    .filter((f) => f.startsWith('podium.sqlite') || f.startsWith('activity.sqlite'))
    .map((f) => readFileSync(path.join(dir, f)).toString('latin1'))
    .join('\n');
}

describe('the validator', () => {
  const body = (items: unknown, opt = true) => {
    const r = JSON.parse(JSON.stringify(fixtureReport())) as Report;
    r.session.backgroundOutput = opt;
    (r.agents[0] as unknown as { backgroundItems: unknown }).backgroundItems = items;
    return r;
  };

  it('keeps an item as sent, and drops a field it does not know', () => {
    const out = validateReport(body([{ ...detailed(), surprise: 1 }]));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.report.agents[0]!.backgroundItems).toEqual([detailed()]);
  });

  it('keeps the owner of an item a child started (#1242), cut at the id limit, and none when the loop started it', () => {
    const out = validateReport(body([item({ id: 'k1', ownerId: 'a-kid' }), item({ id: 'o1' }), item({ id: 'k2', ownerId: 'x'.repeat(LIMITS.id + 50) })]));
    expect(out.ok).toBe(true);
    if (out.ok) {
      const items = out.report.agents[0]!.backgroundItems!;
      expect(items[0]!.ownerId).toBe('a-kid');
      expect(items[1]).not.toHaveProperty('ownerId');
      expect(items[2]!.ownerId!.length).toBeLessThanOrEqual(LIMITS.id);
    }
  });

  it('drops the command and the output when the session says its backgroundOutput option is off', () => {
    const out = validateReport(body([detailed({ commandCut: true, outputCut: true })], false));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.report.agents[0]!.backgroundItems).toEqual([item({ lastOutputAt: T0 + 5 })]);
  });

  it('rejects a list longer than the limit, an unknown kind and a fractional time', () => {
    expect(validateReport(body(Array.from({ length: LIMITS.backgroundItems + 1 }, (_, i) => item({ id: `b${i}` })))).ok).toBe(false);
    expect(validateReport(body([{ ...item(), kind: 'workflow' }])).ok).toBe(false);
    expect(validateReport(body([{ ...item(), startedAt: 1.5 }])).ok).toBe(false);
  });

  it('cuts a label at its limit, and keeps the newest items inside the report budget, losing output before command', () => {
    const long = 'x'.repeat(LIMITS.backgroundLabel + 50);
    const big = 'y'.repeat(LIMITS.activityDetail);
    const out = validateReport(body([item({ id: 'old', label: long, command: big, output: big }), item({ id: 'mid', command: big, output: big }), ...Array.from({ length: 4 }, (_, i) => item({ id: `n${i}`, command: big, output: big }))]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const list = out.report.agents[0]!.backgroundItems!;
    expect(list[0]!.label).toHaveLength(LIMITS.backgroundLabel);
    expect(list[list.length - 1]).toMatchObject({ id: 'n3', output: big });
    expect(list.reduce((n, i) => n + (i.command?.length ?? 0) + (i.output?.length ?? 0), 0)).toBeLessThanOrEqual(LIMITS.backgroundDetailChars);
    expect(list[0]).not.toHaveProperty('command');
  });
});

describe('the reply and the Background list', () => {
  it('lists watchBackground as the loops under a live viewer lease', async () => {
    const s = await server();
    expect((await s.send(s.live([]))).body.watchBackground).toEqual([]);
    await s.feed();
    expect((await s.send(s.live([]))).body.watchBackground).toEqual(expect.arrayContaining([AID]));
  });

  it('lists nothing while the background-output flag is off', async () => {
    const s = await server({ background: false });
    await s.send(s.live([]));
    await s.feed();
    expect((await s.send(s.live([]))).body.watchBackground).toEqual([]);
  });

  it('holds a loop’s items for a watched loop and serves them with the command and output on a live lease', async () => {
    const s = await server();
    await s.send(s.live([]));
    await s.feed();
    clock += 10;
    await s.send(s.live([detailed()], [item({ id: 'm1' })]));
    const got = (await s.feed()).body;
    expect(got.background).toEqual([detailed()]);
    // the orchestrator's own loop holds its own items, apart from the agent's
    await s.feed(MAIN_LOOP);
    clock += 10;
    await s.send(s.live([detailed()], [item({ id: 'm1' })]));
    expect((await s.feed(MAIN_LOOP)).body.background).toEqual([item({ id: 'm1' })]);
  });

  it('replaces a loop’s list with the newest report, an empty list being none, and keeps it when a report sends no list', async () => {
    const s = await server();
    await s.send(s.live([]));
    await s.feed();
    await s.send(s.live([item({ id: 'a' }), item({ id: 'b' })]));
    expect((await s.feed()).body.background.map((i: BackgroundItem) => i.id)).toEqual(['a', 'b']);
    await s.send(s.live(undefined));
    expect((await s.feed()).body.background).toHaveLength(2);
    await s.send(s.live([]));
    expect((await s.feed()).body.background).toEqual([]);
  });

  it('keeps nothing for a loop no viewer has open', async () => {
    const s = await server();
    await s.send(s.live([detailed()]));
    expect((await s.feed()).body.background).toEqual([]);
  });

  it('serves the list, without the command or output, while the flag is off, and drops them when it goes off', async () => {
    const s = await server();
    await s.send(s.live([]));
    await s.feed();
    await s.send(s.live([detailed()]));
    expect((await s.feed()).body.background[0]).toHaveProperty('output');
    await s.fleet.features.setFeature('background-output', false);
    const got = (await s.feed()).body.background;
    expect(got).toEqual([item({ lastOutputAt: T0 + 5 })]);
    expect(JSON.stringify(got)).not.toContain(SECRET);
    await s.fleet.features.setFeature('background-output', true);
    expect(JSON.stringify((await s.feed()).body)).not.toContain(SECRET);
  });

  it('drops the command and output when the session turns the option off, and reports the option on the session', async () => {
    const s = await server();
    await s.send(s.live([]));
    await s.feed();
    await s.send(s.live([detailed()]));
    expect(s.fleet.activity.backgroundOptionOn(SID)).toBe(true);
    await s.send(s.live([detailed()], undefined, false));
    expect(s.fleet.activity.backgroundOptionOn(SID)).toBe(false);
    expect(JSON.stringify((await s.feed()).body)).not.toContain(SECRET);
  });

  it('an older reporter (no option, no items) behaves as before: option unknown, empty list', async () => {
    const s = await server();
    await s.send(s.live(undefined, undefined, null));
    await s.feed();
    await s.send(s.live(undefined, undefined, null));
    expect(s.fleet.activity.backgroundOptionOn(SID)).toBeNull();
    expect((await s.feed()).body.background).toEqual([]);
  });

  it('says nothing is held when the feature is off for the whole server', async () => {
    const s = await server();
    await s.send(s.live([]));
    await s.fleet.features.setFeature('activity-feed', false);
    const body = (await s.feed()).body;
    expect(body).toMatchObject({ enabled: false, background: [] });
  });
});

describe('a secret in a background shell’s output', () => {
  it('is in no database file and no log line, and is gone with the lease', async () => {
    const s = await server();
    await s.send(s.live([]));
    await s.feed();
    clock += 10;
    await s.send(s.live([detailed()]));
    expect(JSON.stringify((await s.feed()).body)).toContain(SECRET);
    expect(raw()).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain(SECRET);
    // the lease lapses, and the next viewer starts empty
    clock += 120_000;
    s.fleet.activity.expire();
    expect(JSON.stringify((await s.feed()).body)).not.toContain(SECRET);
  });

  it('never reaches the stream or the fleet state', async () => {
    const s = await server();
    const seen: string[] = [];
    s.fleet.hub.add({ write: (c: string) => void seen.push(c), end: () => {} });
    await s.send(s.live([]));
    await s.feed();
    await s.send(s.live([detailed()]));
    expect(seen.join('')).not.toContain(SECRET);
    expect(JSON.stringify(await s.fleet.state())).not.toContain(SECRET);
  });
});
