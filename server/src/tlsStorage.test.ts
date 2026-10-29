import { describe, expect, it } from 'vitest';
import { createLogger } from './logging/logger.js';
import { tlsDir, tlsStorageProblem, warnIfTlsNotPersistent } from './tlsStorage.js';

const line = (root: string, mount: string) => `600 580 0:55 ${root} ${mount} rw,relatime - ext4 /dev/vda1 rw`;
const ANON = `/var/lib/containers/storage/volumes/${'a1'.repeat(32)}/_data`;
const NAMED = '/var/lib/containers/storage/volumes/podium-data/_data';

describe('tlsDir', () => {
  it('is the tls folder inside the data directory', () => {
    expect(tlsDir('/data')).toBe('/data/tls');
    expect(tlsDir('/repo/data')).toBe('/repo/data/tls');
  });
});

describe('tlsStorageProblem', () => {
  it('is null when /data/tls is a mount of its own, such as the bind mount podiumctl makes', () => {
    expect(tlsStorageProblem(`${line('/', '/')}\n${line('/home/me/.podium/tls', '/data/tls')}`, '/data/tls')).toBeNull();
  });

  it('is null when /data is a named volume', () => {
    expect(tlsStorageProblem(`${line('/', '/')}\n${line(NAMED, '/data')}`, '/data/tls')).toBeNull();
  });

  it('names the problem when nothing is mounted at /data or /data/tls', () => {
    expect(tlsStorageProblem(line('/', '/'), '/data/tls')).toMatch(/not on a volume or a bind mount/);
  });

  it('treats the anonymous volume the image declares for /data as not persistent', () => {
    expect(tlsStorageProblem(line(ANON, '/data'), '/data/tls')).toMatch(/lose the CA/);
  });

  it('does not take /data2 or /database for /data', () => {
    expect(tlsStorageProblem(`${line(NAMED, '/data2')}\n${line(NAMED, '/database')}`, '/data/tls')).not.toBeNull();
  });

  it('is null for a folder that is not under /data, where the host decides', () => {
    expect(tlsStorageProblem(line('/', '/'), '/home/me/.podium/data/tls')).toBeNull();
  });
});

describe('warnIfTlsNotPersistent', () => {
  const run = (env: Record<string, string>, mountinfo: string | null) => {
    const lines: string[] = [];
    const logger = createLogger({ format: 'json', write: (l) => lines.push(l) });
    warnIfTlsNotPersistent({ env, dataDir: '/data', logger, readMountinfo: () => mountinfo });
    return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  };

  it('logs one tls.storage_not_persistent warning when TLS is on and the CA would be lost', () => {
    const events = run({ PODIUM_TLS: 'on' }, line('/', '/'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: 'warn', event: 'tls.storage_not_persistent', dir: '/data/tls' });
  });

  it('says nothing with TLS off, with a persistent folder, or when mountinfo cannot be read', () => {
    expect(run({}, line('/', '/'))).toEqual([]);
    expect(run({ PODIUM_TLS: 'off' }, line('/', '/'))).toEqual([]);
    expect(run({ PODIUM_TLS: 'on' }, line('/h/tls', '/data/tls'))).toEqual([]);
    expect(run({ PODIUM_TLS: 'on' }, null)).toEqual([]);
  });
});
