import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../core/transport.ts';
import type { NoticeEvent } from './bridge.ts';
import { AdminBoard, ToastKeeper, dedupe, deliver, messagingLine, messagingOffReason, noticeOf, podiumText, StatusRelay, StatusWatcher, statusChange } from './notice.ts';
import { optionsOf } from './options.ts';
import { Reporter } from './reporter.ts';
import type { BusEvent } from './state.ts';

let n = 0;
const ev = (type: string, data: Record<string, unknown>, created: number): BusEvent => ({ id: `n${++n}`, created, type, data, location: { directory: '/work/project' } });

function reporter(reply: { status: number; text: string }, log: (l: string) => void = () => undefined) {
  const fetch: FetchLike = async () => ({ status: reply.status, ok: reply.status >= 200 && reply.status < 300, text: reply.text });
  return new Reporter({ fetch, now: () => 5000, runIn: () => async () => ({ exitCode: 1, stdout: '' }), log }, { ...optionsOf({}, null, { PODIUM_SERVER: 'http://podium.test:4317/', PODIUM_TOKEN: 't' }, null), idleMs: 600_000 });
}

const sign = { signIn: { configPath: null, tokenSet: true }, signedIn: true, context: null };

describe('dedupe: a warning is said once (#969)', () => {
  it('passes a line on the first time and drops the same line after', () => {
    const said: string[] = [];
    const log = dedupe((l) => said.push(l));
    log('a');
    log('b');
    log('a');
    log('b');
    log('c');
    expect(said).toEqual(['a', 'b', 'c']);
  });

  it('forgets the oldest lines past its bound, so it cannot grow without end', () => {
    const said: string[] = [];
    const log = dedupe((l) => said.push(l), 2);
    log('a');
    log('b');
    log('c');
    log('a');
    expect(said).toEqual(['a', 'b', 'c', 'a']);
  });
});

describe('the transport notices reach the log (#969, #850)', () => {
  it('a v2-too-old refusal, a token refusal and an owner conflict are each said once through the logger', async () => {
    for (const [status, text, expected] of [
      [400, '{"path":"$.v"}', /report version 1/],
      [401, '{"error":"nope"}', /refused/],
      [409, '{"error":"owned"}', /belongs to someone else/],
    ] as const) {
      const said: string[] = [];
      const r = reporter({ status, text }, dedupe((l) => said.push(l)));
      r.handle(ev('session.created', { sessionID: `ses_${status}` }, 1000));
      await r.tick();
      expect(said.join('\n')).toMatch(expected);
    }
  });
});

describe('podiumText: what /podium shows (#969)', () => {
  it('names the console, the home folder, the connection, the counts and the last error', async () => {
    const r = reporter({ status: 200, text: '{"ok":true,"liveSessions":2,"serverVersion":"1.5.0"}' });
    r.handle(ev('session.created', { sessionID: 'ses_a' }, 1000));
    await r.tick();
    const text = podiumText(r.summary(), { serverUrl: r.opts.serverUrl, home: '/home/dana', tls: null, version: r.opts.version, ...sign });
    expect(text).toContain('Podium fleet console: http://podium.test:4317/#/');
    expect(text).toContain('Home folder: /home/dana');
    expect(text).toContain('Connection: online (2 live sessions)');
    expect(text).toContain('Reports sent: 1, failed: 0, rejected: 0; events queued: 0');
    expect(text).toContain('Last error: none');
    expect(text).toContain(`reporter ${r.opts.version}`);
    expect(text).toContain('server 1.5.0');
    expect(text).not.toContain('TLS:');
  });

  it('says a connection is offline, not tried, or refused, and prints the notice and the last error', async () => {
    const down = new Reporter({ fetch: async () => { throw new Error('connect ECONNREFUSED'); }, now: () => 5000, runIn: () => async () => ({ exitCode: 1, stdout: '' }), log: () => undefined }, optionsOf({}, null, {}, null));
    expect(podiumText(down.summary(), { serverUrl: 'http://x', home: '/h', tls: null, version: '1', ...sign })).toContain('Connection: not tried yet');
    down.handle(ev('session.created', { sessionID: 'ses_b' }, 1000));
    await down.tick();
    const t = podiumText(down.summary(), { serverUrl: 'http://x', home: '/h', tls: 'connected over HTTPS', version: '1', ...sign });
    expect(t).toContain('Connection: offline, retrying');
    expect(t).toContain('Last error: connect ECONNREFUSED');
    expect(t).toContain('TLS: connected over HTTPS');
    const old = reporter({ status: 400, text: '{"path":"$.v"}' });
    old.handle(ev('session.created', { sessionID: 'ses_c' }, 1000));
    await old.tick();
    expect(podiumText(old.summary(), { serverUrl: 'http://x', home: '/h', tls: null, version: '1', ...sign })).toContain('report version 1');
  });

  it('counts dropped events when there are some', () => {
    const base = reporter({ status: 200, text: '{}' }).summary();
    expect(podiumText({ ...base, dropped: 3 }, { serverUrl: 'http://x', home: '/h', tls: null, version: '1', ...sign })).toContain(', dropped: 3');
  });
});

describe('podiumText: the console address (#969)', () => {
  it('drops every slash at the end of the address, and only those', () => {
    const facts = (serverUrl: string) => ({ serverUrl, home: '/h', tls: null, version: '1', ...sign });
    const summary = { online: null, liveSessions: null, serverVersion: null, notices: [], sent: 0, failed: 0, rejected: 0, queued: 0, dropped: 0, lastError: null, sessions: 0, messaging: { option: false, canPrompt: false, reported: false, serverSays: false } };
    expect(podiumText(summary, facts('http://x///'))).toContain('Podium fleet console: http://x/#/');
    expect(podiumText(summary, facts('http://x/a/b'))).toContain('Podium fleet console: http://x/a/b/#/');
    expect(podiumText(summary, facts('///'))).toContain('Podium fleet console: /#/');
  });
});

describe('statusChange and noticeOf: the toast (#969)', () => {
  it('is quiet until there is a status, and again when only the live count changed', () => {
    expect(statusChange(null, null)).toBeNull();
    expect(statusChange(null, 'podium v1 ○ connecting')).toBeNull();
    expect(statusChange(null, 'podium v1 ● 1 live')).toBe('podium v1 ● 1 live');
    expect(statusChange('podium v1 ● 1 live', 'podium v1 ● 3 live')).toBeNull();
    expect(statusChange('podium v1 ● 1 live', 'podium v1 ○ offline')).toBe('podium v1 ○ offline');
  });

  it('compares two texts that differ only in the digits before the first " live", and keeps any other text as it is', () => {
    expect(statusChange('podium v1 ● 12 live', 'podium v1 ● 345 live')).toBeNull();
    expect(statusChange('live ● 1 live', 'live ● 2 live')).toBeNull();
    expect(statusChange('a live ● x', 'a live ● y')).toBe('a live ● y');
    expect(statusChange('2 live', '3 live')).toBeNull();
  });

  it('shows a problem as a warning and a good state as information', () => {
    expect(noticeOf('podium v1 ○ token refused')).toEqual({ title: 'Podium', message: 'podium v1 ○ token refused', variant: 'warning' });
    expect(noticeOf('podium v1 ● 1 live')).toEqual({ title: 'Podium', message: 'podium v1 ● 1 live', variant: 'info' });
  });
});

describe('StatusWatcher and deliver (#969)', () => {
  it('hands over a notice once per change of status', () => {
    const w = new StatusWatcher();
    expect(w.poll(null)).toBeNull();
    expect(w.poll('podium v1 ○ connecting')).toBeNull();
    expect(w.poll('podium v1 ● 1 live')).toMatchObject({ variant: 'info' });
    expect(w.poll('podium v1 ● 2 live')).toBeNull();
    expect(w.poll('podium v1 ○ offline')).toMatchObject({ variant: 'warning', message: 'podium v1 ○ offline' });
    expect(w.poll('podium v1 ○ offline')).toBeNull();
  });

  it('sends a notice to the TUI part when one is attached, and to the fallback when there is none or the send fails', async () => {
    const n = noticeOf('podium v1 ● 1 live');
    const got: unknown[] = [];
    const lines: string[] = [];
    await deliver(n, async (x) => { got.push(x); }, (l) => lines.push(l));
    expect(got).toEqual([n]);
    expect(lines).toEqual([]);
    await deliver(n, undefined, (l) => lines.push(l));
    await deliver(n, async () => { throw new Error('gone'); }, (l) => lines.push(l));
    expect(lines).toEqual(['podium v1 ● 1 live', 'podium v1 ● 1 live']);
  });
});

describe('podiumText: sign-in, messaging, context and the commands (#987)', () => {
  const on = { option: true, canPrompt: true, reported: true, serverSays: true };

  it('says how the reporter signs in and the commands it takes, and never a token', () => {
    const base = reporter({ status: 200, text: '{}' }).summary();
    const t = podiumText(base, { serverUrl: 'http://x', home: '/h', tls: null, version: '1', signIn: { configPath: '/h/.podium/a.pem', tokenSet: true }, signedIn: true, context: null });
    expect(t).toContain('Sign-in: reporter config file /h/.podium/a.pem (mTLS)');
    expect(t).toContain('Name this session: /podium name <text>. Contexts (which Podium server): /podium context');
    expect(t).not.toContain('Context:');
    expect(podiumText(base, { serverUrl: 'http://x', home: '/h', tls: null, version: '1', signIn: { configPath: null, tokenSet: false }, signedIn: false, context: null })).toContain('Sign-in: none');
  });
  it('says the commit of a dev build on the Versions line, and nothing for a release', () => {
    const base = reporter({ status: 200, text: '{}' }).summary();
    const facts = { serverUrl: 'http://x', home: '/h', tls: null, version: '1.4.0', ...sign };
    expect(podiumText(base, { ...facts, build: 'a1b2c3d4-dirty' })).toContain('Versions: reporter 1.4.0 · Dev: a1b2c3d4-dirty');
    expect(podiumText(base, { ...facts, build: null })).toContain('Versions: reporter 1.4.0');
    expect(podiumText(base, facts)).not.toContain('Dev:');
  });
  it('names the context that chose the reporter config file', () => {
    const base = reporter({ status: 200, text: '{}' }).summary();
    const t = podiumText(base, { serverUrl: 'https://p.test:4318/', home: '/h', tls: null, version: '1', ...sign, context: 'work' });
    expect(t).toContain('Context: work (https://p.test:4318). Switch it for the next session with /podium context use <name>.');
  });
  it('gives the reason messaging is off, the first that holds, and says on when nothing stops it', () => {
    expect(messagingOffReason({ ...on, option: false }, true)).toContain('PODIUM_PEERS is off');
    expect(messagingOffReason({ ...on, canPrompt: false }, true)).toContain('cannot submit a prompt');
    expect(messagingOffReason(on, false)).toContain('no per-person token');
    expect(messagingOffReason({ ...on, reported: false }, true)).toContain('no session has reported yet');
    expect(messagingOffReason({ ...on, serverSays: false }, true)).toContain("messaging flag is off");
    expect(messagingOffReason(on, true)).toBeNull();
    expect(messagingLine(on, true)).toBe('Messaging: on. PODIUM_PEERS: on; Podium says: takes part');
    expect(messagingLine({ ...on, serverSays: false }, true)).toContain('Podium says: does not take part');
    expect(messagingLine({ ...on, reported: false }, true)).toContain('off, because no session has reported yet: send it a prompt. PODIUM_PEERS: on; Podium says: nothing yet');
    expect(messagingLine({ ...on, option: false }, true)).toContain('PODIUM_PEERS: off');
  });
  it('reads the messaging facts from the reporter', async () => {
    const r = reporter({ status: 200, text: '{"peers":true}' });
    expect(r.summary().messaging).toEqual({ option: false, canPrompt: false, reported: false, serverSays: false });
    r.handle(ev('session.created', { sessionID: 'ses_m' }, 1000));
    await r.tick();
    expect(r.summary().messaging).toMatchObject({ reported: true, serverSays: true });
  });
});

describe('StatusRelay: the footer status is sent on change and on attach (#999)', () => {
  it('sends a text once, and nothing again while it is the same', () => {
    const sent: string[] = [];
    const relay = new StatusRelay(async (s) => void sent.push(s.text));
    relay.push('online');
    relay.push('online');
    relay.push('online');
    expect(sent).toEqual(['online']);
  });

  it('sends an empty text when the status goes away, so the footer clears', () => {
    const sent: string[] = [];
    const relay = new StatusRelay(async (s) => void sent.push(s.text));
    relay.push('online');
    relay.push(null);
    relay.push(null);
    expect(sent).toEqual(['online', '']);
  });

  it('sends nothing for a status that was never there', () => {
    const sent: string[] = [];
    new StatusRelay(async (s) => void sent.push(s.text)).push(null);
    expect(sent).toEqual([]);
  });

  it('hands the current text to a TUI part that attaches late, and only when there is one', () => {
    const sent: string[] = [];
    const relay = new StatusRelay(async (s) => void sent.push(s.text));
    relay.attached();
    expect(sent).toEqual([]);
    relay.push('online');
    relay.attached();
    expect(sent).toEqual(['online', 'online']);
  });

  it('is not sent when there is nowhere to send it, and is sent once a sender exists', () => {
    const sent: string[] = [];
    const relay = new StatusRelay();
    relay.push('online');
    relay.send = async (s) => void sent.push(s.text);
    relay.attached();
    expect(sent).toEqual(['online']);
  });

  it('survives a failing send', async () => {
    const relay = new StatusRelay(async () => Promise.reject(new Error('gone')));
    expect(() => relay.push('online')).not.toThrow();
  });
});

describe('the Admin callout is never lost to another toast, because the host shows one toast at a time (#1051, found in a live run)', () => {
  function keeper() {
    const t = { now: 0 };
    const shown: { message: string; duration?: number }[] = [];
    const timers: { at: number; fn: () => void }[] = [];
    const k = new ToastKeeper((n) => void shown.push({ message: n.message, ...(n.duration === undefined ? {} : { duration: n.duration }) }), () => t.now, (ms, fn) => void timers.push({ at: t.now + ms, fn }));
    /** Moves the clock and runs the timers that fell due. */
    const advance = (ms: number) => {
      t.now += ms;
      for (const x of timers.filter((y) => y.at <= t.now)) { timers.splice(timers.indexOf(x), 1); x.fn(); }
    };
    return { k, shown, advance };
  }
  const admin = (message = 'Podium: Admin (an Admin) is reading your Podium group.'): NoticeEvent => ({ message, title: 'Podium', variant: 'info', duration: 60_000, id: 'rd-1', admin: true });

  it('shows the Admin toast again after a status toast that came 14 ms behind it displaced it, for the time it has left', () => {
    const { k, shown, advance } = keeper();
    k.offer(admin());
    advance(14);
    k.offer({ message: 'podium v1 | dev ● 1 live', variant: 'info' });
    expect(shown.map((s) => s.message)).toEqual(['Podium: Admin (an Admin) is reading your Podium group.', 'podium v1 | dev ● 1 live']);
    advance(6000);
    expect(shown).toHaveLength(3);
    expect(shown[2]).toEqual({ message: 'Podium: Admin (an Admin) is reading your Podium group.', duration: 60_000 - 6014 });
  });

  it('shows nothing again once the Admin toast has run its time, or when no Admin toast is up', () => {
    const { k, shown, advance } = keeper();
    k.offer({ message: 'plain', variant: 'info' });
    advance(10_000);
    expect(shown).toHaveLength(1);
    k.offer(admin());
    advance(61_000);
    k.offer({ message: 'later', variant: 'info' });
    advance(10_000);
    expect(shown.map((s) => s.message)).toEqual(['plain', 'Podium: Admin (an Admin) is reading your Podium group.', 'later']);
  });

  it('shows it again only after the last of several toasts, not between them', () => {
    const { k, shown, advance } = keeper();
    k.offer(admin());
    k.offer({ message: 'one', variant: 'info' });
    advance(2000);
    k.offer({ message: 'two', variant: 'info' });
    advance(4000);
    expect(shown.map((s) => s.message)).toEqual([admin().message, 'one', 'two']);
    advance(2000);
    expect(shown.map((s) => s.message)).toEqual([admin().message, 'one', 'two', admin().message]);
  });

  it('a second Admin toast replaces the first as the one shown again', () => {
    const { k, shown, advance } = keeper();
    k.offer(admin('first'));
    k.offer({ ...admin('second'), id: 'rd-2' });
    k.offer({ message: 'status', variant: 'info' });
    advance(6000);
    expect(shown.map((s) => s.message)).toEqual(['first', 'second', 'status', 'second']);
  });
});

describe('the Admin board: the lines that stay where the host has no transcript (#1051)', () => {
  it('lists each notice once, oldest first, and drops it after the keep time', () => {
    const b = new AdminBoard(600_000);
    b.add('a', 'Podium: A (an Admin) is reading your Podium group.', 1000);
    b.add('b', 'Podium: B (an Admin) removed all messages in your Podium group.', 2000);
    b.add('a', 'Podium: A (an Admin) is reading your Podium group.', 3000);
    expect(b.lines(4000)).toEqual(['Podium: A (an Admin) is reading your Podium group.', 'Podium: B (an Admin) removed all messages in your Podium group.']);
    expect(b.lines(601_500)).toEqual(['Podium: B (an Admin) removed all messages in your Podium group.']);
    expect(b.lines(700_000)).toEqual([]);
  });
  it('keeps at most a few lines, the newest', () => {
    const b = new AdminBoard(600_000, 3);
    for (let i = 0; i < 5; i++) b.add(`id${i}`, `line ${i}`, i);
    expect(b.lines(10)).toEqual(['line 2', 'line 3', 'line 4']);
  });
});
