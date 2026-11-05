// The reporter's TLS helper (#584, SPEC 5.9). The mod cannot hand $.http.fetch a CA or a client certificate, so
// podium-reporter starts this script once per session. It reads the reporter config file, makes the HTTPS connection
// with the CA and the person's certificate, and listens on a Unix socket the mod sends its requests to.
//
//   node helper.mjs <config path> <socket path> <server url>
//
// It prints `ready` on stdout once it listens, and `error <CODE> <why>` before exiting 1 when it cannot start.
import fs from 'node:fs';
import http from 'node:http';
import { duplexPair } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOP_HEADERS, createTlsClient } from './client.mjs';
import { StartError } from './config.mjs';
import { classifyError } from './errors.mjs';
import { reporterTarget } from './routes.mjs';

const PARENT_POLL_MS = 1000;

function fail(code, message) {
  process.stdout.write(`error ${code} ${message}\n`);
  process.exit(1);
}

/**
 * `mailbox:<folder>` in place of a socket path (#834). Windows cannot give the mod a socket: Node has no Unix sockets there (its local
 * sockets are named pipes, and a `.sock` path is an invalid pipe name), and the engine refuses a pipe address as a network location.
 * So the mod writes each request into the folder and this helper answers on its stdout. Returns the folder, or null for a socket path.
 */
export function isMailbox(arg) {
  return arg.startsWith('mailbox:') ? arg.slice('mailbox:'.length) : null;
}

const MAILBOX_NAME = /^req-([0-9A-Za-z-]{1,40})\.json$/;
const MAILBOX_POLL_MS = 250;
/** A request file that still is not valid JSON this long after it was written is not going to be. */
const MAILBOX_STALE_MS = 10_000;
const MAILBOX_REPLY_MAX = 2 * 1024 * 1024;

/**
 * One HTTP request through `server`, in memory: no socket is opened, and the helper's own handler answers it, so the routes it
 * forwards, the certificate checks and the error headers are exactly those of a request over a socket.
 */
function inMemoryRequest(server, { method, path: target, body }) {
  return new Promise((resolve, reject) => {
    const [clientSide, serverSide] = duplexPair();
    for (const side of [clientSide, serverSide]) {
      // http expects these of a net.Socket.
      for (const name of ['setTimeout', 'setNoDelay', 'setKeepAlive', 'ref', 'unref']) side[name] = () => side;
      side.on('error', () => {});
    }
    const done = () => {
      clientSide.destroy();
      serverSide.destroy();
    };
    server.emit('connection', serverSide);
    // No `agent` option: with one, http ignores createConnection and opens a real connection. The reporter sends one header, Content-Type, so the
    // helper sets it and takes none from the file.
    const req = http.request({ method, path: target, headers: { 'content-type': 'application/json', host: 'podium' }, createConnection: () => clientSide }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAILBOX_REPLY_MAX) {
          done();
          reject(Object.assign(new Error('the reply is larger than the helper passes on'), { code: 'REPLY_TOO_LARGE' }));
        } else chunks.push(c);
      });
      res.on('error', (err) => (done(), reject(err)));
      res.on('end', () => {
        const out = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
        done();
        resolve({ status: res.statusCode ?? 502, headers: out, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', (err) => (done(), reject(err)));
    req.end(body);
  });
}

/** The request the mod wrote in `name`: `{ id, method, path, body }`, or null when it is not one (a name that carries no id, or an id that differs from the file's). */
function mailboxRequest(name, req) {
  const id = MAILBOX_NAME.exec(name)?.[1];
  if (!id || !req || typeof req !== 'object' || req.id !== id) return null;
  return { id, method: req.method, path: req.path, body: req.body ?? '' };
}

/** True when the pieces are what the mod writes: a method, a path and a body, all text. */
function wellFormed(req) {
  return typeof req.method === 'string' && typeof req.path === 'string' && typeof req.body === 'string';
}

const refusal = (code, status, message) => ({ status, headers: { 'content-type': 'application/json', 'x-podium-helper-error': code }, body: JSON.stringify({ error: code, message }) });

/**
 * Answers the request files in `dir` through `server`. A file is taken once it parses as JSON (the engine does not write a file in one
 * step, so a half-written one is left alone), removed, and answered with one stdout line `res <id> <base64 of {status, headers, body}>`.
 * Files left by an earlier helper are removed unanswered.
 */
function serveMailbox(server, dir) {
  if (typeof duplexPair !== 'function') return fail('MAILBOX_UNSUPPORTED', 'the mailbox needs Node 20.17 or later');
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) if (name.startsWith('req-')) fs.rmSync(path.join(dir, name), { force: true });
  } catch (err) {
    return fail(err.code ?? 'SOCKET_DIR', err.message);
  }
  const busy = new Set();
  const reply = (id, answer) => process.stdout.write(`res ${id} ${Buffer.from(JSON.stringify(answer)).toString('base64')}\n`);
  const scan = () => {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith('req-') || busy.has(name)) continue;
      const file = path.join(dir, name);
      let st;
      let text;
      try {
        // One handle for the size, the age and the text, so the file cannot change between looking at it and reading it.
        const fd = fs.openSync(file, 'r');
        try {
          st = fs.fstatSync(fd);
          text = fs.readFileSync(fd, 'utf8');
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        continue; // still being written, or locked for a moment
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        if (Date.now() - st.mtimeMs > MAILBOX_STALE_MS) fs.rmSync(file, { force: true });
        continue;
      }
      const req = mailboxRequest(name, parsed);
      fs.rmSync(file, { force: true });
      if (!req) continue;
      if (!wellFormed(req)) {
        reply(req.id, refusal('BAD_REQUEST', 400, 'The request file is not a request the helper can send.'));
        continue;
      }
      // The method and path sent on are the ones the helper's own list rebuilds, not the text in the file.
      const route = reporterTarget(req.method, req.path);
      if (!route) {
        reply(req.id, refusal('ROUTE_NOT_ALLOWED', 403, 'The Podium connection helper forwards the reporter calls only.'));
        continue;
      }
      busy.add(name);
      inMemoryRequest(server, { method: route.method, path: route.path, body: req.body })
        .then((answer) => reply(req.id, answer))
        .catch((err) => {
          const code = classifyError(err);
          reply(req.id, refusal(code, 502, String(err.message ?? err)));
        })
        .finally(() => busy.delete(name));
    }
  };
  try {
    fs.watch(dir, () => scan()).on('error', () => {});
  } catch {
    // the poll below still finds the files
  }
  // Not unref'd: in this mode these are what keep the process alive.
  setInterval(scan, MAILBOX_POLL_MS);
  process.stdout.write('ready\n');
}

/** Makes a directory only this user can enter; refuses one that is someone else's or open to others. */
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new StartError('SOCKET_DIR', `${dir} is not a folder`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new StartError('SOCKET_DIR', `${dir} belongs to another user`);
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

function main(configPath, socketPath, serverUrl) {
  // An inherited NODE_TLS_REJECT_UNAUTHORIZED=0 turned verification off in the spike; nothing here reads it, and it is gone.
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete process.env.NODE_OPTIONS;
  let client;
  try {
    client = createTlsClient({ configPath, serverUrl, log: (line) => process.stderr.write(`${line}\n`) });
  } catch (err) {
    return fail(err.code ?? 'CONFIG_INVALID', err.message);
  }

  const server = http.createServer((req, res) => {
    const g = client.guard(req.method, req.url);
    if (g.refusal) {
      req.resume();
      res.writeHead(g.refusal.status, { 'content-type': 'application/json', 'x-podium-helper-error': g.refusal.code });
      res.end(JSON.stringify({ error: g.refusal.code, message: g.refusal.message }));
      return;
    }
    const up = client.open(g.route, req.headers, {
      onResponse: (upRes) => {
        const out = {};
        for (const [k, v] of Object.entries(upRes.headers)) if (!HOP_HEADERS.has(k) && v !== undefined) out[k] = v;
        res.writeHead(upRes.statusCode ?? 502, out);
        upRes.on('error', () => res.destroy());
        upRes.on('aborted', () => res.destroy());
        upRes.pipe(res);
      },
      onError: ({ code, message }) => {
        if (res.headersSent) return res.destroy();
        res.writeHead(502, { 'content-type': 'application/json', 'x-podium-helper-error': code });
        res.end(JSON.stringify({ error: code, message }));
      },
    });
    req.on('aborted', () => up.destroy());
    req.pipe(up);
  });

  const box = isMailbox(socketPath);
  let owned = false;
  const cleanup = () => {
    if (!owned) return;
    owned = false;
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // already gone
    }
  };
  const stop = () => {
    cleanup();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('SIGHUP', stop);
  process.on('exit', cleanup);

  if (box !== null) {
    serveMailbox(server, box);
  } else {
    try {
      privateDir(path.dirname(socketPath));
      if (fs.existsSync(socketPath) && fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath);
    } catch (err) {
      return fail(err.code ?? 'SOCKET_DIR', err.message);
    }

    server.on('error', (err) => fail(err.code ?? 'LISTEN', `cannot listen on ${socketPath}: ${err.message}`));
    const umask = process.umask(0o177);
    server.listen(socketPath, () => {
      process.umask(umask);
      owned = true;
      fs.chmodSync(socketPath, 0o600);
      process.stdout.write('ready\n');
    });
  }

  // A session that is idle still renews in time: look at the certificate now and then, and once at start.
  client.start();

  // The child of a mod that was killed outright (SIGKILL) gets no signal: watch the parent instead.
  const parent = process.ppid;
  setInterval(() => {
    let gone = process.ppid !== parent;
    if (!gone) {
      try {
        process.kill(parent, 0);
      } catch (err) {
        gone = err.code === 'ESRCH';
      }
    }
    if (gone) stop();
  }, PARENT_POLL_MS).unref?.();
  // unref'd timers do not keep the process alive; the listening server (or the mailbox poll) does.
}

/** True when this file is the script node was started with. Both sides are real paths: import.meta.url is already resolved, argv[1] is not (#918). */
function isEntry() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    return false; // argv[1] is not a file (a REPL, a test runner's worker): this is not the entry script
  }
}

if (isEntry()) {
  const [configPath, socketPath, serverUrl] = process.argv.slice(2);
  if (!configPath || !socketPath || !serverUrl) fail('USAGE', 'usage: node helper.mjs <config path> <socket path> <server url>');
  else main(configPath, socketPath, serverUrl);
}
