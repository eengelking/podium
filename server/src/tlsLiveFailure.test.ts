// The TLS settings held in memory follow the stored rows, also when a write's COMMIT fails (#313).
import { describe, expect, it } from 'vitest';
import { openSqliteStorage } from './storage/sqlite/index.js';
import { LiveTlsSettings } from './tlsLive.js';

/** A deferred foreign key that fails at COMMIT when the given settings key is inserted. */
const failCommitOn = (db: ReturnType<typeof openSqliteStorage>['sqliteHandle'], key: string) =>
  db.exec(`CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(p INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER bad AFTER INSERT ON settings WHEN NEW.key = '${key}' BEGIN INSERT INTO child VALUES (999); END;`);

describe('LiveTlsSettings when COMMIT fails', () => {
  it('keeps the reporter lifetime that is stored, not the one that was rolled back', async () => {
    const s = openSqliteStorage(':memory:');
    const live = new LiveTlsSettings(s.tlsSettings, s.tx);
    await live.load();
    const before = live.getReporter().lifetimeDays;
    failCommitOn(s.sqliteHandle, 'tls.reporter.lifetimeDays');
    await expect(live.set({ 'tls.reporter.lifetimeDays': 77 })).rejects.toThrow(/FOREIGN KEY/);
    expect(live.getReporter().lifetimeDays).toBe(before);
    expect(s.sqliteHandle.prepare("SELECT value FROM settings WHERE key = 'tls.reporter.lifetimeDays'").get()).toBeUndefined();
  });

  it('keeps the reporter-HTTP gate that is stored when the seed does not commit', async () => {
    const s = openSqliteStorage(':memory:');
    const live = new LiveTlsSettings(s.tlsSettings, s.tx);
    await live.load();
    expect(live.allowReportersOverHttp()).toBe(true); // a missing row reads as on
    failCommitOn(s.sqliteHandle, 'tls.allowReportersOverHttp');
    await expect(live.seedAllowReportersOverHttp(false)).rejects.toThrow(/FOREIGN KEY/);
    expect(live.allowReportersOverHttp()).toBe(true);
  });

  it('still holds what a write stores when it commits', async () => {
    const s = openSqliteStorage(':memory:');
    const live = new LiveTlsSettings(s.tlsSettings, s.tx);
    await live.load();
    const out = await live.set({ 'tls.reporter.lifetimeDays': 77, 'tls.allowReportersOverHttp': false });
    expect(out.ok).toBe(true);
    expect(live.getReporter().lifetimeDays).toBe(77);
    expect(live.allowReportersOverHttp()).toBe(false);
    await live.seedAllowReportersOverHttp(true); // a row that exists is left alone
    expect(live.allowReportersOverHttp()).toBe(false);
  });
});
