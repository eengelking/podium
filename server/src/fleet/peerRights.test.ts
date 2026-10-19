import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from './db.js';
import { ReporterStore, ADMIN_SECRET, type ReporterSeen } from './reporters.js';
import { PeerRights } from './peerRights.js';
import { OWNER_DEFAULTS, type Actor, type ReporterLookup, type RightsTrail } from './peerTypes.js';
import type { PeerLevel } from './protocol.js';
import type { PeerLimits } from './peerSettings.js';

const START = 1_000_000_000_000;
const SERVER: PeerLimits = { roundTrips: 10, perMinute: 6, maxChars: 20_000 };
const ADMIN: Actor = { name: 'Admin', admin: true };
const DANA: Actor = { name: 'Dana', admin: false };

let db: ReturnType<typeof openDb>;
let reporters: ReporterStore;
let lookup: ReporterLookup;
let t: number;
let trails: RightsTrail[];
let rights: PeerRights;

/** Records one reporter; the machine id is its key. */
const add = (key: string, over: Partial<ReporterSeen> = {}) =>
  reporters.record(
    {
      kind: 'mod',
      machineId: key,
      machineName: key,
      source: null,
      owner: 'Dana',
      credential: 'pdm_3f9a1c07b2e4',
      version: '1.2.0',
      engineVersion: null,
      sessionId: `s-${key}`,
      ...over,
    },
    START,
  );

beforeEach(() => {
  db = openDb(':memory:');
  reporters = new ReporterStore(db, START);
  lookup = reporters.peerLookup();
  t = START;
  trails = [];
  rights = new PeerRights(db, lookup, () => t, (x) => trails.push(x));
  add('mac');
  add('linux');
  add('pi');
  add('eve', { owner: 'Eve' });
  add('secret', { credential: ADMIN_SECRET });
  add('nobody', { owner: null });
  add('admin', { owner: 'Admin' });
});

const access = (over: Partial<Parameters<PeerRights['requestAccess']>[0]> = {}) =>
  rights.requestAccess({ owner: 'Dana', fromKey: 'mac', toKey: 'linux', right: 'see', reason: 'to compare notes', by: 'builder', fromSession: 's1', ...over });

const counts = () => ({
  rights: (db.prepare('SELECT COUNT(*) AS n FROM peer_rights').get() as { n: number }).n,
  requests: (db.prepare('SELECT COUNT(*) AS n FROM peer_requests').get() as { n: number }).n,
});

describe('peer rights: the same owner only', () => {
  const writes: [string, (a: string, b: string, owner?: string | null) => unknown][] = [
    ['setRight', (a, b, owner) => rights.setRight(owner ?? 'Dana', a, b, 'send', DANA)],
    ['pauseLink', (a, b, owner) => rights.pauseLink(owner === undefined ? null : owner, a, b, true, ADMIN)],
    ['removeLink', (a, b, owner) => rights.removeLink(owner === undefined ? null : owner, a, b, ADMIN)],
    ['propose', (a, b) => rights.propose(a, b, 'send', ADMIN)],
    ['requestAccess', (a, b, owner) => access({ fromKey: a, toKey: b, owner: owner ?? 'Dana' })],
  ];

  for (const [name, write] of writes) {
    it(`${name} refuses reporters of two people, the admin secret, no owner, Admin and unknown keys, storing nothing`, () => {
      expect(write('mac', 'eve')).toEqual({ ok: false, status: 403, error: expect.any(String) });
      expect(write('mac', 'secret')).toEqual({ ok: false, status: 403, error: 'a reporter on the admin secret cannot take part' });
      expect(write('nobody', 'mac')).toEqual({ ok: false, status: 403, error: 'a reporter on the admin secret cannot take part' });
      expect(write('mac', 'admin')).toEqual({ ok: false, status: 403, error: 'a reporter on the admin secret cannot take part' });
      expect(write('mac', 'gone')).toEqual({ ok: false, status: 404, error: 'no such reporter' });
      expect(write('gone', 'mac')).toEqual({ ok: false, status: 404, error: 'no such reporter' });
      expect(counts()).toEqual({ rights: 0, requests: 0 });
      expect(trails).toEqual([]);
    });
  }

  it('says why when an Admin joins two people, and "not your reporter" to a person', () => {
    expect(rights.pauseLink(null, 'mac', 'eve', true, ADMIN)).toEqual({ ok: false, status: 403, error: 'a link can only join two reporters with the same owner' });
    expect(rights.setRight('Dana', 'mac', 'eve', 'send', DANA)).toEqual({ ok: false, status: 403, error: 'not your reporter' });
    expect(rights.setRight('Eve', 'mac', 'linux', 'send', DANA)).toEqual({ ok: false, status: 403, error: 'not your reporter' });
    expect(rights.removeLink('Eve', 'mac', 'linux', DANA)).toEqual({ ok: false, status: 403, error: 'not your reporter' });
    expect(access({ owner: 'Eve' })).toEqual({ ok: false, status: 403, error: 'not your reporter' });
    expect(counts()).toEqual({ rights: 0, requests: 0 });
  });

  it('works with the default clock and no trail', () => {
    const plain = new PeerRights(db, lookup);
    expect(plain.setRight('Dana', 'mac', 'linux', 'see', DANA)).toMatchObject({ ok: true, right: { level: 'see' } });
  });

  it('compares owners without regard to case or spacing', () => {
    add('laptop', { owner: 'dana' });
    expect(rights.setRight(' DANA ', 'mac', 'laptop', 'send', DANA)).toMatchObject({ ok: true, right: { owner: 'Dana', level: 'send' } });
  });

  it('takes the same reporter twice: two orchestrators on one machine', () => {
    expect(rights.setRight('Dana', 'mac', 'mac', 'ask', DANA)).toMatchObject({ ok: true, right: { from: 'mac', to: 'mac', level: 'ask' } });
    expect(rights.effective('mac', 'mac')).toEqual({ level: 'ask', paused: false });
    expect(rights.pauseLink('Dana', 'mac', 'mac', true, DANA)).toEqual({ ok: true });
    expect(rights.rightsOf('Dana')).toHaveLength(1);
    expect(rights.effective('mac', 'mac')).toEqual({ level: 'ask', paused: true });
  });
});

describe('peer rights: effective and setRight', () => {
  it('is none with no row, the stored level otherwise, and send under Trust', () => {
    expect(rights.effective('mac', 'linux')).toEqual({ level: 'none', paused: false });
    rights.setRight('Dana', 'mac', 'linux', 'see', DANA);
    expect(rights.effective('mac', 'linux')).toEqual({ level: 'see', paused: false });
    expect(rights.effective('linux', 'mac')).toEqual({ level: 'none', paused: false });
    rights.setDefaults('Dana', { trust: true }, SERVER, DANA);
    expect(rights.effective('linux', 'mac')).toEqual({ level: 'send', paused: false });
    expect(rights.effective('mac', 'pi')).toEqual({ level: 'send', paused: false });
  });

  it('is none between two people, the admin secret or an unknown reporter, Trust or not', () => {
    rights.setDefaults('Dana', { trust: true }, SERVER, DANA);
    expect(rights.effective('mac', 'eve')).toEqual({ level: 'none', paused: false });
    expect(rights.effective('mac', 'secret')).toEqual({ level: 'none', paused: false });
    expect(rights.effective('mac', 'gone')).toEqual({ level: 'none', paused: false });
  });

  it('stores the row under the owner as the server recorded it and trails it', () => {
    t = START + 5;
    const r = rights.setRight('dana', 'mac', 'linux', 'send', DANA);
    expect(r).toEqual({ ok: true, right: { from: 'mac', to: 'linux', owner: 'Dana', level: 'send', paused: false, setAt: START + 5 } });
    expect(trails).toEqual([{ kind: 'set', right: { from: 'mac', to: 'linux', owner: 'Dana', level: 'send', paused: false, setAt: START + 5 }, actor: DANA }]);
    expect(rights.rightsOf('DANA')).toHaveLength(1);
    expect(rights.rightsOf('Eve')).toEqual([]);
  });

  it('deletes the row on none, unless the link is paused', () => {
    rights.setRight('Dana', 'mac', 'linux', 'send', DANA);
    expect(rights.setRight('Dana', 'mac', 'linux', 'none', DANA)).toEqual({ ok: true, right: null });
    expect(trails.at(-1)).toEqual({ kind: 'set', right: { from: 'mac', to: 'linux', owner: 'Dana', level: 'none' }, actor: DANA });
    expect(rights.rightsOf('Dana')).toEqual([]);

    rights.setRight('Dana', 'mac', 'linux', 'send', DANA);
    rights.pauseLink('Dana', 'mac', 'linux', true, DANA);
    expect(rights.setRight('Dana', 'mac', 'linux', 'none', DANA)).toMatchObject({ ok: true, right: { level: 'none', paused: true } });
    expect(rights.effective('mac', 'linux')).toEqual({ level: 'none', paused: true });
    // A new level keeps the pause.
    expect(rights.setRight('Dana', 'mac', 'linux', 'ask', DANA)).toMatchObject({ ok: true, right: { level: 'ask', paused: true } });
  });

  it('refuses a level it does not know', () => {
    expect(rights.setRight('Dana', 'mac', 'linux', 'all' as PeerLevel, DANA)).toEqual({ ok: false, status: 400, error: 'level must be none, see, ask or send' });
    expect(counts().rights).toBe(0);
  });
});

describe('peer rights: pause, remove, pause all', () => {
  it('pauses both directions, creating none rows so the pause holds, and trails once', () => {
    rights.setRight('Dana', 'mac', 'linux', 'send', DANA);
    trails = [];
    expect(rights.pauseLink(null, 'linux', 'mac', true, ADMIN)).toEqual({ ok: true });
    expect(rights.rightsOf('Dana').map((r) => [r.from, r.to, r.level, r.paused])).toEqual([
      ['linux', 'mac', 'none', true],
      ['mac', 'linux', 'send', true],
    ]);
    expect(trails).toEqual([{ kind: 'paused', owner: 'Dana', a: 'linux', b: 'mac', actor: ADMIN }]);
  });

  it('resumes: keeps the rights, drops the rows that only held the pause', () => {
    rights.setRight('Dana', 'mac', 'linux', 'send', DANA);
    rights.pauseLink('Dana', 'mac', 'linux', true, DANA);
    trails = [];
    expect(rights.pauseLink('Dana', 'mac', 'linux', false, DANA)).toEqual({ ok: true });
    expect(rights.rightsOf('Dana').map((r) => [r.from, r.to, r.level, r.paused])).toEqual([['mac', 'linux', 'send', false]]);
    expect(trails).toEqual([{ kind: 'resumed', owner: 'Dana', a: 'mac', b: 'linux', actor: DANA }]);
    // Resuming a link with no rows stores nothing.
    rights.pauseLink('Dana', 'mac', 'pi', false, DANA);
    expect(rights.rightsOf('Dana')).toHaveLength(1);
  });

  it('removes both directions and trails it', () => {
    rights.setRight('Dana', 'mac', 'linux', 'send', DANA);
    rights.setRight('Dana', 'linux', 'mac', 'see', DANA);
    trails = [];
    expect(rights.removeLink('Dana', 'mac', 'linux', DANA)).toEqual({ ok: true });
    expect(rights.rightsOf('Dana')).toEqual([]);
    expect(trails).toEqual([{ kind: 'removed', owner: 'Dana', a: 'mac', b: 'linux', actor: DANA }]);
  });

  it('under Trust, leaves a removed link paused at none, so the removal holds', () => {
    rights.setDefaults('Dana', { trust: true }, SERVER, DANA);
    rights.setRight('Dana', 'mac', 'linux', 'send', DANA);
    expect(rights.removeLink(null, 'mac', 'linux', ADMIN)).toEqual({ ok: true });
    expect(rights.rightsOf('Dana').map((r) => [r.from, r.to, r.level, r.paused])).toEqual([
      ['linux', 'mac', 'none', true],
      ['mac', 'linux', 'none', true],
    ]);
    expect(rights.effective('mac', 'linux').paused).toBe(true);
  });

  it("pauses every link of one reporter with each of its owner's reporters, itself included, and resumes them", () => {
    add('dana-secret', { credential: ADMIN_SECRET });
    rights.setRight('Dana', 'pi', 'mac', 'send', DANA);
    trails = [];
    expect(rights.pauseReporter('mac', true, ADMIN)).toEqual({ ok: true, links: 3 });
    const rows = rights.rightsOf('Dana');
    expect(rows.map((r) => `${r.from}>${r.to}`).sort()).toEqual(['linux>mac', 'mac>linux', 'mac>mac', 'mac>pi', 'pi>mac']);
    expect(rows.every((r) => r.paused)).toBe(true);
    expect(rows.find((r) => r.from === 'pi')?.level).toBe('send');
    expect(trails.map((x) => (x.kind === 'paused' ? x.b : null)).sort()).toEqual(['linux', 'mac', 'pi']);
    expect(rights.effective('eve', 'eve').paused).toBe(false);

    expect(rights.pauseReporter('mac', false, ADMIN)).toEqual({ ok: true, links: 3 });
    expect(rights.rightsOf('Dana').map((r) => [r.from, r.to, r.level, r.paused])).toEqual([['pi', 'mac', 'send', false]]);
  });

  it('refuses Pause all for an unknown or admin-secret reporter', () => {
    expect(rights.pauseReporter('gone', true, ADMIN)).toEqual({ ok: false, status: 404, error: 'no such reporter' });
    expect(rights.pauseReporter('secret', true, ADMIN)).toEqual({ ok: false, status: 403, error: 'a reporter on the admin secret cannot take part' });
    expect(counts().rights).toBe(0);
  });

  it('stores none of a Pause all when one write fails', () => {
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON peer_rights WHEN (SELECT COUNT(*) FROM peer_rights) >= 2 BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => rights.pauseReporter('mac', true, ADMIN)).toThrow('boom');
    expect(counts().rights).toBe(0);
    expect(trails).toEqual([]);
  });
});

describe('peer rights: defaults and limits', () => {
  it('starts from the defaults, and saves a patch per owner without regard to case', () => {
    expect(rights.defaults('Dana')).toEqual(OWNER_DEFAULTS);
    const r = rights.setDefaults('dana', { trust: true, onRequest: 'allow', newSend: 'send', limits: { roundTrips: 4, perMinute: 2 } }, SERVER, DANA);
    const want = { trust: true, onRequest: 'allow', newSend: 'send', limits: { roundTrips: 4, perMinute: 2 } };
    expect(r).toEqual({ ok: true, defaults: want });
    expect(rights.defaults('DANA')).toEqual(want);
    expect(rights.defaults('Eve')).toEqual(OWNER_DEFAULTS);
    expect(trails).toEqual([{ kind: 'defaults', owner: 'dana', actor: DANA }]);
    // A later patch changes only what it names; null takes the Admin's limit back.
    expect(rights.setDefaults('Dana', { limits: { roundTrips: null, maxChars: 500 } }, SERVER, DANA)).toEqual({
      ok: true,
      defaults: { ...want, limits: { perMinute: 2, maxChars: 500 } },
    });
  });

  it('refuses a bad patch with the reason and saves nothing', () => {
    const bad: [Record<string, unknown>, string][] = [
      [{}, 'nothing to change'],
      [[] as unknown as Record<string, unknown>, 'nothing to change'],
      [{ trust: 'yes' }, 'trust must be true or false'],
      [{ onRequest: 'maybe' }, 'onRequest must be ask, allow or decline'],
      [{ newSend: 'see' }, 'newSend must be ask or send'],
      [{ limits: 5 }, 'limits must be an object'],
      [{ limits: { speed: 1 } }, 'unknown limit: speed'],
      [{ limits: { roundTrips: 11 } }, 'Round trips must be a whole number from 1 to 10'],
      [{ limits: { perMinute: 1.5 } }, 'Messages per minute must be a whole number from 1 to 6'],
      [{ trust: true, colour: 'red' }, 'unknown setting: colour'],
    ];
    for (const [patch, error] of bad) expect(rights.setDefaults('Dana', patch, SERVER, DANA)).toEqual({ ok: false, status: 400, error });
    expect(rights.defaults('Dana')).toEqual(OWNER_DEFAULTS);
    expect(trails).toEqual([]);
  });

  it('reads past a damaged row: bad JSON, bad values and unknown words fall back', () => {
    db.prepare("INSERT INTO peer_owner_settings (owner_lower, trust, on_request, new_send, limits_json) VALUES ('dana', 1, 'sometimes', 'later', '{oops')").run();
    expect(rights.defaults('Dana')).toEqual({ ...OWNER_DEFAULTS, trust: true });
    db.prepare(`UPDATE peer_owner_settings SET limits_json = '{"roundTrips":0,"perMinute":3}'`).run();
    expect(rights.defaults('Dana').limits).toEqual({ perMinute: 3 });
    db.prepare(`UPDATE peer_owner_settings SET limits_json = '[1]'`).run();
    expect(rights.defaults('Dana').limits).toEqual({});
    db.prepare('UPDATE peer_owner_settings SET limits_json = NULL').run();
    expect(rights.defaults('Dana').limits).toEqual({});
  });

  it("applies the stricter of the Admin's and the owner's limits", () => {
    expect(rights.limits('Dana', SERVER)).toEqual(SERVER);
    rights.setDefaults('Dana', { limits: { roundTrips: 3, maxChars: 100 } }, SERVER, DANA);
    expect(rights.limits('Dana', SERVER)).toEqual({ roundTrips: 3, perMinute: 6, maxChars: 100 });
    // The Admin lowered theirs below the owner's later: the Admin's wins.
    expect(rights.limits('Dana', { roundTrips: 2, perMinute: 1, maxChars: 50 })).toEqual({ roundTrips: 2, perMinute: 1, maxChars: 50 });
  });
});

describe('peer rights: proposals', () => {
  it('opens a proposal by Admin that changes nothing until the owner allows it', () => {
    const r = rights.propose('mac', 'linux', 'send', ADMIN);
    expect(r).toMatchObject({ ok: true, request: { owner: 'Dana', kind: 'proposal', fromKey: 'mac', toKey: 'linux', level: 'send', by: 'Admin', closedAt: null, outcome: null } });
    if (!r.ok) throw new Error('refused');
    expect(r.request.id).toMatch(/^prq_[0-9a-f]{24}$/);
    expect(rights.effective('mac', 'linux').level).toBe('none');
    expect(trails).toEqual([{ kind: 'proposed', request: r.request, actor: ADMIN }]);
    // Trust and Allow do not accept it for the owner.
    rights.setDefaults('Dana', { onRequest: 'allow' }, SERVER, DANA);
    expect(rights.rightsOf('Dana')).toEqual([]);
  });

  it('updates an open proposal for the same direction rather than adding one', () => {
    const first = rights.propose('mac', 'linux', 'see', ADMIN);
    t = START + 100;
    const again = rights.propose('mac', 'linux', 'ask', ADMIN);
    expect(again).toMatchObject({ ok: true, request: { level: 'ask', createdAt: START + 100 } });
    if (!first.ok || !again.ok) throw new Error('refused');
    expect(again.request.id).toBe(first.request.id);
    expect(rights.openRequests('Dana')).toEqual([again.request]);
    rights.propose('linux', 'mac', 'see', ADMIN);
    expect(rights.openRequests('Dana')).toHaveLength(2);
  });

  it('refuses to propose none or an unknown level', () => {
    expect(rights.propose('mac', 'linux', 'none', ADMIN)).toEqual({ ok: false, status: 400, error: 'level must be see, ask or send' });
    expect(rights.propose('mac', 'linux', 'all' as PeerLevel, ADMIN)).toEqual({ ok: false, status: 400, error: 'level must be see, ask or send' });
  });
});

describe('peer rights: requests for access', () => {
  it('asks the owner by default, and reuses an identical open request from the same session', () => {
    const r = access();
    expect(r).toMatchObject({ ok: true, state: 'asked', request: { kind: 'access', level: 'see', reason: 'to compare notes', by: 'builder', fromSession: 's1' } });
    if (!r.ok || r.state !== 'asked') throw new Error('not asked');
    expect(trails).toEqual([{ kind: 'access-requested', request: r.request }]);
    expect(access()).toEqual(r);
    expect(trails).toHaveLength(1);
    access({ reason: 'another reason' });
    access({ fromSession: 's2' });
    access({ reason: '' });
    access({ reason: '' });
    expect(rights.openRequests('Dana')).toHaveLength(4);
    expect(rights.openRequests('Dana').filter((x) => x.reason === null)).toHaveLength(1);
    expect(rights.rightsOf('Dana')).toEqual([]);
  });

  it('asks for a right to send as the owner\'s newSend', () => {
    expect(access({ right: 'send' })).toMatchObject({ state: 'asked', request: { level: 'ask' } });
    rights.setDefaults('Dana', { newSend: 'send' }, SERVER, DANA);
    expect(access({ right: 'send', fromSession: 's9' })).toMatchObject({ state: 'asked', request: { level: 'send' } });
  });

  it('applies at once under Allow, trailing the owner, and never lowers a higher right', () => {
    rights.setDefaults('Dana', { onRequest: 'allow', newSend: 'send' }, SERVER, DANA);
    trails = [];
    const r = access({ right: 'send' });
    expect(r).toMatchObject({ ok: true, state: 'allowed', applied: { from: 'mac', to: 'linux', level: 'send', owner: 'Dana' } });
    expect(trails).toEqual([{ kind: 'set', right: expect.objectContaining({ level: 'send' }), actor: { name: 'Dana', admin: false } }]);
    expect(access({ right: 'see' })).toMatchObject({ state: 'allowed', applied: { level: 'send' } });
    expect(trails).toHaveLength(1);
    expect(counts().requests).toBe(0);
  });

  it('declines at once under Decline and stores nothing', () => {
    rights.setDefaults('Dana', { onRequest: 'decline' }, SERVER, DANA);
    trails = [];
    expect(access()).toEqual({ ok: true, state: 'declined' });
    expect(counts()).toEqual({ rights: 0, requests: 0 });
    expect(trails).toEqual([]);
  });

  it('cleans the reason of control characters, keeping line breaks and tabs, and refuses one too long without cutting it', () => {
    const r = access({ reason: '  line one\u0007\nline\ttwo\u001b[31m\u007f  ' });
    expect(r).toMatchObject({ state: 'asked', request: { reason: 'line one\nline\ttwo[31m' } });
    expect(access({ reason: `${'x'.repeat(1000)}\u0000\u0001` })).toMatchObject({ ok: true, state: 'asked' });
    expect(access({ reason: 'x'.repeat(1001) })).toEqual({ ok: false, status: 400, error: 'the reason must be at most 1000 characters' });
    expect(access({ reason: 5 as unknown as string })).toEqual({ ok: false, status: 400, error: 'reason must be text' });
    expect(access({ right: 'all' as 'see' })).toEqual({ ok: false, status: 400, error: 'right must be see or send' });
    expect(counts().requests).toBe(2);
  });
});

describe('peer rights: message requests and the list', () => {
  const msg = (messageId: string, over: { fromKey?: string; toKey?: string } = {}) =>
    rights.openMessageRequest({ owner: 'Dana', fromKey: 'mac', toKey: 'linux', by: 'builder', fromSession: 's1', messageId, ...over });

  it('opens a message request and closes it once', () => {
    const r = msg('pmsg_1');
    expect(r).toMatchObject({ kind: 'message', messageId: 'pmsg_1', level: null, reason: null, closedAt: null });
    t = START + 9;
    rights.closeMessageRequest('pmsg_1', 'dropped');
    expect(rights.getRequest(r.id)).toMatchObject({ closedAt: START + 9, outcome: 'dropped' });
    t = START + 20;
    rights.closeMessageRequest('pmsg_1', 'delivered');
    rights.closeMessageRequest('pmsg_none', 'delivered');
    expect(rights.getRequest(r.id)).toMatchObject({ closedAt: START + 9, outcome: 'dropped' });
    expect(rights.getRequest('prq_nope')).toBeNull();
  });

  it('lists open requests oldest first, of one owner, and about one reporter', () => {
    const a = msg('m1');
    t = START + 1;
    const b = msg('m2', { fromKey: 'pi', toKey: 'pi' });
    t = START + 2;
    const c = msg('m3', { fromKey: 'linux', toKey: 'mac' });
    rights.closeMessageRequest('m3', 'declined');
    expect(rights.openRequests('dana').map((r) => r.id)).toEqual([a.id, b.id]);
    expect(rights.openRequests('Dana', 'linux').map((r) => r.id)).toEqual([a.id]);
    expect(rights.openRequests('Dana', 'pi').map((r) => r.id)).toEqual([b.id]);
    expect(rights.openRequests('Eve')).toEqual([]);
    expect(c.id).not.toBe(a.id);
  });
});

describe('peer rights: answering', () => {
  const proposal = (level: PeerLevel = 'send') => {
    const r = rights.propose('mac', 'linux', level, ADMIN);
    if (!r.ok) throw new Error('refused');
    return r.request;
  };

  it('refuses an unknown request, another owner\'s, a closed one, and an answer that does not fit', () => {
    const p = proposal();
    const m = rights.openMessageRequest({ owner: 'Dana', fromKey: 'mac', toKey: 'linux', by: 'b', fromSession: 's1', messageId: 'm1' });
    const a = access();
    if (!a.ok || a.state !== 'asked') throw new Error('not asked');
    expect(rights.answer('prq_nope', 'Dana', 'allow', DANA)).toEqual({ ok: false, status: 404, error: 'no such request' });
    expect(rights.answer(p.id, 'Eve', 'allow', DANA)).toEqual({ ok: false, status: 403, error: 'not your request' });
    expect(rights.answer(p.id, 'Dana', 'deliver', DANA)).toEqual({ ok: false, status: 422, error: 'a proposal is allowed or declined' });
    expect(rights.answer(a.request.id, 'Dana', 'deliver', DANA)).toEqual({ ok: false, status: 422, error: 'a request for access is allowed or declined' });
    expect(rights.answer(m.id, 'Dana', 'allow', DANA)).toEqual({ ok: false, status: 422, error: 'a message is delivered or declined' });
    expect(rights.answer(p.id, 'Dana', 'maybe' as 'allow', DANA)).toEqual({ ok: false, status: 422, error: 'the answer must be allow, decline or deliver' });
    rights.answer(p.id, 'Dana', 'decline', DANA);
    expect(rights.answer(p.id, 'Dana', 'allow', DANA)).toEqual({ ok: false, status: 410, error: 'already declined' });
  });

  it('applies an allowed proposal as proposed, keeping a pause, closes it and trails it', () => {
    rights.setRight('Dana', 'mac', 'linux', 'send', DANA);
    rights.pauseLink('Dana', 'mac', 'linux', true, DANA);
    const p = proposal('see');
    trails = [];
    t = START + 50;
    const r = rights.answer(p.id, 'dana', 'allow', DANA);
    expect(r).toMatchObject({ ok: true, request: { outcome: 'allowed', closedAt: START + 50 }, applied: { level: 'see', paused: true } });
    expect(rights.effective('mac', 'linux')).toEqual({ level: 'see', paused: true });
    expect(trails).toEqual([{ kind: 'accepted', request: expect.objectContaining({ id: p.id, outcome: 'allowed' }), actor: DANA }]);
    expect(rights.openRequests('Dana')).toEqual([]);
  });

  it('applies an allowed access request without lowering a higher right', () => {
    const a = access({ right: 'see' });
    if (!a.ok || a.state !== 'asked') throw new Error('not asked');
    rights.setRight('Dana', 'mac', 'linux', 'ask', DANA);
    expect(rights.answer(a.request.id, 'Dana', 'allow', DANA)).toMatchObject({ ok: true, applied: { level: 'ask' } });
    const b = access({ right: 'send', fromSession: 's2' });
    if (!b.ok || b.state !== 'asked') throw new Error('not asked');
    rights.setDefaults('Dana', { newSend: 'send' }, SERVER, DANA);
    expect(rights.answer(b.request.id, 'Dana', 'allow', DANA)).toMatchObject({ ok: true, applied: { level: 'ask' } });
    const c = access({ fromKey: 'pi' });
    if (!c.ok || c.state !== 'asked') throw new Error('not asked');
    expect(rights.answer(c.request.id, 'Dana', 'allow', DANA)).toMatchObject({ ok: true, applied: { from: 'pi', level: 'see' } });
  });

  it('declines a proposal or an access request, storing no right', () => {
    const p = proposal();
    trails = [];
    expect(rights.answer(p.id, 'Dana', 'decline', DANA)).toMatchObject({ ok: true, request: { outcome: 'declined' }, applied: null });
    expect(trails).toEqual([{ kind: 'declined', request: expect.objectContaining({ id: p.id }), actor: DANA }]);
    expect(rights.rightsOf('Dana')).toEqual([]);
  });

  it('re-checks the owner when a proposal is allowed', () => {
    const p = proposal();
    db.prepare("UPDATE reporters SET owner = 'Eve' WHERE key = 'linux'").run();
    expect(rights.answer(p.id, 'Dana', 'allow', DANA)).toEqual({ ok: false, status: 403, error: 'not your reporter' });
    expect(rights.getRequest(p.id)?.closedAt).toBeNull();
    expect(rights.rightsOf('Dana')).toEqual([]);
  });

  it('closes a message request as delivered or declined and hands the message back, with no trail', () => {
    const m1 = rights.openMessageRequest({ owner: 'Dana', fromKey: 'mac', toKey: 'linux', by: 'b', fromSession: 's1', messageId: 'm1' });
    const m2 = rights.openMessageRequest({ owner: 'Dana', fromKey: 'mac', toKey: 'linux', by: 'b', fromSession: 's1', messageId: 'm2' });
    expect(rights.answer(m1.id, 'Dana', 'deliver', DANA)).toMatchObject({ ok: true, request: { outcome: 'delivered' }, message: { id: 'm1', deliver: true } });
    expect(rights.answer(m2.id, 'Dana', 'decline', DANA)).toMatchObject({ ok: true, request: { outcome: 'declined' }, message: { id: 'm2', deliver: false } });
    expect(rights.answer(m1.id, 'Dana', 'deliver', DANA)).toEqual({ ok: false, status: 410, error: 'already delivered' });
    expect(trails).toEqual([]);
  });
});

describe('peer rights: retention', () => {
  it('deletes closed requests before the cutoff, and requests and rights about a reporter that is gone', () => {
    const old = rights.openMessageRequest({ owner: 'Dana', fromKey: 'mac', toKey: 'linux', by: 'b', fromSession: 's1', messageId: 'm1' });
    rights.closeMessageRequest('m1', 'delivered');
    t = START + 1000;
    const recent = rights.openMessageRequest({ owner: 'Dana', fromKey: 'mac', toKey: 'linux', by: 'b', fromSession: 's1', messageId: 'm2' });
    rights.closeMessageRequest('m2', 'delivered');
    const open = rights.openMessageRequest({ owner: 'Dana', fromKey: 'mac', toKey: 'linux', by: 'b', fromSession: 's1', messageId: 'm3' });
    const aboutPi = rights.propose('linux', 'pi', 'see', ADMIN);
    rights.setRight('Dana', 'mac', 'pi', 'send', DANA);
    rights.setRight('Dana', 'mac', 'linux', 'send', DANA);
    if (!aboutPi.ok) throw new Error('refused');
    reporters.remove('pi');

    expect(rights.retain(START + 500)).toBe(2);
    expect(rights.getRequest(old.id)).toBeNull();
    expect(rights.getRequest(aboutPi.request.id)).toBeNull();
    expect(rights.getRequest(recent.id)).not.toBeNull();
    expect(rights.getRequest(open.id)).not.toBeNull();
    expect(rights.rightsOf('Dana').map((r) => `${r.from}>${r.to}`)).toEqual(['mac>linux']);
    expect(rights.retain(START + 500)).toBe(0);
  });
});
