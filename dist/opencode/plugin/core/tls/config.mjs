// Reading the reporter config file the TLS helper connects with (#584, #948): the CA certificates, the person's certificate and the key.
// Shared by every reporter that makes the mTLS connection (#927).
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';

export class StartError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** The name in the file's `# user: Name` line, or ''. Read line by line, not with one multiline regex that could backtrack over a long run of blanks. */
export function headerUser(text) {
  for (const line of text.split('\n')) {
    if (!line.startsWith('#')) continue;
    const rest = line.slice(1).trimStart();
    if (!rest.startsWith('user:')) continue;
    const name = rest.slice(5).trim();
    if (name) return name;
  }
  return '';
}

/** The CA certificates, the person's certificate and the key, by block type and role, never by position. */
export function parseConfig(text) {
  const blocks = [...text.matchAll(/-----BEGIN ([A-Z ]+)-----[\s\S]*?-----END \1-----/g)];
  const ca = [];
  let cert = null;
  let key = null;
  for (const m of blocks) {
    const [pem, type] = [m[0], m[1]];
    if (type === 'CERTIFICATE') {
      let x;
      try {
        x = new X509Certificate(pem);
      } catch {
        throw new StartError('CONFIG_INVALID', 'a certificate block in the config file cannot be read');
      }
      if (x.ca) ca.push(pem);
      else if (cert) throw new StartError('CONFIG_INVALID', 'the config file holds more than one person certificate');
      else cert = pem;
    } else if (type.endsWith('PRIVATE KEY')) {
      if (key) throw new StartError('CONFIG_INVALID', 'the config file holds more than one private key');
      key = pem;
    }
  }
  if (ca.length === 0) throw new StartError('CONFIG_INVALID', 'the config file has no CA certificate');
  if (!cert) throw new StartError('CONFIG_INVALID', 'the config file has no person certificate');
  if (!key) throw new StartError('CONFIG_INVALID', 'the config file has no private key');
  const user = headerUser(text);
  return { ca, cert, key, user, notAfter: Date.parse(new X509Certificate(cert).validTo), notBefore: Date.parse(new X509Certificate(cert).validFrom) };
}

/**
 * Reads the file, refusing one that group or others can read (the key is in it, as `ssh` does with a private key). The mode is
 * read from the open file, not from its path, so the file checked is the file read.
 */
export function readConfig(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    throw new StartError('CONFIG_MISSING', `cannot read ${file}: ${err.code ?? err.message}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      throw new StartError('CONFIG_PERMISSIONS', `${file} is readable by others (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${file}`);
    }
    let text;
    try {
      text = fs.readFileSync(fd, 'utf8');
    } catch (err) {
      throw new StartError('CONFIG_MISSING', `cannot read ${file}: ${err.code ?? err.message}`);
    }
    return { ...parseConfig(text), mtimeMs: st.mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

/** One keep-alive agent per config; verification is forced on, whatever the environment says. */
export function agentFor(cfg) {
  return new https.Agent({ ca: cfg.ca, cert: cfg.cert, key: cfg.key, rejectUnauthorized: true, keepAlive: true });
}
