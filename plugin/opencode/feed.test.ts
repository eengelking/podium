// The activity feed, command output, full prompts and session recording of the OpenCode reporter (#969): what is captured, and that
// nothing is captured or sent while the person's consent is off. The wire shapes are the Claude Code reporter's.
import { describe, expect, it } from 'vitest';
import { MAIN_LOOP, type RecordingBatch, type RecordingGrant, type Report } from '../core/protocol.ts';
import type { FetchLike } from '../core/transport.ts';
import { optionsOf } from './options.ts';
import { buildReport } from './report.ts';
import { Reporter } from './reporter.ts';
import { apply, EVENT_TYPES, newStore, setWatched, setWatchedOutput, type BusEvent } from './state.ts';
import { VERSION } from './version.ts';
import { entryFor, finishedEntry } from './activity.ts';
import { decisionRecord } from './answer.ts';
import { limitLine, refusedLine, startLine, stoppedLine } from './recordingLines.ts';

let n = 0;
const ev = (type: string, data: Record<string, unknown>, created: number): BusEvent => ({ id: `f${++n}`, created, type, data, location: { directory: '/work/project' } });
const ROOT = 'ses_root';
const KID = 'ses_kid';
const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
const META = { now: 9, version: VERSION, engineVersion: null, hostSurface: null };

const call = (sid: string, id: string, name: string, input: Record<string, unknown>, at: number) => [
  ev('session.tool.input.started', { sessionID: sid, id, name }, at),
  ev('session.tool.called', { sessionID: sid, id, name, input }, at + 1),
];
const ok = (sid: string, id: string, text: string, at: number) => ev('session.tool.success', { sessionID: sid, id, content: [{ type: 'text', text }] }, at);
const bad = (sid: string, id: string, message: string, at: number) => ev('session.tool.failed', { sessionID: sid, id, error: { message } }, at);

function store(...events: BusEvent[]) {
  const s = newStore();
  for (const e of events) apply(s, e, e.created ?? 0);
  return s;
}
const feedOf = (s: ReturnType<typeof store>, sid = ROOT) => s.roots.get(ROOT)!.sessions.get(sid)!.activity;

describe('activity feed: what is kept', () => {
  const begin = [ev('session.created', { sessionID: ROOT }, 1), ...call(ROOT, 'c1', 'bash', { command: `ls -la # ${SECRET}` }, 2)];

  it('keeps nothing for a loop nobody watches', () => {
    const s = store(...begin, ok(ROOT, 'c1', 'total 0', 5));
    expect(feedOf(s)).toEqual([]);
  });

  it('keeps a tool call as the Claude Code reporter words it, with a shell command in full and redacted', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1));
    setWatched(s.roots.get(ROOT)!, [MAIN_LOOP]);
    for (const e of [...begin.slice(1), ...call(ROOT, 'c2', 'read', { filePath: '/work/project/a.ts' }, 6), ...call(ROOT, 'c3', 'grep', { pattern: 'foo', path: 'src' }, 8), ...call(ROOT, 'c4', 'task', { description: 'look around' }, 10), ...call(ROOT, 'c5', 'webfetch', { url: 'https://example.com' }, 12), ...call(ROOT, 'c6', 'skill', { name: 'review' }, 14)]) apply(s, e, e.created ?? 0);
    const feed = feedOf(s);
    expect(feed.map((e) => e.text)).toEqual(['Bash ls -la # [redacted]', 'Read /work/project/a.ts', 'Grep "foo" in src', 'Agent look around', 'WebFetch https://example.com', 'Skill review']);
    expect(feed[0]).toMatchObject({ kind: 'tool', id: 'c1', command: 'ls -la # [redacted]' });
    expect(feed[1]).not.toHaveProperty('command');
    expect(JSON.stringify(feed)).not.toContain(SECRET);
  });

  it('adds how a shell call ended to its entry, and its output only while a viewer has the feed open', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1));
    const root = s.roots.get(ROOT)!;
    setWatched(root, [MAIN_LOOP]);
    for (const e of begin.slice(1)) apply(s, e, e.created ?? 0);
    apply(s, ok(ROOT, 'c1', `line one\n\x1b[31mred\x1b[0m ${SECRET}`, 5), 5);
    expect(feedOf(s)[0]).toMatchObject({ done: true });
    expect(feedOf(s)[0]).not.toHaveProperty('output');
    // A second call, now with the output lease.
    setWatchedOutput(root, [MAIN_LOOP]);
    for (const e of call(ROOT, 'c2', 'bash', { command: 'make' }, 6)) apply(s, e, e.created ?? 0);
    apply(s, ok(ROOT, 'c2', `built\n\x1b[31mred\x1b[0m ${SECRET}`, 8), 8);
    expect(feedOf(s)[1]).toMatchObject({ done: true, output: 'built\nred [redacted]' });
    expect(feedOf(s)[1]).not.toHaveProperty('failed');
  });

  it('marks a failed call with the exit code its text states, and keeps what it printed as the output', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1));
    const root = s.roots.get(ROOT)!;
    setWatched(root, [MAIN_LOOP]);
    setWatchedOutput(root, [MAIN_LOOP]);
    for (const e of [...call(ROOT, 'c1', 'bash', { command: 'false' }, 2), bad(ROOT, 'c1', 'command exited with code 3: boom', 5), ...call(ROOT, 'c2', 'bash', { command: 'nope' }, 6), ev('session.tool.failed', { sessionID: ROOT, id: 'c2', content: [{ type: 'text', text: 'not found' }] }, 8)]) apply(s, e, e.created ?? 0);
    expect(feedOf(s)[0]).toMatchObject({ done: true, failed: true, exitCode: 3, output: 'command exited with code 3: boom' });
    expect(feedOf(s)[1]).toMatchObject({ done: true, failed: true, output: 'not found' });
    expect(feedOf(s)[1]).not.toHaveProperty('exitCode');
  });

  it('leaves the output out when the call printed nothing to read', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1));
    const root = s.roots.get(ROOT)!;
    setWatched(root, [MAIN_LOOP]);
    setWatchedOutput(root, [MAIN_LOOP]);
    for (const e of [...call(ROOT, 'c1', 'bash', { command: 'true' }, 2), ev('session.tool.success', { sessionID: ROOT, id: 'c1' }, 5)]) apply(s, e, e.created ?? 0);
    expect(feedOf(s)[0]).toMatchObject({ done: true });
    expect(feedOf(s)[0]).not.toHaveProperty('output');
  });

  it('keeps the text a step wrote, and only the last twenty entries', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1));
    setWatched(s.roots.get(ROOT)!, [MAIN_LOOP]);
    apply(s, ev('session.text.ended', { sessionID: ROOT, text: `I will   run it ${SECRET}` }, 2), 2);
    expect(feedOf(s)).toEqual([{ at: 2, kind: 'text', text: 'I will run it [redacted]' }]);
    apply(s, ev('session.text.ended', { sessionID: ROOT, text: '   ' }, 3), 3);
    expect(feedOf(s)).toHaveLength(1);
    for (let i = 0; i < 25; i++) apply(s, ev('session.text.ended', { sessionID: ROOT, text: `step ${i}` }, 10 + i), 10 + i);
    expect(feedOf(s)).toHaveLength(20);
    expect(feedOf(s).at(-1)!.text).toBe('step 24');
  });

  it('keys a subagent by its session id, apart from the orchestrator', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1), ev('session.created', { sessionID: KID, parentID: ROOT }, 2));
    setWatched(s.roots.get(ROOT)!, [KID]);
    for (const e of [...call(ROOT, 'c1', 'bash', { command: 'a' }, 3), ...call(KID, 'k1', 'bash', { command: 'b' }, 5)]) apply(s, e, e.created ?? 0);
    expect(feedOf(s)).toEqual([]);
    expect(feedOf(s, KID).map((e) => e.text)).toEqual(['Bash b']);
  });

  it('forgets a loop that is no longer watched, and the output of one that lost its lease', () => {
    const s = store(ev('session.created', { sessionID: ROOT }, 1), ev('session.created', { sessionID: KID, parentID: ROOT }, 2));
    const root = s.roots.get(ROOT)!;
    setWatched(root, [MAIN_LOOP, KID]);
    setWatchedOutput(root, [MAIN_LOOP, KID]);
    for (const e of [...call(ROOT, 'c1', 'bash', { command: 'a' }, 3), ok(ROOT, 'c1', 'out-a', 4), ...call(KID, 'k1', 'bash', { command: 'b' }, 5), ok(KID, 'k1', 'out-b', 6)]) apply(s, e, e.created ?? 0);
    expect(feedOf(s)[0]!.output).toBe('out-a');
    setWatched(root, [MAIN_LOOP, KID]); // unchanged: nothing is touched
    expect(feedOf(s)[0]!.output).toBe('out-a');
    setWatchedOutput(root, [KID]);
    expect(feedOf(s)[0]).not.toHaveProperty('output');
    expect(feedOf(s)[0]).toMatchObject({ done: true, command: 'a' });
    expect(feedOf(s, KID)[0]!.output).toBe('out-b');
    setWatched(root, [MAIN_LOOP]);
    expect(feedOf(s, KID)).toEqual([]);
    expect(root.watchedOutput).toEqual([]); // a loop that is not watched has no output lease
    expect(feedOf(s)).toHaveLength(1);
  });
});

describe('activity feed: what a report carries', () => {
  function watched(over: { feed?: boolean; output?: boolean } = {}) {
    const s = store(ev('session.created', { sessionID: ROOT }, 1), ev('session.created', { sessionID: KID, parentID: ROOT }, 2));
    const root = s.roots.get(ROOT)!;
    setWatched(root, [MAIN_LOOP, KID]);
    setWatchedOutput(root, [MAIN_LOOP, KID]);
    for (const e of [...call(ROOT, 'c1', 'bash', { command: 'ls' }, 3), ok(ROOT, 'c1', 'files', 4), ...call(KID, 'k1', 'bash', { command: 'pwd' }, 5), ok(KID, 'k1', '/work', 6)]) apply(s, e, e.created ?? 0);
    return { root, meta: { ...META, activity: over.feed ?? true, activityOutput: over.output ?? true } };
  }

  it('sends the orchestrator feed and each agent feed with the output when both options are on, and says so', () => {
    const { root, meta } = watched();
    const r = buildReport(root, [], meta);
    expect(r.session).toMatchObject({ activityFeed: true, activityOutput: true });
    expect(r.session.activity).toEqual([{ at: 4, kind: 'tool', text: 'Bash ls', id: 'c1', command: 'ls', output: 'files', done: true }].map((e) => ({ ...e, at: 4 })));
    expect(r.agents[0]!.activity![0]).toMatchObject({ text: 'Bash pwd', output: '/work', done: true });
  });

  it('holds the output back when the activityOutput option is off, though the entry has it', () => {
    const { root, meta } = watched({ output: false });
    const r = buildReport(root, [], meta);
    expect(r.session).toMatchObject({ activityFeed: true, activityOutput: false });
    expect(r.session.activity![0]).not.toHaveProperty('output');
    expect(r.session.activity![0]).toMatchObject({ command: 'ls', done: true });
  });

  it('sends no feed at all, and says the option is off, while the activityFeed option is off', () => {
    const { root, meta } = watched({ feed: false, output: false });
    const r = buildReport(root, [], meta);
    expect(r.session).toMatchObject({ activityFeed: false, activityOutput: false });
    expect(r.session).not.toHaveProperty('activity');
    expect(r.agents[0]).not.toHaveProperty('activity');
  });
});

describe('Reporter: the feed follows the server and the person', () => {
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

  it('starts keeping the feed once a reply lists the loop, and sends it, output included, on the next report', async () => {
    const { r, posts } = wired({ PODIUM_ACTIVITY_FEED: 'true', PODIUM_ACTIVITY_OUTPUT: 'true' }, { watch: [MAIN_LOOP], watchOutput: [MAIN_LOOP] });
    run(r, ev('session.created', { sessionID: ROOT }, 1000), ...call(ROOT, 'c0', 'bash', { command: 'before' }, 1001));
    await r.tick();
    expect(posts[0]!.session).toMatchObject({ activityFeed: true, activityOutput: true });
    expect(posts[0]!.session).not.toHaveProperty('activity'); // nobody watched yet
    run(r, ...call(ROOT, 'c1', 'bash', { command: 'make' }, 2000), ok(ROOT, 'c1', 'built', 2003));
    await r.tick();
    expect(posts[1]!.session.activity).toMatchObject([{ text: 'Bash make', command: 'make', output: 'built', done: true }]);
  });

  it('ignores the server watch list and keeps and sends nothing while the person has not turned the feed on', async () => {
    const { r, posts } = wired({}, { watch: [MAIN_LOOP], watchOutput: [MAIN_LOOP] });
    run(r, ev('session.created', { sessionID: ROOT }, 1000));
    await r.tick();
    run(r, ...call(ROOT, 'c1', 'bash', { command: 'make' }, 2000), ok(ROOT, 'c1', 'built', 2003), ev('session.text.ended', { sessionID: ROOT, text: 'said' }, 2004));
    await r.tick();
    expect(posts[1]!.session).toMatchObject({ activityFeed: false, activityOutput: false });
    expect(posts[1]!.session).not.toHaveProperty('activity');
    expect(r.store.roots.get(ROOT)!.sessions.get(ROOT)!.activity).toEqual([]);
  });

  it('keeps the commands but no output when the activityOutput option is off', async () => {
    const { r, posts } = wired({ PODIUM_ACTIVITY_FEED: 'true' }, { watch: [MAIN_LOOP], watchOutput: [MAIN_LOOP] });
    run(r, ev('session.created', { sessionID: ROOT }, 1000));
    await r.tick();
    run(r, ...call(ROOT, 'c1', 'bash', { command: 'make' }, 2000), ok(ROOT, 'c1', 'built', 2003));
    await r.tick();
    expect(posts[1]!.session.activity).toMatchObject([{ command: 'make', done: true }]);
    expect(JSON.stringify(posts[1])).not.toContain('built');
  });

  it('does not take an output lease for a loop that is not also watched', async () => {
    const { r } = wired({ PODIUM_ACTIVITY_FEED: 'true', PODIUM_ACTIVITY_OUTPUT: 'true' }, { watch: [], watchOutput: [MAIN_LOOP] });
    run(r, ev('session.created', { sessionID: ROOT }, 1000));
    await r.tick();
    expect(r.store.roots.get(ROOT)!.watchedOutput).toEqual([]);
  });
});

describe('full prompts', () => {
  const prompt = (sid: string, text: string, at: number) => ev('session.inbox.enqueued', { sessionID: sid, item: { payload: { text } } }, at);
  const lines = [ev('session.created', { sessionID: ROOT }, 1), ev('session.created', { sessionID: KID, parentID: ROOT }, 2), prompt(KID, `Find the bug\nin parser.ts ${SECRET}`, 3), ev('session.text.ended', { sessionID: KID, text: `Found it.\nIt is on line 4. ${SECRET}` }, 4)];

  it('puts an agent whole prompt and answer, redacted, in the report when the fullText option is on', () => {
    const s = store(...lines);
    const a = buildReport(s.roots.get(ROOT)!, [], { ...META, fullText: true }).agents[0]!;
    expect(a.promptText).toBe('Find the bug\nin parser.ts [redacted]');
    expect(a.answerText).toBe('Found it.\nIt is on line 4. [redacted]');
  });

  it('sends neither while the option is off', () => {
    const a = buildReport(store(...lines).roots.get(ROOT)!, [], META).agents[0]!;
    expect(a).not.toHaveProperty('promptText');
    expect(a).not.toHaveProperty('answerText');
  });

  it('sends each text once: after an accepted report it is left out, and a newer answer goes out again', async () => {
    const posts: Report[] = [];
    const fetch: FetchLike = async (_u, init) => {
      posts.push(JSON.parse(init.body!) as Report);
      return { status: 200, ok: true, text: '{}' };
    };
    let at = 10_000;
    const r = new Reporter({ fetch, now: () => at, runIn: () => async () => ({ exitCode: 1, stdout: '' }), log: () => undefined }, { ...optionsOf({}, null, { PODIUM_SERVER: 'http://podium.test', PODIUM_TOKEN: 'tok', PODIUM_FULL_PROMPTS: 'true' }), idleMs: 600_000 });
    for (const e of lines) r.handle(e);
    await r.tick();
    expect(posts[0]!.agents[0]).toMatchObject({ promptText: 'Find the bug\nin parser.ts [redacted]', answerText: 'Found it.\nIt is on line 4. [redacted]' });
    r.handle(ev('session.text.ended', { sessionID: KID, text: 'Second answer' }, 5));
    at += 100;
    await r.tick();
    expect(posts[1]!.agents[0]).not.toHaveProperty('promptText');
    expect(posts[1]!.agents[0]).toMatchObject({ answerText: 'Second answer' });
    at += 100;
    r.handle(ev('session.tool.success', { sessionID: ROOT, id: 'x' }, 6));
    await r.tick();
    expect(posts[2]!.agents[0]).not.toHaveProperty('answerText');
  });

  it('never sends a full text from a Reporter whose person has not allowed it', async () => {
    const bodies: string[] = [];
    const fetch: FetchLike = async (_u, init) => {
      bodies.push(init.body!);
      return { status: 200, ok: true, text: '{}' };
    };
    const r = new Reporter({ fetch, now: () => 10_000, runIn: () => async () => ({ exitCode: 1, stdout: '' }), log: () => undefined }, { ...optionsOf({}, null, { PODIUM_SERVER: 'http://podium.test', PODIUM_TOKEN: 'tok' }), idleMs: 600_000 });
    for (const e of lines) r.handle(e);
    await r.tick();
    expect(bodies[0]).not.toContain('promptText');
    expect(bodies[0]).not.toContain('answerText');
  });
});

describe('session recording', () => {
  const GRANT: RecordingGrant = { state: 'recording', consent: { admin: true, chosen: true, owner: true }, loops: [MAIN_LOOP, KID], limit: null, startedBy: 'Maya', startedAt: 1, stoppedBy: null, stoppedAt: null, keptUntil: null, bytes: 0 };
  const prompt = (sid: string, text: string, at: number) => ev('session.inbox.enqueued', { sessionID: sid, item: { payload: { text } } }, at);

  function wired(env: Record<string, string>, grant: RecordingGrant | null = GRANT, recordingStatus = 200) {
    const reports: Report[] = [];
    const batches: { url: string; body: RecordingBatch }[] = [];
    const notices: string[] = [];
    let at = 10_000;
    const fetch: FetchLike = async (url, init) => {
      if (url.endsWith('/recording')) {
        batches.push({ url, body: JSON.parse(init.body!) });
        return { status: recordingStatus, ok: recordingStatus < 300, text: JSON.stringify({ recording: grant }) };
      }
      reports.push(JSON.parse(init.body!) as Report);
      return { status: 200, ok: true, text: JSON.stringify({ recording: grant }) };
    };
    const r = new Reporter({ fetch, now: () => at, runIn: () => async () => ({ exitCode: 1, stdout: '' }), log: () => undefined, notify: (line) => notices.push(line) }, { ...optionsOf({}, null, { PODIUM_SERVER: 'http://podium.test', PODIUM_TOKEN: 'tok', ...env }), idleMs: 600_000 });
    return { r, reports, batches, notices, advance: (ms: number) => (at += ms) };
  }

  it('records the prompt, the text, the thinking, the call and its result, redacted, once the server grants it', async () => {
    const { r, batches, reports, notices, advance } = wired({ PODIUM_SESSION_RECORDING: 'true' });
    r.handle(ev('session.created', { sessionID: ROOT }, 1000));
    r.handle(prompt(ROOT, 'before the grant', 1001));
    await r.tick();
    expect(reports[0]!.session.sessionRecording).toBe(true);
    expect(batches).toEqual([]); // the grant came with the first reply; nothing was captured before it
    expect(notices.join('\n')).toContain('This session is being recorded by Maya');
    r.handle(prompt(ROOT, `Fix it ${SECRET}`, 2000));
    r.handle(ev('session.reasoning.ended', { sessionID: ROOT }, 2001));
    for (const e of call(ROOT, 'c1', 'bash', { command: 'make' }, 2002)) r.handle(e);
    r.handle(ok(ROOT, 'c1', 'built', 2004));
    r.handle(ev('session.text.ended', { sessionID: ROOT, text: 'All done' }, 2005));
    advance(6000);
    await r.tick();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.url).toContain(`/${ROOT}/recording`);
    const entries = batches[0]!.body.entries;
    expect(entries.map((e) => [e.loop, e.seq, e.kind, e.name])).toEqual([[MAIN_LOOP, 1, 'prompt', undefined], [MAIN_LOOP, 2, 'thinking', undefined], [MAIN_LOOP, 3, 'tool', 'Bash'], [MAIN_LOOP, 4, 'result', 'Bash'], [MAIN_LOOP, 5, 'text', undefined]]);
    expect(entries[0]!.text).toBe('Fix it [redacted]');
    expect(entries[3]).toMatchObject({ text: 'built', callSeq: 3 });
    expect(JSON.stringify(batches)).not.toContain(SECRET);
  });

  it('records a failed result as failed, a subagent in its own loop, and a compaction with who ran it', async () => {
    const { r, batches, advance } = wired({ PODIUM_SESSION_RECORDING: 'true' });
    r.handle(ev('session.created', { sessionID: ROOT }, 1000));
    await r.tick();
    r.handle(ev('session.created', { sessionID: KID, parentID: ROOT }, 2000));
    r.handle(prompt(KID, 'sub task', 2001));
    for (const e of call(KID, 'k1', 'read', { filePath: '/work/.env' }, 2002)) r.handle(e);
    r.handle(bad(KID, 'k1', 'denied', 2004));
    r.handle(ev('session.compaction.started', { sessionID: ROOT }, 2005));
    advance(6000);
    await r.tick();
    const entries = batches[0]!.body.entries;
    expect(entries.map((e) => [e.loop, e.kind, e.failed ?? false])).toEqual([[KID, 'prompt', false], [KID, 'tool', false], [KID, 'result', true], [MAIN_LOOP, 'compact', false]]);
    // The tool's input names a file on the never-send list: its path alone is kept.
    expect(entries[1]!.text).toBe('{"file_path":"/work/.env"}');
  });

  it('captures and sends nothing while the sessionRecording option is off, though the server says the session is chosen', async () => {
    const { r, batches, reports, notices, advance } = wired({}, { ...GRANT, consent: { admin: true, chosen: true, owner: false } });
    r.handle(ev('session.created', { sessionID: ROOT }, 1000));
    await r.tick();
    expect(reports[0]!.session.sessionRecording).toBe(false);
    r.handle(prompt(ROOT, 'secret plans', 2000));
    for (const e of call(ROOT, 'c1', 'bash', { command: 'make' }, 2002)) r.handle(e);
    r.handle(ok(ROOT, 'c1', 'built', 2004));
    r.handle(ev('session.text.ended', { sessionID: ROOT, text: 'said' }, 2005));
    r.handle(ev('session.compaction.started', { sessionID: ROOT }, 2006));
    advance(6000);
    await r.tick();
    expect(batches).toEqual([]);
    expect(notices.join('\n')).toContain('chose to record this session, but session recording is off here');
    expect(notices.filter((l) => l.includes('chose to record'))).toHaveLength(1); // told once
    expect(r.store.roots.get(ROOT)!.recorder.queued).toBe(0);
  });

  it('records nothing when the server sends no grant at all', async () => {
    const { r, batches, advance } = wired({ PODIUM_SESSION_RECORDING: 'true' }, null);
    r.handle(ev('session.created', { sessionID: ROOT }, 1000));
    await r.tick();
    r.handle(prompt(ROOT, 'hello', 2000));
    advance(6000);
    await r.tick();
    expect(batches).toEqual([]);
  });

  it('records nothing for a loop the grant does not list', async () => {
    const { r, batches, advance } = wired({ PODIUM_SESSION_RECORDING: 'true' }, { ...GRANT, loops: [KID] });
    r.handle(ev('session.created', { sessionID: ROOT }, 1000));
    await r.tick();
    r.handle(prompt(ROOT, 'hello', 2000));
    advance(6000);
    await r.tick();
    expect(batches).toEqual([]);
  });

  it('tells the owner when the recording is stopped, and stops capturing', async () => {
    const stopped: RecordingGrant = { ...GRANT, state: 'stopped', stoppedBy: 'Maya', stoppedAt: 5 };
    let grant: RecordingGrant = GRANT;
    const reports: number[] = [];
    const notices: string[] = [];
    const fetch: FetchLike = async (url) => {
      reports.push(1);
      return { status: 200, ok: true, text: JSON.stringify({ recording: url.endsWith('/recording') ? stopped : grant }) };
    };
    let at = 10_000;
    const r = new Reporter({ fetch, now: () => at, runIn: () => async () => ({ exitCode: 1, stdout: '' }), log: () => undefined, notify: (l) => notices.push(l) }, { ...optionsOf({}, null, { PODIUM_SERVER: 'http://podium.test', PODIUM_TOKEN: 'tok', PODIUM_SESSION_RECORDING: 'true' }), idleMs: 600_000 });
    r.handle(ev('session.created', { sessionID: ROOT }, 1000));
    await r.tick();
    r.handle(prompt(ROOT, 'hello', 2000));
    at += 6000;
    await r.tick();
    grant = stopped;
    at += 6000;
    r.handle(prompt(ROOT, 'after', 3000));
    await r.tick();
    expect(notices.some((l) => l.startsWith('Recording stopped by Maya'))).toBe(true);
    expect(r.store.roots.get(ROOT)!.recorder.capturing).toBe(false);
  });

  it('drops a batch the server will never take, and gives up the queue when it says no', async () => {
    const bad400 = wired({ PODIUM_SESSION_RECORDING: 'true' }, GRANT, 400);
    bad400.r.handle(ev('session.created', { sessionID: ROOT }, 1000));
    await bad400.r.tick();
    bad400.r.handle(prompt(ROOT, 'hello', 2000));
    bad400.advance(6000);
    await bad400.r.tick();
    expect(bad400.r.store.roots.get(ROOT)!.recorder.queued).toBe(0);
    const no403 = wired({ PODIUM_SESSION_RECORDING: 'true' }, GRANT, 403);
    no403.r.handle(ev('session.created', { sessionID: ROOT }, 1000));
    await no403.r.tick();
    no403.r.handle(prompt(ROOT, 'hello', 2000));
    no403.advance(6000);
    await no403.r.tick();
    expect(no403.r.store.roots.get(ROOT)!.recorder.capturing).toBe(false);
    const down = wired({ PODIUM_SESSION_RECORDING: 'true' }, GRANT, 500);
    down.r.handle(ev('session.created', { sessionID: ROOT }, 1000));
    await down.r.tick();
    down.r.handle(prompt(ROOT, 'hello', 2000));
    down.advance(6000);
    await down.r.tick();
    expect(down.r.store.roots.get(ROOT)!.recorder.queued).toBe(1); // kept for a retry
  });

  it('sends what is queued once more when the session ends', async () => {
    const { r, batches } = wired({ PODIUM_SESSION_RECORDING: 'true' });
    r.handle(ev('session.created', { sessionID: ROOT }, 1000));
    await r.tick();
    r.handle(prompt(ROOT, 'last words', 2000));
    await r.close();
    expect(batches.flatMap((b) => b.body.entries.map((e) => e.text))).toEqual(['last words']);
  });
});

describe('what the person is told about a recording', () => {
  const base: RecordingGrant = { state: 'recording', consent: { admin: true, chosen: true, owner: true }, loops: [], limit: null, startedBy: 'Maya', startedAt: Date.parse('2026-10-21T11:42:00'), stoppedBy: null, stoppedAt: null, keptUntil: Date.parse('2026-10-21T17:42:00'), bytes: 0 };
  const now = Date.parse('2026-10-21T12:00:00');

  it('says who started it, from when, and until when it is kept', () => {
    expect(startLine(base, now)).toContain('recorded by Maya, from 11:42.');
    expect(startLine(base, now)).toContain('deleted at 17:42 today.');
    expect(startLine({ ...base, startedBy: null, startedAt: null, keptUntil: null }, now)).toContain('recorded by Podium, from now.');
    expect(startLine({ ...base, startedBy: null, startedAt: null, keptUntil: null }, now)).toContain('deleted when its retention runs out.');
    expect(startLine({ ...base, startedAt: Date.parse('2026-10-20T09:05:00'), keptUntil: Date.parse('2026-10-22T09:05:00') }, now)).toContain('from 09:05 on 2026-10-20');
    expect(startLine({ ...base, keptUntil: Date.parse('2026-10-22T09:05:00') }, now)).toContain('at 09:05 on 2026-10-22');
  });

  it('says who stopped it and when', () => {
    expect(stoppedLine({ ...base, state: 'stopped', stoppedBy: 'Ed', stoppedAt: Date.parse('2026-10-21T11:50:00') }, now)).toBe('Recording stopped by Ed at 11:50. What was recorded until then is kept until 17:42 today.');
    expect(stoppedLine({ ...base, state: 'stopped', keptUntil: null }, now)).toBe('Recording stopped by Podium at an unknown time. What was recorded until then is kept until its retention runs out.');
  });

  it('says which limit stopped it', () => {
    expect(limitLine({ ...base, state: 'limit', limit: 'size', bytes: 50 * 1_048_576 })).toContain('its 50 MB limit');
    expect(limitLine({ ...base, state: 'limit', limit: 'budget' })).toContain("the server's disk budget");
  });

  it('says who chose it when the person has not allowed it', () => {
    expect(refusedLine(base)).toContain('Maya chose to record this session');
    expect(refusedLine({ ...base, startedBy: null })).toContain('Someone chose to record');
  });
});

describe('activity entries for OpenCode tools', () => {
  it('words a tool like the Claude Code reporter and keeps no id or command for a shell call without them', () => {
    expect(entryFor('patch', { filePath: '/a.ts' }, 'p1', 5)).toEqual({ at: 5, kind: 'tool', text: 'Edit /a.ts' });
    expect(entryFor('bash', {}, undefined, 5)).toEqual({ at: 5, kind: 'tool', text: 'Bash' });
    expect(entryFor('bash', { command: 'x'.repeat(30_000) }, 'b', 5)).toMatchObject({ commandCut: true, id: 'b' });
  });

  it('reads the names and arguments of OpenCode 2.2.5: the shell tool is shell, a file tool takes path, the skill tool takes id', () => {
    expect(entryFor('shell', { command: 'echo hi' }, 's1', 5)).toEqual({ at: 5, kind: 'tool', text: 'Bash echo hi', id: 's1', command: 'echo hi' });
    expect(entryFor('read', { path: '/a/b.ts' }, 'r1', 5).text).toBe('Read /a/b.ts');
    expect(entryFor('write', { path: '/a/c.ts', content: 'x' }, 'r1', 5).text).toBe('Write /a/c.ts');
    expect(entryFor('edit', { path: '/a/d.ts', oldString: 'a', newString: 'b' }, 'r1', 5).text).toBe('Edit /a/d.ts');
    expect(entryFor('apply_patch', { patchText: 'x' }, 'r1', 5).text).toBe('Edit');
    expect(entryFor('subagent', { agent: 'general', description: 'look around' }, 'r1', 5).text).toBe('Agent look around');
    expect(entryFor('skill', { id: 'hello' }, 'r1', 5).text).toBe('Skill hello');
    expect(entryFor('websearch', { query: 'cats' }, 'r1', 5).text).toBe('WebSearch cats');
    expect(entryFor('todowrite', { todos: [{ content: 'a', status: 'pending' }] }, 'r1', 5).text).toMatch(/^TodoWrite /);
    expect(entryFor('Glob', { pattern: '*.ts' }, 'r1', 5).text).toBe('Glob *.ts');
  });

  it('cuts a long output and says so, and keeps exit codes only for a failed call', () => {
    expect(finishedEntry(false, 'z'.repeat(30_000), true)).toMatchObject({ outputCut: true, done: true });
    expect(finishedEntry(false, 'exit code 4', true)).not.toHaveProperty('exitCode');
    expect(finishedEntry(true, 'exit code 4', false)).toEqual({ done: true, failed: true, exitCode: 4 });
  });

  it('subscribes to the end of reasoning, which the recording marks as thinking', () => {
    expect(EVENT_TYPES).toContain('session.reasoning.ended');
  });
});

describe('what a recording keeps of an answer', () => {
  const field = { key: 'q0', title: 'Pick', description: '', type: 'string', options: [{ value: 'A', label: 'A', description: '' }], custom: false };
  const ask = (over: Record<string, unknown>) => ({ id: 'a', kind: 'question', sessionId: ROOT, openedAt: 1, note: '', fields: [field], ...over }) as Parameters<typeof decisionRecord>[1];

  it('names a question by its title, or by the key when it has none, and keeps a multiple choice whole', () => {
    expect(decisionRecord({ id: 'd', askId: 'a', by: 'Ed', at: 1, kind: 'question', answers: [{ options: [0] }] }, ask({})).text).toBe('Pick: A');
    expect(decisionRecord({ id: 'd', askId: 'a', by: 'Ed', at: 1, kind: 'question', answers: [{ options: [0, 1] }] }, ask({ fields: [{ ...field, title: '', type: 'array', options: [...field.options, { value: 'B', label: 'B', description: '' }] }] })).text).toBe('q0: A, B');
    expect(decisionRecord({ id: 'd', askId: 'a', by: 'Ed', at: 1, kind: 'question' }, ask({})).text).toBe('');
  });
});
