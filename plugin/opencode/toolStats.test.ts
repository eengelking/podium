// What each tool did beyond being called (#721), counted from OpenCode's events as the Claude Code reporter counts it from its hooks.
import { describe, expect, it } from 'vitest';
import { timeBucket } from '../core/protocol.ts';
import { buildReport } from './report.ts';
import { apply, newStore, type BusEvent } from './state.ts';
import { VERSION } from './version.ts';

let n = 0;
const ev = (type: string, data: Record<string, unknown>, created: number): BusEvent => ({ id: `e${++n}`, created, type, data, location: { directory: '/work/project' } });
const META = { now: 9000, version: VERSION, engineVersion: null, hostSurface: null };
const ROOT = 'ses_root';
const KID = 'ses_kid';

const start = (sid: string, id: string, name: string, input: Record<string, unknown>, at: number) => [
  ev('session.tool.input.started', { sessionID: sid, id, name }, at),
  ev('session.tool.called', { sessionID: sid, id, name, input }, at + 1),
];
const ok = (sid: string, id: string, at: number, extra: Record<string, unknown> = {}) => ev('session.tool.success', { sessionID: sid, id, content: [{ type: 'text', text: 'x' }], ...extra }, at);
const failed = (sid: string, id: string, at: number) => ev('session.tool.failed', { sessionID: sid, id, error: { message: 'no' } }, at);
const asked = (id: string, sid: string, callId: string, at: number) => ev('permission.asked', { id, sessionID: sid, action: 'bash', resources: ['x'], source: { type: 'tool', messageID: 'm', id: callId } }, at);
const replied = (id: string, reply: string, at: number) => ev('permission.replied', { requestID: id, sessionID: ROOT, reply }, at);

function world(...events: BusEvent[]) {
  const s = newStore();
  for (const e of [ev('session.created', { sessionID: ROOT, slug: 'x', version: '2.2.5' }, 1), ev('session.created', { sessionID: KID, parentID: ROOT, title: 'kid', agent: 'general' }, 2), ...events]) apply(s, e, e.created ?? 0);
  return s.roots.get(ROOT)!;
}
const main = (r: ReturnType<typeof world>) => buildReport(r, [], META).session.loop!.toolStats;
const kid = (r: ReturnType<typeof world>) => buildReport(r, [], META).agents[0]!.toolStats;

describe('call lengths', () => {
  it('count a call in the bucket of the time from when it started running to when it ended', () => {
    const r = world(...start(ROOT, 'c1', 'read', { filePath: '/a' }, 100), ok(ROOT, 'c1', 141));
    expect(main(r)).toEqual({ Read: { times: { [String(timeBucket(40))]: 1 } } });
  });

  it('leave out a call whose start was never seen, which has no length', () => {
    const r = world(ok(ROOT, 'orphan', 500));
    expect(main(r)).toEqual({});
  });
});

describe('failed calls', () => {
  it('count a call that failed, and a shell call that exited non-zero, and not one that succeeded', () => {
    const r = world(
      ...start(ROOT, 'c1', 'read', { filePath: '/a' }, 100), failed(ROOT, 'c1', 110),
      ...start(ROOT, 'c2', 'bash', { command: 'false' }, 120), ok(ROOT, 'c2', 130, { metadata: { exit: 1 } }),
      ...start(ROOT, 'c3', 'bash', { command: 'true' }, 140), ok(ROOT, 'c3', 150, { metadata: { exit: 0 } }),
    );
    const s = main(r);
    expect(s.Read).toMatchObject({ failed: 1 });
    expect(s.Bash).toMatchObject({ failed: 1 });
  });

  it('keep an agent apart from the main loop', () => {
    const r = world(...start(KID, 'k1', 'bash', { command: 'x' }, 100), failed(KID, 'k1', 110));
    expect(kid(r)).toMatchObject({ Bash: { failed: 1 } });
    expect(main(r)).toEqual({});
  });
});

describe('permission asks', () => {
  it('count an ask for the tool of its call, and allowed once it is answered with once or always', () => {
    const r = world(
      ...start(ROOT, 'c1', 'bash', { command: 'ls' }, 100), asked('p1', ROOT, 'c1', 102), replied('p1', 'once', 105), ok(ROOT, 'c1', 110),
      ...start(ROOT, 'c2', 'bash', { command: 'ls' }, 120), asked('p2', ROOT, 'c2', 122), replied('p2', 'always', 125), ok(ROOT, 'c2', 130),
    );
    expect(main(r)!.Bash).toMatchObject({ asked: 2, allowed: 2 });
    expect(main(r)!.Bash!.denied).toBeUndefined();
  });

  it('count a refusal as denied, and the call it stopped as denied and not as failed', () => {
    const r = world(...start(ROOT, 'c1', 'bash', { command: 'rm x' }, 100), asked('p1', ROOT, 'c1', 102), replied('p1', 'reject', 105), failed(ROOT, 'c1', 106));
    expect(main(r)!.Bash).toMatchObject({ asked: 1, denied: 1 });
    expect(main(r)!.Bash!.failed).toBeUndefined();
  });

  it('count an ask that is still open as asked and as neither answer', () => {
    const r = world(...start(ROOT, 'c1', 'bash', { command: 'ls' }, 100), asked('p1', ROOT, 'c1', 102));
    expect(main(r)!.Bash).toMatchObject({ asked: 1 });
    expect(main(r)!.Bash!.allowed).toBeUndefined();
  });

  it('count one answered from Podium, whichever way it went', () => {
    const s = newStore();
    for (const e of [ev('session.created', { sessionID: ROOT, slug: 'x', version: '2.2.5' }, 1), ...start(ROOT, 'c1', 'bash', { command: 'ls' }, 100), asked('p1', ROOT, 'c1', 102)]) apply(s, e, e.created ?? 0);
    const root = s.roots.get(ROOT)!;
    root.podiumAnswered.add('p1');
    for (const e of [replied('p1', 'once', 105), ok(ROOT, 'c1', 110)]) apply(s, e, e.created ?? 0);
    expect(main(root)!.Bash).toMatchObject({ asked: 1, allowed: 1, podium: 1 });
    expect(root.podiumAnswered.has('p1')).toBe(false);
  });

  it('name an ask whose call it cannot find by its action', () => {
    const r = world(ev('permission.asked', { id: 'p1', sessionID: ROOT, action: 'edit', resources: ['a'] }, 100));
    expect(main(r)).toEqual({ edit: { asked: 1 } });
  });
});
