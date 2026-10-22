// Helpers for tests that need a certificate with dates the server would never issue (an expired one). Not used by the server.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** `20260404183519Z`: the form `openssl x509 -not_before` and `-not_after` take. */
export const opensslStamp = (ms: number): string => new Date(ms).toISOString().replaceAll(/[-:T]|\.\d{3}/g, '');

/**
 * A client certificate with the dates given, signed by the CA files named (the real CA, or a forger's). Needs OpenSSL 3.4 or
 * later for `-not_before` and `-not_after`. Returns the certificate and its key.
 */
export function signClientDated(o: { caCrt: string; caKey: string; keyId: string; from: number; to: number; serial?: string }): { cert: string; key: string } {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-dated-'));
  try {
    const run = (...a: string[]) => execFileSync('openssl', a, { cwd: work });
    fs.writeFileSync(path.join(work, 'c.cnf'), '[v3]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n');
    run('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'k.pem');
    run('req', '-new', '-key', 'k.pem', '-subj', `/CN=pdm_${o.keyId}/O=podium`, '-out', 'c.csr');
    run('x509', '-req', '-in', 'c.csr', '-CA', o.caCrt, '-CAkey', o.caKey, '-not_before', opensslStamp(o.from), '-not_after', opensslStamp(o.to), ...(o.serial ? ['-set_serial', o.serial] : []), '-extfile', 'c.cnf', '-extensions', 'v3', '-out', 'c.pem');
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
