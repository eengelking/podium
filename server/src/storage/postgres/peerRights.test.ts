import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { PgPeerRights } from './peerRights.js';
import { fakeReporters } from './peerTesting.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';
import { OWNER_DEFAULTS, type Actor, type ReporterRef, type RightsTrail } from '../../fleet/peerTypes.js';
import type { PeerLevel } from '../../fleet/protocol.js';
import type { PeerLimits } from '../settings.js';
import type { AsyncPeerReporterLookup } from '../types.js';

const START = 1_000_000_000_000;
const SERVER: PeerLimits = { roundTrips: 10, perMinute: 6, maxChars: 20_000 };
const ADMIN: Actor = { name: 'Admin', admin: true };
const DANA: Actor = { name: 'Dana', admin: false };

describe.skipIf(!TEST_PG)('postgres peer rights', () => {
  let td: TestDatabase;
  let db: PgDb;
  let reps: Map<string, ReporterRef>;
  let t: number;
  let trails: RightsTrail[];
  let rights: PgPeerRights;
  let lookup: AsyncPeerReporterLookup;

  beforeAll(async () => {
    td = await createTestDatabase();
    db = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 4, name: 'test' });
    await migrate(db, MAIN_SCHEMA, MAIN_STEPS);
  });
  afterAll(async () => {
    await db.close();
    await td.drop();
  });

  /** Adds one reporter; the machine name is its key. */
  const add = (key: string, over: Partial<ReporterRef> = {}) => {
    reps.set(key, { key, machine: key, owner: 'Dana', adminSecret: false, os: null, peers: true, version: '1.2.0', ...over });
  };

  beforeEach(async () => {
    await db.exec('TRUNCATE peer_rights, peer_owner_settings, peer_requests, peer_messages');
    const fake = fakeReporters(START);
    reps = fake.reps;
    lookup = fake.lookup;
    t = START;
    trails = [];
    rights = new PgPeerRights(db, fake.lookup, () => t, (x) => void trails.push(x));
    add('mac');
    add('linux');
    add('pi');
    add('eve', { owner: 'Eve' });
    add('secret', { adminSecret: true });
    add('nobody', { owner: null });
    add('admin', { owner: 'Admin' });
  });

  const access = (over: Partial<Parameters<PgPeerRights['requestAccess']>[0]> = {}) =>
    rights.requestAccess({ owner: 'Dana', fromKey: 'mac', toKey: 'linux', right: 'see', reason: 'to compare notes', by: 'builder', fromSession: 's1', ...over });

  const counts = async () => ({
    rights: (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM peer_rights'))!.n,
    requests: (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM peer_requests'))!.n,
  });

  describe('peer rights: the same owner only', () => {
    const writes: [string, (a: string, b: string, owner?: string | null) => Promise<unknown>][] = [
      ['setRight', (a, b, owner) => rights.setRight(owner ?? 'Dana', a, b, 'send', DANA)],
      ['pauseLink', (a, b, owner) => rights.pauseLink(owner === undefined ? null : owner, a, b, true, ADMIN)],
      ['removeLink', (a, b, owner) => rights.removeLink(owner === undefined ? null : owner, a, b, ADMIN)],
      ['propose', (a, b) => rights.propose(a, b, 'send', ADMIN)],
      ['requestAccess', (a, b, owner) => access({ fromKey: a, toKey: b, owner: owner ?? 'Dana' })],
    ];

    for (const [name, write] of writes) {
      it(`${name} refuses reporters of two people, the admin secret, no owner, Admin and unknown keys, storing nothing`, async () => {
        expect(await write('mac', 'eve')).toEqual({ ok: false, status: 403, error: expect.any(String) });
        expect(await write('mac', 'secret')).toEqual({ ok: false, status: 403, error: 'a reporter on the admin secret cannot take part' });
        expect(await write('nobody', 'mac')).toEqual({ ok: false, status: 403, error: 'a reporter on the admin secret cannot take part' });
        expect(await write('mac', 'admin')).toEqual({ ok: false, status: 403, error: 'a reporter on the admin secret cannot take part' });
        expect(await write('mac', 'gone')).toEqual({ ok: false, status: 404, error: 'no such reporter' });
        expect(await write('gone', 'mac')).toEqual({ ok: false, status: 404, error: 'no such reporter' });
        expect(await counts()).toEqual({ rights: 0, requests: 0 });
        expect(trails).toEqual([]);
      });
    }

    it('says why when an Admin joins two people, and "not your reporter" to a person', async () => {
      expect(await rights.pauseLink(null, 'mac', 'eve', true, ADMIN)).toEqual({ ok: false, status: 403, error: 'a link can only join two reporters with the same owner' });
      expect(await rights.setRight('Dana', 'mac', 'eve', 'send', DANA)).toEqual({ ok: false, status: 403, error: 'not your reporter' });
      expect(await rights.setRight('Eve', 'mac', 'linux', 'send', DANA)).toEqual({ ok: false, status: 403, error: 'not your reporter' });
      expect(await rights.removeLink('Eve', 'mac', 'linux', DANA)).toEqual({ ok: false, status: 403, error: 'not your reporter' });
      expect(await access({ owner: 'Eve' })).toEqual({ ok: false, status: 403, error: 'not your reporter' });
      expect(await counts()).toEqual({ rights: 0, requests: 0 });
    });

    it('works with the default clock and no trail', async () => {
      const plain = new PgPeerRights(db, lookup);
      expect(await plain.setRight('Dana', 'mac', 'linux', 'see', DANA)).toMatchObject({ ok: true, right: { level: 'see' } });
    });

    it('compares owners without regard to case or spacing', async () => {
      add('laptop', { owner: 'dana' });
      expect(await rights.setRight(' DANA ', 'mac', 'laptop', 'send', DANA)).toMatchObject({ ok: true, right: { owner: 'Dana', level: 'send' } });
    });

    it('takes the same reporter twice: two orchestrators on one machine', async () => {
      expect(await rights.setRight('Dana', 'mac', 'mac', 'ask', DANA)).toMatchObject({ ok: true, right: { from: 'mac', to: 'mac', level: 'ask' } });
      expect(await rights.effective('mac', 'mac')).toEqual({ level: 'ask', paused: false });
      expect(await rights.pauseLink('Dana', 'mac', 'mac', true, DANA)).toEqual({ ok: true });
      expect(await rights.rightsOf('Dana')).toHaveLength(1);
      expect(await rights.effective('mac', 'mac')).toEqual({ level: 'ask', paused: true });
    });
  });

  describe('peer rights: effective and setRight', () => {
    it('is none with no row, the stored level otherwise, and send under Trust', async () => {
      expect(await rights.effective('mac', 'linux')).toEqual({ level: 'none', paused: false });
      await rights.setRight('Dana', 'mac', 'linux', 'see', DANA);
      expect(await rights.effective('mac', 'linux')).toEqual({ level: 'see', paused: false });
      expect(await rights.effective('linux', 'mac')).toEqual({ level: 'none', paused: false });
      await rights.setDefaults('Dana', { trust: true }, SERVER, DANA);
      expect(await rights.effective('linux', 'mac')).toEqual({ level: 'send', paused: false });
      expect(await rights.effective('mac', 'pi')).toEqual({ level: 'send', paused: false });
    });

    it('is none between two people, the admin secret or an unknown reporter, Trust or not', async () => {
      await rights.setDefaults('Dana', { trust: true }, SERVER, DANA);
      expect(await rights.effective('mac', 'eve')).toEqual({ level: 'none', paused: false });
      expect(await rights.effective('mac', 'secret')).toEqual({ level: 'none', paused: false });
      expect(await rights.effective('mac', 'gone')).toEqual({ level: 'none', paused: false });
    });

    it('stores the row under the owner as the server recorded it and trails it', async () => {
      t = START + 5;
      const r = await rights.setRight('dana', 'mac', 'linux', 'send', DANA);
      expect(r).toEqual({ ok: true, right: { from: 'mac', to: 'linux', owner: 'Dana', level: 'send', paused: false, setAt: START + 5 } });
      expect(trails).toEqual([{ kind: 'set', right: { from: 'mac', to: 'linux', owner: 'Dana', level: 'send', paused: false, setAt: START + 5 }, actor: DANA }]);
      expect(await rights.rightsOf('DANA')).toHaveLength(1);
      expect(await rights.rightsOf('Eve')).toEqual([]);
    });

    it('deletes the row on none, unless the link is paused', async () => {
      await rights.setRight('Dana', 'mac', 'linux', 'send', DANA);
      expect(await rights.setRight('Dana', 'mac', 'linux', 'none', DANA)).toEqual({ ok: true, right: null });
      expect(trails.at(-1)).toEqual({ kind: 'set', right: { from: 'mac', to: 'linux', owner: 'Dana', level: 'none' }, actor: DANA });
      expect(await rights.rightsOf('Dana')).toEqual([]);

      await rights.setRight('Dana', 'mac', 'linux', 'send', DANA);
      await rights.pauseLink('Dana', 'mac', 'linux', true, DANA);
      expect(await rights.setRight('Dana', 'mac', 'linux', 'none', DANA)).toMatchObject({ ok: true, right: { level: 'none', paused: true } });
      expect(await rights.effective('mac', 'linux')).toEqual({ level: 'none', paused: true });
      // A new level keeps the pause.
      expect(await rights.setRight('Dana', 'mac', 'linux', 'ask', DANA)).toMatchObject({ ok: true, right: { level: 'ask', paused: true } });
    });

    it('refuses a level it does not know', async () => {
      expect(await rights.setRight('Dana', 'mac', 'linux', 'all' as PeerLevel, DANA)).toEqual({ ok: false, status: 400, error: 'level must be none, see, ask or send' });
      expect((await counts()).rights).toBe(0);
    });
  });

  describe('peer rights: pause, remove, pause all', () => {
    it('pauses both directions, creating none rows so the pause holds, and trails once', async () => {
      await rights.setRight('Dana', 'mac', 'linux', 'send', DANA);
      trails = [];
      expect(await rights.pauseLink(null, 'linux', 'mac', true, ADMIN)).toEqual({ ok: true });
      expect((await rights.rightsOf('Dana')).map((r) => [r.from, r.to, r.level, r.paused])).toEqual([
        ['linux', 'mac', 'none', true],
        ['mac', 'linux', 'send', true],
      ]);
      expect(trails).toEqual([{ kind: 'paused', owner: 'Dana', a: 'linux', b: 'mac', actor: ADMIN }]);
    });

    it('resumes: keeps the rights, drops the rows that only held the pause', async () => {
      await rights.setRight('Dana', 'mac', 'linux', 'send', DANA);
      await rights.pauseLink('Dana', 'mac', 'linux', true, DANA);
      trails = [];
      expect(await rights.pauseLink('Dana', 'mac', 'linux', false, DANA)).toEqual({ ok: true });
      expect((await rights.rightsOf('Dana')).map((r) => [r.from, r.to, r.level, r.paused])).toEqual([['mac', 'linux', 'send', false]]);
      expect(trails).toEqual([{ kind: 'resumed', owner: 'Dana', a: 'mac', b: 'linux', actor: DANA }]);
      // Resuming a link with no rows stores nothing.
      await rights.pauseLink('Dana', 'mac', 'pi', false, DANA);
      expect(await rights.rightsOf('Dana')).toHaveLength(1);
    });

    it('removes both directions and trails it', async () => {
      await rights.setRight('Dana', 'mac', 'linux', 'send', DANA);
      await rights.setRight('Dana', 'linux', 'mac', 'see', DANA);
      trails = [];
      expect(await rights.removeLink('Dana', 'mac', 'linux', DANA)).toEqual({ ok: true });
      expect(await rights.rightsOf('Dana')).toEqual([]);
      expect(trails).toEqual([{ kind: 'removed', owner: 'Dana', a: 'mac', b: 'linux', actor: DANA }]);
    });

    it('under Trust, leaves a removed link paused at none, so the removal holds', async () => {
      await rights.setDefaults('Dana', { trust: true }, SERVER, DANA);
      await rights.setRight('Dana', 'mac', 'linux', 'send', DANA);
      expect(await rights.removeLink(null, 'mac', 'linux', ADMIN)).toEqual({ ok: true });
      expect((await rights.rightsOf('Dana')).map((r) => [r.from, r.to, r.level, r.paused])).toEqual([
        ['linux', 'mac', 'none', true],
        ['mac', 'linux', 'none', true],
      ]);
      expect((await rights.effective('mac', 'linux')).paused).toBe(true);
    });

    it("pauses every link of one reporter with each of its owner's reporters, itself included, and resumes them", async () => {
      add('dana-secret', { adminSecret: true });
      await rights.setRight('Dana', 'pi', 'mac', 'send', DANA);
      trails = [];
      expect(await rights.pauseReporter('mac', true, ADMIN)).toEqual({ ok: true, links: 3 });
      const rows = await rights.rightsOf('Dana');
      expect(rows.map((r) => `${r.from}>${r.to}`).sort()).toEqual(['linux>mac', 'mac>linux', 'mac>mac', 'mac>pi', 'pi>mac']);
      expect(rows.every((r) => r.paused)).toBe(true);
      expect(rows.find((r) => r.from === 'pi')?.level).toBe('send');
      expect(trails.map((x) => (x.kind === 'paused' ? x.b : null)).sort()).toEqual(['linux', 'mac', 'pi']);
      expect((await rights.effective('eve', 'eve')).paused).toBe(false);

      expect(await rights.pauseReporter('mac', false, ADMIN)).toEqual({ ok: true, links: 3 });
      expect((await rights.rightsOf('Dana')).map((r) => [r.from, r.to, r.level, r.paused])).toEqual([['pi', 'mac', 'send', false]]);
    });

    it('refuses Pause all for an unknown or admin-secret reporter', async () => {
      expect(await rights.pauseReporter('gone', true, ADMIN)).toEqual({ ok: false, status: 404, error: 'no such reporter' });
      expect(await rights.pauseReporter('secret', true, ADMIN)).toEqual({ ok: false, status: 403, error: 'a reporter on the admin secret cannot take part' });
      expect((await counts()).rights).toBe(0);
    });

    it('stores none of a Pause all when one write fails', async () => {
      await db.exec(`CREATE FUNCTION peer_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF (SELECT COUNT(*) FROM peer_rights) >= 2 THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$`);
      await db.exec('CREATE TRIGGER boom BEFORE INSERT ON peer_rights FOR EACH ROW EXECUTE FUNCTION peer_boom()');
      await expect(rights.pauseReporter('mac', true, ADMIN)).rejects.toThrow('boom');
      await db.exec('DROP TRIGGER boom ON peer_rights');
      await db.exec('DROP FUNCTION peer_boom()');
      expect((await counts()).rights).toBe(0);
      expect(trails).toEqual([]);
    });
  });

  describe('peer rights: defaults and limits', () => {
    it('starts from the defaults, and saves a patch per owner without regard to case', async () => {
      expect(await rights.defaults('Dana')).toEqual(OWNER_DEFAULTS);
      const r = await rights.setDefaults('dana', { trust: true, onRequest: 'allow', newSend: 'send', limits: { roundTrips: 4, perMinute: 2 } }, SERVER, DANA);
      const want = { trust: true, onRequest: 'allow', newSend: 'send', limits: { roundTrips: 4, perMinute: 2 } };
      expect(r).toEqual({ ok: true, defaults: want });
      expect(await rights.defaults('DANA')).toEqual(want);
      expect(await rights.defaults('Eve')).toEqual(OWNER_DEFAULTS);
      expect(trails).toEqual([{ kind: 'defaults', owner: 'dana', actor: DANA }]);
      // A later patch changes only what it names; null takes the Admin's limit back.
      expect(await rights.setDefaults('Dana', { limits: { roundTrips: null, maxChars: 500 } }, SERVER, DANA)).toEqual({
        ok: true,
        defaults: { ...want, limits: { perMinute: 2, maxChars: 500 } },
      });
    });

    it('refuses a bad patch with the reason and saves nothing', async () => {
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
      for (const [patch, error] of bad) expect(await rights.setDefaults('Dana', patch, SERVER, DANA)).toEqual({ ok: false, status: 400, error });
      expect(await rights.defaults('Dana')).toEqual(OWNER_DEFAULTS);
      expect(trails).toEqual([]);
    });

    it('reads past a damaged row: bad JSON, bad values and unknown words fall back', async () => {
      await db.run("INSERT INTO peer_owner_settings (owner_lower, trust, on_request, new_send, limits_json) VALUES ('dana', 1, 'sometimes', 'later', '{oops')");
      expect(await rights.defaults('Dana')).toEqual({ ...OWNER_DEFAULTS, trust: true });
      await db.run(`UPDATE peer_owner_settings SET limits_json = '{"roundTrips":0,"perMinute":3}'`);
      expect((await rights.defaults('Dana')).limits).toEqual({ perMinute: 3 });
      await db.run(`UPDATE peer_owner_settings SET limits_json = '[1]'`);
      expect((await rights.defaults('Dana')).limits).toEqual({});
      await db.run('UPDATE peer_owner_settings SET limits_json = NULL');
      expect((await rights.defaults('Dana')).limits).toEqual({});
    });

    it("applies the stricter of the Admin's and the owner's limits", async () => {
      expect(await rights.limits('Dana', SERVER)).toEqual(SERVER);
      await rights.setDefaults('Dana', { limits: { roundTrips: 3, maxChars: 100 } }, SERVER, DANA);
      expect(await rights.limits('Dana', SERVER)).toEqual({ roundTrips: 3, perMinute: 6, maxChars: 100 });
      // The Admin lowered theirs below the owner's later: the Admin's wins.
      expect(await rights.limits('Dana', { roundTrips: 2, perMinute: 1, maxChars: 50 })).toEqual({ roundTrips: 2, perMinute: 1, maxChars: 50 });
    });
  });

  describe('peer rights: proposals', () => {
    it('opens a proposal by Admin that changes nothing until the owner allows it', async () => {
      const r = await rights.propose('mac', 'linux', 'send', ADMIN);
      expect(r).toMatchObject({ ok: true, request: { owner: 'Dana', kind: 'proposal', fromKey: 'mac', toKey: 'linux', level: 'send', by: 'Admin', closedAt: null, outcome: null } });
      if (!r.ok) throw new Error('refused');
      expect(r.request.id).toMatch(/^prq_[0-9a-f]{24}$/);
      expect((await rights.effective('mac', 'linux')).level).toBe('none');
      expect(trails).toEqual([{ kind: 'proposed', request: r.request, actor: ADMIN }]);
      // Trust and Allow do not accept it for the owner.
      await rights.setDefaults('Dana', { onRequest: 'allow' }, SERVER, DANA);
      expect(await rights.rightsOf('Dana')).toEqual([]);
    });

    it('updates an open proposal for the same direction rather than adding one', async () => {
      const first = await rights.propose('mac', 'linux', 'see', ADMIN);
      t = START + 100;
      const again = await rights.propose('mac', 'linux', 'ask', ADMIN);
      expect(again).toMatchObject({ ok: true, request: { level: 'ask', createdAt: START + 100 } });
      if (!first.ok || !again.ok) throw new Error('refused');
      expect(again.request.id).toBe(first.request.id);
      expect(await rights.openRequests('Dana')).toEqual([again.request]);
      await rights.propose('linux', 'mac', 'see', ADMIN);
      expect(await rights.openRequests('Dana')).toHaveLength(2);
    });

    it('refuses to propose none or an unknown level', async () => {
      expect(await rights.propose('mac', 'linux', 'none', ADMIN)).toEqual({ ok: false, status: 400, error: 'level must be see, ask or send' });
      expect(await rights.propose('mac', 'linux', 'all' as PeerLevel, ADMIN)).toEqual({ ok: false, status: 400, error: 'level must be see, ask or send' });
    });

    it('refuses a proposal at or below the stored right, and keeps the open one', async () => {
      const LOWER = { ok: false, status: 409, error: 'a proposal must raise the right; it is already ask' };
      await rights.setRight('Dana', 'mac', 'linux', 'ask', DANA);
      const open = await rights.propose('mac', 'linux', 'send', ADMIN);
      if (!open.ok) throw new Error('refused');
      trails = [];
      expect(await rights.propose('mac', 'linux', 'ask', ADMIN)).toEqual(LOWER);
      expect(await rights.propose('mac', 'linux', 'see', ADMIN)).toEqual(LOWER);
      expect(await rights.openRequests('Dana')).toEqual([open.request]);
      expect(trails).toEqual([]);
      // Paused or not, the stored level is what counts; the other direction has none, so any level raises it.
      await rights.pauseLink('Dana', 'mac', 'linux', true, DANA);
      expect(await rights.propose('mac', 'linux', 'ask', ADMIN)).toEqual(LOWER);
      expect(await rights.propose('linux', 'mac', 'see', ADMIN)).toMatchObject({ ok: true });
    });
  });

  describe('peer rights: requests for access', () => {
    it('asks the owner by default, and reuses an identical open request from the same session', async () => {
      const r = await access();
      expect(r).toMatchObject({ ok: true, state: 'asked', request: { kind: 'access', level: 'see', reason: 'to compare notes', by: 'builder', fromSession: 's1' } });
      if (!r.ok || r.state !== 'asked') throw new Error('not asked');
      expect(trails).toEqual([{ kind: 'access-requested', request: r.request }]);
      expect(await access()).toEqual(r);
      expect(trails).toHaveLength(1);
      await access({ reason: 'another reason' });
      await access({ fromSession: 's2' });
      await access({ reason: '' });
      await access({ reason: '' });
      expect(await rights.openRequests('Dana')).toHaveLength(4);
      expect((await rights.openRequests('Dana')).filter((x) => x.reason === null)).toHaveLength(1);
      expect(await rights.rightsOf('Dana')).toEqual([]);
    });

    it('asks for a right to send as the owner\'s newSend', async () => {
      expect(await access({ right: 'send' })).toMatchObject({ state: 'asked', request: { level: 'ask' } });
      await rights.setDefaults('Dana', { newSend: 'send' }, SERVER, DANA);
      expect(await access({ right: 'send', fromSession: 's9' })).toMatchObject({ state: 'asked', request: { level: 'send' } });
    });

    it('applies at once under Allow, trailing the owner, and never lowers a higher right', async () => {
      await rights.setDefaults('Dana', { onRequest: 'allow', newSend: 'send' }, SERVER, DANA);
      trails = [];
      const r = await access({ right: 'send' });
      expect(r).toMatchObject({ ok: true, state: 'allowed', applied: { from: 'mac', to: 'linux', level: 'send', owner: 'Dana' } });
      expect(trails).toEqual([{ kind: 'set', right: expect.objectContaining({ level: 'send' }), actor: { name: 'Dana', admin: false } }]);
      expect(await access({ right: 'see' })).toMatchObject({ state: 'allowed', applied: { level: 'send' } });
      expect(trails).toHaveLength(1);
      expect((await counts()).requests).toBe(0);
    });

    it('declines at once under Decline and stores nothing', async () => {
      await rights.setDefaults('Dana', { onRequest: 'decline' }, SERVER, DANA);
      trails = [];
      expect(await access()).toEqual({ ok: true, state: 'declined' });
      expect(await counts()).toEqual({ rights: 0, requests: 0 });
      expect(trails).toEqual([]);
    });

    it('cleans the reason of control characters, keeping line breaks and tabs, and refuses one too long without cutting it', async () => {
      const r = await access({ reason: '  line one\u0007\nline\ttwo\u001b[31m\u007f  ' });
      expect(r).toMatchObject({ state: 'asked', request: { reason: 'line one\nline\ttwo[31m' } });
      expect(await access({ reason: `${'x'.repeat(1000)}\u0000\u0001` })).toMatchObject({ ok: true, state: 'asked' });
      expect(await access({ reason: 'x'.repeat(1001) })).toEqual({ ok: false, status: 400, error: 'the reason must be at most 1000 characters' });
      expect(await access({ reason: 5 as unknown as string })).toEqual({ ok: false, status: 400, error: 'reason must be text' });
      expect(await access({ right: 'all' as 'see' })).toEqual({ ok: false, status: 400, error: 'right must be see or send' });
      expect((await counts()).requests).toBe(2);
    });
  });

  describe('peer rights: message requests and the list', () => {
    const msg = (messageId: string, over: { fromKey?: string; toKey?: string } = {}) =>
      rights.openMessageRequest({ owner: 'Dana', fromKey: 'mac', toKey: 'linux', by: 'builder', fromSession: 's1', messageId, ...over });

    it('opens a message request and closes it once', async () => {
      const r = await msg('pmsg_1');
      expect(r).toMatchObject({ kind: 'message', messageId: 'pmsg_1', level: null, reason: null, closedAt: null });
      t = START + 9;
      await rights.closeMessageRequest('pmsg_1', 'dropped');
      expect(await rights.getRequest(r.id)).toMatchObject({ closedAt: START + 9, outcome: 'dropped' });
      t = START + 20;
      await rights.closeMessageRequest('pmsg_1', 'delivered');
      await rights.closeMessageRequest('pmsg_none', 'delivered');
      expect(await rights.getRequest(r.id)).toMatchObject({ closedAt: START + 9, outcome: 'dropped' });
      expect(await rights.getRequest('prq_nope')).toBeNull();
    });

    it('lists open requests oldest first, of one owner, and about one reporter', async () => {
      const a = await msg('m1');
      t = START + 1;
      const b = await msg('m2', { fromKey: 'pi', toKey: 'pi' });
      t = START + 2;
      const c = await msg('m3', { fromKey: 'linux', toKey: 'mac' });
      await rights.closeMessageRequest('m3', 'declined');
      expect((await rights.openRequests('dana')).map((r) => r.id)).toEqual([a.id, b.id]);
      expect((await rights.openRequests('Dana', 'linux')).map((r) => r.id)).toEqual([a.id]);
      expect((await rights.openRequests('Dana', 'pi')).map((r) => r.id)).toEqual([b.id]);
      expect(await rights.openRequests('Eve')).toEqual([]);
      expect(c.id).not.toBe(a.id);
    });

    it('finds the rights and requests of an owner whose name has a capital beyond ASCII', async () => {
      add('m1', { owner: 'Émile' });
      add('m2', { owner: 'Émile' });
      const emile: Actor = { name: 'Émile', admin: false };
      expect(await rights.setRight('Émile', 'm1', 'm2', 'send', emile)).toMatchObject({ ok: true });
      const r = await rights.openMessageRequest({ owner: 'Émile', fromKey: 'm1', toKey: 'm2', by: 'b', fromSession: 's1', messageId: 'mx' });
      expect((await rights.rightsOf('Émile')).map((x) => `${x.from}>${x.to}`)).toEqual(['m1>m2']);
      expect((await rights.rightsOf('émile')).map((x) => `${x.from}>${x.to}`)).toEqual(['m1>m2']);
      expect((await rights.openRequests('Émile')).map((x) => x.id)).toEqual([r.id]);
      expect((await rights.openRequests('émile', 'm2')).map((x) => x.id)).toEqual([r.id]);
    });
  });

  describe('peer rights: answering', () => {
    const proposal = async (level: PeerLevel = 'send') => {
      const r = await rights.propose('mac', 'linux', level, ADMIN);
      if (!r.ok) throw new Error('refused');
      return r.request;
    };

    it('refuses an unknown request, another owner\'s, a closed one, and an answer that does not fit', async () => {
      const p = await proposal();
      const m = await rights.openMessageRequest({ owner: 'Dana', fromKey: 'mac', toKey: 'linux', by: 'b', fromSession: 's1', messageId: 'm1' });
      const a = await access();
      if (!a.ok || a.state !== 'asked') throw new Error('not asked');
      expect(await rights.answer('prq_nope', 'Dana', 'allow', DANA)).toEqual({ ok: false, status: 404, error: 'no such request' });
      expect(await rights.answer(p.id, 'Eve', 'allow', DANA)).toEqual({ ok: false, status: 403, error: 'not your request' });
      expect(await rights.answer(p.id, 'Dana', 'deliver', DANA)).toEqual({ ok: false, status: 422, error: 'a proposal is allowed or declined' });
      expect(await rights.answer(a.request.id, 'Dana', 'deliver', DANA)).toEqual({ ok: false, status: 422, error: 'a request for access is allowed or declined' });
      expect(await rights.answer(m.id, 'Dana', 'allow', DANA)).toEqual({ ok: false, status: 422, error: 'a message is delivered or declined' });
      expect(await rights.answer(p.id, 'Dana', 'maybe' as 'allow', DANA)).toEqual({ ok: false, status: 422, error: 'the answer must be allow, decline or deliver' });
      await rights.answer(p.id, 'Dana', 'decline', DANA);
      expect(await rights.answer(p.id, 'Dana', 'allow', DANA)).toEqual({ ok: false, status: 410, error: 'already declined' });
    });

    it('applies an allowed proposal as proposed, keeping a pause, closes it and trails it', async () => {
      await rights.setRight('Dana', 'mac', 'linux', 'see', DANA);
      await rights.pauseLink('Dana', 'mac', 'linux', true, DANA);
      const p = await proposal('ask');
      trails = [];
      t = START + 50;
      const r = await rights.answer(p.id, 'dana', 'allow', DANA);
      expect(r).toMatchObject({ ok: true, request: { outcome: 'allowed', closedAt: START + 50 }, applied: { level: 'ask', paused: true } });
      expect(await rights.effective('mac', 'linux')).toEqual({ level: 'ask', paused: true });
      expect(trails).toEqual([{ kind: 'accepted', request: expect.objectContaining({ id: p.id, outcome: 'allowed' }), actor: DANA }]);
      expect(await rights.openRequests('Dana')).toEqual([]);
    });

    it('never lowers a right that rose after the proposal was made', async () => {
      const p = await proposal('ask');
      await rights.setRight('Dana', 'mac', 'linux', 'send', DANA);
      expect(await rights.answer(p.id, 'Dana', 'allow', DANA)).toMatchObject({ ok: true, request: { outcome: 'allowed' }, applied: { level: 'send' } });
      expect((await rights.effective('mac', 'linux')).level).toBe('send');
    });

    it('applies an allowed access request without lowering a higher right', async () => {
      const a = await access({ right: 'see' });
      if (!a.ok || a.state !== 'asked') throw new Error('not asked');
      await rights.setRight('Dana', 'mac', 'linux', 'ask', DANA);
      expect(await rights.answer(a.request.id, 'Dana', 'allow', DANA)).toMatchObject({ ok: true, applied: { level: 'ask' } });
      const b = await access({ right: 'send', fromSession: 's2' });
      if (!b.ok || b.state !== 'asked') throw new Error('not asked');
      await rights.setDefaults('Dana', { newSend: 'send' }, SERVER, DANA);
      expect(await rights.answer(b.request.id, 'Dana', 'allow', DANA)).toMatchObject({ ok: true, applied: { level: 'ask' } });
      const c = await access({ fromKey: 'pi' });
      if (!c.ok || c.state !== 'asked') throw new Error('not asked');
      expect(await rights.answer(c.request.id, 'Dana', 'allow', DANA)).toMatchObject({ ok: true, applied: { from: 'pi', level: 'see' } });
    });

    it('declines a proposal or an access request, storing no right', async () => {
      const p = await proposal();
      trails = [];
      expect(await rights.answer(p.id, 'Dana', 'decline', DANA)).toMatchObject({ ok: true, request: { outcome: 'declined' }, applied: null });
      expect(trails).toEqual([{ kind: 'declined', request: expect.objectContaining({ id: p.id }), actor: DANA }]);
      expect(await rights.rightsOf('Dana')).toEqual([]);
    });

    it('re-checks the owner when a proposal is allowed', async () => {
      const p = await proposal();
      reps.set('linux', { ...reps.get('linux')!, owner: 'Eve' });
      expect(await rights.answer(p.id, 'Dana', 'allow', DANA)).toEqual({ ok: false, status: 403, error: 'not your reporter' });
      expect((await rights.getRequest(p.id))?.closedAt).toBeNull();
      expect(await rights.rightsOf('Dana')).toEqual([]);
    });

    it('closes a message request as delivered or declined and hands the message back, with no trail', async () => {
      const m1 = await rights.openMessageRequest({ owner: 'Dana', fromKey: 'mac', toKey: 'linux', by: 'b', fromSession: 's1', messageId: 'm1' });
      const m2 = await rights.openMessageRequest({ owner: 'Dana', fromKey: 'mac', toKey: 'linux', by: 'b', fromSession: 's1', messageId: 'm2' });
      expect(await rights.answer(m1.id, 'Dana', 'deliver', DANA)).toMatchObject({ ok: true, request: { outcome: 'delivered' }, message: { id: 'm1', deliver: true } });
      expect(await rights.answer(m2.id, 'Dana', 'decline', DANA)).toMatchObject({ ok: true, request: { outcome: 'declined' }, message: { id: 'm2', deliver: false } });
      expect(await rights.answer(m1.id, 'Dana', 'deliver', DANA)).toEqual({ ok: false, status: 410, error: 'already delivered' });
      expect(trails).toEqual([]);
    });
  });

  describe('peer rights: retention', () => {
    it('deletes closed requests before the cutoff, and requests and rights about a reporter that is gone', async () => {
      const old = await rights.openMessageRequest({ owner: 'Dana', fromKey: 'mac', toKey: 'linux', by: 'b', fromSession: 's1', messageId: 'm1' });
      await rights.closeMessageRequest('m1', 'delivered');
      t = START + 1000;
      const recent = await rights.openMessageRequest({ owner: 'Dana', fromKey: 'mac', toKey: 'linux', by: 'b', fromSession: 's1', messageId: 'm2' });
      await rights.closeMessageRequest('m2', 'delivered');
      const open = await rights.openMessageRequest({ owner: 'Dana', fromKey: 'mac', toKey: 'linux', by: 'b', fromSession: 's1', messageId: 'm3' });
      const aboutPi = await rights.propose('linux', 'pi', 'see', ADMIN);
      await rights.setRight('Dana', 'mac', 'pi', 'send', DANA);
      await rights.setRight('Dana', 'mac', 'linux', 'send', DANA);
      if (!aboutPi.ok) throw new Error('refused');
      reps.delete('pi');

      expect(await rights.retain(START + 500)).toBe(2);
      expect(await rights.getRequest(old.id)).toBeNull();
      expect(await rights.getRequest(aboutPi.request.id)).toBeNull();
      expect(await rights.getRequest(recent.id)).not.toBeNull();
      expect(await rights.getRequest(open.id)).not.toBeNull();
      expect((await rights.rightsOf('Dana')).map((r) => `${r.from}>${r.to}`)).toEqual(['mac>linux']);
      expect(await rights.retain(START + 500)).toBe(0);
    });

    it("closes a message request whose message is no longer stored, and leaves one whose message is", async () => {
      await db.run(
        `INSERT INTO peer_messages (id, owner, link, from_key, to_key, from_session, to_session, from_name, from_machine, to_name, to_machine, text, sent_at, state, state_at, approved, handed)
         VALUES ('kept', 'Dana', 'linux|mac', 'mac', 'linux', 's1', 's2', 'a', 'mac', 'b', 'linux', 'hi', 1, 'approval', 1, 0, 0)`,
      );
      const kept = await rights.openMessageRequest({ owner: 'Dana', fromKey: 'mac', toKey: 'linux', by: 'b', fromSession: 's1', messageId: 'kept' });
      const gone = await rights.openMessageRequest({ owner: 'Dana', fromKey: 'mac', toKey: 'linux', by: 'b', fromSession: 's1', messageId: 'gone' });
      t = START + 7;
      await rights.retain(START);
      expect(await rights.getRequest(kept.id)).toMatchObject({ closedAt: null, outcome: null });
      expect(await rights.getRequest(gone.id)).toMatchObject({ closedAt: START + 7, outcome: 'dropped' });
      expect((await rights.openRequests('Dana')).map((r) => r.id)).toEqual([kept.id]);
    });
  });
});
