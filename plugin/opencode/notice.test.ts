import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../core/transport.ts';
import { dedupe, deliver, noticeOf, podiumText, StatusWatcher, statusChange } from './notice.ts';
import { optionsOf } from './options.ts';
import { Reporter } from './reporter.ts';
import type { BusEvent } from './state.ts';

let n = 0;
const ev = (type: string, data: Record<string, unknown>, created: number): BusEvent => ({ id: `n${++n}`, created, type, data, location: { directory: '/work/project' } });

function reporter(reply: { status: number; text: string }, log: (l: string) => void = () => undefined) {
  const fetch: FetchLike = async () => ({ status: reply.status, ok: reply.status >= 200 && reply.status < 300, text: reply.text });
  return new Reporter({ fetch, now: () => 5000, runIn: () => async () => ({ exitCode: 1, stdout: '' }), log }, { ...optionsOf({}, null, { PODIUM_SERVER: 'http://podium.test:4317/', PODIUM_TOKEN: 't' }, null), idleMs: 600_000 });
}

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
    const text = podiumText(r.summary(), { serverUrl: r.opts.serverUrl, home: '/home/dana', tls: null, version: r.opts.version });
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
    expect(podiumText(down.summary(), { serverUrl: 'http://x', home: '/h', tls: null, version: '1' })).toContain('Connection: not tried yet');
    down.handle(ev('session.created', { sessionID: 'ses_b' }, 1000));
    await down.tick();
    const t = podiumText(down.summary(), { serverUrl: 'http://x', home: '/h', tls: 'connected over HTTPS', version: '1' });
    expect(t).toContain('Connection: offline, retrying');
    expect(t).toContain('Last error: connect ECONNREFUSED');
    expect(t).toContain('TLS: connected over HTTPS');
    const old = reporter({ status: 400, text: '{"path":"$.v"}' });
    old.handle(ev('session.created', { sessionID: 'ses_c' }, 1000));
    await old.tick();
    expect(podiumText(old.summary(), { serverUrl: 'http://x', home: '/h', tls: null, version: '1' })).toContain('report version 1');
  });

  it('counts dropped events when there are some', () => {
    const base = reporter({ status: 200, text: '{}' }).summary();
    expect(podiumText({ ...base, dropped: 3 }, { serverUrl: 'http://x', home: '/h', tls: null, version: '1' })).toContain(', dropped: 3');
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
