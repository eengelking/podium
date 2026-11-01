// Contract cases for the settings stores (#890): feature flags, the wall's display settings, model prices, the TLS settings, the
// peer server settings and a person's certificates. Each runs one scenario over the adapter and over the SQLite reference
// (`sameOnBoth`) and states in itself what a value must be where two equal wrong answers would pass.
import { it, expect } from 'vitest';
import { sameOnBoth, type Openers } from './contractSame.js';
import { FEATURES } from './features.js';
import type { Storage } from './types.js';

const T0 = 1_800_000_000_000;

export function settingsCases(o: Openers): void {
  it('matches SQLite for feature flags: unknown ids, defaults, and what the console is sent', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
      const f = s.featureFlags;
      await rec('view (fresh)', f.view());
      for (const def of FEATURES) await rec(`on ${def.id} (fresh)`, f.featureOn(def.id));
      await rec('on unknown', f.featureOn('no-such-flag'));
      await rec('set unknown', f.setFeature('no-such-flag', false));
      const id = FEATURES[0]!.id;
      await rec('set off', f.setFeature(id, false));
      await rec('on after off', f.featureOn(id));
      await rec('set on', f.setFeature(id, true));
      await rec('view (after)', f.view());
    });
    expect(t.get('set unknown')).toBe(false);
    expect(Object.keys(t.get('view (fresh)') as object).sort()).toEqual(FEATURES.map((d) => d.id).sort());
  });

  it('matches SQLite for the wall settings, and a setter says whether it changed the value', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
      const w = s.wallSettings;
      await rec('view (fresh)', w.view());
      await rec('update dismissed (fresh)', w.updateDismissed());
      await rec('notice unknown', w.setNotice('nope', true));
      await rec('notice on', w.setNotice('background-sessions', true));
      await rec('notice on again', w.setNotice('background-sessions', true));
      await rec('notice off', w.setNotice('background-sessions', false));
      await rec('background on', w.setShowBackgroundSessions(true));
      await rec('background on again', w.setShowBackgroundSessions(true));
      await rec('title machine', w.setCardTitleMachine(true));
      await rec('title machine again', w.setCardTitleMachine(true));
      await rec('dismiss', w.dismissUpdate('1.2.3'));
      await rec('dismiss again', w.dismissUpdate('1.2.3'));
      await rec('update dismissed', w.updateDismissed());
      await rec('view (after)', w.view());
    });
    expect(t.get('notice unknown')).toEqual({ known: false, changed: false });
    expect(t.get('update dismissed')).toBe('1.2.3');
  });

  it('matches SQLite for model prices: validation messages, saved rows, and resetting a row', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
      const m = s.modelPrices;
      await rec('overrides (fresh)', m.overrides());
      await rec('view (fresh)', m.view());
      await rec('set empty key', m.set('  ', { std: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1, cacheWrite1h: 2 } }));
      await rec('set proto', m.set('__proto__', { std: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1, cacheWrite1h: 2 } }));
      await rec('set bad price', m.set('my-model', { std: { input: -1, output: 2, cacheRead: 0.1, cacheWrite: 1, cacheWrite1h: 2 } }));
      await rec('set long on a model without one', m.set('my-model', { std: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1, cacheWrite1h: 2 }, long: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1, cacheWrite1h: 2 } }));
      await rec('set', m.set('  My-Model ', { std: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.875, cacheWrite1h: 3 } }));
      await rec('overrides (set)', m.overrides());
      await rec('pricing (set)', m.pricing());
      await rec('view (set)', m.view());
      await rec('reset unknown', m.reset('never-set'));
      await rec('reset', m.reset('MY-MODEL'));
      await rec('overrides (reset)', m.overrides());
      await rec('view (reset)', m.view());
    });
    expect(t.get('set')).toBeNull();
    expect(Object.keys(t.get('overrides (set)') as object)).toEqual(['my-model']);
    expect(t.get('overrides (reset)')).toEqual({});
  });

  it('matches SQLite for the TLS settings, the reporter setting and the first-run seed of "allow reporters over HTTP"', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
      const tls = s.tlsSettings;
      await rec('get (fresh)', tls.get());
      await rec('reporter (fresh)', tls.getReporter());
      await rec('allow (missing row)', tls.allowReportersOverHttp());
      await rec('seed fresh install', tls.seedAllowReportersOverHttp(false));
      await rec('allow (seeded off)', tls.allowReportersOverHttp());
      await rec('seed existing install (row exists, left alone)', tls.seedAllowReportersOverHttp(true));
      await rec('allow (still off)', tls.allowReportersOverHttp());
      await rec('set unknown key', tls.set({ 'no.such.key': 1 }));
      await rec('set too low', tls.set({ 'tls.serving.lifetimeDays': 1 }));
      await rec('set all-or-nothing', tls.set({ 'tls.serving.lifetimeDays': 100, 'tls.serving.renewBeforeDays': 1 }));
      await rec('get (nothing saved)', tls.get());
      await rec('set', tls.set({ 'tls.serving.lifetimeDays': 100, 'tls.reporter.lifetimeDays': 60 }));
      await rec('set same again', tls.set({ 'tls.serving.lifetimeDays': 100 }));
      await rec('get (after)', tls.get());
      await rec('reporter (after)', tls.getReporter());
    });
    expect(t.get('allow (missing row)')).toBe(true);
    expect(t.get('allow (seeded off)')).toBe(false);
    expect(t.get('allow (still off)')).toBe(false);
  });

  it('matches SQLite for the peer server settings: values checked first, nothing saved on one failure', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
      // The peer store needs the flag and the live directory; the settings store does not, and is reached through the same call.
      const p = s.peers({ now: () => T0, flagOn: () => true, startedAt: T0 } as never).settings;
      await rec('get (fresh)', p.get());
      await rec('limits (fresh)', p.limits());
      await rec('retainMs (fresh)', p.retainMs());
      await rec('set unknown key', p.set({ 'no.such.key': 1 }));
      await rec('set not a number', p.set({ roundTrips: 'many' }));
      await rec('set one bad of two', p.set({ roundTrips: 3, perMinute: -1 }));
      await rec('set valid', p.set({ retainDays: 7 }));
      await rec('limits (after)', p.limits());
      await rec('retainMs (after)', p.retainMs());
    });
    expect(t.get('retainMs (fresh)')).not.toBe(t.get('retainMs (after)'));
  });

  it('matches SQLite for certificates: replacing revokes the earlier live ones, renewing keeps them, revoking counts', async () => {
    const cert = (n: number, issuer = 'ca-a') => ({
      cert: `PEM${n}`, issuerFingerprint: issuer,
      info: { fingerprintSha256: `fp${n}`, serial: `0${n}`, notBefore: new Date(T0).toISOString(), notAfter: new Date(T0 + 86_400_000).toISOString() },
    }) as unknown as Parameters<Storage['personCerts']['add']>[1];
    const t = await sameOnBoth(o, async (s, rec) => {
      const c = s.personCerts;
      const { person } = await s.people.createPerson('cert-person', null, T0);
      await rec('find (none)', c.find('fp1'));
      await rec('current (none)', c.current(person.id));
      await rec('revoke (none)', c.revokeFor(person.id, 'gone', T0));
      await rec('add', c.add(person.id, cert(1), T0));
      await rec('add (renewed)', c.add(person.id, cert(2, 'ca-b'), T0 + 1));
      await rec('list (both live)', c.listFor(person.id));
      await rec('replace', c.replace(person.id, cert(3), T0 + 2));
      await rec('list (after replace)', c.listFor(person.id));
      await rec('find', c.find('fp1'));
      await rec('current', c.current(person.id));
      await rec('by issuer', c.reportersByIssuer(T0 - 5));
      await rec('revoke', c.revokeFor(person.id, 'lost', T0 + 3));
      await rec('revoke again', c.revokeFor(person.id, 'lost', T0 + 4));
      await rec('current (revoked)', c.current(person.id));
      await rec('list (revoked)', c.listFor(person.id));
      await rec('by issuer (revoked)', c.reportersByIssuer(T0 - 5));
    });
    expect(t.get('revoke (none)')).toBe(0);
    expect(t.get('revoke')).toBe(1);
    expect(t.get('revoke again')).toBe(0);
    expect(t.get('current (revoked)')).toBeUndefined();
  });
}
