// Built-in TLS keeps its CA in a folder in the data directory (#577). If that folder is not on a volume or a bind mount,
// recreating the container loses the CA and every reporter config must be reissued, so the server says so at start (#580).
import path from 'node:path';
import fs from 'node:fs';
import type { Logger } from './logging/logger.js';

/** The CA's folder: `tls` in the data directory, so /data/tls in the container and data/tls in standalone mode. */
export const tlsDir = (dataDir: string): string => path.join(dataDir, 'tls');

// The anonymous volume a `docker run` without -v gets from the image's VOLUME /data is named by 64 hex digits, and goes
// with the container's removal; a named volume or a bind mount is a person's choice to keep the data.
const ANONYMOUS_VOLUME = /\/volumes\/[0-9a-f]{64}\//;

/**
 * Why the CA folder `dir` would not outlive its container, or null. Only a folder under /data is judged (that is the
 * container's layout); anywhere else the host decides. `mountinfo` is the text of /proc/self/mountinfo.
 */
export function tlsStorageProblem(mountinfo: string, dir: string): string | null {
  if (dir !== '/data/tls') return null;
  const durable = mountinfo.split('\n').some((l) => {
    const f = l.split(' ');
    return (f[4] === '/data/tls' || f[4] === '/data') && !ANONYMOUS_VOLUME.test(f[3] ?? '');
  });
  return durable ? null : `TLS is on but ${dir} is not on a volume or a bind mount, so recreating the container would lose the CA and every reporter config would need reissuing. Start it with \`podiumctl start --tls\`, or mount a named volume or folder at /data.`;
}

export function warnIfTlsNotPersistent(o: {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  logger: Logger;
  readMountinfo?: () => string | null;
}): void {
  if (o.env.PODIUM_TLS !== 'on') return;
  const read = o.readMountinfo ?? (() => { try { return fs.readFileSync('/proc/self/mountinfo', 'utf8'); } catch { return null; } });
  const text = read();
  if (text === null) return;
  const dir = tlsDir(o.dataDir);
  const problem = tlsStorageProblem(text, dir);
  if (problem) o.logger.warn('tls.storage_not_persistent', `podium: ${problem}`, { dir });
}
