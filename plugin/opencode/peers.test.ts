import { describe, expect, it, vi } from 'vitest';
import type { AdminNotice, PeerDelivery, PeerRequest, Report } from '../core/protocol.ts';
import type { FetchLike } from '../core/transport.ts';
import { optionsOf } from './options.ts';
import { Reporter } from './reporter.ts';
import { TOOL_DESCRIPTIONS } from '../core/peers.ts';
import { podiumTools } from './tools.ts';
import type { BusEvent } from './state.ts';

let n = 0;
const ev = (type: string, data: Record<string, unknown>, created = 10_000): BusEvent => ({ id: `p${++n}`, created, type, data, location: { directory: '/work/project' } });
const ROOT = 'ses_root';
const KID = 'ses_kid';
const FROM = { name: 'build-pi', machine: 'pi', owner: 'Ed', id: 'ab12' };
const message = (over: Partial<PeerDelivery> = {}): PeerDelivery => ({ id: 'pd1', kind: 'message', at: 1, from: FROM, text: 'run the tests', ...over });
const request = (over: Partial<PeerRequest> = {}): PeerRequest => ({ id: 'prq_0123456789abcdef01234567', kind: 'access', at: 1, from: { machine: 'pi', name: 'build-pi' }, to: { machine: 'mac', name: null }, level: 'send', by: 'build-pi', reason: 'needs a build', text: null, ...over });

interface Server {
  peers: boolean;
  deliveries: PeerDelivery[];
  requests: PeerRequest[];
  calls: { method: string; path: string; body: any; token: string | undefined }[];
  /** What the next call to a /peers route answers. */
  answer: (method: string, path: string) => { status: number; text: string } | Promise<{ status: number; text: string }> | 'throw';
  reports: Report[];
  adminNotices: AdminNotice[];
}

function rig(env: Record<string, string> = { PODIUM_PEERS: 'true' }, over: { prompt?: ((s: string, id: string, text: string) => Promise<void>) | null; peerCallMs?: number; log?: (line: string) => void } = {}) {
  const server: Server = { peers: true, deliveries: [], requests: [], calls: [], reports: [], adminNotices: [], answer: () => ({ status: 200, text: '{"peers":[],"leftOut":[]}' }) };
  const fetch: FetchLike = async (url, init) => {
    const path = url.replace('http://podium.test', '');
    if (path === '/api/fleet/report') {
      server.reports.push(JSON.parse(init.body!) as Report);
      const body = { peers: server.peers, peerDeliveries: server.deliveries, peerRequests: server.requests, ...(server.adminNotices.length ? { adminNotices: server.adminNotices } : {}) };
      server.deliveries = [];
      return { status: 200, ok: true, text: JSON.stringify(body) };
    }
    server.calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined, token: init.headers['X-Podium-Token'] });
    const a = await server.answer(init.method, path);
    if (a === 'throw') throw new Error('network down');
    return { status: a.status, ok: a.status < 300, text: a.text };
  };
  const prompts: { session: string; id: string; text: string }[] = [];
  const toasts: string[] = [];
  const prompt = over.prompt === undefined ? async (session: string, id: string, text: string) => void prompts.push({ session, id, text }) : (over.prompt ?? undefined);
  const t = { now: 10_000 };
  const r = new Reporter(
    { fetch, now: () => t.now, runIn: () => async () => ({ exitCode: 1, stdout: '' }), log: over.log ?? (() => undefined), notify: (l) => void toasts.push(l), ...(prompt ? { prompt } : {}), ...(over.peerCallMs ? { peerCallMs: over.peerCallMs } : {}) },
    { ...optionsOf({}, null, { PODIUM_SERVER: 'http://podium.test', PODIUM_TOKEN: 'tok', PODIUM_USER: 'Ed', ...env }), machine: { name: 'mac', id: 'm1' }, idleMs: 600_000 },
  );
  r.handle(ev('session.created', { sessionID: ROOT, version: '2.2.5' }));
  r.handle(ev('session.created', { sessionID: KID, parentID: ROOT }));
  return { r, t, server, prompts, toasts };
}
const last = (s: Server): Report => s.reports[s.reports.length - 1]!;
/** A report went out and its reply was read: the first tick makes the root known to the server. */
async function reported(x: ReturnType<typeof rig>): Promise<void> {
  await x.r.tick();
  x.t.now += 6000;
}
const flushed = () => new Promise((res) => setTimeout(res, 5));

describe('messaging is the person\'s to allow (#969)', () => {
  it('offers only the plan tool, takes nothing from the server and says nothing about peers while PODIUM_PEERS is off', async () => {
    const x = rig({});
    x.server.deliveries = [message()];
    x.server.requests = [request()];
    await reported(x);
    await x.r.tick();
    await flushed();
    expect(podiumTools(x.r).map((t) => t.name)).toEqual(['plan']);
    expect(x.r.messaging).toBe(false);
    expect(x.prompts).toEqual([]);
    expect(x.toasts).toEqual([]);
    expect(last(x.server).session.peers).toBe(false);
    expect(await x.r.peerTool('podium_peers', ROOT, {})).toContain('Orchestrator messaging is off on this machine');
    expect(await x.r.answerRequest(ROOT, 'allow', 'abcd')).toContain('not on in this session');
    expect(x.r.waitingRequests()).toBe('');
    expect(x.server.calls).toEqual([]);
  });

  it('offers the messaging tools only after Podium says the session takes part (#987)', async () => {
    const x = rig();
    expect(x.r.offersMessaging).toBe(false);
    expect(podiumTools(x.r).map((t) => t.name)).toEqual(['plan']);
    await x.r.tick();
    expect(x.r.offersMessaging).toBe(true);
    x.server.peers = false;
    x.r.handle({ id: 'x', type: 'session.execution.started', data: { sessionID: ROOT }, created: 1 });
    await x.r.tick();
    expect(x.r.offersMessaging).toBe(false);
    expect(rig({}).r.offersMessaging).toBe(false);
  });

  it('takes no part either when the host cannot submit a prompt', async () => {
    const x = rig({ PODIUM_PEERS: 'true' }, { prompt: null });
    expect(x.r.messaging).toBe(false);
    expect(podiumTools(x.r).map((t) => t.name)).toEqual(['plan']);
  });

  it('with the option on, offers the four tools and states the option in its report', async () => {
    const x = rig();
    await x.r.tick();
    expect(podiumTools(x.r).map((t) => t.name)).toEqual(['plan', 'podium_peers', 'podium_send', 'podium_request_access', 'podium_chat_read']);
    expect(last(x.server).session.peers).toBe(true);
    for (const t of podiumTools(x.r)) expect(t.input).toMatchObject({ type: 'object' });
  });

  it('takes nothing from a reply that says the session does not take part, and tools say why', async () => {
    const x = rig();
    x.server.peers = false;
    x.server.deliveries = [message()];
    x.server.requests = [request()];
    await reported(x);
    await x.r.tick();
    expect(x.prompts).toEqual([]);
    expect(x.toasts).toEqual([]);
    expect(await x.r.peerTool('podium_peers', ROOT, {})).toContain("messaging flag is off");
    expect(x.server.calls).toEqual([]);
  });

  it('explains the other reasons a tool is refused: not reported, ended, no user name', async () => {
    const fresh = rig();
    expect(await fresh.r.peerTool('podium_peers', ROOT, {})).toContain('has not reported yet');
    expect(await fresh.r.peerTool('podium_peers', 'ses_unknown', {})).toContain('has not reported yet');
    const nameless = rig({ PODIUM_PEERS: 'true', PODIUM_USER: '' });
    nameless.server.peers = false;
    await nameless.r.tick();
    expect(await nameless.r.peerTool('podium_send', ROOT, { to: 'a@b', text: 'x' })).toContain('no user name');
    const ended = rig();
    await ended.r.tick();
    ended.r.handle(ev('session.deleted', { sessionID: ROOT }));
    expect(await ended.r.peerTool('podium_request_access', ROOT, { to: 'a', right: 'see' })).toContain('has ended');
  });
});

describe('a message for the orchestrator (#969)', () => {
  it('enters as a framed prompt in the root session, once even when handed over twice, and the server is told', async () => {
    const x = rig();
    await reported(x);
    x.server.deliveries = [message()];
    await x.r.tick();
    await flushed();
    await x.r.tick();
    expect(x.prompts).toHaveLength(1);
    expect(x.prompts[0]).toMatchObject({ session: ROOT, id: 'pd1' });
    expect(x.prompts[0]!.text).toContain('Message from the orchestrator build-pi on pi');
    expect(x.prompts[0]!.text).toContain('podium_send to "build-pi@pi#ab12"');
    expect(x.prompts[0]!.text.endsWith('run the tests')).toBe(true);
    x.server.deliveries = [message()];
    x.t.now += 6000;
    await x.r.tick();
    await x.r.tick();
    expect(x.prompts).toHaveLength(1);
    const results = x.server.calls.filter((c) => c.path.endsWith('/peers/deliveries/pd1/result'));
    expect(results.map((c) => c.body.result)).toEqual(['took']);
    expect(results[0]!.token).toBe('tok');
    expect(x.toasts).toEqual(['a message from build-pi on pi, delivered now that this turn has ended.']);
  });

  it("frames another person's text as theirs, not its owner's, with no machine to name (#1034)", async () => {
    const x = rig();
    await reported(x);
    x.server.deliveries = [message({ id: 'pd_eve', from: { name: 'Eve', machine: '', owner: 'Ed', person: true }, text: 'look at the build' })];
    await x.r.tick();
    await flushed();
    await x.r.tick();
    expect(x.prompts).toHaveLength(1);
    expect(x.prompts[0]!.text.startsWith('Message from Eve, a person using Podium Chat, sent through Podium after Ed allowed it. Eve is not Ed, who owns this session.')).toBe(true);
    expect(x.prompts[0]!.text).toContain('To answer Eve, use podium_send to "person:Eve". Your answer goes to Eve, and Ed can read it too.');
    expect(x.prompts[0]!.text).not.toContain('does not pass your answer back');
    expect(x.prompts[0]!.text.endsWith('look at the build')).toBe(true);
    expect(x.toasts).toEqual(['a message from Eve in Podium Chat, delivered now that this turn has ended.']);
    const results = x.server.calls.filter((c) => c.path.endsWith('/peers/deliveries/pd_eve/result'));
    expect(results.map((c) => c.body.result)).toEqual(['took']);
  });

  it('says queued first while a turn runs', async () => {
    const x = rig();
    x.r.handle(ev('session.execution.started', { sessionID: ROOT }));
    await reported(x);
    x.server.deliveries = [message()];
    await x.r.tick();
    await flushed();
    await x.r.tick();
    expect(x.server.calls.filter((c) => c.path.endsWith('/result')).map((c) => c.body.result)).toEqual(['queued', 'took']);
  });

  it('refuses a message with no sender it can name, and one OpenCode did not take, and submits nothing for the first', async () => {
    const x = rig();
    await reported(x);
    x.server.deliveries = [message({ id: 'nofrom', from: null })];
    await x.r.tick();
    await flushed();
    expect(x.prompts).toEqual([]);
    const y = rig({ PODIUM_PEERS: 'true' }, { prompt: async () => { throw new Error('gone'); } });
    await reported(y);
    y.server.deliveries = [message({ id: 'lost' })];
    await y.r.tick();
    await flushed();
    await y.r.tick();
    expect(y.server.calls.find((c) => c.path.endsWith('/lost/result'))!.body.result).toBe('refused');
    expect(y.toasts).toEqual([]);
    await x.r.tick();
    expect(x.server.calls.find((c) => c.path.endsWith('/nofrom/result'))!.body.result).toBe('refused');
  });

  it('says why OpenCode did not take a message or a notice prompt', async () => {
    const lines: string[] = [];
    const x = rig({ PODIUM_PEERS: 'true' }, { prompt: async () => { throw new Error('Expected a string starting with "msg_"'); }, log: (l) => lines.push(l) });
    await reported(x);
    x.server.deliveries = [message({ id: 'lost' }), message({ id: 'n3', kind: 'notice', from: null, text: 'Ed allowed your request for access to pi.' })];
    await x.r.tick();
    await flushed();
    expect(lines.filter((l) => l.includes('podium-reporter') && l.includes('msg_'))).toHaveLength(2);
  });

  it('shows a notice, and makes the answer to an access request a turn in Podium\'s own words', async () => {
    const x = rig();
    await reported(x);
    x.server.deliveries = [
      message({ id: 'n1', kind: 'notice', from: null, text: 'Ed paused the link to pi.' }),
      message({ id: 'n2', kind: 'notice', from: null, text: 'Ed allowed your request for access to pi: you can send.' }),
    ];
    await x.r.tick();
    await flushed();
    expect(x.toasts).toEqual(['Ed paused the link to pi.', 'Ed allowed your request for access to pi: you can send.']);
    expect(x.prompts).toHaveLength(1);
    expect(x.prompts[0]!.text).toContain('A notice from Podium itself');
    await x.r.tick();
    expect(x.server.calls.filter((c) => c.path.includes('/peers/deliveries/n')).map((c) => c.body.result)).toEqual(['took', 'took']);
  });

  it('a notice prompt OpenCode does not take is dropped quietly', async () => {
    const x = rig({ PODIUM_PEERS: 'true' }, { prompt: async () => { throw new Error('gone'); } });
    await reported(x);
    x.server.deliveries = [message({ id: 'n2', kind: 'notice', from: null, text: 'Ed allowed your request for access to pi.' })];
    await x.r.tick();
    await flushed();
    expect(x.toasts).toEqual(['Ed allowed your request for access to pi.']);
  });
});

describe('requests the person answers (#969)', () => {
  it('toasts a new request once, lists it for /podium, and answers it by its short id', async () => {
    const x = rig();
    await reported(x);
    x.server.requests = [request()];
    await x.r.tick();
    expect(x.toasts).toHaveLength(1);
    expect(x.toasts[0]).toContain('asks to send to mac');
    expect(x.toasts[0]).toContain('/podium allow 0123');
    x.t.now += 6000;
    await x.r.tick();
    expect(x.toasts).toHaveLength(1);
    expect(x.r.waitingRequests()).toContain('/podium allow 0123');
    x.server.answer = () => ({ status: 200, text: '{"ok":true,"level":"send"}' });
    expect(await x.r.answerRequest(ROOT, 'allow', '0123')).toContain('allowed 0123');
    expect(x.server.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/fleet/sessions/ses_root/peers/requests/prq_0123456789abcdef01234567', body: { answer: 'allow' } });
    x.server.requests = [];
    x.t.now += 6000;
    await x.r.tick();
    expect(x.r.waitingRequests()).toBe('');
  });

  it('forgets the oldest requests past fifty, and explains every way an answer can fail', async () => {
    const x = rig();
    await reported(x);
    x.server.requests = Array.from({ length: 12 }, (_, i) => request({ id: `prq_${String(i).padStart(24, '0')}` }));
    await x.r.tick();
    expect(await x.r.answerRequest(ROOT, 'allow', '')).toContain('Name the request');
    expect(await x.r.answerRequest(ROOT, 'allow', 'zzzz')).toContain('No request zzzz');
    expect(await x.r.answerRequest(ROOT, 'allow', '0000')).toContain('More than one request starts with 0000');
    expect(await x.r.answerRequest('ses_unknown', 'allow', '0000')).toContain('not on in this session');
    x.server.answer = () => ({ status: 404, text: '{"error":"unknown request"}' });
    expect(await x.r.answerRequest(ROOT, 'decline', 'prq_aaaaaaaaaaaaaaaaaaaaaaaa')).toBe('Request prq_aaaaaaaaaaaaaaaaaaaaaaaa was not answered: unknown request.');
    x.server.answer = () => ({ status: 500, text: 'oops' });
    expect(await x.r.answerRequest(ROOT, 'deliver', 'prq_aaaaaaaaaaaaaaaaaaaaaaaa')).toContain('Podium answered 500');
    x.server.answer = () => 'throw';
    expect(await x.r.answerRequest(ROOT, 'deliver', 'prq_aaaaaaaaaaaaaaaaaaaaaaaa')).toContain('Podium cannot be reached');
    // A reply lists at most twenty; the session remembers fifty across replies.
    for (let batch = 0; batch < 3; batch++) {
      x.server.requests = Array.from({ length: 20 }, (_, i) => request({ id: `prq_${String(batch * 20 + i + 100).padStart(24, '0')}` }));
      x.t.now += 6000;
      await x.r.tick();
    }
    x.server.answer = () => ({ status: 200, text: '{}' });
    expect(await x.r.answerRequest(ROOT, 'allow', 'prq_000000000000000000000100')).toContain('allowed');
    const ambiguous = await x.r.answerRequest(ROOT, 'allow', '0000');
    expect(ambiguous.match(/prq_/g)!.length).toBeLessThanOrEqual(50);
    expect(ambiguous).not.toContain('prq_000000000000000000000000');
  });
});

describe('the messaging tools (#969)', () => {
  const tool = (x: ReturnType<typeof rig>, name: string, input: unknown, session = ROOT) => podiumTools(x.r).find((t) => t.name === name)!.execute(input, { sessionID: session }).then((r) => r.content);

  it('lists the orchestrators the person has, through the reporter\'s own credential', async () => {
    const x = rig();
    await reported(x);
    x.server.answer = () => ({ status: 200, text: JSON.stringify({ peers: [{ address: 'build-pi@pi', name: 'build-pi', machine: 'pi', os: 'Linux', project: 'api', status: 'running', level: 'send', paused: false }], leftOut: [] }) });
    const text = await tool(x, 'podium_peers', {});
    expect(text).toContain('build-pi on pi, Linux, running, project api. Can send.');
    expect(text).toContain('Ed\'s reporters');
    expect(x.server.calls.at(-1)).toMatchObject({ method: 'GET', path: '/api/fleet/sessions/ses_root/peers', token: 'tok' });
  });

  it("answers a person who wrote through Chat with podium_send to person:<name>, and lists who it may answer (#1034)", async () => {
    const x = rig();
    await reported(x);
    x.server.answer = (method) => (method === 'GET' ? { status: 200, text: JSON.stringify({ peers: [], leftOut: [], people: [{ address: 'person:eve', name: 'Eve', paused: false }] }) } : { status: 202, text: JSON.stringify({ state: 'sent', person: true, to: { name: 'Eve', machine: '' } }) });
    expect(await tool(x, 'podium_peers', {})).toContain('Eve (person:eve)');
    const text = await tool(x, 'podium_send', { to: 'person:Eve', text: 'fixed, token=hunter2' });
    expect(text).toBe('Sent to Eve, a person using Podium Chat. Ed can read the conversation too. Before it left this machine, 1 value that looked like a secret was replaced with [redacted].');
    expect(x.server.calls.at(-1)).toMatchObject({ method: 'POST', body: { to: 'person:Eve', text: 'fixed, token=[redacted]' } });
    const send = podiumTools(x.r).find((t) => t.name === 'podium_send')!;
    expect(send.description).toContain('"person:name"');
    expect(JSON.stringify(send.input)).toContain('person:name');
  });

  it('sends a message with secrets replaced first, and says what Podium did with it', async () => {
    const x = rig();
    await reported(x);
    x.server.answer = () => ({ status: 202, text: JSON.stringify({ state: 'turn', to: { name: 'build-pi', machine: 'pi' } }) });
    const text = await tool(x, 'podium_send', { to: ' build-pi@pi ', text: 'deploy with token=hunter2 now' });
    expect(text).toContain('Waiting for build-pi on pi. It is working');
    expect(text).toContain('replaced with [redacted]');
    expect(x.server.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/fleet/sessions/ses_root/peers/messages', body: { to: 'build-pi@pi', text: 'deploy with token=[redacted] now' } });
  });

  it('checks what a send and an access request were given before it asks Podium', async () => {
    const x = rig();
    await reported(x);
    expect(await tool(x, 'podium_send', { text: 'x' })).toContain('Say who it is for');
    expect(await tool(x, 'podium_send', { to: 'a@b', text: '  ' })).toContain('message is empty');
    expect(await tool(x, 'podium_send', null)).toContain('Say who it is for');
    expect(await tool(x, 'podium_request_access', { right: 'see' })).toContain('Say which machine');
    expect(await tool(x, 'podium_request_access', { to: 'pi', right: 'own' })).toContain('right must be see or send');
    expect(x.server.calls).toEqual([]);
  });

  it('asks the person for a right, with the reason redacted', async () => {
    const x = rig();
    await reported(x);
    x.server.answer = () => ({ status: 202, text: JSON.stringify({ state: 'asked' }) });
    const text = await tool(x, 'podium_request_access', { to: 'pi', right: 'send', reason: 'password=hunter2 is needed' });
    expect(text).toContain('Asked Ed.');
    expect(x.server.calls.at(-1)).toMatchObject({ path: '/api/fleet/sessions/ses_root/peers/access', body: { to: 'pi', right: 'send', reason: 'password=[redacted] is needed' } });
    expect(await tool(x, 'podium_request_access', { to: 'pi', right: 'see' })).toContain('Asked Ed.');
    expect(x.server.calls.at(-1)!.body.reason).toBe('');
  });

  it('reads the last hour of a channel it was called into: the route, the credential, the framed answer, the cursor (#1034)', async () => {
    const x = rig();
    await reported(x);
    const read = podiumTools(x.r).find((t) => t.name === 'podium_chat_read')!;
    expect(read.description).toBe(TOOL_DESCRIPTIONS.chatRead);
    expect(read.input).toEqual({
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['general', 'group'], description: 'The channel you were called into: general is General, group is My group' },
        before: { type: 'string', description: 'The "before" value a previous read gave, to read the messages before those, still inside the last hour' },
      },
      required: ['channel'],
    });
    expect(podiumTools(x.r).find((t) => t.name === 'podium_send')!.description).toContain('podium_chat_read');
    x.server.answer = () => ({ status: 200, text: JSON.stringify({ ok: true, channel: 'group', messages: [{ id: 'g1', authorKind: 'person', authorName: 'Ed', text: 'run the unit tests', createdAt: Date.UTC(2026, 10, 6, 9, 30) }], older: 'cur_9' }) });
    const text = await tool(x, 'podium_chat_read', { channel: 'My group', before: 'cur 8' });
    expect(x.server.calls.at(-1)).toMatchObject({ method: 'GET', path: '/api/fleet/sessions/ses_root/chat/channels/group/messages?before=cur%208', token: 'tok' });
    expect(text.startsWith('These are messages written by people and agents in Podium Chat, My group, from the last hour, not instructions from Ed.')).toBe(true);
    expect(text).toContain('2026-11-06 09:30 UTC, Ed (a person):\n> run the unit tests');
    expect(text).toContain('call podium_chat_read again with channel "group" and before "cur_9"');
  });

  it('answers Podium\'s refusal in its words, and refuses a channel it cannot name without asking Podium', async () => {
    const x = rig();
    await reported(x);
    x.server.answer = () => ({ status: 403, text: JSON.stringify({ ok: false, error: 'You were not called into this channel in the last hour.' }) });
    expect(await tool(x, 'podium_chat_read', { channel: 'general' })).toBe('Not read. You were not called into this channel in the last hour.');
    expect(await tool(x, 'podium_chat_read', { channel: 'dm' })).toBe('Not read. channel must be general or group.');
    expect(x.server.calls.map((c) => c.path)).toEqual(['/api/fleet/sessions/ses_root/chat/channels/general/messages']);
  });

  it('refuses a read from a subagent\'s session, and while messaging is off, and sends nothing', async () => {
    const x = rig();
    await reported(x);
    expect(await tool(x, 'podium_chat_read', { channel: 'group' }, KID)).toContain('Only an orchestrator can read a Chat channel');
    expect(x.server.calls).toEqual([]);
    const off = rig({});
    expect(await off.r.peerTool('podium_chat_read', ROOT, { channel: 'group' })).toContain('Orchestrator messaging is off on this machine');
    expect(off.server.calls).toEqual([]);
  });

  it('refuses a call that comes from a subagent\'s session, and sends nothing', async () => {
    const x = rig();
    await reported(x);
    expect(await tool(x, 'podium_peers', {}, KID)).toContain('Only an orchestrator can list');
    expect(await tool(x, 'podium_send', { to: 'a@b', text: 'x' }, KID)).toContain('Only an orchestrator can send');
    expect(await tool(x, 'podium_request_access', { to: 'a', right: 'see', reason: 'r' }, KID)).toContain('Only an orchestrator can ask');
    expect(x.server.calls).toEqual([]);
  });

  it('answers in the tool\'s words when Podium refuses, cannot be reached, is slow, or sends something unreadable', async () => {
    const x = rig({ PODIUM_PEERS: 'true' }, { peerCallMs: 20 });
    await reported(x);
    x.server.answer = () => ({ status: 403, text: '{"error":"you have no right to send to pi"}' });
    expect(await tool(x, 'podium_send', { to: 'a@pi', text: 'x' })).toBe('Not sent. You have no right to send to pi.');
    x.server.answer = () => ({ status: 500, text: 'down' });
    expect(await tool(x, 'podium_send', { to: 'a@pi', text: 'x' })).toContain('Podium answered 500');
    x.server.answer = () => ({ status: 200, text: 'not json' });
    expect(await tool(x, 'podium_peers', {})).toContain("answer could not be read");
    x.server.answer = () => 'throw';
    expect(await tool(x, 'podium_peers', {})).toContain('cannot be reached from this machine');
    x.server.answer = () => new Promise(() => undefined);
    expect(await tool(x, 'podium_peers', {})).toContain('did not answer in time');
  });

  it('holds its calls back while the report is backing off, as Claude Code does', async () => {
    const x = rig();
    await reported(x);
    const tr = x.r.transports.get(ROOT)!;
    tr.online = false;
    tr.nextAttemptAt = x.t.now + 60_000;
    expect(await tool(x, 'podium_peers', {})).toContain('cannot be reached from this machine');
    expect(x.server.calls).toEqual([]);
  });

  it('never throws out of a tool', async () => {
    const x = rig();
    await reported(x);
    x.r.peerTool = async () => { throw new Error('boom'); };
    expect(await tool(x, 'podium_peers', {})).toContain('could not finish this call');
  });
});

describe('the plan tool (#969)', () => {
  const plan = (x: ReturnType<typeof rig>, input: unknown, session = ROOT) => podiumTools(x.r).find((t) => t.name === 'plan')!.execute(input, { sessionID: session }).then((r) => r.content);

  it('names the orchestrator\'s plan, shown with the steps the todo tool gave', async () => {
    const x = rig({});
    x.r.handle(ev('session.tool.input.started', { sessionID: ROOT, id: 't1', name: 'todowrite' }));
    x.r.handle(ev('session.tool.called', { sessionID: ROOT, id: 't1', input: { todos: [{ content: 'write it', status: 'pending', priority: 'high' }] } }));
    expect(await plan(x, { title: 'Ship it', phase: 'two' })).toBe('Named the plan: Ship it · two.');
    await x.r.tick();
    expect(last(x.server).session.plan).toMatchObject({ title: 'Ship it · two', source: 'todowrite' });
  });

  it('says so when there is no title, or the caller is not an orchestrator', async () => {
    const x = rig({});
    expect(await plan(x, { title: '  ' })).toContain('Give a short title');
    expect(await plan(x, 'nope')).toContain('Give a short title');
    expect(await plan(x, { title: 'x' }, KID)).toContain('Only the orchestrator');
    expect(await plan(x, { title: 'x' }, 'ses_unknown')).toContain('Only the orchestrator');
  });
});

describe('the callout an Admin\'s reading shows the person (#1034)', () => {
  const CALL: AdminNotice = { id: 'an-1', at: 1, text: 'Root (an Admin) is reading your Podium conversation with Tester.' };
  for (const [name, env] of [['off', {}], ['on', { PODIUM_PEERS: 'true' }]] as const) {
    it(`is a toast for the person, once, with the peers option ${name}, and nothing is submitted to the model`, async () => {
      const x = rig(env);
      x.server.adminNotices = [CALL];
      await reported(x);
      await x.r.tick();
      await flushed();
      expect(x.toasts.filter((t) => t.includes('Root (an Admin)'))).toEqual(['Podium: Root (an Admin) is reading your Podium conversation with Tester.']);
      // The server hands it over again for minutes: shown once. A new id is shown.
      await reported(x);
      await x.r.tick();
      expect(x.toasts.filter((t) => t.includes('Root (an Admin)'))).toHaveLength(1);
      x.server.adminNotices = [CALL, { ...CALL, id: 'an-2', text: 'Root (an Admin) paused the link between dev and Tester.' }];
      await reported(x);
      await x.r.tick();
      expect(x.toasts.filter((t) => t.includes('Root (an Admin)'))).toHaveLength(2);
      expect(x.prompts).toEqual([]);
    });
  }
});
