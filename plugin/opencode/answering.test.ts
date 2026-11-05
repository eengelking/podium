import { describe, expect, it, vi } from 'vitest';
import type { Delivery, Report } from '../core/protocol.ts';
import type { FetchLike } from '../core/transport.ts';
import { formAnswer, framedMessage, permissionReply, podiumAsk } from './answer.ts';
import type { Host } from './answering.ts';
import { ATTACH_TTL_MS } from './bridge.ts';
import { makeHost, messageIdFor, promptVia, serviceOf, servicePath, type HostDeps } from './host.ts';
import { optionsOf } from './options.ts';
import { capabilities } from './report.ts';
import { Reporter } from './reporter.ts';
import { apply, formFields, newStore, type BusEvent, type FormField } from './state.ts';

let n = 0;
const ev = (type: string, data: Record<string, unknown>, created = 1): BusEvent => ({ id: `a${++n}`, created, type, data, location: { directory: '/work/project' } });

const ROOT = 'ses_root';
const KID = 'ses_kid';
const FORM = { id: 'frm_1', sessionID: ROOT, title: 'Questions', fields: [{ key: 'q0', title: 'Pick', description: 'Pick one?', type: 'string', options: [{ value: 'A', label: 'A', description: 'first' }, { value: 'B', label: 'B', description: 'second' }], custom: true }] };
const permission = (id = 'per_1', sessionID = ROOT) => ev('permission.asked', { id, sessionID, action: 'read', resources: ['secret.env'] });
const D = (d: Partial<Delivery>): Delivery => ({ id: 'd1', askId: null, by: 'Ed', at: 1, kind: 'message', ...d });

describe('answer: what Podium is shown and what OpenCode takes', () => {
  const store = () => {
    const s = newStore();
    apply(s, ev('session.created', { sessionID: ROOT }), 1);
    apply(s, ev('session.created', { sessionID: KID, parentID: ROOT }), 1);
    return s;
  };

  it('shows a permission as its action and resources, never cut for a short one', () => {
    const s = store();
    apply(s, permission(), 2);
    const root = s.roots.get(ROOT)!;
    expect(podiumAsk(root.asks.get('per_1')!, root)).toMatchObject({ id: 'per_1', kind: 'permission', agentId: null, tool: { name: 'read', input: { resources: ['secret.env'] }, cut: false } });
  });

  it('names the subagent a permission belongs to, and marks a resource list that did not fit as cut', () => {
    const s = store();
    apply(s, ev('permission.asked', { id: 'per_k', sessionID: KID, action: 'bash', resources: Array.from({ length: 25 }, (_, i) => `r${i}`) }), 2);
    const root = s.roots.get(ROOT)!;
    const a = podiumAsk(root.asks.get('per_k')!, root)!;
    expect(a.agentId).toBe(KID);
    expect(a.tool).toMatchObject({ cut: true });
    expect((a.tool!.input.resources as string[]).length).toBe(20);
  });

  it('marks a resource that is redacted or too long as cut, so Podium cannot allow what it did not see whole', () => {
    const s = store();
    apply(s, ev('permission.asked', { id: 'per_l', sessionID: ROOT, action: 'read', resources: ['x'.repeat(1500)] }), 2);
    const root = s.roots.get(ROOT)!;
    expect(podiumAsk(root.asks.get('per_l')!, root)!.tool!.cut).toBe(true);
  });

  it('shows a question form as questions with their options, and leaves one it cannot carry to the terminal', () => {
    const s = store();
    apply(s, ev('form.created', { form: FORM }), 2);
    const root = s.roots.get(ROOT)!;
    expect(podiumAsk(root.asks.get('frm_1')!, root)).toMatchObject({ kind: 'question', questions: [{ question: 'Pick one?', header: 'Pick', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }] });
    apply(s, ev('form.created', { form: { id: 'frm_none', sessionID: ROOT, title: 'x' } }), 3);
    expect(podiumAsk(root.asks.get('frm_none')!, root)).toBeNull();
    apply(s, ev('form.created', { form: { id: 'frm_many', sessionID: ROOT, fields: Array.from({ length: 5 }, (_, i) => ({ key: `q${i}`, title: `Q${i}` })) } }), 4);
    expect(podiumAsk(root.asks.get('frm_many')!, root)).toBeNull();
  });

  it('reads form fields, dropping what has no key', () => {
    expect(formFields('nope')).toEqual([]);
    expect(formFields([null, { title: 'no key' }, { key: 'k', options: [{ value: 'v' }, { label: 'no value' }, null] }])).toEqual([{ key: 'k', title: '', description: '', type: 'string', options: [{ value: 'v', label: 'v', description: '' }], custom: false }]);
  });

  it('replies once or reject to a permission and nothing else, never always', () => {
    expect(permissionReply('allow-once')).toBe('once');
    expect(permissionReply('deny')).toBe('reject');
    expect(permissionReply('reply')).toBe('reject');
    for (const k of ['question', 'plan-approve', 'plan-feedback', 'message', 'command'] as const) expect(permissionReply(k)).toBeNull();
  });

  const field = (over: Partial<FormField> = {}): FormField => ({ key: 'q0', title: 'T', description: '', type: 'string', options: [{ value: 'A', label: 'A', description: '' }, { value: 'B', label: 'B', description: '' }], custom: false, ...over });

  it('turns answers by position into the form answer by field key', () => {
    expect(formAnswer([field()], [{ options: [1] }])).toEqual({ q0: 'B' });
    expect(formAnswer([field({ custom: true })], [{ text: 'mine' }])).toEqual({ q0: 'mine' });
    expect(formAnswer([field({ type: 'array' })], [{ options: [0, 1] }])).toEqual({ q0: ['A', 'B'] });
    expect(formAnswer([field(), field({ key: 'q1' })], [null, { options: [0] }])).toEqual({ q1: 'A' });
  });

  it('refuses an answer that does not fit the form', () => {
    expect(formAnswer([field()], [{ options: [5] }])).toBeNull();
    expect(formAnswer([field()], [{ options: [] }])).toBeNull();
    expect(formAnswer([field()], [{ options: [0, 1] }])).toBeNull();
    expect(formAnswer([field()], [{ text: 'free' }])).toBeNull();
    expect(formAnswer([field()], [null])).toBeNull();
    expect(formAnswer([field({ options: Array.from({ length: 6 }, (_, i) => ({ value: `v${i}`, label: '', description: '' })) })], [{ options: [4] }])).toBeNull();
  });

  it('labels a message as coming through Podium', () => {
    const t = framedMessage({ by: 'Ed', text: 'hello' });
    expect(t).toContain('Ed');
    expect(t).toContain('via Podium');
    expect(t.endsWith('hello')).toBe(true);
    expect(framedMessage({ by: 'Ed' }).endsWith('\n\n')).toBe(true);
  });
});

describe('host: answering inside OpenCode', () => {
  const baseDeps = (over: Partial<HostDeps> = {}) => {
    const calls: string[] = [];
    const deps: HostDeps = {
      api: {
        permissionReply: async (i) => void calls.push(`reply ${i.requestID} ${i.reply}`),
        prompt: async (i) => void calls.push(`prompt ${i.sessionID} ${i.id} ${i.text}`),
        compact: async (i) => void calls.push(`compact ${i.sessionID} ${i.id}`),
      },
      emitAnswer: async (e) => void calls.push(`emit ${e.formID} ${JSON.stringify(e.answer)}`),
      tuiSeenAt: () => 0,
      isOpen: () => false,
      readService: () => null,
      hasService: () => false,
      fetch: async (url, init) => { calls.push(`${init.method} ${url} ${init.headers.Authorization} ${init.body}`); return { ok: true, status: 204 }; },
      now: () => 1_000_000,
      sleep: async () => undefined,
      ...over,
    };
    return { deps, calls, host: makeHost(deps) };
  };

  it('passes a permission reply, a prompt and a compaction through to OpenCode, each under an id OpenCode takes', async () => {
    const { host, calls } = baseDeps();
    await host.permissionReply('s', 'per_1', 'once');
    await host.prompt('s', 'dlv_d1', 'hi');
    await host.compact('s', 'dlv_d2');
    expect(calls[0]).toBe('reply per_1 once');
    expect(calls[1]).toMatch(/^prompt s msg_[0-9a-f]{12}[0-9A-Za-z]{14} hi$/);
    expect(calls[2]).toMatch(/^compact s msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });

  it('gives one delivery one message id, so a retry is the same message, and another delivery another', async () => {
    const { host, calls } = baseDeps();
    await host.prompt('s', 'dlv_d1', 'hi');
    await host.prompt('s', 'dlv_d1', 'hi');
    await host.prompt('s', 'dlv_d2', 'hi');
    const ids = calls.map((c) => c.split(' ')[2]);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('derives a message id that starts with msg_ from any delivery id, the same one each time, and forgets old ones', () => {
    const ids = new Map<string, string>();
    const a = messageIdFor('dlv_x', 1_700_000_000_000, ids);
    expect(a).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(messageIdFor('dlv_x', 1_800_000_000_000, ids)).toBe(a);
    expect(messageIdFor('', 1, new Map())).toMatch(/^msg_/);
    for (let i = 0; i < 300; i++) messageIdFor(`dlv_${i}`, 1, ids);
    expect(ids.size).toBeLessThanOrEqual(200);
  });

  it('submits a peer message under a message id too', async () => {
    const seen: string[] = [];
    const send = promptVia({ prompt: async (i) => void seen.push(`${i.sessionID} ${i.id} ${i.text}`), compact: async () => undefined, permissionReply: async () => undefined }, () => 5);
    await send('s', 'pd1', 'hello');
    expect(seen[0]).toMatch(/^s msg_[0-9a-f]{12}[0-9A-Za-z]{14} hello$/);
  });

  it('chooses the channel for a question: the TUI part while attached, else the local service, else none', () => {
    expect(baseDeps().host.formChannel()).toBeNull();
    expect(baseDeps({ hasService: () => true }).host.formChannel()).toBe('http');
    expect(baseDeps({ tuiSeenAt: () => 1_000_000 - 1000 }).host.formChannel()).toBe('tui');
    expect(baseDeps({ hasService: () => true, tuiSeenAt: () => 1_000_000 - ATTACH_TTL_MS - 1 }).host.formChannel()).toBe('http');
  });

  it('hands an answer to the TUI part and sees it land when the form closes', async () => {
    let open = true;
    const { host, calls } = baseDeps({ tuiSeenAt: () => 999_999, isOpen: () => open, sleep: async () => { open = false; } });
    await host.formReply('s', 'frm_1', { q0: 'B' });
    expect(calls).toEqual(['emit frm_1 {"q0":"B"}']);
  });

  it('fails when the TUI part does not answer in time', async () => {
    const { host } = baseDeps({ tuiSeenAt: () => 999_999, isOpen: () => true, tuiWaitMs: 200 });
    await expect(host.formReply('s', 'frm_1', { q0: 'B' })).rejects.toThrow(/TUI part/);
  });

  it('falls back to the local route when the TUI part does not answer', async () => {
    const { host, calls } = baseDeps({ tuiSeenAt: () => 999_999, isOpen: () => true, tuiWaitMs: 100, hasService: () => true, readService: () => JSON.stringify({ url: 'http://127.0.0.1:9', password: 'p' }) });
    await host.formReply('s', 'f', { q0: 'A' });
    expect(calls[0]).toMatch(/^emit f /);
    expect(calls[1]).toMatch(/^POST http:\/\/127\.0\.0\.1:9\/api\/session\/s\/form\/f\/reply/);
  });

  it('looks for the service file at most every 5 seconds', () => {
    let now = 0;
    let looks = 0;
    const { host } = baseDeps({ now: () => now, hasService: () => { looks++; return true; } });
    host.formChannel(); host.formChannel(); host.formChannel();
    expect(looks).toBe(1);
    now = 5000;
    host.formChannel();
    expect(looks).toBe(2);
  });

  it('accepts a form that closed just as the wait ran out', async () => {
    let calls = 0;
    const { host, calls: made } = baseDeps({ tuiSeenAt: () => 999_999, tuiWaitMs: 100, isOpen: () => ++calls < 2 });
    await expect(host.formReply('s', 'frm_1', { q0: 'B' })).resolves.toBeUndefined();
    expect(made).toEqual(['emit frm_1 {"q0":"B"}']);
  });

  it('answers through the local service route with Basic auth, reading the file only now', async () => {
    let reads = 0;
    const { host, calls } = baseDeps({ hasService: () => true, readService: () => { reads++; return JSON.stringify({ url: 'http://127.0.0.1:49374', password: 'pw' }); } });
    expect(reads).toBe(0);
    await host.formReply('ses 1', 'frm/1', { q0: 'B' });
    expect(reads).toBe(1);
    expect(calls[0]).toBe(`POST http://127.0.0.1:49374/api/session/ses%201/form/frm%2F1/reply Basic ${Buffer.from('opencode:pw').toString('base64')} {"answer":{"q0":"B"}}`);
  });

  it('fails when there is no service, or the route refuses', async () => {
    await expect(baseDeps().host.formReply('s', 'f', { q0: 'A' })).rejects.toThrow(/no local service/);
    const refused = baseDeps({ readService: () => JSON.stringify({ url: 'http://127.0.0.1:1', password: 'p' }), fetch: async () => ({ ok: false, status: 401 }) });
    await expect(refused.host.formReply('s', 'f', { q0: 'A' })).rejects.toThrow(/401/);
  });

  it('sends the password only to this machine', () => {
    expect(serviceOf(JSON.stringify({ url: 'http://127.0.0.1:1/', password: 'p' }))).toEqual({ url: 'http://127.0.0.1:1', password: 'p' });
    expect(serviceOf(JSON.stringify({ url: 'http://localhost:2', password: 'p' }))?.url).toBe('http://localhost:2');
    expect(serviceOf(JSON.stringify({ url: 'http://[::1]:3', password: 'p' }))?.url).toBe('http://[::1]:3');
    for (const bad of [{ url: 'http://evil.test', password: 'p' }, { url: 'https://127.0.0.1', password: 'p' }, { url: 'http://127.0.0.1', password: '' }, { url: 'nope', password: 'p' }, { url: 5, password: 'p' }]) expect(serviceOf(JSON.stringify(bad))).toBeNull();
    expect(serviceOf('not json')).toBeNull();
    expect(serviceOf(null)).toBeNull();
  });

  it('finds service.json under XDG_STATE_HOME or ~/.local/state', () => {
    expect(servicePath({}, '/home/me')).toBe('/home/me/.local/state/opencode/service.json');
    expect(servicePath({ XDG_STATE_HOME: '/state' }, '/home/me')).toBe('/state/opencode/service.json');
  });
});

describe('capabilities', () => {
  it('declares answering only when something can be answered, and /compact only with commands allowed', () => {
    expect(capabilities(null)).toMatchObject({ respond: false, commands: [] });
    expect(capabilities({ level: 'everything', accepts: [], limits: [] })).toMatchObject({ respond: false, commands: [] });
    expect(capabilities({ level: 'everything', accepts: ['permission', 'message'], limits: [] })).toMatchObject({ respond: true, commands: [] });
    expect(capabilities({ level: 'everything', accepts: ['permission', 'command'], limits: [] })).toMatchObject({ respond: true, commands: ['compact'] });
  });
});

// ---- the whole thing, against a fake Podium and a fake OpenCode ----

/** A Podium that takes reports, holds a request for an ask's answer until one is delivered, and records every other call. */
function podium(opts: { respond?: boolean; deliveries?: Delivery[]; recording?: unknown } = {}) {
  const reports: Report[] = [];
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {};
  /** Every delivery result in the order sent, as `<id> <result>`: `bodies` keeps only the last one per path. */
  const results: string[] = [];
  const held = new Map<string, (r: { status: number; text: string }) => void>();
  const queued = new Map<string, Delivery>();
  let respond = opts.respond ?? true;
  let handOver = opts.deliveries ?? [];
  const fetch: FetchLike = async (url, init) => {
    const path = url.replace('http://podium.test', '');
    if (path === '/api/fleet/report') {
      reports.push(JSON.parse(init.body!) as Report);
      const body = { respond, deliveries: handOver, ...(opts.recording ? { recording: opts.recording } : {}) };
      handOver = [];
      return { status: 200, ok: true, text: JSON.stringify(body) };
    }
    calls.push(`${init.method} ${path}`);
    if (init.body) bodies[`${init.method} ${path}`] = JSON.parse(init.body);
    if (init.body && path.endsWith('/result')) results.push(`${/deliveries\/([^/]+)\/result/.exec(path)![1]} ${(JSON.parse(init.body) as { result: string }).result}`);
    const m = /\/asks\/([^/]+)\/answer/.exec(path);
    if (init.method === 'GET' && m) {
      const id = decodeURIComponent(m[1]!);
      const q = queued.get(id);
      if (q) {
        queued.delete(id);
        return { status: 200, ok: true, text: JSON.stringify({ delivery: q }) };
      }
      return new Promise((resolve) => held.set(id, (r) => resolve({ ...r, ok: r.status < 300 })));
    }
    // A recording batch's reply carries the grant again, as the server's does.
    if (path.endsWith('/recording')) return { status: 200, ok: true, text: JSON.stringify({ recording: opts.recording }) };
    return { status: 200, ok: true, text: '{}' };
  };
  return {
    fetch, reports, calls, bodies, results,
    answer(askId: string, d: Partial<Delivery>) {
      const delivery = D({ askId, ...d });
      const h = held.get(askId);
      if (h) {
        held.delete(askId);
        h({ status: 200, text: JSON.stringify({ delivery }) });
      } else queued.set(askId, delivery);
    },
    /** The ask closed: the held request ends with nothing for it. */
    releaseAll() {
      for (const [id, h] of [...held]) { held.delete(id); h({ status: 204, text: '' }); }
    },
    setRespond: (v: boolean) => { respond = v; },
    handOver: (d: Delivery[]) => { handOver = d; },
  };
}

function fakeHost(over: Partial<Host> = {}) {
  const calls: string[] = [];
  const host: Host = {
    permissionReply: async (s, r, reply, message) => void calls.push(`permission ${s} ${r} ${reply}${message === undefined ? '' : ` ${message}`}`),
    formChannel: () => 'tui',
    formReply: async (s, f, a) => void calls.push(`form ${s} ${f} ${JSON.stringify(a)}`),
    prompt: async (s, id, text) => void calls.push(`prompt ${s} ${id} ${text.split('\n').pop()}`),
    compact: async (s, id) => void calls.push(`compact ${s} ${id}`),
    ...over,
  };
  return { host, calls };
}

function rig(host: Host, respond = true, activityFeed = true, server = podium(), answerMs?: number, env: Record<string, string> = {}, log: (line: string) => void = () => undefined) {
  const t = { now: 10_000 };
  const options = optionsOf({}, null, { PODIUM_SERVER: 'http://podium.test', PODIUM_TOKEN: 'tok', PODIUM_RESPOND: 'everything', ...env });
  const r = new Reporter(
    { fetch: server.fetch, now: () => t.now, runIn: () => async () => ({ exitCode: 1, stdout: '' }), log, answering: { host, consent: { respond, activityFeed, level: options.respondLevel }, sleep: async () => true, answerMs } },
    { ...options, idleMs: 600_000 },
  );
  r.handle(ev('session.created', { sessionID: ROOT, version: '2.2.5' }, 10_000));
  return { r, t, server };
}

const last = (s: ReturnType<typeof podium>): Report => s.reports[s.reports.length - 1]!;

describe('respond while answering is off (#1011)', () => {
  it('sends level off from a reporter built the way index.ts builds one with answering off: no Answering at all', async () => {
    const server = podium();
    const options = optionsOf({}, null, { PODIUM_SERVER: 'http://podium.test', PODIUM_TOKEN: 'tok' });
    expect(options.consent.respond).toBe(false);
    const r = new Reporter({ fetch: server.fetch, now: () => 10_000, runIn: () => async () => ({ exitCode: 1, stdout: '' }), log: () => undefined }, { ...options, idleMs: 600_000 });
    r.handle(ev('session.created', { sessionID: ROOT, version: '2.2.5' }, 10_000));
    await r.tick();
    expect(last(server).session.respond).toEqual({ level: 'off', accepts: [], limits: [] });
    expect(last(server).capabilities).toMatchObject({ respond: false, commands: [] });
    expect(server.calls).toEqual([]);
  });

  it('still sends respond with level off, so the console says "Turned off" and not "Reporter can\'t answer"', async () => {
    const { host } = fakeHost();
    const { r, server } = rig(host, false, true, podium(), undefined, { PODIUM_RESPOND: '' });
    await r.tick();
    expect(last(server).session.respond).toEqual({ level: 'off', accepts: [], limits: [] });
    expect(last(server).asks ?? []).toEqual([]);
  });
});

describe('respond levels (#969)', () => {
  const kinds = (level: string) => {
    const { host, calls } = fakeHost();
    const { r, t, server } = rig(host, true, true, podium(), undefined, { PODIUM_RESPOND: level });
    return { r, t, server, calls };
  };

  it('reads the level from the person\'s settings: a plain true is questions, and a project cannot raise it', () => {
    expect(optionsOf({}, null, { PODIUM_RESPOND: 'true' }).respondLevel).toBe('questions');
    expect(optionsOf({}, null, {}, 'PODIUM_RESPOND=questions-and-plans').respondLevel).toBe('questions-and-plans');
    expect(optionsOf({ respond: 'everything', respondLevel: 'everything' }, null, {}).respondLevel).toBe('off');
  });

  it.each([
    ['questions', ['question', 'message']],
    ['questions-and-plans', ['question', 'message']],
    ['everything', ['question', 'message', 'permission', 'command']],
  ])('level %s declares what it takes, and plan approval is never among it', async (level, accepts) => {
    const { r, server } = kinds(level);
    await r.tick();
    expect(last(server).session.respond).toEqual({ level, accepts, limits: ['no-reply-in-place'] });
    expect(last(server).capabilities).toMatchObject({ respond: true, commands: accepts.includes('command') ? ['compact'] : [] });
  });

  it.each(['questions', 'questions-and-plans'])('level %s does not announce or answer a permission, but does a question', async (level) => {
    const { r, t, server, calls } = kinds(level);
    r.handle(permission());
    r.handle(ev('form.created', { form: FORM }));
    await r.tick();
    await vi.waitFor(() => expect(server.calls).toContain('PUT /api/fleet/sessions/ses_root/asks/frm_1'));
    expect(server.calls.some((c) => c.includes('per_1'))).toBe(false);
    t.now += 6000;
    await r.tick();
    expect(last(server).session.asks!.map((a) => a.id)).toEqual(['frm_1']);
    server.answer('frm_1', { id: 'dq', kind: 'question', answers: [{ options: [0] }] });
    await vi.waitFor(() => expect(calls).toEqual(['form ses_root frm_1 {"q0":"A"}']));
    expect(calls.some((c) => c.startsWith('permission'))).toBe(false);
  });

  it('a permission delivery at a lower level is never replied to, even if the server hands one over', async () => {
    const { r, server, calls } = kinds('questions');
    r.handle(permission());
    server.handOver([D({ id: 'dp', askId: 'per_1', kind: 'allow-once' })]);
    await r.tick();
    await r.tick();
    expect(calls).toEqual([]);
  });

  it('a message is taken at every level above off, and /compact only at everything', async () => {
    for (const level of ['questions', 'questions-and-plans', 'everything']) {
      const { host, calls } = fakeHost();
      const { r, server } = rig(host, true, true, podium({ deliveries: [D({ id: 'm1', kind: 'message', text: 'hello' }), D({ id: 'c1', kind: 'command', command: 'compact' })] }), undefined, { PODIUM_RESPOND: level });
      await r.tick();
      await r.tick();
      expect(calls.some((c) => c.startsWith('prompt'))).toBe(true);
      expect(calls.filter((c) => c.startsWith('compact')).length).toBe(level === 'everything' ? 1 : 0);
      expect(server.bodies['POST /api/fleet/sessions/ses_root/deliveries/c1/result']).toMatchObject({ result: level === 'everything' ? 'took' : 'refused' });
    }
  });

  it('level off says so and takes nothing', async () => {
    const { host, calls } = fakeHost();
    const { r, server } = rig(host, false, true, podium({ deliveries: [D({ id: 'm1', kind: 'message', text: 'hello' })] }), undefined, { PODIUM_RESPOND: 'off' });
    r.handle(permission());
    await r.tick();
    await r.tick();
    expect(last(server).session.respond).toEqual({ level: 'off', accepts: [], limits: [] });
    expect(calls).toEqual([]);
  });
});

describe('Reporter answering (#858)', () => {
  it('says answering is off until the person allowed it, and never waits for an answer', async () => {
    const { host } = fakeHost();
    const { r, server } = rig(host, false);
    r.handle(permission());
    await r.tick();
    expect(last(server).session.respond).toEqual({ level: 'off', accepts: [], limits: [] });
    expect(last(server).session.asks ?? []).toEqual([]);
    expect(last(server).capabilities).toMatchObject({ respond: false, commands: [] });
    expect(server.calls).toEqual([]);
  });

  it('does not answer without the activity feed: it accepts nothing', async () => {
    const { host } = fakeHost();
    const { r, server } = rig(host, true, false);
    r.handle(permission());
    await r.tick();
    expect(last(server).session.respond).toMatchObject({ accepts: [] });
    expect(last(server).capabilities.respond).toBe(false);
    expect(server.calls).toEqual([]);
  });

  it('declares what it takes, then lists the open asks once the server takes answers', async () => {
    const { host } = fakeHost();
    const { r, t, server } = rig(host);
    r.handle(permission());
    r.handle(ev('form.created', { form: FORM }));
    await r.tick();
    expect(last(server).capabilities).toMatchObject({ respond: true, commands: ['compact'] });
    expect(last(server).session.respond).toEqual({ level: 'everything', accepts: ['question', 'message', 'permission', 'command'], limits: ['no-reply-in-place'] });
    expect(last(server).session.asks).toEqual([]); // the first reply has not said yet
    t.now += 6000;
    await r.tick();
    expect(last(server).session.asks!.map((a) => a.id).sort()).toEqual(['frm_1', 'per_1']);
    server.releaseAll();
  });

  it('offers no question when no channel can answer it, and still offers permissions', async () => {
    const { host } = fakeHost({ formChannel: () => null });
    const { r, server } = rig(host);
    r.handle(ev('form.created', { form: FORM }));
    await r.tick();
    expect(last(server).session.respond!.accepts).not.toContain('question');
    expect(last(server).session.respond!.accepts).toContain('permission');
    expect(server.calls).toEqual([]);
  });

  it('allows a permission once from Podium and reports it taken', async () => {
    const { host, calls } = fakeHost();
    const { r, server } = rig(host);
    r.handle(permission());
    await r.tick();
    await vi.waitFor(() => expect(server.calls).toContain('GET /api/fleet/sessions/ses_root/asks/per_1/answer?wait=20'));
    expect(server.calls[0]).toBe('PUT /api/fleet/sessions/ses_root/asks/per_1');
    expect(server.bodies['PUT /api/fleet/sessions/ses_root/asks/per_1']).toMatchObject({ kind: 'permission', tool: { name: 'read' } });
    server.answer('per_1', { id: 'dp', kind: 'allow-once' });
    await vi.waitFor(() => expect(calls).toEqual(['permission ses_root per_1 once']));
    await r.tick();
    expect(server.bodies['POST /api/fleet/sessions/ses_root/deliveries/dp/result']).toMatchObject({ result: 'took' });
  });

  it('denies a permission from Podium as a rejection, never as always', async () => {
    const { host, calls } = fakeHost();
    const { r, server } = rig(host);
    r.handle(permission());
    await r.tick();
    await vi.waitFor(() => expect(server.calls.length).toBeGreaterThan(1));
    server.answer('per_1', { id: 'dd', kind: 'deny' });
    await vi.waitFor(() => expect(calls).toEqual(['permission ses_root per_1 reject Denied from Podium.']));
  });

  it('passes the typed deny reason to OpenCode as the reply message (#968)', async () => {
    const { host, calls } = fakeHost();
    const { r, server } = rig(host);
    r.handle(permission());
    await r.tick();
    await vi.waitFor(() => expect(server.calls.length).toBeGreaterThan(1));
    server.answer('per_1', { id: 'dd', kind: 'deny', text: '  not in this repo  ' });
    await vi.waitFor(() => expect(calls).toEqual(['permission ses_root per_1 reject not in this repo']));
  });

  it('takes a reply in place of a permission as a rejection with the text (#968)', async () => {
    const { host, calls } = fakeHost();
    const { r, server } = rig(host);
    r.handle(permission());
    await r.tick();
    await vi.waitFor(() => expect(server.calls.length).toBeGreaterThan(1));
    server.answer('per_1', { id: 'dr', kind: 'reply', text: 'hold off, I want to look first' });
    await vi.waitFor(() => expect(calls).toEqual(['permission ses_root per_1 reject hold off, I want to look first']));
  });

  it('declares that a question takes no reply in its place (#968)', async () => {
    const { host } = fakeHost();
    const { r, server } = rig(host);
    await r.tick();
    expect(last(server).session.respond?.limits).toContain('no-reply-in-place');
  });

  it('refuses an answer of the wrong kind for a permission, and leaves OpenCode alone', async () => {
    const { host, calls } = fakeHost();
    const { r, server } = rig(host);
    r.handle(permission());
    await r.tick();
    await vi.waitFor(() => expect(server.calls.length).toBeGreaterThan(1));
    server.answer('per_1', { id: 'dq', kind: 'question', answers: [] });
    server.answer('per_1', { id: 'da', kind: 'allow-once' });
    await vi.waitFor(() => expect(calls).toEqual(['permission ses_root per_1 once']));
    await r.tick();
    expect(server.bodies['POST /api/fleet/sessions/ses_root/deliveries/dq/result']).toMatchObject({ result: 'refused' });
  });

  it('reports a permission OpenCode did not take as not taken', async () => {
    const { host } = fakeHost({ permissionReply: async () => { throw new Error('gone'); } });
    const { r, server } = rig(host);
    r.handle(permission());
    await r.tick();
    await vi.waitFor(() => expect(server.calls.length).toBeGreaterThan(1));
    server.answer('per_1', { id: 'dn', kind: 'allow-once' });
    await vi.waitFor(async () => { await r.tick(); expect(server.bodies['POST /api/fleet/sessions/ses_root/deliveries/dn/result']).toMatchObject({ result: 'not-taken' }); });
  });

  it('answers a question form by field key', async () => {
    const { host, calls } = fakeHost();
    const { r, server } = rig(host);
    r.handle(ev('form.created', { form: FORM }));
    await r.tick();
    await vi.waitFor(() => expect(server.calls.length).toBeGreaterThan(1));
    expect(server.bodies['PUT /api/fleet/sessions/ses_root/asks/frm_1']).toMatchObject({ kind: 'question', questions: [{ question: 'Pick one?' }] });
    server.answer('frm_1', { id: 'dq', kind: 'question', answers: [{ options: [1] }] });
    await vi.waitFor(() => expect(calls).toEqual(['form ses_root frm_1 {"q0":"B"}']));
    await r.tick();
    expect(server.bodies['POST /api/fleet/sessions/ses_root/deliveries/dq/result']).toMatchObject({ result: 'took' });
  });

  it('refuses an answer that does not fit the form, and reports one the channel lost as not taken', async () => {
    let channel: 'tui' | null = 'tui';
    const { host, calls } = fakeHost({ formChannel: () => channel });
    const { r, server } = rig(host);
    r.handle(ev('form.created', { form: FORM }));
    await r.tick();
    await vi.waitFor(() => expect(server.calls.length).toBeGreaterThan(1));
    server.answer('frm_1', { id: 'bad', kind: 'question', answers: [{ options: [9] }] });
    await vi.waitFor(async () => { await r.tick(); expect(server.bodies['POST /api/fleet/sessions/ses_root/deliveries/bad/result']).toMatchObject({ result: 'refused' }); });
    // The wait ended with that answer; the form is still open, so a new pass listens again.
    await vi.waitFor(() => expect(server.calls.filter((c) => c.startsWith('GET')).length).toBeGreaterThan(0));
    channel = null;
    await r.tick();
    server.answer('frm_1', { id: 'lost', kind: 'question', answers: [{ options: [0] }] });
    await vi.waitFor(async () => { await r.tick(); expect(server.bodies['POST /api/fleet/sessions/ses_root/deliveries/lost/result']).toMatchObject({ result: 'not-taken' }); });
    expect(calls).toEqual([]);
  });

  it('closes an ask the person answered in the terminal, and one the session ended on', async () => {
    const { host } = fakeHost();
    const { r, server } = rig(host);
    r.handle(permission());
    await r.tick();
    await vi.waitFor(() => expect(server.calls.length).toBeGreaterThan(1));
    r.handle(ev('permission.replied', { sessionID: ROOT, requestID: 'per_1', reply: 'once' }));
    server.releaseAll();
    await vi.waitFor(async () => { await r.tick(); expect(server.bodies['POST /api/fleet/sessions/ses_root/asks/per_1/close']).toMatchObject({ outcome: 'terminal' }); });
  });

  it('reports an ask closed as ended when the session ended while it waited', async () => {
    const { host } = fakeHost();
    const { r, server } = rig(host);
    r.handle(permission());
    await r.tick();
    await vi.waitFor(() => expect(server.calls.length).toBeGreaterThan(1));
    r.handle(ev('session.deleted', { sessionID: ROOT }));
    server.releaseAll();
    await vi.waitFor(async () => { await r.tick(); expect(server.bodies['POST /api/fleet/sessions/ses_root/asks/per_1/close']).toMatchObject({ outcome: 'ended' }); });
  });

  it('sends a message as a labeled prompt, queued then taken while a turn runs, once even when handed over twice (#1011)', async () => {
    const { host, calls } = fakeHost();
    const msg = D({ id: 'm1', kind: 'message', text: 'please stop' });
    const { r, server } = rig(host, true, true, podium({ deliveries: [msg, msg] }));
    r.handle(ev('session.execution.started', { sessionID: ROOT }, 10_001));
    await r.tick();
    await r.tick();
    expect(calls).toEqual(['prompt ses_root m1 please stop']);
    await vi.waitFor(async () => { await r.tick(); expect(server.results).toEqual(['m1 queued', 'm1 took']); });
  });

  it('reports a message sent to an idle session as taken', async () => {
    const { host } = fakeHost();
    const { r, server } = rig(host, true, true, podium({ deliveries: [D({ id: 'm2', kind: 'message', text: 'hi' })] }));
    await r.tick();
    await vi.waitFor(async () => { await r.tick(); expect(server.bodies['POST /api/fleet/sessions/ses_root/deliveries/m2/result']).toMatchObject({ result: 'took' }); });
  });

  it('is not held up by a call into OpenCode that never returns', async () => {
    const { host } = fakeHost({ prompt: () => new Promise(() => undefined) });
    const { r, t, server } = rig(host, true, true, podium({ deliveries: [D({ id: 'hang', kind: 'message', text: 'x' })] }), 20);
    await r.tick();
    t.now += 6000;
    await r.tick();
    expect(server.reports.length).toBe(2);
  });

  it('announces nothing for a session that ended', async () => {
    const { host } = fakeHost();
    const { r, t, server } = rig(host);
    r.handle(permission());
    r.handle(ev('session.deleted', { sessionID: ROOT }));
    await r.tick();
    t.now += 6000;
    await r.tick();
    expect(server.calls.filter((c) => c.startsWith('PUT'))).toEqual([]);
  });

  it('runs /compact, and refuses /clear and anything else', async () => {
    const { host, calls } = fakeHost();
    const server = podium({ deliveries: [D({ id: 'c1', kind: 'command', command: 'compact' }), D({ id: 'c2', kind: 'command', command: 'clear' }), D({ id: 'c3', kind: 'plan-approve' }), D({ id: 'c4', kind: 'message' })] });
    const { r, t } = rig(host, true, true, server);
    await r.tick();
    t.now += 6000;
    server.handOver([D({ id: 'c1', kind: 'command', command: 'compact' }), D({ id: 'c2', kind: 'command', command: 'clear' }), D({ id: 'c3', kind: 'plan-approve' }), D({ id: 'c4', kind: 'message' })]);
    await r.tick();
    await r.tick();
    await r.tick();
    expect(calls).toEqual(['compact ses_root c1']);
    const res = (id: string) => server.bodies[`POST /api/fleet/sessions/ses_root/deliveries/${id}/result`];
    expect(res('c1')).toMatchObject({ result: 'took' });
    expect(res('c2')).toMatchObject({ result: 'refused' });
    expect(res('c3')).toMatchObject({ result: 'refused' });
    expect(res('c4')).toMatchObject({ result: 'refused' });
  });

  it('reports a message or /compact OpenCode did not take as refused, never not-taken, which locks the ask (#1011)', async () => {
    const { host } = fakeHost({ prompt: async () => { throw new Error('no'); }, compact: async () => { throw new Error('no'); } });
    const server = podium();
    const { r, t } = rig(host, true, true, server);
    await r.tick();
    t.now += 6000;
    server.handOver([D({ id: 'm9', kind: 'message', text: 'x' }), D({ id: 'm8', kind: 'command', command: 'compact' })]);
    await r.tick();
    await r.tick();
    await r.tick();
    expect(server.bodies['POST /api/fleet/sessions/ses_root/deliveries/m9/result']).toMatchObject({ result: 'refused' });
    expect(server.bodies['POST /api/fleet/sessions/ses_root/deliveries/m8/result']).toMatchObject({ result: 'refused' });
  });

  it('says why OpenCode did not take a message, a command or an answer, instead of hiding it', async () => {
    const reason = new Error('Expected a string starting with "msg_"');
    const { host } = fakeHost({ prompt: async () => { throw reason; }, compact: async () => { throw reason; }, permissionReply: async () => { throw new Error('no permission'); } });
    const lines: string[] = [];
    const server = podium();
    const { r, t } = rig(host, true, true, server, undefined, {}, (l) => lines.push(l));
    r.handle(permission());
    await r.tick();
    t.now += 6000;
    server.handOver([D({ id: 'm9', kind: 'message', text: 'x' }), D({ id: 'm8', kind: 'command', command: 'compact' })]);
    await r.tick();
    await vi.waitFor(() => expect(server.calls.length).toBeGreaterThan(1));
    server.answer('per_1', { id: 'dp', kind: 'allow-once' });
    await vi.waitFor(() => expect(lines.some((l) => l.includes('answer') && l.includes('no permission'))).toBe(true));
    await r.tick();
    expect(lines.some((l) => l.includes('podium-reporter') && l.includes('message') && l.includes('msg_'))).toBe(true);
    expect(lines.some((l) => l.includes('/compact') && l.includes('msg_'))).toBe(true);
    expect(lines.some((l) => l.includes('answer') && l.includes('no permission'))).toBe(true);
    server.releaseAll();
  });

  it('stops listening and lists no asks when the server stops taking answers', async () => {
    const { host } = fakeHost();
    const { r, t, server } = rig(host);
    r.handle(permission());
    await r.tick();
    server.setRespond(false);
    t.now += 6000;
    await r.tick();
    t.now += 6000;
    await r.tick();
    expect(last(server).session.asks).toEqual([]);
    server.releaseAll();
  });
});

describe('Reporter answering: what the recording keeps (#353, #969)', () => {
  const GRANT = { state: 'recording' as const, consent: { admin: true, chosen: true, owner: true }, loops: ['@orchestrator'], limit: null, startedBy: 'Maya', startedAt: 1, stoppedBy: null, stoppedAt: null, keptUntil: null, bytes: 0 };
  const call = (id: string) => [ev('session.tool.input.started', { sessionID: ROOT, id, name: 'bash' }, 10_001), ev('session.tool.called', { sessionID: ROOT, id, name: 'bash', input: { command: 'rm x' } }, 10_002)];
  const entries = (r: Reporter) => r.store.roots.get(ROOT)!.recorder.nextBatch(0)?.batch.entries ?? [];

  /** A session whose first report has been answered with a grant, so capture is on when the person's option is. */
  async function recording(on = true) {
    const { host, calls } = fakeHost();
    const out = rig(host, true, true, podium({ recording: GRANT }), undefined, on ? { PODIUM_SESSION_RECORDING: 'true' } : {});
    await out.r.tick();
    expect(out.r.store.roots.get(ROOT)!.recorder.capturing).toBe(on);
    return { ...out, calls };
  }

  it('keeps an allowed permission once, after the call it answers, with who sent it', async () => {
    const { r, t, server, calls } = await recording();
    for (const e of call('c1')) r.handle(e);
    r.handle(ev('permission.asked', { id: 'per_1', sessionID: ROOT, action: 'bash', resources: ['rm x'], source: { type: 'tool', messageID: 'm', id: 'c1' } }));
    await r.tick();
    await vi.waitFor(() => expect(server.calls.length).toBeGreaterThan(1));
    server.answer('per_1', { id: 'dp', kind: 'allow-once', by: 'Maya' });
    await vi.waitFor(() => expect(calls).toEqual(['permission ses_root per_1 once']));
    // The first tick sent the call (seq 1); the decision follows it and points back at it.
    t.now += 6000;
    await r.tick();
    const sent = server.bodies['POST /api/fleet/sessions/ses_root/recording'] as { entries: { kind: string; seq: number; name: string; callSeq?: number; text: string; by?: string }[] };
    expect(sent.entries.map((e) => [e.kind, e.seq, e.name, e.callSeq, e.text, e.by])).toEqual([['decision', 2, 'permission', 1, 'Allowed once', 'Maya']]);
  });

  it('keeps a denial as failed, with the reason', async () => {
    const { r, server, calls } = await recording();
    r.handle(permission());
    await r.tick();
    await vi.waitFor(() => expect(server.calls.length).toBeGreaterThan(1));
    server.answer('per_1', { id: 'dp', kind: 'deny', text: 'not that file' });
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(entries(r).map((e) => [e.kind, e.name, e.callSeq, e.text, e.failed])).toEqual([['decision', 'permission', undefined, 'Denied: not that file', true]]);
  });

  it('keeps a question answered from Podium as the questions and the chosen values', async () => {
    const { r, server, calls } = await recording();
    r.handle(ev('form.created', { form: FORM }));
    await r.tick();
    await vi.waitFor(() => expect(server.calls.length).toBeGreaterThan(1));
    server.answer('frm_1', { id: 'dq', kind: 'question', answers: [{ options: [1] }] });
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(entries(r).map((e) => [e.kind, e.name, e.text])).toEqual([['decision', 'question', 'Pick: B']]);
  });

  it('keeps a message from Podium as the text that was sent, not the framed prompt OpenCode saw', async () => {
    const { r, t, server, calls } = await recording();
    t.now += 6000;
    server.handOver([D({ id: 'm1', kind: 'message', text: 'please stop', by: 'Maya' })]);
    await r.tick();
    await vi.waitFor(() => expect(calls.length).toBe(1));
    r.handle(ev('session.inbox.enqueued', { sessionID: ROOT, item: { payload: { text: framedMessage({ by: 'Maya', text: 'please stop' }) } } }));
    r.handle(ev('session.inbox.enqueued', { sessionID: ROOT, item: { payload: { text: 'typed at the terminal' } } }));
    expect(entries(r).map((e) => e.text)).toEqual(['please stop', 'typed at the terminal']);
  });

  it('marks the compaction a Podium command ran as theirs, once', async () => {
    const { r, t, server, calls } = await recording();
    t.now += 6000;
    server.handOver([D({ id: 'c1', kind: 'command', command: 'compact', by: 'Maya' })]);
    await r.tick();
    await vi.waitFor(() => expect(calls).toEqual(['compact ses_root c1']));
    r.handle(ev('session.compaction.started', { sessionID: ROOT }));
    r.handle(ev('session.compaction.ended', { sessionID: ROOT }));
    r.handle(ev('session.compaction.started', { sessionID: ROOT }));
    expect(entries(r).map((e) => [e.kind, e.by])).toEqual([['compact', 'Maya'], ['compact', undefined]]);
  });

  it('keeps nothing while recording is off', async () => {
    const { r, server, calls } = await recording(false);
    r.handle(permission());
    await r.tick();
    await vi.waitFor(() => expect(server.calls.length).toBeGreaterThan(1));
    server.answer('per_1', { id: 'dp', kind: 'allow-once' });
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(entries(r)).toEqual([]);
  });
});
