// The OpenCode reporter's secure connection (#948): finding the reporter config file, the mTLS handshake against a real local https
// server that asks for a client certificate (certificates made by `openssl`, as core/tls/client.node.test.ts does), the problems a
// reporter that cannot use the file says, and the plugin entry's use of it (one client per location, started and stopped once).
import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartError } from '../core/tls/config.mjs';
import { Reporter, DEFAULTS } from './reporter.ts';
import { optionsOf } from './options.ts';
import plugin from './index.ts';
import { homeOf, nodeSource, openLink, scrub, withLink, type TlsLink } from './tls.ts';

// The real client, with its start and stop counted.
const seen = vi.hoisted(() => ({ made: [] as string[], starts: 0, stops: 0 }));
vi.mock('../core/tls/client.mjs', async (original) => {
  const m = await original<typeof import('../core/tls/client.mjs')>();
  return {
    ...m,
    createTlsClient: (o: Parameters<typeof m.createTlsClient>[0]) => {
      const c = m.createTlsClient(o);
      seen.made.push(o.configPath);
      return { ...c, start: () => { seen.starts++; c.start(); }, stop: () => { seen.stops++; c.stop(); } };
    },
  };
});

const POSIX = process.platform !== 'win32';
const dirs: string[] = [];
process.on('exit', () => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-oc-tls-'));
  dirs.push(d);
  return d;
};

// ---- certificates -------------------------------------------------------------------------------------------------------
const work = tmp();
const run = (...a: string[]) => execFileSync('openssl', a, { cwd: work, stdio: 'pipe' });
const read = (n: string) => fs.readFileSync(path.join(work, n), 'utf8');
fs.writeFileSync(path.join(work, 'ca.cnf'), '[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n');
fs.writeFileSync(path.join(work, 'leaf.cnf'), '[v3]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n');
fs.writeFileSync(path.join(work, 'serving.cnf'), '[v3]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
fs.writeFileSync(path.join(work, 'wrong.cnf'), '[v3]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:elsewhere.example\n');
for (const n of ['ca', 'stranger', 'serving', 'wrong', 'leaf', 'strsrv']) run('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', `${n}.key`);
const root = (n: string, subj: string) => run('req', '-new', '-x509', '-key', `${n}.key`, '-subj', subj, '-config', 'ca.cnf', '-extensions', 'v3_ca', '-days', '3650', '-out', `${n}.crt`);
root('ca', '/CN=Podium CA/O=podium');
root('stranger', '/CN=Stranger CA/O=podium');
let serial = 2000;
function issue(out: string, subj: string, ext: string, days: number, ca = 'ca'): void {
  const key = out.replace(/\.crt$/, '');
  run('pkey', '-in', `${key}.key`, '-pubout', '-out', `${key}.pub`);
  run('x509', '-new', '-force_pubkey', `${key}.pub`, '-subj', subj, '-CA', `${ca}.crt`, '-CAkey', `${ca}.key`, '-set_serial', String(serial++), '-days', String(days), '-extfile', ext, '-extensions', 'v3', '-out', out);
}
issue('serving.crt', '/CN=localhost', 'serving.cnf', 90);
issue('wrong.crt', '/CN=elsewhere', 'wrong.cnf', 90);
issue('leaf.crt', '/CN=pdm_a1b2c3d4e5f6/O=podium', 'leaf.cnf', 90);
issue('strsrv.crt', '/CN=localhost', 'serving.cnf', 90, 'stranger');
const CA = read('ca.crt');
const SERVING = { cert: read('serving.crt'), key: read('serving.key') };
const WRONG_NAME = { cert: read('wrong.crt'), key: read('wrong.key') };
const STRANGER_SERVING = { cert: read('strsrv.crt'), key: read('strsrv.key') };
const LEAF = { cert: read('leaf.crt'), key: read('leaf.key') };
/** The base64 of the private key, which no log line, error, report or status may hold. */
const KEY_BODY = LEAF.key.split('\n').filter((l) => l && !l.startsWith('-----')).join('');
const SECRET = /-----BEGIN|-----END|PRIVATE KEY/;
const holdsKey = (text: string): boolean => SECRET.test(text) || text.includes(KEY_BODY.slice(0, 40));

const configText = (user: string, server: string, extra = '') => `# podium-reporter-config v1\n# user: ${user}\n# server: ${server}\n# issued-at: 1700000000\n${extra}${CA}${LEAF.cert}${LEAF.key}`;
function putConfig(home: string, name: string, text: string, mode = 0o600): string {
  const dir = path.join(home, '.podium');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
  return file;
}

// ---- a server that asks for a client certificate ------------------------------------------------------------------------
interface Up {
  url: string;
  hits: Array<{ method: string; url: string; token: string | undefined; body: string; peer: string | null }>;
}
async function upstream<T>(
  body: (up: Up) => Promise<T>,
  o: { tls?: { cert: string; key: string }; trust?: string[]; status?: number } = {},
): Promise<T> {
  const sockets = new Set<Socket>();
  const up: Up = { url: '', hits: [] };
  const server = https.createServer({ ...(o.tls ?? SERVING), ca: o.trust ?? [CA], requestCert: true, rejectUnauthorized: true }, (req, res) => {
    const raw = (req.socket as unknown as { getPeerCertificate: () => { raw?: Buffer } }).getPeerCertificate().raw;
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      up.hits.push({ method: req.method ?? '', url: req.url ?? '', token: req.headers['x-podium-token'] as string | undefined, body: text, peer: raw ? new X509Certificate(raw).fingerprint256 : null });
      res.writeHead(o.status ?? 200, { 'content-type': 'application/json', date: new Date().toUTCString() });
      res.end(JSON.stringify({ ackedEvents: 100, liveSessions: 1 }));
    });
  });
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  up.url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await body(up);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const POST = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"v":2}' };
const REPORT = '/api/fleet/report';
const now = () => Date.now();
const settings = { userName: null as string | null, serverUrl: 'http://127.0.0.1:4317', reporterConfig: '', reporterContext: '' };

/** Opens the link for a home folder, collecting what it says. */
async function link(home: string, over: Partial<typeof settings> = {}, extra: Partial<Parameters<typeof openLink>[0]> = {}): Promise<{ link: TlsLink | null; said: string[] }> {
  const said: string[] = [];
  const l = await openLink({ options: { ...settings, ...over }, env: { HOME: home }, home, now, warn: (line) => said.push(line), ...extra });
  return { link: l, said };
}
const rejection = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
};

afterEach(() => {
  seen.made.length = 0;
  seen.starts = 0;
  seen.stops = 0;
});

describe('finding the reporter config file (#948)', () => {
  it('takes the newest reporter-config-*.pem in ~/.podium by the epoch in its name, and the address and name in it', async () => {
    const home = tmp();
    putConfig(home, 'reporter-config-Dana-1700000100.pem', configText('Dana', 'https://old.example:4318'));
    const newest = putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', 'https://new.example:4318'));
    const { link: l, said } = await link(home);
    expect(l).toMatchObject({ serverUrl: 'https://new.example:4318', user: 'Dana', configPath: newest, context: null });
    expect(l?.problem()).toBeNull();
    expect(said).toEqual([]);
    l?.stop();
    expect(withLink({ serverUrl: 'http://x', userName: null as string | null }, l)).toEqual({ serverUrl: 'https://new.example:4318', userName: 'Dana' });
  });

  it('takes the file PODIUM_REPORTER_CONFIG names, and the current context in contexts.json', async () => {
    const home = tmp();
    putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', 'https://newest.example:4318'));
    const named = putConfig(home, 'elsewhere.pem', configText('Dana', 'https://named.example:4318'));
    const ctxFile = putConfig(home, 'reporter-config-Dana-1700000100.pem', configText('Dana', 'https://context.example:4318'));
    expect((await link(home, { reporterConfig: named })).link?.configPath).toBe(named);
    fs.writeFileSync(path.join(home, '.podium', 'contexts.json'), JSON.stringify({ current: 'work', contexts: { work: path.basename(ctxFile) } }));
    const { link: byContext } = await link(home);
    expect(byContext).toMatchObject({ context: 'work', configPath: ctxFile, serverUrl: 'https://context.example:4318' });
    byContext?.stop();
    const { link: byName } = await link(home, { reporterContext: 'work' });
    expect(byName?.context).toBe('work');
    byName?.stop();
  });

  it('says when a context cannot be used, and uses the newest file instead', async () => {
    const home = tmp();
    const file = putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', 'https://newest.example:4318'));
    fs.writeFileSync(path.join(home, '.podium', 'contexts.json'), JSON.stringify({ current: null, contexts: {} }));
    const { link: l, said } = await link(home, { reporterContext: 'gone' });
    expect(l?.configPath).toBe(file);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^podium-reporter: .*"gone".*is not one of the contexts/);
    l?.stop();
  });

  it('is no link at all without a file, so the reporter works as before', async () => {
    const home = tmp();
    expect((await link(home)).link).toBeNull();
    fs.mkdirSync(path.join(home, '.podium'));
    expect((await link(home)).link).toBeNull();
    const o = { serverUrl: 'http://127.0.0.1:4317', userName: 'Dana' };
    expect(withLink(o, null)).toBe(o);
  });

  it('answers a PODIUM_REPORTER_CONFIG that is not a config file with a link that sends nothing, over https or http', async () => {
    const home = tmp();
    const plain: string[] = [];
    const server = http.createServer((req, res) => { plain.push(req.url ?? ''); res.end('{}'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const { link: l, said } = await link(home, { reporterConfig: path.join(home, 'nothing.pem'), serverUrl: url });
      expect(l?.problem()?.code).toBe('CONFIG_INVALID');
      expect(said[0]).toContain('PODIUM_REPORTER_CONFIG names');
      expect((await rejection(l!.fetch(`${url}${REPORT}`, POST))).message).toContain('PODIUM_REPORTER_CONFIG names');
      expect(plain).toEqual([]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('is no link when looking for the file fails outright, and says so once', async () => {
    const said: string[] = [];
    const source = { env: { get: async (n: string) => (n === 'HOME' ? '/h' : undefined) }, get fs(): never { throw new Error(`no fs ${LEAF.key}`); } };
    expect(await openLink({ options: settings, env: {}, home: '/h', now, warn: (l) => said.push(l), source })).toBeNull();
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^podium-reporter: could not look for a reporter config file: no fs/);
    expect(holdsKey(said[0]!)).toBe(false);
  });

  it('reads the home folder from HOME, else USERPROFILE, else the operating system', () => {
    expect(homeOf({ HOME: '/a', USERPROFILE: '/b' })).toBe('/a');
    expect(homeOf({ USERPROFILE: '/b' })).toBe('/b');
    expect(homeOf({})).toBe(os.homedir());
  });

  it('lists a folder and tests for a file through node:fs', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'f'), 'x');
    fs.mkdirSync(path.join(dir, 'd'));
    const s = nodeSource({}, dir, { reporterConfig: '', reporterContext: '' });
    expect((await s.fs.list(dir)).sort((a, b) => a.name.localeCompare(b.name))).toEqual([{ name: 'd', kind: 'dir' }, { name: 'f', kind: 'file' }]);
    expect(await s.fs.exists(path.join(dir, 'f'))).toBe(true);
    expect(await s.fs.exists(path.join(dir, 'nope'))).toBe(false);
    expect(await s.env.get('HOME')).toBe(dir);
  });
});

describe('a project cannot choose the file (#856, #948)', () => {
  it('an opencode.json that names a config file, a context or a server changes nothing', () => {
    const hostile = { reporterConfig: '/evil/steal.pem', reporterContext: 'evil', config: '/evil.pem', context: 'evil', PODIUM_REPORTER_CONFIG: '/evil.pem', PODIUM_REPORTER_CONTEXT: 'evil', serverUrl: 'https://evil.test', userName: 'Boss' };
    const o = optionsOf(hostile, null, { PODIUM_REPORTER_CONFIG: '/mine.pem' }, 'PODIUM_REPORTER_CONTEXT=work');
    expect(o).toMatchObject({ reporterConfig: '/mine.pem', reporterContext: 'work', serverUrl: 'http://127.0.0.1:4317', userName: null });
    expect(optionsOf(hostile, null, {}, null)).toMatchObject({ reporterConfig: '', reporterContext: '' });
  });

  it('the plugin entry reads the file in ~/.podium, whatever the project options say', async () => {
    const home = tmp();
    const file = putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', 'https://127.0.0.1:1'));
    putConfig(tmp(), 'evil.pem', configText('Dana', 'https://evil.example:4318'));
    const cleanup = await withEnv({ HOME: home }, async () => {
      const ctx = fakeCtx({ reporterConfig: '/evil/steal.pem', reporterContext: 'evil', config: '/evil.pem', serverUrl: 'https://evil.example' }, '/hostile');
      return (plugin as unknown as { setup: (c: unknown) => Promise<() => Promise<void>> }).setup(ctx);
    });
    expect(seen.made).toEqual([file]);
    await cleanup();
  });
});

describe('the handshake (#948)', () => {
  it('reports with the certificate and no token, and the server sees the person', async () => {
    await upstream(async (up) => {
      const home = tmp();
      putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', up.url));
      const { link: l, said } = await link(home);
      const res = await l!.fetch(`${up.url}${REPORT}`, POST);
      expect(res).toMatchObject({ status: 200, ok: true });
      expect(JSON.parse(res.text)).toMatchObject({ ackedEvents: 100 });
      expect(up.hits).toHaveLength(1);
      expect(up.hits[0]).toMatchObject({ method: 'POST', url: REPORT, token: undefined, peer: new X509Certificate(LEAF.cert).fingerprint256 });
      expect(l!.problem()).toBeNull();
      expect(said).toEqual([]);
      l!.stop();
    });
  });

  it('never goes to another origin or over http: a URL that is not the file\'s server is refused before anything is sent', async () => {
    await upstream(async (up) => {
      const home = tmp();
      putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', up.url));
      const { link: l } = await link(home);
      expect((await rejection(l!.fetch(`http://127.0.0.1:${new URL(up.url).port}${REPORT}`, POST))) as { code?: string }).toMatchObject({ message: expect.stringContaining('own server only') });
      expect((await rejection(l!.fetch(`https://example.com${REPORT}`, POST))).message).toContain('own server only');
      expect(up.hits).toEqual([]);
      l!.stop();
    });
  });

  it('a file whose server is http is not a config file, and a client that refuses http leaves a link that sends nothing', async () => {
    const home = tmp();
    putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', 'http://127.0.0.1:4318'));
    expect((await link(home)).link).toBeNull();
    const refuse = () => { throw new StartError('INSECURE_URL', 'http://127.0.0.1:4318 is not https'); };
    putConfig(home, 'reporter-config-Dana-1700000300.pem', configText('Dana', 'https://127.0.0.1:4318'));
    const { link: l, said } = await link(home, {}, { createClient: refuse });
    expect(l?.problem()).toMatchObject({ code: 'INSECURE_URL', status: 'server address not https' });
    expect(said).toHaveLength(1);
    expect((await rejection(l!.fetch('https://127.0.0.1:4318/api/fleet/report', POST))).message).toContain('never sends a credential over http');
  });

  it('a certificate the server turns away (a 401) is "certificate refused", and an accepted report clears it', async () => {
    await upstream(async (up) => {
      const home = tmp();
      putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', up.url));
      const { link: l, said } = await link(home);
      expect((await l!.fetch(`${up.url}${REPORT}`, POST)).status).toBe(401);
      expect(l!.problem()).toMatchObject({ code: 'CLIENT_CERT_REJECTED', status: 'certificate refused' });
      expect(said).toHaveLength(1);
      await l!.fetch(`${up.url}${REPORT}`, POST);
      expect(said).toHaveLength(1);
      l!.stop();
    }, { status: 401 });
    await upstream(async (up) => {
      const home = tmp();
      putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', up.url));
      const { link: l } = await link(home);
      expect((await l!.fetch(`${up.url}${REPORT}`, POST)).ok).toBe(true);
      expect(l!.problem()).toBeNull();
      l!.stop();
    });
  });

  it('a server that does not accept our certificate fails the request and says so', async () => {
    await upstream(async (up) => {
      const home = tmp();
      putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', up.url));
      const { link: l, said } = await link(home);
      const err = await rejection(l!.fetch(`${up.url}${REPORT}`, POST));
      expect(['CLIENT_CERT_REJECTED', 'CLOSED_AFTER_HANDSHAKE']).toContain(l!.problem()?.code);
      expect(err.message).toBe(l!.problem()?.text);
      expect(said).toHaveLength(1);
      l!.stop();
    }, { trust: [read('stranger.crt')] });
  });

  it('a server whose certificate is not signed by the CA in the file is "server not trusted"', async () => {
    await upstream(async (up) => {
      const home = tmp();
      putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', up.url));
      const { link: l } = await link(home);
      await rejection(l!.fetch(`${up.url}${REPORT}`, POST));
      expect(l!.problem()).toMatchObject({ status: 'server not trusted' });
      l!.stop();
    }, { tls: STRANGER_SERVING });
  });

  it('a server whose certificate is for another name is "wrong server name"', async () => {
    await upstream(async (up) => {
      const home = tmp();
      putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', up.url));
      const { link: l } = await link(home);
      await rejection(l!.fetch(`${up.url}${REPORT}`, POST));
      expect(l!.problem()).toMatchObject({ code: 'ALTNAME', status: 'wrong server name' });
      l!.stop();
    }, { tls: WRONG_NAME });
  });

  it('an outage has no words of its own and does not wipe a standing problem', async () => {
    const home = tmp();
    putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', 'https://127.0.0.1:1'));
    const { link: l, said } = await link(home);
    const err = await rejection(l!.fetch(`https://127.0.0.1:1${REPORT}`, POST));
    expect(err.message).toMatch(/ECONNREFUSED|connect/);
    expect(l!.problem()).toBeNull();
    expect(said).toEqual([]);
    l!.stop();
  });
});

describe('what a reporter that cannot use the file says (#948)', () => {
  it('a name that is not the file\'s is "wrong config for this name" and sends nothing', async () => {
    const home = tmp();
    putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', 'https://127.0.0.1:1'));
    const { link: l, said } = await link(home, { userName: 'Boss' });
    expect(l?.problem()).toMatchObject({ code: 'NAME_MISMATCH', status: 'wrong config for this name' });
    expect(l?.problem()?.text).toContain('comes from PODIUM_USER');
    expect(said).toHaveLength(1);
    expect((await rejection(l!.fetch(`https://127.0.0.1:1${REPORT}`, POST))).message).toBe(l?.problem()?.text);
    // the name the person set stays; the file's does not replace it
    expect(withLink({ serverUrl: 'http://x', userName: 'Boss' as string | null }, l).userName).toBe('Boss');
  });

  it('a name that is the file\'s is taken, and an empty one becomes the file\'s', async () => {
    const home = tmp();
    putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', 'https://127.0.0.1:1'));
    const { link: l } = await link(home, { userName: ' Dana ' });
    expect(l?.problem()).toBeNull();
    l?.stop();
  });

  it.runIf(POSIX)('a file other people can read is "config too open", and nothing is sent', async () => {
    const home = tmp();
    const file = putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', 'https://127.0.0.1:1'), 0o644);
    const { link: l, said } = await link(home);
    expect(l?.problem()).toMatchObject({ code: 'CONFIG_PERMISSIONS', status: 'config too open' });
    expect(l?.problem()?.text).toContain(`chmod 600 ${file}`);
    expect(said).toEqual([`podium-reporter: ${l?.problem()?.text}`]);
    expect((await rejection(l!.fetch(`https://127.0.0.1:1${REPORT}`, POST))).message).toBe(l?.problem()?.text);
    expect(holdsKey(said.join('\n'))).toBe(false);
  });

  it('a file that cannot be parsed past its header is "config unreadable"', async () => {
    const home = tmp();
    putConfig(home, 'reporter-config-Dana-1700000200.pem', '# podium-reporter-config v1\n# user: Dana\n# server: https://127.0.0.1:1\n# issued-at: 1700000000\nnothing else\n');
    const { link: l } = await link(home);
    expect(l?.problem()).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(l?.problem()?.status).toMatch(/^config unreadable: /);
  });

  it('a file that is gone since it was found is "config unreadable"', async () => {
    const home = tmp();
    const file = putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', 'https://127.0.0.1:1'));
    const source = nodeSource({ HOME: home }, home, settings);
    const { link: l } = await link(home, {}, { source: { ...source, fs: { ...source.fs, read: async (p) => { const t = await source.fs.read(p); fs.rmSync(file); return t; } } } });
    expect(l?.problem()).toMatchObject({ code: 'CONFIG_MISSING' });
  });

  it('an expired certificate is "certificate expired" from the start, and the client refuses to connect', async () => {
    const home = tmp();
    putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', 'https://127.0.0.1:1', '# expires: 2020-01-02T03:04:05Z\n'));
    const { link: l, said } = await link(home);
    expect(l?.problem()).toMatchObject({ code: 'CERT_EXPIRED', status: 'certificate expired' });
    expect(l?.problem()?.text).toContain('on 2020-01-02');
    expect(said).toHaveLength(1);
    l?.stop();
  });

  it('a client that refuses an expired certificate is worded with the date, and any other failure of the client is its own message', async () => {
    const home = tmp();
    putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', 'https://127.0.0.1:1'));
    const refusing = (code: string, message: string): never => ({ start() {}, stop() {}, status: () => ({ notAfter: Date.parse('2021-05-06T00:00:00Z') }), fetch: () => Promise.reject(Object.assign(new Error(message), { code })) }) as never;
    const a = await link(home, {}, { createClient: (() => refusing('CERT_EXPIRED', 'x')) as never });
    expect((await rejection(a.link!.fetch('https://127.0.0.1:1/api/fleet/report', POST))).message).toContain('expired on 2021-05-06');
    const b = await link(home, {}, { createClient: (() => refusing('CERT_HAS_EXPIRED', 'x')) as never });
    await rejection(b.link!.fetch('https://127.0.0.1:1/api/fleet/report', POST));
    expect(b.link!.problem()).toMatchObject({ code: 'CERT_HAS_EXPIRED', status: 'check the clock' });
    const c = await link(home, {}, { createClient: (() => { throw new Error('odd'); }) as never });
    expect(c.link!.problem()).toMatchObject({ code: 'TLS_CLIENT', status: 'connection unavailable' });
    expect(c.link!.problem()?.text).toContain('odd');
    // a renewal that failed is said once
    let log: (l: string) => void = () => undefined;
    const d = await link(home, {}, { createClient: ((o: { log: (l: string) => void }) => { log = o.log; return refusing('X', 'x'); }) as never });
    log('renewal failed: the server answered 500');
    log('renewal failed: the server answered 500');
    expect(d.said).toEqual(['podium-reporter: renewal failed: the server answered 500']);
  });
});

describe('the private key stays out of every message (#948)', () => {
  it('scrub removes a PEM block, even one cut off', () => {
    expect(scrub(`before ${LEAF.key.trim()} after`)).toBe('before [removed] after');
    expect(scrub('x -----BEGIN PRIVATE KEY-----\nMIIabc')).toBe('x [removed]');
    expect(scrub('nothing to see')).toBe('nothing to see');
  });

  it('a message that carries a key is scrubbed on its way out', async () => {
    const home = tmp();
    putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', 'https://127.0.0.1:1'));
    const leaky = ((): never => ({ start() {}, stop() {}, status: () => ({ notAfter: 0 }), fetch: () => Promise.reject(Object.assign(new Error(`bad ${LEAF.key}`), { code: 'WEIRD' })) })) as never;
    const { link: l } = await link(home, {}, { createClient: leaky });
    const err = await rejection(l!.fetch('https://127.0.0.1:1/api/fleet/report', POST));
    expect(holdsKey(err.message)).toBe(false);
    const thrown = (): never => { throw new Error(`bad ${LEAF.key}`); };
    const { link: s, said } = await link(home, {}, { createClient: thrown as never });
    expect(holdsKey(s!.problem()!.text)).toBe(false);
    expect(holdsKey(said.join('\n'))).toBe(false);
  });

  it('no line, error, status or report of a whole run, failures included, holds the key or a certificate', async () => {
    const everything: string[] = [];
    const oldWarn = console.warn;
    console.warn = (...a: unknown[]) => everything.push(a.join(' '));
    try {
      for (const o of [{}, { tls: WRONG_NAME }, { tls: STRANGER_SERVING }, { trust: [read('stranger.crt')] }, { status: 401 }]) {
        await upstream(async (up) => {
          const home = tmp();
          putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', up.url));
          const { link: l, said } = await link(home);
          const sent: string[] = [];
          const reporter = new Reporter({ fetch: (url, init) => { sent.push(init.body ?? ''); return l!.fetch(url, init); }, now, runIn: () => async () => ({ exitCode: 1, stdout: '' }), log: (line) => everything.push(line), problem: l!.problem }, withLink(optionsOf(null, null, {}, null), l));
          reporter.handle({ id: 'a', type: 'session.created', data: { sessionID: 's1', version: '2.2.5' }, created: 1, location: { directory: '/w' } });
          await reporter.tick().catch((e) => everything.push(String(e)));
          const t = reporter.transports.get('s1');
          everything.push(...said, ...sent, t?.lastError ?? '', reporter.statusText() ?? '', l!.problem()?.text ?? '', JSON.stringify(l!.problem()));
          l!.stop();
        }, o);
      }
    } finally {
      console.warn = oldWarn;
    }
    expect(everything.length).toBeGreaterThan(5);
    for (const line of everything) {
      expect(holdsKey(line)).toBe(false);
      expect(line).not.toContain('BEGIN CERTIFICATE');
    }
  });
});

describe('the Reporter over the link (#948)', () => {
  it('sends a report through the certificate, with no token; a failed connection is a failed send with the usual backoff, and the status leads with the problem', async () => {
    await upstream(async (up) => {
      const home = tmp();
      putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', up.url));
      const { link: l } = await link(home);
      const reporter = new Reporter({ fetch: l!.fetch, now, runIn: () => async () => ({ exitCode: 1, stdout: '' }), log: () => undefined, problem: l!.problem }, withLink(optionsOf(null, null, {}, null), l));
      expect(reporter.statusText()).toBeNull();
      reporter.handle({ id: 'a', type: 'session.created', data: { sessionID: 's1', version: '2.2.5' }, created: 1, location: { directory: '/w' } });
      await reporter.tick();
      expect(up.hits).toHaveLength(1);
      expect(up.hits[0]!.token).toBeUndefined();
      expect(JSON.parse(up.hits[0]!.body)).toMatchObject({ v: 2, session: { id: 's1' }, userName: 'Dana' });
      expect(reporter.statusText()).toMatch(/● 1 live$/);
      l!.stop();
    });
    // a server that cannot be reached: the same backoff as without a file
    const home = tmp();
    putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', 'https://127.0.0.1:1'));
    const { link: l } = await link(home);
    let at = 1000;
    const reporter = new Reporter({ fetch: l!.fetch, now: () => at, runIn: () => async () => ({ exitCode: 1, stdout: '' }), log: () => undefined, problem: l!.problem }, withLink(optionsOf(null, null, {}, null), l));
    reporter.handle({ id: 'a', type: 'session.created', data: { sessionID: 's1' }, created: 1, location: { directory: '/w' } });
    await reporter.tick();
    const t = reporter.transports.get('s1')!;
    expect(t.failures).toBe(1);
    expect(t.nextAttemptAt).toBe(at + 1000);
    expect(t.lastError).toMatch(/ECONNREFUSED|connect/);
    expect(reporter.statusText()).toMatch(/○ offline$/);
    at += 1;
    await reporter.tick();
    expect(t.failures).toBe(1);
    l!.stop();
  });

  it('shows the problem in the status when the file cannot be used, and a plain http server with a token works as before', async () => {
    const posts: Array<{ token: string | undefined; url: string }> = [];
    const server = http.createServer((req, res) => {
      posts.push({ token: req.headers['x-podium-token'] as string | undefined, url: req.url ?? '' });
      res.end(JSON.stringify({ ackedEvents: 1 }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const home = tmp();
      expect((await link(home)).link).toBeNull();
      const plainFetch = async (u: string, init: { method: string; headers: Record<string, string>; body?: string }) => { const r = await fetch(u, init); return { status: r.status, ok: r.ok, text: await r.text() }; };
      const opts = withLink(optionsOf(null, null, { PODIUM_SERVER: url, PODIUM_TOKEN: 'secret-token', PODIUM_USER: 'Dana' }, null), null);
      const reporter = new Reporter({ fetch: plainFetch, now, runIn: () => async () => ({ exitCode: 1, stdout: '' }), log: () => undefined }, opts);
      reporter.handle({ id: 'a', type: 'session.created', data: { sessionID: 's1' }, created: 1, location: { directory: '/w' } });
      await reporter.tick();
      expect(posts).toEqual([{ token: 'secret-token', url: REPORT }]);
      expect(reporter.statusText()).toMatch(/● 1 live$/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    const bad = tmp();
    putConfig(bad, 'reporter-config-Dana-1700000200.pem', configText('Dana', 'https://127.0.0.1:1'), 0o644);
    if (!POSIX) return;
    const { link: l } = await link(bad);
    const reporter = new Reporter({ fetch: l!.fetch, now, runIn: () => async () => ({ exitCode: 1, stdout: '' }), log: () => undefined, problem: l!.problem }, withLink(optionsOf(null, null, {}, null), l));
    reporter.handle({ id: 'a', type: 'session.created', data: { sessionID: 's1' }, created: 1, location: { directory: '/w' } });
    await reporter.tick();
    expect(reporter.statusText()).toMatch(/○ config too open$/);
    expect(reporter.transports.get('s1')?.lastError).toContain('chmod 600');
  });
});

// ---- the plugin entry ---------------------------------------------------------------------------------------------------
async function withEnv<T>(vars: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    old[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await body();
  } finally {
    for (const k of Object.keys(vars)) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
}

/** The part of OpenCode's plugin context the entry uses, with one session's events. */
function fakeCtx(options: Record<string, unknown>, directory: string, events: unknown[] = []) {
  const emitted: { name: string; data: any }[] = [];
  const commands: { name: string; description?: string; execute: (i: any) => Promise<void> }[] = [];
  const tools: { name: string; description: string; input: unknown; execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }> }[] = [];
  const prompts: unknown[] = [];
  const generated: unknown[] = [];
  const hooks: Record<string, (i: any) => void> = {};
  return {
    options,
    location: { directory },
    event: { subscribe: async function* () { for (const e of events) yield e; } },
    permission: { list: async () => [] },
    rpc: { register: async () => ({ events: { emit: async (name: string, data: unknown) => void emitted.push({ name, data }) } }) },
    command: { transform: async (cb: (e: { add: (d: (typeof commands)[number]) => void }) => void) => { cb({ add: (d) => void commands.push(d) }); return { dispose: async () => undefined }; } },
    tool: { transform: async (cb: (e: { add: (d: (typeof tools)[number]) => void }) => void) => { cb({ add: (d) => void tools.push(d) }); return { dispose: async () => undefined }; } },
    session: { prompt: async (i: unknown) => void prompts.push(i), hook: async (name: string, cb: (i: any) => void) => { hooks[name] = cb; return { dispose: async () => undefined }; } },
    model: { list: async () => ({ data: [{ providerID: 'local', id: 'qwen-mini', type: 'chat', enabled: true, status: 'active', cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }] }) },
    experimental: { generate: { text: async (i: unknown) => { generated.push(i); return { text: 'Because of X.' }; } } },
    emitted,
    commands,
    tools,
    prompts,
    generated,
    hooks,
  };
}
type Setup = (c: unknown) => Promise<() => Promise<void>>;
const PODIUM_ENV = { PODIUM_SERVER: undefined, PODIUM_TOKEN: undefined, PODIUM_USER: undefined, PODIUM_REPORTER_CONFIG: undefined, PODIUM_REPORTER_CONTEXT: undefined, PODIUM_RESPOND: undefined, PODIUM_PEERS: undefined, PODIUM_EXPLAIN_FAILURES: undefined, XDG_STATE_HOME: undefined };

describe('the plugin entry (#948)', () => {
  it('makes one client per location, starts it once and stops it once, and reports through it', async () => {
    await upstream(async (up) => {
      const home = tmp();
      putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', up.url));
      const events = [
        { id: 'e1', type: 'session.created', data: { sessionID: 'ses_1', slug: 'x', version: '2.2.5' }, created: Date.now(), location: { directory: '/loc/a' } },
        { id: 'e2', type: 'session.execution.started', data: { sessionID: 'ses_1' }, created: Date.now(), location: { directory: '/loc/a' } },
      ];
      await withEnv({ ...PODIUM_ENV, HOME: home }, async () => {
        const setup = (plugin as unknown as { setup: Setup }).setup;
        const ctxA = fakeCtx({}, '/loc/a', events);
        const first = await setup(ctxA);
        await ctxA.commands[0]!.execute({});
        expect(ctxA.emitted.find((e) => e.name === 'notice')?.data.message).toMatch(/TLS: .*HTTPS|TLS: /);
        const second = await setup(fakeCtx({}, '/loc/a'));
        expect(seen.made).toHaveLength(1);
        expect(seen.starts).toBe(1);
        const other = await setup(fakeCtx({}, '/loc/b'));
        expect(seen.made).toHaveLength(2);
        expect(seen.starts).toBe(2);
        // the timer sends the first report within a flush
        for (let waited = 0; up.hits.length === 0 && waited < 5000; waited += 100) await new Promise((r) => setTimeout(r, 100));
        expect(up.hits.length).toBeGreaterThan(0);
        expect(up.hits[0]).toMatchObject({ method: 'POST', url: REPORT, token: undefined, peer: new X509Certificate(LEAF.cert).fingerprint256 });
        expect(JSON.parse(up.hits[0]!.body).userName).toBe('Dana');
        expect(holdsKey(up.hits.map((h) => h.body).join('\n'))).toBe(false);
        await first();
        expect(seen.stops).toBe(0);
        await second();
        expect(seen.stops).toBe(1);
        await other();
        expect(seen.stops).toBe(2);
        expect(DEFAULTS.flushMs).toBe(1000);
      });
    });
  });

  it('stops the connection even when closing the reporter throws, and two loads that start together share one client', async () => {
    const home = tmp();
    putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', 'https://127.0.0.1:1'));
    const close = Reporter.prototype.close;
    Reporter.prototype.close = async () => {
      throw new Error('close failed');
    };
    try {
      await withEnv({ ...PODIUM_ENV, HOME: home }, async () => {
        const setup = (plugin as unknown as { setup: Setup }).setup;
        const [a, b] = await Promise.all([setup(fakeCtx({}, '/loc/throws')), setup(fakeCtx({}, '/loc/throws'))]);
        expect(seen.made).toHaveLength(1);
        await a();
        expect(seen.stops).toBe(0);
        await expect(b()).rejects.toThrow('close failed');
        expect(seen.stops).toBe(1);
      });
    } finally {
      Reporter.prototype.close = close;
    }
  });

  it('without a file nothing is made and nothing is started', async () => {
    const home = tmp();
    await withEnv({ ...PODIUM_ENV, HOME: home }, async () => {
      const cleanup = await (plugin as unknown as { setup: Setup }).setup(fakeCtx({}, '/loc/plain'));
      expect(seen.made).toEqual([]);
      await cleanup();
      expect(seen.stops).toBe(0);
    });
  });

  it('a file that cannot be used makes no client, says why once, and the plugin still loads', async () => {
    if (!POSIX) return;
    const home = tmp();
    putConfig(home, 'reporter-config-Dana-1700000200.pem', configText('Dana', 'https://127.0.0.1:1'), 0o644);
    const warned: string[] = [];
    const oldWarn = console.warn;
    console.warn = (...a: unknown[]) => warned.push(a.join(' '));
    try {
      await withEnv({ ...PODIUM_ENV, HOME: home }, async () => {
        const cleanup = await (plugin as unknown as { setup: Setup }).setup(fakeCtx({}, '/loc/open'));
        await cleanup();
      });
    } finally {
      console.warn = oldWarn;
    }
    expect(seen.made).toEqual([]);
    expect(warned.filter((w) => w.includes('chmod 600'))).toHaveLength(1);
  });
});

describe('the plugin entry tells the person what is wrong (#969)', () => {
  const events = [
    { id: 'u1', type: 'session.created', data: { sessionID: 'ses_u', slug: 'x', version: '2.2.5' }, created: Date.now(), location: { directory: '/loc/u' } },
    { id: 'u2', type: 'session.execution.started', data: { sessionID: 'ses_u' }, created: Date.now(), location: { directory: '/loc/u' } },
  ];

  it('writes the refusal to the console once, shows the status as a toast, and answers /podium with a toast', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"error":"no"}', { status: 401 })) as typeof fetch;
    try {
      await withEnv({ ...PODIUM_ENV, HOME: tmp(), PODIUM_SERVER: 'http://podium.test:4317' }, async () => {
        const setup = (plugin as unknown as { setup: Setup }).setup;
        const ctx = fakeCtx({ flushIntervalMs: 200 }, '/loc/u', events);
        const stop = await setup(ctx);
        for (let waited = 0; !ctx.emitted.some((e) => e.name === 'notice') && waited < 5000; waited += 100) await new Promise((r) => setTimeout(r, 100));
        const toast = ctx.emitted.find((e) => e.name === 'notice');
        expect(toast?.data).toMatchObject({ title: 'Podium', variant: 'warning' });
        expect(toast?.data.message).toContain('token refused');
        expect(warn.mock.calls.filter((c) => String(c[0]).includes('refused this reporter'))).toHaveLength(1);
        expect(ctx.commands.map((c) => c.name)).toEqual(['podium']);
        await ctx.commands[0]!.execute({});
        const shown = ctx.emitted.filter((e) => e.name === 'notice').map((e) => e.data.message as string);
        const text = shown[shown.length - 1]!;
        expect(text).toContain('Podium fleet console: http://podium.test:4317/#/');
        expect(text).toContain('Home folder:');
        expect(text).toContain('Reports sent: 0');
        await stop();
      });
    } finally {
      globalThis.fetch = realFetch;
      warn.mockRestore();
    }
  });

  it('prints the /podium answer to the console when no TUI part has registered', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await withEnv({ ...PODIUM_ENV, HOME: tmp() }, async () => {
        const setup = (plugin as unknown as { setup: Setup }).setup;
        const ctx = fakeCtx({}, '/loc/v');
        ctx.rpc.register = async () => { throw new Error('no rpc'); };
        const stop = await setup(ctx);
        await ctx.commands[0]!.execute({});
        expect(String(log.mock.calls[0]?.[0])).toContain('Podium fleet console: http://127.0.0.1:4317/#/');
        await stop();
      });
    } finally {
      log.mockRestore();
    }
  });
});

describe('the plugin entry reports what an idle session still runs (#987)', () => {
  it('hands experimental.idle to the reporter, and the next report says the session waits on background work', async () => {
    const bodies: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => { bodies.push(JSON.parse(String(init?.body))); return new Response('{}', { status: 200 }); }) as typeof fetch;
    try {
      await withEnv({ ...PODIUM_ENV, HOME: tmp(), PODIUM_SERVER: 'http://podium.test:4317', PODIUM_TOKEN: 'tok' }, async () => {
        const setup = (plugin as unknown as { setup: Setup }).setup;
        const events = [{ id: 'b1', type: 'session.created', data: { sessionID: 'ses_b', slug: 'x', version: '2.2.5' }, created: Date.now(), location: { directory: '/loc/b2' } }];
        const ctx = fakeCtx({ flushIntervalMs: 200 }, '/loc/b2', events);
        const stop = await setup(ctx);
        // The session must be known before the hook can name it: wait for its first report.
        for (let waited = 0; bodies.length === 0 && waited < 5000; waited += 50) await new Promise((r) => setTimeout(r, 50));
        ctx.hooks['experimental.idle']!({ sessionID: 'ses_b', background: [{ kind: 'shell', sessionID: 'ses_b', shellID: 's', command: 'npm run dev' }] });
        for (let waited = 0; !bodies.some((b) => b.session?.background) && waited < 5000; waited += 100) await new Promise((r) => setTimeout(r, 100));
        const sent = bodies.find((b) => b.session?.background);
        expect(sent.session).toMatchObject({ status: 'waiting', waitReason: null, background: { tasks: [{ type: 'shell', description: 'npm run dev' }] } });
        // Not a dev build here: the built folder has no stamp.
        expect(sent.reporter.build).toBeUndefined();
        await stop();
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('the plugin entry adds tools, explains failures and answers requests (#969)', () => {
  const at = Date.now();
  const sessionEvents = (dir: string, extra: unknown[] = []) => [
    { id: `${dir}1`, type: 'session.created', data: { sessionID: `ses_${dir}`, slug: 'x', version: '2.2.5' }, created: at, location: { directory: `/loc/${dir}` } },
    { id: `${dir}2`, type: 'session.execution.started', data: { sessionID: `ses_${dir}` }, created: at, location: { directory: `/loc/${dir}` } },
    ...extra,
  ];
  const setup = (plugin as unknown as { setup: Setup }).setup;
  const until = async (ok: () => boolean) => {
    for (let waited = 0; !ok() && waited < 5000; waited += 50) await new Promise((r) => setTimeout(r, 50));
  };
  /** A Podium that answers every report with `reply`, and records the other calls. */
  const withPodium = async (reply: Record<string, unknown>, body: () => Promise<void>, calls: { url: string; body: unknown }[] = []) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
      if (String(url).endsWith('/api/fleet/report')) return new Response(JSON.stringify(reply), { status: 200 });
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    try {
      await body();
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  it('adds only the plan tool until the person allows messaging, and the tools answer through the reporter', async () => {
    await withEnv({ ...PODIUM_ENV, HOME: tmp(), PODIUM_PEERS: undefined }, async () => {
      const ctx = fakeCtx({}, '/loc/t1');
      const stop = await setup(ctx);
      expect(ctx.tools.map((t) => t.name)).toEqual(['plan']);
      expect(await ctx.tools[0]!.execute({ title: 'x' }, { sessionID: 'ses_nobody' })).toEqual({ content: 'Not named. Only the orchestrator names the plan.' });
      await stop();
    });
    await withEnv({ ...PODIUM_ENV, HOME: tmp(), PODIUM_PEERS: 'true' }, async () => {
      const ctx = fakeCtx({}, '/loc/t2');
      const stop = await setup(ctx);
      expect(ctx.tools.map((t) => t.name)).toEqual(['plan', 'podium_peers', 'podium_send', 'podium_request_access']);
      expect((await ctx.tools[1]!.execute({}, { sessionID: 'ses_nobody' })).content).toContain('has not reported yet');
      await stop();
    });
  });

  it('delivers a message from another orchestrator with session.prompt, queued, and answers a request typed as /podium', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const delivery = { id: 'pd9', kind: 'message', at, text: 'hello there', from: { name: 'build-pi', machine: 'pi', owner: 'Ed', id: 'ab12' } };
    const req = { id: 'prq_0123456789abcdef01234567', kind: 'access', at, from: { machine: 'pi', name: 'build-pi' }, to: { machine: 'mac', name: null }, level: 'send', by: 'build-pi', reason: 'r', text: null };
    await withPodium({ peers: true, peerDeliveries: [delivery], peerRequests: [req] }, async () => {
      await withEnv({ ...PODIUM_ENV, HOME: tmp(), PODIUM_PEERS: 'true', PODIUM_USER: 'Ed', PODIUM_TOKEN: 'tok', PODIUM_SERVER: 'http://podium.test:4317' }, async () => {
        const ctx = fakeCtx({ flushIntervalMs: 200 }, '/loc/t3', sessionEvents('t3'));
        const stop = await setup(ctx);
        await until(() => ctx.prompts.length > 0 && ctx.emitted.some((e) => e.name === 'notice' && String(e.data.message).includes('asks to send')));
        expect(ctx.prompts[0]).toMatchObject({ sessionID: 'ses_t3', id: expect.stringMatching(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/), delivery: 'queue' });
        expect(String((ctx.prompts[0] as { text: string }).text)).toContain('Message from the orchestrator build-pi on pi');
        const command = ctx.commands[0]!;
        await command.execute({ sessionID: 'ses_t3', prompt: { text: '/podium' } });
        expect(String(ctx.emitted.filter((e) => e.name === 'notice').at(-1)!.data.message)).toContain('/podium allow 0123');
        await command.execute({ sessionID: 'ses_t3', prompt: { text: 'allow 0123' } });
        expect(String(ctx.emitted.filter((e) => e.name === 'notice').at(-1)!.data.message)).toContain('allowed 0123');
        await command.execute({ sessionID: 'ses_t3', prompt: { text: 'deliver' } });
        expect(String(ctx.emitted.filter((e) => e.name === 'notice').at(-1)!.data.message)).toContain('Name the request');
        await stop();
      });
    }, calls);
    expect(calls.some((c) => c.url.endsWith('/peers/requests/prq_0123456789abcdef01234567') && (c.body as { answer: string }).answer === 'allow')).toBe(true);
  });

  it('asks OpenCode\'s model to explain a failure only with PODIUM_EXPLAIN_FAILURES on', async () => {
    const failing = (dir: string) => sessionEvents(dir, [
      { id: `${dir}3`, type: 'session.tool.input.started', data: { sessionID: `ses_${dir}`, id: 'c1', name: 'bash' }, created: at, location: { directory: `/loc/${dir}` } },
      { id: `${dir}4`, type: 'session.tool.called', data: { sessionID: `ses_${dir}`, id: 'c1', input: { command: 'npm test' } }, created: at, location: { directory: `/loc/${dir}` } },
      { id: `${dir}5`, type: 'session.tool.failed', data: { sessionID: `ses_${dir}`, id: 'c1', error: { message: 'exit code 2' } }, created: at, location: { directory: `/loc/${dir}` } },
    ]);
    await withPodium({}, async () => {
      await withEnv({ ...PODIUM_ENV, HOME: tmp(), PODIUM_EXPLAIN_FAILURES: 'true', PODIUM_SERVER: 'http://podium.test:4317' }, async () => {
        const ctx = fakeCtx({ flushIntervalMs: 200 }, '/loc/e1', failing('e1'));
        const stop = await setup(ctx);
        await until(() => ctx.generated.length > 0);
        expect(String((ctx.generated[0] as { prompt: string }).prompt)).toContain('An OpenCode agent failed');
        expect((ctx.generated[0] as { model?: unknown }).model).toEqual({ providerID: 'local', id: 'qwen-mini' });
        await stop();
      });
      await withEnv({ ...PODIUM_ENV, HOME: tmp(), PODIUM_EXPLAIN_FAILURES: undefined, PODIUM_SERVER: 'http://podium.test:4317' }, async () => {
        const ctx = fakeCtx({ flushIntervalMs: 200 }, '/loc/e2', failing('e2'));
        const stop = await setup(ctx);
        await new Promise((r) => setTimeout(r, 700));
        expect(ctx.generated).toEqual([]);
        await stop();
      });
    });
  });
});
