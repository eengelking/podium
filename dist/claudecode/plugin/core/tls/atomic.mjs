// Writing the reporter config file safely, and the text a renewal writes (#672, #948). Shared by every reporter that makes the mTLS connection (#927).
import fs from 'node:fs';

const pem = (t) => (t.endsWith('\n') ? t : `${t}\n`);

/**
 * The config file after a renewal: the header lines (the name and the server stay) with the issued-at, expires and
 * fingerprint lines updated, then the CA certificate(s), the new certificate and the new key. The body is replaced whole, so
 * the file never holds a certificate from one renewal and a key from another.
 */
export function rewriteConfig(text, n) {
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((l) => l.startsWith('-----BEGIN'));
  const head = (end === -1 ? lines : lines.slice(0, end)).filter((l) => l.trim() !== '');
  const set = (name, value) => {
    const i = head.findIndex((l) => new RegExp(`^#\\s*${name}:`).test(l));
    if (i === -1) head.push(`# ${name}: ${value}`);
    else head[i] = `# ${name}: ${value}`;
  };
  set('issued-at', `${new Date(n.now).toISOString()} ${Math.floor(n.now / 1000)}`);
  set('expires', n.notAfter);
  set('fingerprint', n.fingerprint);
  return `${head.join('\n')}\n${n.ca.map(pem).join('')}${pem(n.cert)}${pem(n.key)}`;
}

/**
 * Writes `text` to `file` through a temporary file in the same folder and a rename, at mode 0600, so a reader sees all of the old file or all of the new.
 * A destination that is a symlink is followed to the file it points to (a dotfiles manager or a mounted secret): the temporary file is made
 * beside that file and renamed onto it, so the link stays a link. The temporary file is created with `wx`, which never follows a link:
 * one left or planted at that name is removed and made again (#672).
 */
export function writeAtomic(file, text) {
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) file = fs.realpathSync(file);
  const tmp = `${file}.${process.pid}.tmp`;
  const open = () => fs.openSync(tmp, 'wx', 0o600);
  let fd;
  try {
    fd = open();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    fs.rmSync(tmp, { force: true });
    fd = open();
  }
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
