// Helpers for the TLS tests: a certificate with dates the server would never issue (an expired one), and a listener started on a free port. Not used by the server.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from './logging/logger.js';
import { startTls, type StartTlsOptions, type TlsListener } from './tlsServer.js';

/** `20260404183519Z`: the form `openssl ca -startdate` and `-enddate` take. */
export const opensslStamp = (ms: number): string => new Date(ms).toISOString().replaceAll(/[-:T]|\.\d{3}/g, '');

/**
 * Signs a request with the dates given, for a test that needs a certificate the server would never issue (an expired one).
 * `openssl ca` does this on any OpenSSL; `x509 -not_before` and `-not_after` need 3.4 or later, which a CI runner may not have.
 * The paths are relative to `work` or absolute, and the certificate is written to `out`.
 */
export function signDated(work: string, o: { csr: string; caCrt: string; caKey: string; extFile: string; ext: string; from: number; to: number; serial?: string; out: string }): void {
  const at = (f: string) => path.resolve(work, f);
  const db = fs.mkdtempSync(path.join(work, 'ca-db-'));
  const serial = (o.serial ?? '1').replace(/^0x/i, '');
  fs.writeFileSync(path.join(db, 'index.txt'), '');
  fs.writeFileSync(path.join(db, 'serial'), `${serial.length % 2 ? '0' : ''}${serial}\n`);
  fs.writeFileSync(path.join(db, 'ca.cnf'), `[ca]\ndefault_ca=c\n[c]\ndatabase=${db}/index.txt\nnew_certs_dir=${db}\nserial=${db}/serial\ndefault_md=sha256\npolicy=pol\nunique_subject=no\n[pol]\ncommonName=optional\norganizationName=optional\n`);
  execFileSync('openssl', ['ca', '-batch', '-notext', '-preserveDN', '-config', path.join(db, 'ca.cnf'), '-cert', at(o.caCrt), '-keyfile', at(o.caKey), '-in', at(o.csr), '-startdate', opensslStamp(o.from), '-enddate', opensslStamp(o.to), '-extfile', at(o.extFile), '-extensions', o.ext, '-out', at(o.out)], { cwd: work, stdio: 'pipe' });
}

/** A client certificate with the dates given, signed by the CA files named (the real CA, or a forger's). Returns the certificate and its key. */
export function signClientDated(o: { caCrt: string; caKey: string; keyId: string; from: number; to: number; serial?: string }): { cert: string; key: string } {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-dated-'));
  try {
    const run = (...a: string[]) => execFileSync('openssl', a, { cwd: work });
    fs.writeFileSync(path.join(work, 'c.cnf'), '[v3]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n');
    run('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'k.pem');
    run('req', '-new', '-key', 'k.pem', '-subj', `/CN=pdm_${o.keyId}/O=podium`, '-out', 'c.csr');
    signDated(work, { csr: 'c.csr', caCrt: o.caCrt, caKey: o.caKey, extFile: 'c.cnf', ext: 'v3', from: o.from, to: o.to, serial: o.serial, out: 'c.pem' });
    return { cert: fs.readFileSync(path.join(work, 'c.pem'), 'utf8'), key: fs.readFileSync(path.join(work, 'k.pem'), 'utf8') };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** A CA of its own, named like Podium's, that a forger signs with. Returns the paths of its certificate and key. */
export function makeForgerCa(dir: string): { caCrt: string; caKey: string } {
  const run = (...a: string[]) => execFileSync('openssl', a, { cwd: dir });
  fs.writeFileSync(path.join(dir, 'fca.cnf'), '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=Podium CA\nO=podium\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n');
  run('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'fca.key');
  run('req', '-new', '-x509', '-key', 'fca.key', '-config', 'fca.cnf', '-extensions', 'v3_ca', '-days', '3650', '-out', 'fca.crt');
  return { caCrt: path.join(dir, 'fca.crt'), caKey: path.join(dir, 'fca.key') };
}

/** A CA folder as T3 made it, with `pathlen:0`, which cannot sit above a cross certificate. Writes `ca.crt` and `ca.key` into `dir`. */
export function writeLegacyCa(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'x.cnf'), '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=Podium CA\nO=podium\n[v3]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n');
  execFileSync('openssl', ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'ca.key'], { cwd: dir });
  execFileSync('openssl', ['req', '-new', '-x509', '-key', 'ca.key', '-config', 'x.cnf', '-extensions', 'v3', '-days', '3650', '-out', 'ca.crt'], { cwd: dir });
  fs.rmSync(path.join(dir, 'x.cnf'));
}

/** A port nothing listens on right now. Another test file can take it before it is bound, which `startTlsForTest` retries. */
export const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

export interface StartTlsForTestOptions extends Omit<StartTlsOptions, 'env' | 'bind' | 'httpPort' | 'allowedHosts'> {
  env?: NodeJS.ProcessEnv;
  bind?: string;
  httpPort?: number;
  allowedHosts?: string[];
  /** Where the port comes from; a free one by default. A test passes its own to make the first one busy. */
  port?: () => Promise<number>;
}

/**
 * Starts the TLS listener for a test (#670). The port is chosen ahead of the bind, so another file can take it in between: that
 * failure (`EADDRINUSE`) is retried on a new port, up to `tries` times. Any other reason `startTls` returned null is thrown
 * with the reason it logged, so a failed start fails the test where it happened instead of as a `TypeError` on a null listener.
 */
export async function startTlsForTest(o: StartTlsForTestOptions, tries = 5): Promise<TlsListener> {
  const { port: pick = freePort, env, bind = '127.0.0.1', httpPort = 4317, allowedHosts = [], ...rest } = o;
  const reasons: string[] = [];
  const logger: Logger = {
    ...o.logger,
    error: (event, message, fields) => {
      if (event === 'tls.failed') reasons.push(message);
      o.logger.error(event, message, fields);
    },
  };
  for (let attempt = 1; ; attempt++) {
    reasons.length = 0;
    const port = await pick();
    const listener = await startTls({ ...rest, logger, bind, httpPort, allowedHosts, env: { PODIUM_TLS: 'on', PODIUM_TLS_PORT: String(port), ...env } });
    if (listener) return listener;
    const why = reasons.join('; ') || 'nothing was logged';
    if (!why.includes('EADDRINUSE') || attempt >= tries) throw new Error(`startTls returned null after ${attempt} attempt${attempt === 1 ? '' : 's'} (port ${port}): ${why}`);
  }
}
