// A session's background shells in the OpenCode reporter (#897): what `shell.created` and `shell.exited` do to the state, what a report carries for a
// watched loop, and that the whole command and the output go only with the option and a viewer on the Background tab. The wire shapes are the Claude
// Code reporter's (`BackgroundItem` in core/protocol.ts).
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAIN_LOOP, type Report } from '../core/protocol.ts';
import type { FetchLike } from '../core/transport.ts';
import { optionsOf } from './options.ts';
import { buildReport } from './report.ts';
import { Reporter } from './reporter.ts';
import { apply, EVENT_TYPES, newStore, setWatched, setWatchedBackground, type BusEvent } from './state.ts';
import { VERSION } from './version.ts';

let n = 0;
const ev = (type: string, data: Record<string, unknown>, created: number): BusEvent => ({ id: `b${++n}`, created, type, data, location: { directory: '/work/project' } });
const ROOT = 'ses_root';
const KID = 'ses_kid';
const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
const META = { now: 9, version: VERSION, engineVersion: null, hostSurface: null, activity: true };

const dir = mkdtempSync(path.join(os.tmpdir(), 'podium-oc-bg-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const out = (name: string, text: string) => {
  const file = path.join(dir, name);
  writeFileSync(file, text);
  return file;
};

const created = (sid: string, id: string, command: string, file: string | null, at: number) =>
  ev('shell.created', { info: { id, status: 'running', command, cwd: '/work/project', ...(file ? { file } : {}), metadata: { sessionID: sid }, time: { started: at } } }, at);
const exited = (id: string, at: number, exit?: number) => ev('shell.exited', { id, status: 'exited', ...(exit === undefined ? {} : { exit }) }, at);

function begin() {
  const s = newStore();
  for (const e of [ev('session.created', { sessionID: ROOT }, 1), ev('session.created', { sessionID: KID, parentID: ROOT }, 2)]) apply(s, e, e.created ?? 0);
  return s;
}
const shells = (s: ReturnType<typeof begin>, sid = ROOT) => [...s.roots.get(ROOT)!.sessions.get(sid)!.shells.values()];

describe('what the shell events do to the state', () => {
  it('subscribes to both events', () => {
    expect(EVENT_TYPES).toEqual(expect.arrayContaining(['shell.created', 'shell.exited']));
  });

  it('records a shell under the session that started it, with OpenCode’s own start time, and a subagent’s shell under the child', () => {
    const s = begin();
    apply(s, created(ROOT, 'sh1', 'npm test', '/tmp/sh1.out', 500), 500);
    apply(s, created(KID, 'sh2', 'make', '/tmp/sh2.out', 600), 600);
    expect(shells(s).map((x) => x.id)).toEqual(['sh1']);
    expect(shells(s, KID).map((x) => x.id)).toEqual(['sh2']);
    expect(shells(s)[0]).toMatchObject({ startedAt: 500, exited: false, exitCode: null, file: '/tmp/sh1.out' });
  });

  it('marks a shell exited with the code OpenCode sent, and with none for one signalled from outside', () => {
    const s = begin();
    apply(s, created(ROOT, 'sh1', 'a', null, 500), 500);
    apply(s, created(ROOT, 'sh2', 'b', null, 501), 501);
    apply(s, exited('sh1', 900, 2), 900);
    apply(s, exited('sh2', 901), 901);
    expect(shells(s)[0]).toMatchObject({ exited: true, exitCode: 2 });
    expect(shells(s)[1]).toMatchObject({ exited: true, exitCode: null });
  });

  it('ignores a shell of a session it does not know, an exit of a shell it does not know, and a repeat', () => {
    const s = begin();
    expect(apply(s, created('ses_unknown', 'x', 'a', null, 5), 5)).toBeNull();
    expect(s.roots.has('ses_unknown')).toBe(false);
    expect(apply(s, exited('nope', 6, 0), 6)).toBeNull();
    apply(s, created(ROOT, 'sh1', 'a', null, 7), 7);
    expect(apply(s, created(ROOT, 'sh1', 'a', null, 8), 8)).toBeNull();
    expect(shells(s)).toHaveLength(1);
  });
});

describe('what a report carries', () => {
  const setup = () => {
    const s = begin();
    apply(s, created(ROOT, 'sh1', `API_KEY=${SECRET} npm run test:e2e`, null, 500), 500);
    apply(s, created(KID, 'sh2', 'make build', null, 600), 600);
    return s;
  };

  it('carries nothing for a loop nobody watches', () => {
    const r = buildReport(setup().roots.get(ROOT)!, [], META);
    expect(r.session).not.toHaveProperty('backgroundItems');
    expect(r.agents[0]).not.toHaveProperty('backgroundItems');
  });

  it('carries each watched loop’s own shells with the label, state and start time, and never the command without the option', () => {
    const s = setup();
    const root = s.roots.get(ROOT)!;
    setWatched(root, [MAIN_LOOP, KID]);
    const r = buildReport(root, [], META);
    expect(r.session.backgroundItems).toEqual([{ id: 'sh1', kind: 'shell', state: 'running', startedAt: 500, startedKnown: true, label: 'npm' }]);
    expect(r.agents[0]!.backgroundItems).toEqual([{ id: 'sh2', kind: 'shell', state: 'running', startedAt: 600, startedKnown: true, label: 'make' }]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.session).toMatchObject({ backgroundOutput: false });
  });

  it('carries only the watched loop’s shells', () => {
    const s = setup();
    const root = s.roots.get(ROOT)!;
    setWatched(root, [KID]);
    const r = buildReport(root, [], META);
    expect(r.session).not.toHaveProperty('backgroundItems');
    expect(r.agents[0]).toHaveProperty('backgroundItems');
  });

  it('carries the whole command and the output, redacted, only with the option and a viewer on the Background tab', () => {
    const s = setup();
    const root = s.roots.get(ROOT)!;
    root.sessions.get(ROOT)!.shells.get('sh1')!.output = `ready\nTOKEN=${SECRET}\n`;
    setWatched(root, [MAIN_LOOP]);
    expect(buildReport(root, [], { ...META, backgroundOutput: true }).session.backgroundItems![0]).not.toHaveProperty('command');
    setWatchedBackground(root, [MAIN_LOOP]);
    const item = buildReport(root, [], { ...META, backgroundOutput: true }).session.backgroundItems![0]!;
    expect(item.command).toBe('API_KEY=[redacted] npm run test:e2e');
    expect(item.output).toBe('ready\nTOKEN=[redacted]\n');
    // the option off: nothing, whatever the lease says
    expect(buildReport(root, [], { ...META, backgroundOutput: false }).session.backgroundItems![0]).not.toHaveProperty('command');
    // the lease lapsing forgets what the shell held
    setWatchedBackground(root, []);
    expect(root.sessions.get(ROOT)!.shells.get('sh1')!.output).toBeNull();
  });

  it('says an exited shell exited with its code, and one without a code as ended without one', () => {
    const s = setup();
    const root = s.roots.get(ROOT)!;
    apply(s, exited('sh1', 900, 2), 900);
    apply(s, created(ROOT, 'sh3', 'sleep 9', null, 700), 700);
    apply(s, exited('sh3', 901), 901);
    setWatched(root, [MAIN_LOOP]);
    const items = buildReport(root, [], META).session.backgroundItems!;
    expect(items.find((i) => i.id === 'sh1')).toMatchObject({ state: 'exited', exitCode: 2, endedAt: 900 });
    expect(items.find((i) => i.id === 'sh3')).toMatchObject({ state: 'exited' });
    expect(items.find((i) => i.id === 'sh3')).not.toHaveProperty('exitCode');
  });

  it('sends nothing with the feed off', () => {
    const s = setup();
    const root = s.roots.get(ROOT)!;
    setWatched(root, [MAIN_LOOP]);
    expect(buildReport(root, [], { ...META, activity: false }).session).not.toHaveProperty('backgroundItems');
  });
});

describe('Reporter: the shells follow the server, the person and the file', () => {
  function wired(env: Record<string, string>, reply: unknown) {
    const posts: Report[] = [];
    const fetch: FetchLike = async (_u, init) => {
      posts.push(JSON.parse(init.body!) as Report);
      return { status: 200, ok: true, text: JSON.stringify(reply) };
    };
    const r = new Reporter({ fetch, now: () => 10_000, runIn: () => async () => ({ exitCode: 1, stdout: '' }), log: () => undefined }, { ...optionsOf({}, null, { PODIUM_SERVER: 'http://podium.test', PODIUM_TOKEN: 'tok', ...env }), idleMs: 600_000 });
    return { r, posts };
  }
  const run = (r: Reporter, ...events: BusEvent[]) => {
    for (const e of events) r.handle(e);
  };

  it('reads the output file OpenCode named only while a viewer has the tab open and the option is on, and sends it redacted', async () => {
    const file = out('a.out', `line one\nTOKEN=${SECRET}\n`);
    utimesSync(file, 5, 5);
    const { r, posts } = wired({ PODIUM_ACTIVITY_FEED: 'true', PODIUM_BACKGROUND_OUTPUT: 'true' }, { watch: [MAIN_LOOP], watchBackground: [MAIN_LOOP] });
    run(r, ev('session.created', { sessionID: ROOT }, 1000), created(ROOT, 'sh1', 'npm run dev', file, 1001));
    await r.tick();
    expect(posts[0]!.session).toMatchObject({ backgroundOutput: true });
    expect(posts[0]!.session).not.toHaveProperty('backgroundItems'); // nobody watched yet
    await r.tick();
    const item = posts[posts.length - 1]!.session.backgroundItems![0]!;
    expect(item).toMatchObject({ id: 'sh1', label: 'npm', command: 'npm run dev', output: 'line one\nTOKEN=[redacted]\n', lastOutputAt: 5000 });
    expect(JSON.stringify(posts)).not.toContain(SECRET);
  });

  it('sends the list and the time of the last output, but reads no output, with the option off', async () => {
    const file = out('b.out', `secret TOKEN=${SECRET}`);
    utimesSync(file, 6, 6);
    const { r, posts } = wired({ PODIUM_ACTIVITY_FEED: 'true' }, { watch: [MAIN_LOOP], watchBackground: [MAIN_LOOP] });
    run(r, ev('session.created', { sessionID: ROOT }, 1000), created(ROOT, 'sh1', 'npm run dev', file, 1001));
    await r.tick();
    await r.tick();
    const item = posts[posts.length - 1]!.session.backgroundItems![0]!;
    expect(item).toMatchObject({ id: 'sh1', label: 'npm', lastOutputAt: 6000 });
    expect(item).not.toHaveProperty('output');
    expect(item).not.toHaveProperty('command');
    expect(JSON.stringify(posts)).not.toContain(SECRET);
  });

  it('sends nothing and reads nothing while the person has not turned the feed on', async () => {
    const file = out('c.out', 'x');
    const { r, posts } = wired({}, { watch: [MAIN_LOOP], watchBackground: [MAIN_LOOP] });
    run(r, ev('session.created', { sessionID: ROOT }, 1000), created(ROOT, 'sh1', 'npm run dev', file, 1001));
    await r.tick();
    await r.tick();
    expect(JSON.stringify(posts)).not.toContain('backgroundItems');
    expect(r.sessionIds()).toContain(ROOT);
  });

  it('never reads a file that is not a .out file, is a link, or is not absolute, and says nothing for a file that is gone', async () => {
    const real = out('real.txt', `TOKEN=${SECRET}`);
    const link = path.join(dir, 'link.out');
    symlinkSync(real, link);
    mkdirSync(path.join(dir, 'folder.out'));
    const { r, posts } = wired({ PODIUM_ACTIVITY_FEED: 'true', PODIUM_BACKGROUND_OUTPUT: 'true' }, { watch: [MAIN_LOOP], watchBackground: [MAIN_LOOP] });
    run(
      r,
      ev('session.created', { sessionID: ROOT }, 1000),
      created(ROOT, 'a', 'x', real, 1001),
      created(ROOT, 'b', 'x', link, 1002),
      created(ROOT, 'c', 'x', 'relative.out', 1003),
      created(ROOT, 'd', 'x', path.join(dir, 'gone.out'), 1004),
      created(ROOT, 'e', 'x', path.join(dir, 'folder.out'), 1005),
    );
    await r.tick();
    await r.tick();
    const items = posts[posts.length - 1]!.session.backgroundItems!;
    expect(items).toHaveLength(5);
    for (const i of items) expect(i).not.toHaveProperty('output');
    expect(JSON.stringify(posts)).not.toContain(SECRET);
  });

  it('sends a shell’s exit, and reads its output once more after it, then leaves it alone', async () => {
    const file = out('d.out', 'first\n');
    const { r, posts } = wired({ PODIUM_ACTIVITY_FEED: 'true', PODIUM_BACKGROUND_OUTPUT: 'true' }, { watch: [MAIN_LOOP], watchBackground: [MAIN_LOOP] });
    run(r, ev('session.created', { sessionID: ROOT }, 1000), created(ROOT, 'sh1', 'make', file, 1001));
    await r.tick();
    await r.tick();
    writeFileSync(file, 'first\nlast\n');
    run(r, exited('sh1', 2000, 0));
    await r.tick();
    const item = posts[posts.length - 1]!.session.backgroundItems![0]!;
    expect(item).toMatchObject({ state: 'exited', exitCode: 0, output: 'first\nlast\n' });
    writeFileSync(file, 'changed after settling\n');
    await r.tick();
    expect(posts[posts.length - 1]!.session.backgroundItems![0]!.output).toBe('first\nlast\n');
  });
});
