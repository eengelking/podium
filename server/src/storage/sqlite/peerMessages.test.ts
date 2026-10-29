// Orchestrator messaging (#347, #412): the message store, against a fake rights view and a fake reporter lookup.
import { describe, it, expect } from 'vitest';
import { openDb } from './db.js';
import { PeerMessages, MAX_NOTICES, cleanPeerText, roundTripsUsed } from './peerMessages.js';
import { linkKey, type LiveOrchestrator, type MessageTrail, type PeerRequestRow, type PeerRightsView, type ReporterRef, type SendOutcome, type Refusal } from '../../fleet/peerTypes.js';
import { PEER_LIMITS, type PeerLevel } from '../../fleet/protocol.js';

const T0 = 1_800_000_000_000;
const ID = /^dlv_[0-9a-f]{24}$/;

function reporter(key: string, machine: string, extra: Partial<ReporterRef> = {}): ReporterRef {
  return { key, machine, owner: 'Ed', adminSecret: false, os: null, peers: true, version: '1.2.0', ...extra };
}

const REPORTERS: ReporterRef[] = [
  reporter('r-mbp', 'ed-mbp', { os: 'macOS 26.1' }),
  reporter('r-ci', 'ci-runner-01', { os: 'Ubuntu 24.04' }),
  reporter('r-pi', 'build-pi'),
  reporter('r-win', 'win-lab', { peers: false }),
  reporter('r-old', 'old-box', { peers: null }),
  reporter('r-hid', 'hidden-box'),
  reporter('r-idle', 'idle-box'),
  reporter('r-adm', 'admin-box', { adminSecret: true }),
  reporter('r-ann', 'ann-box', { owner: 'Ann' }),
];

function orch(sessionId: string, reporterKey: string, name: string, machine: string, extra: Partial<LiveOrchestrator> = {}): LiveOrchestrator {
  return { sessionId, reporterKey, owner: 'Ed', name, machine, os: null, project: '~/dev/podium', status: 'running', waitReason: null, peers: true, ...extra };
}

const MBP = orch('s-mbp', 'r-mbp', 'claude-dashboard', 'ed-mbp');
const CI = orch('s-ci', 'r-ci', 'Tester', 'ci-runner-01', { status: 'waiting', waitReason: 'input', os: 'Ubuntu 24.04' });
const PI = orch('s-pi', 'r-pi', 'arm64-check', 'build-pi');

/** A store with Ed's three orchestrators live, and rights both ways between ed-mbp and ci-runner-01, with approval to build-pi. */
function setup() {
  let now = T0;
  const levels = new Map<string, PeerLevel>();
  const paused = new Set<string>();
  const limits = { roundTrips: 10, perMinute: 6, maxChars: 20_000 };
  const opened: Parameters<PeerRightsView['openMessageRequest']>[0][] = [];
  const closed: [string, string][] = [];
  const rights: PeerRightsView = {
    effective: (f, t) => ({ level: levels.get(`${f}>${t}`) ?? 'none', paused: paused.has(linkKey(f, t)) }),
    limits: () => limits,
    openMessageRequest: (input) => {
      opened.push(input);
      return { id: `req_${opened.length}` } as PeerRequestRow;
    },
    closeMessageRequest: (id, outcome) => {
      closed.push([id, outcome]);
    },
  };
  const reps = new Map(REPORTERS.map((r) => [r.key, r]));
  const lookup = {
    get: (k: string) => reps.get(k) ?? null,
    ofOwner: (o: string) => REPORTERS.filter((r) => r.owner?.toLowerCase() === o.toLowerCase()),
  };
  const trails: MessageTrail[] = [];
  const db = openDb(':memory:');
  const s = new PeerMessages(db, rights, lookup, () => now, (t) => trails.push(t));
  const set = (f: string, t: string, l: PeerLevel) => levels.set(`${f}>${t}`, l);
  set('r-mbp', 'r-ci', 'send');
  set('r-ci', 'r-mbp', 'send');
  set('r-mbp', 'r-pi', 'ask');
  for (const o of [MBP, CI, PI]) s.note(o);
  return {
    s,
    db,
    set,
    pause: (a: string, b: string) => paused.add(linkKey(a, b)),
    limits,
    opened,
    closed,
    trails,
    tick: (ms = 1) => (now += ms),
    count: () => (db.prepare('SELECT COUNT(*) AS n FROM peer_messages').get() as { n: number }).n,
    stateOf: (id: string) => db.prepare('SELECT state, why, approved, handed FROM peer_messages WHERE id = ?').get(id) as { state: string; why: string | null; approved: number; handed: number },
  };
}

const ok = (r: SendOutcome | Refusal): SendOutcome => {
  if (!r.ok) throw new Error(`refused: ${r.status} ${r.error}`);
  return r;
};

describe('cleanPeerText', () => {
  it('replaces control characters other than a line break and a tab with a space', () => {
    expect(cleanPeerText('a\u0000b\u0007c\rd\u001be\u007ff\ng\th')).toBe('a b c d e f\ng\th');
    expect(cleanPeerText('plain ✓ text')).toBe('plain ✓ text');
  });
});

describe('roundTripsUsed', () => {
  const r = (fromSession: string, extra: Partial<{ state: 'ready' | 'declined' | 'dropped'; approved: boolean }> = {}) => ({ fromSession, state: extra.state ?? 'ready', approved: extra.approved ?? false });
  it('counts each change of direction as half a round trip, rounded up', () => {
    expect(roundTripsUsed([])).toBe(0);
    expect(roundTripsUsed([r('a'), r('a')])).toBe(0);
    expect(roundTripsUsed([r('a'), r('b')])).toBe(1);
    expect(roundTripsUsed([r('a'), r('b'), r('a')])).toBe(1);
    expect(roundTripsUsed([r('a'), r('b'), r('a'), r('b')])).toBe(2);
  });
  it('counts from the newest approved message, and skips declined and dropped ones', () => {
    expect(roundTripsUsed([r('a'), r('b'), r('a', { approved: true }), r('b')])).toBe(1);
    expect(roundTripsUsed([r('a'), r('b', { state: 'declined' }), r('b', { state: 'dropped' }), r('a')])).toBe(0);
  });
});

describe('PeerMessages: defaults', () => {
  it('runs on the wall clock with no trail', () => {
    const rights: PeerRightsView = {
      effective: () => ({ level: 'send', paused: false }),
      limits: () => ({ roundTrips: 10, perMinute: 6, maxChars: 100 }),
      openMessageRequest: () => ({ id: 'req' }) as PeerRequestRow,
      closeMessageRequest: () => {},
    };
    const reps = new Map(REPORTERS.map((r) => [r.key, r]));
    const s = new PeerMessages(openDb(':memory:'), rights, { get: (k) => reps.get(k) ?? null, ofOwner: () => [] });
    s.note(MBP);
    s.note(CI);
    const before = Date.now();
    const r = ok(s.send('s-mbp', 'Tester@ci-runner-01', 'hi'));
    expect(s.conversation('s-mbp', 's-ci')[0].sentAt).toBeGreaterThanOrEqual(before);
    expect(r.state).toBe('sent');
  });
});

describe('PeerMessages: the live directory', () => {
  it('notes an orchestrator, and forgets it when it reports done', () => {
    const { s } = setup();
    expect(s.live('s-ci')).toEqual(CI);
    expect(s.live('s-none')).toBeNull();
    s.note({ ...CI, status: 'done' });
    expect(s.live('s-ci')).toBeNull();
  });
});

describe('PeerMessages: sending', () => {
  it('sends to an idle orchestrator: stored ready, state sent, trailed', () => {
    const { s, trails, stateOf } = setup();
    const r = ok(s.send('s-mbp', 'Tester@ci-runner-01', 'Please run the systemd unit tests'));
    expect(r.id).toMatch(ID);
    expect(r).toMatchObject({ state: 'sent', paused: false, approvalWhy: null, requestId: null, to: { name: 'Tester', machine: 'ci-runner-01' }, roundTrips: { used: 0, cap: 10 } });
    expect(stateOf(r.id)).toEqual({ state: 'ready', why: null, approved: 0, handed: 0 });
    expect(trails).toHaveLength(1);
    expect(trails[0]).toMatchObject({ kind: 'sent', state: 'sent', approvalWhy: null, message: { id: r.id, owner: 'Ed', link: linkKey('r-mbp', 'r-ci'), fromName: 'claude-dashboard', toName: 'Tester', sentAt: T0 } });
  });

  it('says turn when the receiver is working or at a permission prompt', () => {
    const { s, set } = setup();
    set('r-ci', 'r-pi', 'send');
    expect(ok(s.send('s-ci', 'arm64-check@build-pi', 'hi')).state).toBe('turn');
    s.note({ ...CI, waitReason: 'permission' });
    expect(ok(s.send('s-mbp', 'Tester@ci-runner-01', 'hi')).state).toBe('turn');
  });

  it('resolves the address case-insensitively, trimmed, split at the last @', () => {
    const { s } = setup();
    s.note(orch('s-at', 'r-ci', 'me@work', 'ci-runner-01'));
    expect(ok(s.send('s-mbp', '  tester @ CI-RUNNER-01 ', 'hi')).to).toEqual({ name: 'Tester', machine: 'ci-runner-01' });
    expect(ok(s.send('s-mbp', 'me@work@ci-runner-01', 'hi')).to).toEqual({ name: 'me@work', machine: 'ci-runner-01' });
  });

  it('refuses an orchestrator the sender cannot find with one 404 that does not say why', () => {
    const { s, count } = setup();
    s.note(orch('s-hid', 'r-hid', 'Hidden', 'hidden-box'));
    s.note(orch('s-off', 'r-ci', 'Off', 'ci-runner-01', { peers: false }));
    s.note(orch('s-old', 'r-ci', 'Old', 'ci-runner-01', { peers: undefined }));
    s.note(orch('s-adm', 'r-adm', 'Adm', 'admin-box'));
    s.note(orch('s-gone', 'r-missing', 'Gone', 'nowhere'));
    for (const to of ['Nobody@ed-mbp', 'build-pi-2', 'Hidden@hidden-box', 'Off@ci-runner-01', 'Old@ci-runner-01', 'Adm@admin-box', 'Gone@nowhere']) {
      expect(s.send('s-mbp', to, 'hi')).toEqual({ ok: false, status: 404, error: `You cannot see an orchestrator called ${to}. Run podium_peers for the list.` });
    }
    expect(count()).toBe(0);
  });

  it("never finds another owner's orchestrator, whatever the rights say, and stores nothing", () => {
    const { s, set, count } = setup();
    s.note(orch('s-ann', 'r-ann', 'Helper', 'ann-box', { owner: 'Ann' }));
    set('r-mbp', 'r-ann', 'send');
    expect(s.send('s-mbp', 'Helper@ann-box', 'hi')).toMatchObject({ ok: false, status: 404 });
    expect(count()).toBe(0);
  });

  it('refuses two orchestrators of one name with a 409, and the sender itself with a 422', () => {
    const { s, count } = setup();
    s.note(orch('s-ci2', 'r-ci', 'tester', 'ci-runner-01'));
    const two = s.send('s-mbp', 'Tester@ci-runner-01', 'hi') as Refusal;
    expect(two.status).toBe(409);
    expect(two.error).toContain('There are 2 orchestrators called Tester@ci-runner-01');
    expect(two.error).toContain('Tester@ci-runner-01#s-ci');
    expect(s.send('s-mbp', 'claude-dashboard@ed-mbp', 'hi')).toMatchObject({ ok: false, status: 422 });
    expect(count()).toBe(0);
  });

  it('tells same-named orchestrators apart by id: lists each id, flags the duplicates, and sends to exactly the one named (#500)', () => {
    const { s, count } = setup();
    s.note(orch('abcd1234-0000', 'r-ci', 'Tester', 'ci-runner-01'));
    s.note(orch('ef567890-0000', 'r-ci', 'Tester', 'ci-runner-01'));
    const twins = s.list('s-mbp').peers.filter((p) => p.name === 'Tester');
    expect(twins.map((p) => [p.id, p.duplicate])).toEqual([
      ['abcd1234', true],
      ['ef567890', true],
      ['s-ci', true],
    ]);
    const sent = ok(s.send('s-mbp', 'Tester@ci-runner-01#ef567890', 'hi'));
    expect(s.deliveriesFor('abcd1234-0000', true)).toEqual([]);
    expect(s.deliveriesFor('s-ci', true)).toEqual([]);
    expect(s.deliveriesFor('ef567890-0000', true).map((d) => d.id)).toEqual([sent.id]);
    expect(count()).toBe(1);
  });

  it('refuses a bare duplicated address with the ids to use, and an id that matches nobody, or two, with the same 404/409 (#500)', () => {
    const { s, count } = setup();
    s.note(orch('abcd1234-0000', 'r-ci', 'Tester', 'ci-runner-01'));
    s.note(orch('abcd9999-0000', 'r-ci', 'Tester', 'ci-runner-01'));
    const bare = s.send('s-mbp', 'Tester@ci-runner-01', 'hi') as Refusal;
    expect(bare.status).toBe(409);
    expect(bare.error).toContain('Tester@ci-runner-01#abcd1234');
    expect(bare.error).toContain('Tester@ci-runner-01#abcd9999');
    expect(bare.error).toContain('Tester@ci-runner-01#s-ci');
    expect(s.send('s-mbp', 'Tester@ci-runner-01#ffff', 'hi')).toMatchObject({ ok: false, status: 404 });
    expect(s.send('s-mbp', 'Tester@ci-runner-01#abcd', 'hi')).toMatchObject({ ok: false, status: 409 });
    expect(s.send('s-mbp', 'Tester@ci-runner-01#', 'hi')).toMatchObject({ ok: false, status: 409 });
    expect(s.send('s-mbp', 'claude-dashboard@ed-mbp#s-mbp', 'hi')).toMatchObject({ ok: false, status: 422 });
    expect(count()).toBe(0);
  });

  it('still finds a machine whose own name holds a # (#500)', () => {
    const { s } = setup();
    s.note(orch('s-hash', 'r-ci', 'Odd', 'lab#2'));
    expect(ok(s.send('s-mbp', 'Odd@lab#2', 'hi')).to).toEqual({ name: 'Odd', machine: 'lab#2' });
  });

  it('carries the sender\'s id in a delivery, so the receiver can answer the right session (#500)', () => {
    const { s } = setup();
    s.note(orch('abcd1234-0000', 'r-mbp', 'claude-dashboard', 'ed-mbp'));
    ok(s.send('abcd1234-0000', 'Tester@ci-runner-01', 'hi'));
    expect(s.deliveriesFor('s-ci', true)[0]?.from).toEqual({ name: 'claude-dashboard', machine: 'ed-mbp', owner: 'Ed', id: 'abcd1234' });
  });

  it('refuses a sender that is not live, has messaging off, is too old, or is on the admin secret', () => {
    const { s, count } = setup();
    s.note(orch('s-off', 'r-mbp', 'off', 'ed-mbp', { peers: false }));
    s.note(orch('s-old', 'r-mbp', 'old', 'ed-mbp', { peers: undefined }));
    s.note(orch('s-adm', 'r-adm', 'adm', 'admin-box'));
    for (const sid of ['s-none', 's-off', 's-old', 's-adm']) expect(s.send(sid, 'Tester@ci-runner-01', 'hi')).toMatchObject({ ok: false, status: 403 });
    expect(count()).toBe(0);
  });

  it('cleans the text, refuses it empty, and refuses (never cuts) it over the limit', () => {
    const { s, db, limits, count } = setup();
    const r = ok(s.send('s-mbp', 'Tester@ci-runner-01', 'line\u0007one\nline\ttwo'));
    expect((db.prepare('SELECT text FROM peer_messages WHERE id = ?').get(r.id) as { text: string }).text).toBe('line one\nline\ttwo');
    expect(s.send('s-mbp', 'Tester@ci-runner-01', ' \u0000\n ')).toMatchObject({ ok: false, status: 400 });
    expect(s.send('s-mbp', 'Tester@ci-runner-01', 'x'.repeat(25_000))).toEqual({
      ok: false,
      status: 422,
      error: 'The message is 25,000 characters, over the limit of 20,000 on this link. Send a shorter one, or a file path instead of the file.',
    });
    limits.maxChars = 5;
    expect(ok(s.send('s-mbp', 'Tester@ci-runner-01', 'x'.repeat(5))).state).toBe('sent');
    expect(s.send('s-mbp', 'Tester@ci-runner-01', 'x'.repeat(6))).toMatchObject({ ok: false, status: 422 });
    expect(count()).toBe(2);
  });

  it('refuses a right to see only with a 403 that says to ask for access', () => {
    const { s, set, count } = setup();
    set('r-ci', 'r-pi', 'see');
    const r = s.send('s-ci', 'arm64-check@build-pi', 'hi') as Refusal;
    expect(r.status).toBe(403);
    expect(r.error).toBe('ci-runner-01 can see build-pi but has no right to send there. Ask Ed for one with podium_request_access.');
    expect(count()).toBe(0);
  });

  it('holds a message on a link with approval and opens its request', () => {
    const { s, opened, stateOf } = setup();
    const r = ok(s.send('s-mbp', 'arm64-check@build-pi', 'Also run npm run test:mod there'));
    expect(r).toMatchObject({ state: 'approval', approvalWhy: 'link', requestId: 'req_1' });
    expect(opened).toEqual([{ owner: 'Ed', fromKey: 'r-mbp', toKey: 'r-pi', by: 'claude-dashboard', fromSession: 's-mbp', messageId: r.id }]);
    expect(stateOf(r.id).state).toBe('approval');
  });

  it('says when the link is paused', () => {
    const { s, pause } = setup();
    pause('r-ci', 'r-mbp');
    expect(ok(s.send('s-mbp', 'Tester@ci-runner-01', 'hi')).paused).toBe(true);
  });

  it('refuses over the per-minute rate on the link, counting both directions, and takes it again a minute on', () => {
    const { s, limits, tick, count } = setup();
    limits.perMinute = 2;
    ok(s.send('s-mbp', 'Tester@ci-runner-01', 'one'));
    tick(1000);
    ok(s.send('s-ci', 'claude-dashboard@ed-mbp', 'two'));
    tick(1000);
    const r = s.send('s-mbp', 'Tester@ci-runner-01', 'three') as Refusal;
    expect(r.status).toBe(429);
    expect(r.error).toContain('Wait a minute');
    expect(count()).toBe(2);
    tick(59_000);
    expect(ok(s.send('s-mbp', 'Tester@ci-runner-01', 'three')).state).toBe('sent');
  });

  it('holds the next message once the round-trip cap is reached, and counts from an approved one', () => {
    const { s, limits, tick, trails } = setup();
    limits.roundTrips = 2;
    const back = (from: string, to: string) => {
      tick();
      return ok(s.send(from, to, 'msg'));
    };
    expect(back('s-mbp', 'Tester@ci-runner-01').roundTrips).toEqual({ used: 0, cap: 2 });
    expect(back('s-ci', 'claude-dashboard@ed-mbp').roundTrips.used).toBe(1);
    expect(back('s-mbp', 'Tester@ci-runner-01').roundTrips.used).toBe(1);
    expect(back('s-ci', 'claude-dashboard@ed-mbp').roundTrips.used).toBe(2);
    const held = back('s-mbp', 'Tester@ci-runner-01');
    expect(held).toMatchObject({ state: 'approval', approvalWhy: 'round-trips', requestId: 'req_1', roundTrips: { used: 2, cap: 2 } });
    expect(trails.at(-1)).toMatchObject({ kind: 'sent', state: 'approval', approvalWhy: 'round-trips' });
    expect(s.approve(held.id, { name: 'Ed', admin: false })).toBe(true);
    const next = back('s-ci', 'claude-dashboard@ed-mbp');
    expect(next).toMatchObject({ state: 'turn', approvalWhy: null, roundTrips: { used: 1, cap: 2 } });
  });
});

describe('PeerMessages: delivery and results', () => {
  it('hands messages over only while idle, oldest first with notices, and marks them handed', () => {
    const { s, tick, stateOf } = setup();
    const a = ok(s.send('s-mbp', 'Tester@ci-runner-01', 'first'));
    tick();
    s.notice('s-ci', 'A notice');
    tick();
    const b = ok(s.send('s-mbp', 'Tester@ci-runner-01', 'second'));
    expect(s.deliveriesFor('s-ci', false)).toEqual([{ id: expect.stringMatching(ID), kind: 'notice', at: T0 + 1, from: null, text: 'A notice' }]);
    expect(stateOf(a.id).state).toBe('ready');
    const d = s.deliveriesFor('s-ci', true);
    expect(d.map((x) => x.kind)).toEqual(['message', 'notice', 'message']);
    expect(d[0]).toEqual({ id: a.id, kind: 'message', at: T0, from: { name: 'claude-dashboard', machine: 'ed-mbp', owner: 'Ed', id: 's-mbp' }, text: 'first' });
    expect(stateOf(a.id)).toMatchObject({ state: 'handed', handed: 1 });
    expect(stateOf(b.id)).toMatchObject({ state: 'handed', handed: 1 });
    // No result yet: handed again.
    expect(s.deliveriesFor('s-ci', true).filter((x) => x.kind === 'message').map((x) => x.id)).toEqual([a.id, b.id]);
  });

  it('holds messages on a paused link and those waiting for approval', () => {
    const { s, pause } = setup();
    ok(s.send('s-mbp', 'arm64-check@build-pi', 'needs approval'));
    expect(s.deliveriesFor('s-pi', true)).toEqual([]);
    ok(s.send('s-mbp', 'Tester@ci-runner-01', 'paused'));
    pause('r-mbp', 'r-ci');
    expect(s.deliveriesFor('s-ci', true)).toEqual([]);
  });

  it(`hands over at most ${PEER_LIMITS.deliveries} at once`, () => {
    const { s, limits, tick } = setup();
    limits.perMinute = 60;
    for (let i = 0; i < 25; i++) {
      tick();
      ok(s.send('s-mbp', 'Tester@ci-runner-01', `m${i}`));
    }
    const d = s.deliveriesFor('s-ci', true);
    expect(d).toHaveLength(PEER_LIMITS.deliveries);
    expect(d[0].text).toBe('m0');
  });

  it('records took, queued and refused, says repeat once, and unknown for the rest', () => {
    const { s, trails, closed, stateOf } = setup();
    const a = ok(s.send('s-mbp', 'Tester@ci-runner-01', 'a'));
    const b = ok(s.send('s-mbp', 'Tester@ci-runner-01', 'b'));
    const c = ok(s.send('s-mbp', 'Tester@ci-runner-01', 'c'));
    s.deliveriesFor('s-ci', true);
    trails.length = 0;

    expect(s.result('s-mbp', a.id, 'took')).toBe('unknown');
    expect(s.result('s-ci', 'dlv_nope', 'took')).toBe('unknown');

    expect(s.result('s-ci', a.id, 'took')).toBe('new');
    expect(stateOf(a.id).state).toBe('delivered');
    expect(s.result('s-ci', a.id, 'took')).toBe('repeat');
    expect(s.result('s-ci', a.id, 'queued')).toBe('unknown');

    expect(s.result('s-ci', b.id, 'queued')).toBe('new');
    expect(s.result('s-ci', b.id, 'queued')).toBe('repeat');
    expect(stateOf(b.id).state).toBe('queued');
    expect(s.result('s-ci', b.id, 'took')).toBe('new');
    expect(stateOf(b.id).state).toBe('delivered');

    expect(s.result('s-ci', c.id, 'refused')).toBe('new');
    expect(stateOf(c.id)).toMatchObject({ state: 'dropped', why: 'refused' });
    expect(s.result('s-ci', c.id, 'refused')).toBe('repeat');
    expect(s.result('s-ci', c.id, 'took')).toBe('unknown');
    expect(closed).toEqual([[c.id, 'dropped']]);

    expect(trails.map((t) => t.kind)).toEqual(['delivered', 'delivered', 'dropped']);
    expect(trails[2]).toMatchObject({ kind: 'dropped', why: 'refused' });
    expect(s.deliveriesFor('s-mbp', false).map((d) => d.text)).toEqual(["Your message to Tester on ci-runner-01 was not delivered: Tester's session did not take it. It stays in Podium > Traffic."]);
  });

  it('takes no result for a message still waiting for approval', () => {
    const { s } = setup();
    const r = ok(s.send('s-mbp', 'arm64-check@build-pi', 'x'));
    expect(s.result('s-pi', r.id, 'took')).toBe('unknown');
  });

  it("removes a notice on its result, and says unknown for a gone one", () => {
    const { s } = setup();
    s.notice('s-ci', 'hello');
    const [n] = s.deliveriesFor('s-ci', false);
    expect(s.result('s-ci', n.id, 'took')).toBe('new');
    expect(s.result('s-ci', n.id, 'took')).toBe('unknown');
    expect(s.deliveriesFor('s-ci', false)).toEqual([]);
  });
});

describe('PeerMessages: approval', () => {
  it('approves a held message once: ready, approved, trailed', () => {
    const { s, trails, stateOf } = setup();
    const r = ok(s.send('s-mbp', 'arm64-check@build-pi', 'x'));
    const actor = { name: 'Ed', admin: false };
    expect(s.approve(r.id, actor)).toBe(true);
    expect(stateOf(r.id)).toMatchObject({ state: 'ready', approved: 1 });
    expect(trails.at(-1)).toMatchObject({ kind: 'approved', actor, message: { id: r.id, state: 'ready', approved: true } });
    expect(s.approve(r.id, actor)).toBe(false);
    expect(s.approve('dlv_nope', actor)).toBe(false);
    expect(s.decline(r.id, actor)).toBe(false);
  });

  it('declines a held message and tells its sender', () => {
    const { s, trails, stateOf } = setup();
    const r = ok(s.send('s-mbp', 'arm64-check@build-pi', 'x'));
    const actor = { name: 'Ed', admin: false };
    expect(s.decline(r.id, actor)).toBe(true);
    expect(stateOf(r.id).state).toBe('declined');
    expect(trails.at(-1)).toMatchObject({ kind: 'declined', actor });
    expect(s.deliveriesFor('s-mbp', false).map((d) => d.text)).toEqual(['Your message to arm64-check on build-pi was declined by Ed. It stays in Podium > Traffic.']);
    expect(s.decline(r.id, actor)).toBe(false);
  });
});

describe('PeerMessages: notices', () => {
  it(`keeps at most ${MAX_NOTICES} per orchestrator, and none for one that is not live`, () => {
    const { s, tick } = setup();
    for (let i = 0; i < MAX_NOTICES + 3; i++) {
      tick();
      s.notice('s-ci', `n${i}`);
    }
    const d = s.deliveriesFor('s-ci', false);
    expect(d).toHaveLength(MAX_NOTICES);
    expect(d[0].text).toBe('n3');
    s.notice('s-none', 'lost');
    expect(s.deliveriesFor('s-none', false)).toEqual([]);
  });
});

describe('PeerMessages: drops', () => {
  it('drops the held messages to an orchestrator that ended, tells their senders, and keeps what it sent', () => {
    const { s, set, trails, closed, stateOf } = setup();
    set('r-ci', 'r-pi', 'send');
    const toCi = ok(s.send('s-mbp', 'Tester@ci-runner-01', 'x'));
    const fromCi = ok(s.send('s-ci', 'arm64-check@build-pi', 'y'));
    s.note({ ...CI, status: 'done' });
    expect(stateOf(toCi.id)).toMatchObject({ state: 'dropped', why: 'receiver-ended' });
    expect(stateOf(fromCi.id).state).toBe('ready');
    expect(closed).toEqual([[toCi.id, 'dropped']]);
    expect(trails.at(-1)).toMatchObject({ kind: 'dropped', why: 'receiver-ended' });
    expect(s.deliveriesFor('s-mbp', false).map((d) => d.text)).toEqual(['Your message to Tester on ci-runner-01 was not delivered: Tester ended first. It stays in Podium > Traffic.']);
    expect(s.live('s-ci')).toBeNull();
  });

  it('drops held messages to or from deleted sessions, then deletes all their messages, telling only live senders', () => {
    const { s, set, tick, stateOf, count } = setup();
    set('r-ci', 'r-pi', 'send');
    const done = ok(s.send('s-mbp', 'Tester@ci-runner-01', 'old'));
    s.deliveriesFor('s-ci', true);
    s.result('s-ci', done.id, 'took');
    tick();
    ok(s.send('s-mbp', 'Tester@ci-runner-01', 'held to ci'));
    ok(s.send('s-ci', 'arm64-check@build-pi', 'held from ci'));
    const kept = ok(s.send('s-mbp', 'arm64-check@build-pi', 'other'));
    s.deleted(['s-ci']);
    expect(count()).toBe(1);
    expect(stateOf(kept.id).state).toBe('approval');
    expect(s.live('s-ci')).toBeNull();
    expect(s.deliveriesFor('s-mbp', false).map((d) => d.text)).toEqual(["Your message to Tester on ci-runner-01 was not delivered: Tester's session was deleted in Podium. It stays in Podium > Traffic."]);
  });

  it('drops the held messages on a removed link and tells their senders', () => {
    const { s, stateOf } = setup();
    const r = ok(s.send('s-mbp', 'Tester@ci-runner-01', 'x'));
    const other = ok(s.send('s-mbp', 'arm64-check@build-pi', 'y'));
    s.linkRemoved('r-ci', 'r-mbp');
    expect(stateOf(r.id)).toMatchObject({ state: 'dropped', why: 'link-removed' });
    expect(stateOf(other.id).state).toBe('approval');
    expect(s.deliveriesFor('s-mbp', false).map((d) => d.text)).toEqual(['Your message to Tester on ci-runner-01 was not delivered: the link between ed-mbp and ci-runner-01 was removed. It stays in Podium > Traffic.']);
  });

  it('drops every held message when messaging goes off, and clears every notice', () => {
    const { s, trails, closed, stateOf } = setup();
    const a = ok(s.send('s-mbp', 'Tester@ci-runner-01', 'x'));
    const b = ok(s.send('s-mbp', 'arm64-check@build-pi', 'y'));
    s.notice('s-ci', 'pending notice');
    s.dropAll();
    expect(stateOf(a.id)).toMatchObject({ state: 'dropped', why: 'messaging-off' });
    expect(stateOf(b.id)).toMatchObject({ state: 'dropped', why: 'messaging-off' });
    expect(closed).toHaveLength(2);
    expect(trails.filter((t) => t.kind === 'dropped')).toHaveLength(2);
    expect(s.deliveriesFor('s-mbp', false)).toEqual([]);
    expect(s.deliveriesFor('s-ci', false)).toEqual([]);
  });
});

describe('PeerMessages: podium_peers', () => {
  it('lists what the sender can see, and says why each other reporter is left out', () => {
    const { s, set, pause } = setup();
    set('r-mbp', 'r-hid', 'none');
    set('r-mbp', 'r-idle', 'see');
    set('r-mbp', 'r-adm', 'send');
    s.note(orch('s-hid', 'r-hid', 'Hidden', 'hidden-box'));
    s.note(orch('s-adm', 'r-adm', 'Adm', 'admin-box'));
    s.note(orch('s-ann', 'r-ann', 'Helper', 'ann-box', { owner: 'Ann' }));
    s.note(orch('s-mbp2', 'r-mbp', 'second', 'ed-mbp'));
    set('r-mbp', 'r-mbp', 'see');
    pause('r-mbp', 'r-pi');
    const { peers, leftOut } = s.list('s-mbp');
    expect(peers).toEqual([
      { address: 'arm64-check@build-pi', id: 's-pi', duplicate: false, name: 'arm64-check', machine: 'build-pi', os: null, project: '~/dev/podium', status: 'running', level: 'ask', paused: true },
      { address: 'second@ed-mbp', id: 's-mbp2', duplicate: false, name: 'second', machine: 'ed-mbp', os: null, project: '~/dev/podium', status: 'running', level: 'see', paused: false },
      { address: 'Tester@ci-runner-01', id: 's-ci', duplicate: false, name: 'Tester', machine: 'ci-runner-01', os: 'Ubuntu 24.04', project: '~/dev/podium', status: 'waiting', level: 'send', paused: false },
    ]);
    expect(leftOut).toEqual([
      { machine: 'win-lab', why: 'messaging off on the machine' },
      { machine: 'old-box', why: 'reporter too old to message' },
      { machine: 'hidden-box', why: 'no right to see it' },
      { machine: 'idle-box', why: 'no orchestrator running' },
    ]);
  });

  it('lists nothing for a session that cannot take part', () => {
    const { s } = setup();
    expect(s.list('s-none')).toEqual({ peers: [], leftOut: [] });
  });
});

describe('PeerMessages: conversations', () => {
  it('summarizes each pair of orchestrators without the text, and filters by owner, time and liveness', () => {
    const { s, set, tick, pause } = setup();
    set('r-pi', 'r-mbp', 'send');
    ok(s.send('s-mbp', 'Tester@ci-runner-01', 'one'));
    tick(10);
    ok(s.send('s-ci', 'claude-dashboard@ed-mbp', 'two'));
    tick(10);
    ok(s.send('s-mbp', 'arm64-check@build-pi', 'three'));
    const all = s.conversations({});
    expect(all).toHaveLength(2);
    const [pi, ci] = all;
    expect(pi).toEqual({
      link: linkKey('r-mbp', 'r-pi'),
      a: { sessionId: 's-mbp', name: 'claude-dashboard', machine: 'ed-mbp', reporterKey: 'r-mbp' },
      b: { sessionId: 's-pi', name: 'arm64-check', machine: 'build-pi', reporterKey: 'r-pi' },
      owner: 'Ed',
      messages: 1,
      lastAt: T0 + 20,
      state: 'waiting',
      paused: false,
      aToB: true,
      bToA: true,
      roundTrips: { used: 0, cap: 10 },
    });
    expect(ci).toMatchObject({ a: { sessionId: 's-ci' }, b: { sessionId: 's-mbp' }, messages: 2, lastAt: T0 + 10, state: 'active', aToB: true, bToA: true, roundTrips: { used: 1, cap: 10 } });
    expect(JSON.stringify(all)).not.toContain('one');
    pause('r-ci', 'r-mbp');
    expect(s.conversations({}).find((c) => c.a.sessionId === 's-ci')).toMatchObject({ state: 'paused', paused: true });
    // A paused link with a message waiting for approval reads `waiting`, and still says it is paused (#417).
    pause('r-mbp', 'r-pi');
    expect(s.conversations({}).find((c) => c.b.sessionId === 's-pi')).toMatchObject({ state: 'waiting', paused: true });
    expect(s.conversations({ owner: 'ed' })).toHaveLength(2);
    expect(s.conversations({ owner: 'Ann' })).toEqual([]);
    expect(s.conversations({ since: T0 + 15 }).map((c) => c.b.sessionId)).toEqual(['s-pi']);
    s.note({ ...CI, status: 'done' });
    s.note({ ...MBP, status: 'done' });
    expect(s.conversations({ liveOnly: true }).map((c) => c.b.sessionId)).toEqual(['s-pi']);
    s.note({ ...PI, status: 'done' });
    expect(s.conversations({ liveOnly: true })).toEqual([]);
  });

  it('says a direction cannot send when its right is only to see', () => {
    const { s, set } = setup();
    ok(s.send('s-mbp', 'Tester@ci-runner-01', 'x'));
    set('r-ci', 'r-mbp', 'see');
    expect(s.conversations({})[0]).toMatchObject({ a: { sessionId: 's-ci' }, aToB: false, bToA: true });
  });

  it('reads one conversation, both directions, oldest first, with the text', () => {
    const { s, tick } = setup();
    ok(s.send('s-mbp', 'Tester@ci-runner-01', 'one'));
    tick();
    ok(s.send('s-ci', 'claude-dashboard@ed-mbp', 'two'));
    tick();
    ok(s.send('s-mbp', 'arm64-check@build-pi', 'other'));
    expect(s.conversation('s-ci', 's-mbp').map((m) => m.text)).toEqual(['one', 'two']);
    expect(s.conversation('s-mbp', 's-ci').map((m) => m.fromSession)).toEqual(['s-mbp', 's-ci']);
  });

  it('deletes the messages of links whose newest message is older than the cutoff', () => {
    const { s, tick, count } = setup();
    ok(s.send('s-mbp', 'Tester@ci-runner-01', 'old'));
    tick(100);
    ok(s.send('s-mbp', 'arm64-check@build-pi', 'old pi'));
    tick(100);
    ok(s.send('s-ci', 'claude-dashboard@ed-mbp', 'new ci'));
    expect(s.retain(T0 + 150)).toBe(1);
    expect(count()).toBe(2);
    expect(s.conversation('s-mbp', 's-ci')).toHaveLength(2);
  });
});
