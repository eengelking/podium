// The rules the rights stores share (#1309): an owner's defaults from the stored row, the limits an owner works under, and `effectiveOf`, what one reporter can do to another.
import { describe, expect, it } from 'vitest';
import type { ReporterRef, RightRow } from '../fleet/peerTypes.js';
import { distinctOwners, eligible, effectiveOf, effectivesOf, limitsOf, limitsOfMany, rightKey, toDefaults, trustOwners, type EffectiveRows } from './peerRightsRows.js';

const rep = (key: string, over: Partial<ReporterRef> = {}): ReporterRef => ({ key, machine: key, owner: 'ed', ownerId: 11, adminSecret: false, os: null, peers: true, version: '1.0.0', reporterName: 'podium-reporter-claudecode', ...over });
const right = (from: string, to: string, over: Partial<RightRow> = {}): RightRow => ({ from, to, owner: 'ed', level: 'send', paused: false, setAt: 1, ...over });

/** Rows as an adapter would have read them. */
const rows = (reporters: ReporterRef[], rights: RightRow[], trusting: number[] = []): EffectiveRows => ({
  right: (from, to) => rights.find((r) => r.from === from && r.to === to),
  reporter: (key) => reporters.find((r) => r.key === key),
  trusts: (id) => trusting.includes(id),
});

describe('toDefaults', () => {
  it('gives the built-in defaults for an owner with no row', () => {
    expect(toDefaults(undefined)).toEqual({ trust: false, onRequest: 'ask', newSend: 'ask', limits: {} });
  });

  it('reads a stored row, keeps the limits that are valid and falls back for a value it does not know', () => {
    expect(toDefaults({ trust: 1, on_request: 'allow', new_send: 'send', limits_json: '{"roundTrips":3}' })).toEqual({ trust: true, onRequest: 'allow', newSend: 'send', limits: { roundTrips: 3 } });
    expect(toDefaults({ trust: 0, on_request: 'nonsense', new_send: '', limits_json: '{"roundTrips":-1,"perMinute":"x"}' })).toEqual({ trust: false, onRequest: 'ask', newSend: 'ask', limits: {} });
    expect(toDefaults({ trust: 0, on_request: 'ask', new_send: 'ask', limits_json: 'not json' }).limits).toEqual({});
    expect(toDefaults({ trust: 0, on_request: 'ask', new_send: 'ask', limits_json: '[1]' }).limits).toEqual({});
    expect(toDefaults({ trust: 0, on_request: 'ask', new_send: 'ask', limits_json: null }).limits).toEqual({});
  });
});

describe('limitsOf', () => {
  it('takes each of the owner\'s limits and never one above the Admin\'s', () => {
    const server = { roundTrips: 10, perMinute: 6, maxChars: 20_000 };
    expect(limitsOf({}, server)).toEqual(server);
    expect(limitsOf({ roundTrips: 3, perMinute: 60 }, server)).toEqual({ roundTrips: 3, perMinute: 6, maxChars: 20_000 });
  });
});

describe('distinctOwners and limitsOfMany', () => {
  it('reads each owner once, leaves out no owner, and answers every entry in order, the server\'s limits for no owner or one with no row', () => {
    const server = { roundTrips: 10, perMinute: 6, maxChars: 20_000 };
    expect(distinctOwners([3, null, 3, 4])).toEqual([3, 4]);
    const own = new Map([[3, { trust: false, onRequest: 'ask' as const, newSend: 'ask' as const, limits: { roundTrips: 2 } }]]);
    expect(limitsOfMany([4, null, 3, 3], own, server)).toEqual([server, server, { ...server, roundTrips: 2 }, { ...server, roundTrips: 2 }]);
  });
});

describe('effectivesOf', () => {
  it('answers each link in order from the rows read, the same as effectiveOf does one by one', () => {
    const ab = [rep('a'), rep('b')];
    const stored = [right('a', 'b', { level: 'ask' })];
    const answers = effectivesOf([['a', 'b'], ['b', 'a']], new Map(stored.map((r) => [rightKey(r.from, r.to), r])), new Map(ab.map((r) => [r.key, r])), new Map([[11, { trust: false, onRequest: 'ask' as const, newSend: 'ask' as const, limits: {} }]]));
    expect(answers).toEqual([{ level: 'ask', paused: false }, { level: 'none', paused: false }]);
  });
});

describe('eligible', () => {
  it('is true for a reporter a person owns, not for the admin secret\'s or one whose person was deleted', () => {
    expect(eligible(rep('a'))).toBe(true);
    expect(eligible(rep('a', { adminSecret: true }))).toBe(false);
    expect(eligible(rep('a', { ownerId: null }))).toBe(false);
    expect(eligible(rep('a', { owner: null }))).toBe(false);
  });
});

describe('effectiveOf', () => {
  const ab = [rep('a'), rep('b')];

  it('is the stored right between two reporters of one person, with who paused it', () => {
    expect(effectiveOf('a', 'b', rows(ab, [right('a', 'b', { level: 'ask' })]))).toEqual({ level: 'ask', paused: false });
    expect(effectiveOf('a', 'b', rows(ab, [right('a', 'b', { paused: true, pausedBy: 'admin', pausedByAdmin: 'Root' })]))).toEqual({ level: 'send', paused: true, pausedBy: 'admin', pausedByAdmin: 'Root' });
    expect(effectiveOf('b', 'a', rows(ab, [right('a', 'b')]))).toEqual({ level: 'none', paused: false });
  });

  it('is Send when the owner trusts their own reporters, whatever is stored, and keeps a pause', () => {
    expect(effectiveOf('a', 'b', rows(ab, [], [11]))).toEqual({ level: 'send', paused: false });
    expect(effectiveOf('a', 'b', rows(ab, [right('a', 'b', { level: 'see', paused: true, pausedBy: 'owner' })], [11]))).toEqual({ level: 'send', paused: true, pausedBy: 'owner' });
    expect(effectiveOf('a', 'b', rows(ab, [], [12]))).toEqual({ level: 'none', paused: false });
  });

  it('is nothing when a reporter is unknown, on the admin secret, has no person or belongs to another person', () => {
    const stored = [right('a', 'b')];
    expect(effectiveOf('a', 'b', rows([rep('a')], stored))).toEqual({ level: 'none', paused: false });
    expect(effectiveOf('a', 'b', rows([rep('a'), rep('b', { adminSecret: true })], stored))).toEqual({ level: 'none', paused: false });
    expect(effectiveOf('a', 'b', rows([rep('a'), rep('b', { ownerId: null })], stored))).toEqual({ level: 'none', paused: false });
    expect(effectiveOf('a', 'b', rows([rep('a'), rep('b', { ownerId: 12 })], stored, [11, 12]))).toEqual({ level: 'none', paused: false });
  });

  it('reads one reporter\'s own link to itself once', () => {
    expect(effectiveOf('a', 'a', rows([rep('a')], [right('a', 'a', { level: 'see' })]))).toEqual({ level: 'see', paused: false });
  });

  it('is the row alone for a person\'s link to another person\'s agent, with no trust and no reporter needed', () => {
    expect(effectiveOf('person:11', 'x', rows([], [right('person:11', 'x', { level: 'send' })], [11]))).toEqual({ level: 'send', paused: false });
    expect(effectiveOf('person:11', 'x', rows([], []))).toEqual({ level: 'none', paused: false });
    expect(effectiveOf('person:11', 'x', rows([], [right('person:11', 'x', { paused: true, pausedBy: 'owner' })]))).toEqual({ level: 'send', paused: true, pausedBy: 'owner' });
  });
});

describe('trustOwners', () => {
  it('names the owners whose trust the links read, once each, and none for a link that reads none', () => {
    const reps = new Map([rep('a'), rep('b'), rep('c', { ownerId: 12 }), rep('d', { ownerId: 12 }), rep('s', { adminSecret: true })].map((r) => [r.key, r]));
    const owners = trustOwners([['a', 'b'], ['b', 'a'], ['c', 'd'], ['a', 'c'], ['a', 's'], ['person:11', 'a'], ['a', 'nobody'], ['d', 'd']], (k) => reps.get(k));
    expect(owners.sort()).toEqual([11, 12]);
    expect(trustOwners([['a', 'c'], ['person:11', 'a']], (k) => reps.get(k))).toEqual([]);
  });
});
