// client.mjs: the mTLS client of the reporter config file (#584, #948). It talks to a real local https server that asks for a client
// certificate, with certificates made by `openssl` as config.node.test.ts does. The server's renewal endpoint signs the new key with
// `openssl x509 -force_pubkey`, so a renewal here is the whole thing: a new key, a certificate for it, a file rewritten under the lock.
import { X509Certificate, createPrivateKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "claude-code/testing";
import { createTlsClient, type TlsClient } from "./client.mjs";
import { parseConfig } from "./config.mjs";
import { LOCK_STALE_MS, generations, olderThan } from "./lock.mjs";

const made: string[] = [];
process.on("exit", () => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "podium-client-"));
  made.push(d);
  return d;
};
const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POSIX = process.platform !== "win32";

const work = tmp();
const run = (...a: string[]) => execFileSync("openssl", a, { cwd: work, stdio: "pipe" });
const read = (n: string) => fs.readFileSync(path.join(work, n), "utf8");
fs.writeFileSync(path.join(work, "ca.cnf"), "[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n");
fs.writeFileSync(path.join(work, "leaf.cnf"), "[v3]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n");
fs.writeFileSync(path.join(work, "serving.cnf"), "[v3]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n");
fs.writeFileSync(path.join(work, "wrong.cnf"), "[v3]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:elsewhere.example\n");
for (const n of ["ca", "ca2", "newca", "stranger", "serving", "wrong", "leaf", "leaf2", "outsider", "strsrv"]) run("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", `${n}.key`);
const root = (n: string, subj: string) => run("req", "-new", "-x509", "-key", `${n}.key`, "-subj", subj, "-config", "ca.cnf", "-extensions", "v3_ca", "-days", "3650", "-out", `${n}.crt`);
root("ca", "/CN=Podium CA/O=podium");
root("stranger", "/CN=Stranger CA/O=podium");
root("newca", "/CN=Podium CA 2/O=podium");
let serial = 1000;
/** A certificate for `key` (or for the public key in `pub`), signed by `ca`. */
function issue(out: string, subj: string, ext: string, days: number, ca = "ca", key = out.replace(/\.crt$/, ""), pub = ""): void {
  const args = pub
    ? ["x509", "-new", "-force_pubkey", pub, "-subj", subj]
    : ["x509", "-new", "-force_pubkey", `${key}.pub`, "-subj", subj];
  if (!pub) run("pkey", "-in", `${key}.key`, "-pubout", "-out", `${key}.pub`);
  run(...args, "-CA", `${ca}.crt`, "-CAkey", `${ca}.key`, "-set_serial", String(serial++), "-days", String(days), "-extfile", ext, "-extensions", "v3", "-out", out);
}
issue("serving.crt", "/CN=localhost", "serving.cnf", 90);
issue("wrong.crt", "/CN=elsewhere", "wrong.cnf", 90);
issue("leaf.crt", "/CN=pdm_a1b2c3d4e5f6/O=podium", "leaf.cnf", 90);
issue("leaf2.crt", "/CN=pdm_a1b2c3d4e5f6/O=podium", "leaf.cnf", 200);
issue("outsider.crt", "/CN=pdm_ffffffffffff/O=podium", "leaf.cnf", 90, "stranger");
issue("strsrv.crt", "/CN=localhost", "serving.cnf", 90, "stranger");
// the new CA of a planned rotation, vouched for by a cross certificate from the held one
run("req", "-new", "-key", "newca.key", "-subj", "/CN=Podium CA 2/O=podium", "-out", "newca.csr");
run("x509", "-req", "-in", "newca.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-set_serial", "7", "-days", "365", "-extfile", "ca.cnf", "-extensions", "v3_ca", "-out", "cross.crt");

const CA = read("ca.crt");
const NEW_CA = read("newca.crt");
const CROSS = read("cross.crt");
const SERVING = { cert: read("serving.crt"), key: read("serving.key") };
const WRONG_NAME = { cert: read("wrong.crt"), key: read("wrong.key") };
const STRANGER_SERVING = { cert: read("strsrv.crt"), key: read("strsrv.key") }; // signed by a CA the config does not hold
const LEAF = { cert: read("leaf.crt"), key: read("leaf.key") };
const LEAF2 = { cert: read("leaf2.crt"), key: read("leaf2.key") };
const OUTSIDER = { cert: read("outsider.crt"), key: read("outsider.key") };

/** A certificate for the public key a renewal request carries, signed by `by` for `days`. */
function signFor(spki: string, days: number, by = "ca"): string {
  const pub = path.join(work, `renew-${serial}.pub`);
  fs.writeFileSync(pub, spki);
  const out = `renewed-${serial}.crt`;
  issue(out, "/CN=pdm_a1b2c3d4e5f6/O=podium", "leaf.cnf", days, by, "", pub);
  return read(out);
}

const configText = (user: string, ca: string[], leaf = LEAF) => `# podium-reporter-config v1\n# user: ${user}\n# server: https://127.0.0.1\n${ca.join("")}${leaf.cert}${leaf.key}`;
function writeConfig(text: string, mtimeOffsetMs = 0): string {
  const f = path.join(tmp(), "reporter-config.pem");
  fs.writeFileSync(f, text, { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  if (mtimeOffsetMs) {
    const t = new Date(Date.now() + mtimeOffsetMs);
    fs.utimesSync(f, t, t);
  }
  return f;
}
let bump = 5000;
/** Replaces the file as another session would, with a modification time the client has not seen. */
function rewrite(file: string, text: string): void {
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  bump += 2000;
  const t = new Date(Date.now() + bump);
  fs.utimesSync(file, t, t);
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string, peer: X509Certificate | null) => void;
interface Up {
  url: string;
  hits: string[];
  peers: string[];
}
/** An https server that asks for a client certificate signed by `CA`; `body` runs with its URL, and everything is closed afterwards. */
async function upstream<T>(handler: Handler, body: (up: Up) => Promise<T>, tls: { cert: string; key: string } = SERVING): Promise<T> {
  const sockets = new Set<Socket>();
  const up: Up = { url: "", hits: [], peers: [] };
  const server = https.createServer({ cert: tls.cert, key: tls.key, ca: [CA], requestCert: true, rejectUnauthorized: true }, (req, res) => {
    const raw = (req.socket as unknown as { getPeerCertificate: () => { raw?: Buffer } }).getPeerCertificate().raw;
    const peer = raw ? new X509Certificate(raw) : null;
    up.hits.push(`${req.method} ${req.url}`);
    if (peer) up.peers.push(peer.fingerprint256);
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (text += c));
    req.on("end", () => handler(req, res, text, peer));
  });
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  up.url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await body(up);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** The client for `file`, stopped afterwards. `env` is only what a test sets; nothing here depends on the real environment. */
async function withClient<T>(file: string, url: string, body: (c: TlsClient, log: string[]) => Promise<T>, env: Record<string, string> = {}): Promise<T> {
  const log: string[] = [];
  const c = createTlsClient({ configPath: file, serverUrl: url, log: (l) => log.push(l), env });
  try {
    return await body(c, log);
  } finally {
    c.stop();
  }
}

const ok: Handler = (req, res, text) => {
  res.writeHead(200, { "content-type": "application/json", "x-seen-upgrade": String(req.headers.upgrade ?? ""), "x-seen-a": String(req.headers["x-a"] ?? "") });
  res.end(JSON.stringify({ method: req.method, url: req.url, text }));
};
const PEERS = "/api/fleet/sessions/s1/peers";
/** Due at once: a 90-day certificate has fewer than 120 days left. A renewed certificate of more days is not due. */
const DUE = { PODIUM_RENEW_BEFORE_SECONDS: String(120 * 86400), PODIUM_RENEW_CHECK_SECONDS: "3600" };
const refusedWith = async (p: Promise<unknown>): Promise<Error & { code: string }> => {
  try {
    await p;
  } catch (err) {
    return err as Error & { code: string };
  }
  throw new Error("expected a rejection");
};
const SECRET = /BEGIN|PRIVATE|CERTIFICATE|MII[A-Za-z0-9+/]{20}/;

describe("client.mjs: starting", () => {
  test("refuses a server URL that is not a URL or is not https, and a config that cannot be read, with the helper's codes", () => {
    const file = writeConfig(configText("Dana Lee", [CA]));
    const err = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e as Error & { code: string };
      }
      throw new Error("expected a throw");
    };
    expect(err(() => createTlsClient({ configPath: file, serverUrl: "not a url" })).code).toBe("INSECURE_URL");
    const http1 = err(() => createTlsClient({ configPath: file, serverUrl: "http://127.0.0.1:1" }));
    expect(http1.code).toBe("INSECURE_URL");
    expect(http1.message).toContain("never sends a credential over http");
    expect(err(() => createTlsClient({ configPath: path.join(tmp(), "gone.pem"), serverUrl: "https://127.0.0.1:1" })).code).toBe("CONFIG_MISSING");
    expect(err(() => createTlsClient({ configPath: writeConfig("nothing here"), serverUrl: "https://127.0.0.1:1" })).code).toBe("CONFIG_INVALID");
    if (POSIX) {
      const open = writeConfig(configText("Dana Lee", [CA]));
      fs.chmodSync(open, 0o644);
      expect(err(() => createTlsClient({ configPath: open, serverUrl: "https://127.0.0.1:1" })).code).toBe("CONFIG_PERMISSIONS");
    }
  });
});

describe("client.mjs: requests", () => {
  test("a good request carries the person's certificate and answers status, text and headers", async () => {
    await upstream(ok, async (up) => {
      await withClient(writeConfig(configText("Dana Lee", [CA])), up.url, async (c) => {
        const got = await c.request("POST", "/api/fleet/report?x=1", { headers: { "content-type": "application/json", "X-A": "yes", Upgrade: "websocket" }, body: '{"a":1}' });
        expect(got.status).toBe(200);
        expect(got.ok).toBe(true);
        expect(JSON.parse(got.text)).toEqual({ method: "POST", url: "/api/fleet/report?x=1", text: '{"a":1}' });
        expect(got.headers["content-type"]).toBe("application/json");
        // a header the caller sent is passed on; one that describes the hop is not
        expect(got.headers["x-seen-a"]).toBe("yes");
        expect(got.headers["x-seen-upgrade"]).toBe("");
        expect(up.peers).toEqual([new X509Certificate(LEAF.cert).fingerprint256]);
        // a second request reuses the connection and sends no body
        const again = await c.request("GET", PEERS);
        expect(JSON.parse(again.text).url).toBe(PEERS);
      });
    });
  });

  test("an answer that is not a success is a result, not an error, and fetch takes a full URL on the server's own origin", async () => {
    await upstream(
      (req, res) => {
        res.writeHead(req.url === "/api/fleet/report" ? 500 : 200, { "set-cookie": ["a=1", "b=2"] });
        res.end("no");
      },
      async (up) => {
        await withClient(writeConfig(configText("Dana Lee", [CA])), up.url, async (c) => {
          const bad = await c.fetch(`${up.url}/api/fleet/report`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          expect(bad).toMatchObject({ status: 500, ok: false, text: "no" });
          expect(bad.headers["set-cookie"]).toBe("a=1, b=2");
          const got = await c.fetch(`${up.url}${PEERS}?since=1`);
          expect(got).toMatchObject({ status: 200, ok: true });
          expect(up.hits.at(-1)).toBe(`GET ${PEERS}?since=1`);
          expect((await refusedWith(c.fetch("https://example.com/api/fleet/report", { method: "POST" }))).code).toBe("ROUTE_NOT_ALLOWED");
          expect((await refusedWith(c.fetch("/api/fleet/report", { method: "POST" }))).code).toBe("ROUTE_NOT_ALLOWED");
          expect(up.hits).toHaveLength(2);
        });
      },
    );
  });

  test("a call that is not a reporter route is refused with 403 and goes nowhere", async () => {
    await upstream(ok, async (up) => {
      await withClient(writeConfig(configText("Dana Lee", [CA])), up.url, async (c) => {
        const g = c.guard("GET", "/api/admin/users");
        expect(g.refusal).toEqual({ status: 403, code: "ROUTE_NOT_ALLOWED", message: "The Podium connection helper forwards the reporter calls only." });
        expect(g.route).toBeUndefined();
        expect(c.guard("GET", PEERS).route).toEqual({ method: "GET", path: PEERS });
        const err = await refusedWith(c.request("DELETE", "/api/fleet/report"));
        expect(err.code).toBe("ROUTE_NOT_ALLOWED");
        expect(up.hits).toEqual([]);
      });
    });
  });

  test("a certificate that has expired by this machine's clock is refused before anything goes upstream, naming the day", async () => {
    await upstream(ok, async (up) => {
      await withClient(writeConfig(configText("Dana Lee", [CA])), up.url, async (c) => {
        const real = Date.now;
        const later = real() + 100 * DAY;
        Date.now = () => later;
        let g;
        let rejected: Promise<Error & { code: string }>;
        let status;
        try {
          g = c.guard("GET", PEERS);
          rejected = refusedWith(c.request("GET", PEERS));
          status = c.status();
        } finally {
          Date.now = real;
        }
        const on = new Date(new X509Certificate(LEAF.cert).validTo).toISOString().slice(0, 10);
        expect(g.refusal).toEqual({ status: 502, code: "CERT_EXPIRED", message: `Your Podium certificate expired on ${on}. Ask an Admin to generate a new reporter config.` });
        const err = await rejected;
        expect(err.code).toBe("CERT_EXPIRED");
        expect(err.message).toContain(on);
        expect(status.expired).toBe(true);
        expect(c.status().expired).toBe(false);
        expect(up.hits).toEqual([]);
      });
    });
  });

  test("a server that presents a certificate for another name is refused as ALTNAME", async () => {
    await upstream(ok, async (up) => {
      await withClient(writeConfig(configText("Dana Lee", [CA])), up.url, async (c) => {
        const err = await refusedWith(c.request("GET", PEERS));
        expect(err.code).toBe("ALTNAME");
        expect(up.hits).toEqual([]);
      });
    }, WRONG_NAME);
  });

  test("a self-signed server is refused even with NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment", async () => {
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      await upstream(ok, async (up) => {
        await withClient(writeConfig(configText("Dana Lee", [CA])), up.url, async (c) => {
          const err = await refusedWith(c.request("GET", PEERS));
          expect(err.code).not.toBe("UPSTREAM_ERROR");
          expect(["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "DEPTH_ZERO_SELF_SIGNED_CERT"]).toContain(err.code);
          expect(up.hits).toEqual([]);
          // the client never changes the environment: that is the shell's business
          expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0");
        });
      }, STRANGER_SERVING);
    } finally {
      if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
    }
  });

  test("a client certificate the server does not trust is CLIENT_CERT_REJECTED or, when TLS 1.3 shows it only as a close, CLOSED_AFTER_HANDSHAKE", async () => {
    await upstream(ok, async (up) => {
      await withClient(writeConfig(configText("Dana Lee", [CA], OUTSIDER)), up.url, async (c) => {
        const err = await refusedWith(c.request("GET", PEERS));
        expect(["CLIENT_CERT_REJECTED", "CLOSED_AFTER_HANDSHAKE"]).toContain(err.code);
        expect(up.hits).toEqual([]);
      });
    });
  });

  test("a connection that closes after the handshake with no answer is CLOSED_AFTER_HANDSHAKE, and a refused connection is ECONNREFUSED", async () => {
    let port = 0;
    await upstream(
      (req) => req.socket.destroy(),
      async (up) => {
        port = Number(new URL(up.url).port);
        await withClient(writeConfig(configText("Dana Lee", [CA])), up.url, async (c) => {
          expect((await refusedWith(c.request("GET", PEERS))).code).toBe("CLOSED_AFTER_HANDSHAKE");
        });
      },
    );
    // the server is gone: nothing listens on its port now
    await withClient(writeConfig(configText("Dana Lee", [CA])), `https://127.0.0.1:${port}`, async (c) => {
      const err = await refusedWith(c.request("GET", PEERS));
      expect(err.code).toBe("ECONNREFUSED");
    });
  });

  test("open hands the caller the upstream request, and a timeout is ETIMEDOUT", async () => {
    await upstream(
      () => {
        // never answers
      },
      async (up) => {
        await withClient(writeConfig(configText("Dana Lee", [CA])), up.url, async (c) => {
          const g = c.guard("GET", PEERS);
          const failure = await new Promise<{ code: string; message: string }>((resolve) => {
            const req = c.open(g.route!, { host: "ignored", connection: "close" }, { onResponse: () => resolve({ code: "none", message: "" }), onError: resolve });
            req.on("socket", () => setImmediate(() => req.emit("timeout")));
            req.end();
          });
          expect(failure).toMatchObject({ code: "ETIMEDOUT", message: "upstream timed out" });
        });
      },
    );
  });

  test("a reply that is cut off is an UPSTREAM_ERROR", async () => {
    await upstream(
      (_req, res) => {
        res.writeHead(200, { "content-length": "100" });
        res.write("part");
        setTimeout(() => res.socket?.destroy(), 20);
      },
      async (up) => {
        await withClient(writeConfig(configText("Dana Lee", [CA])), up.url, async (c) => {
          expect((await refusedWith(c.request("GET", PEERS))).code).toBe("UPSTREAM_ERROR");
        });
      },
    );
  });
});

describe("client.mjs: the config file is rewritten by another session", () => {
  test("a rewrite for the same person is taken up for the next request, and one for another person is not", async () => {
    await upstream(ok, async (up) => {
      const file = writeConfig(configText("Dana Lee", [CA]));
      await withClient(file, up.url, async (c) => {
        const first = c.status().notAfter;
        expect(first).toBe(Date.parse(new X509Certificate(LEAF.cert).validTo));
        await c.request("GET", PEERS);
        rewrite(file, configText("Dana Lee", [CA], LEAF2));
        await c.request("GET", PEERS);
        const second = c.status().notAfter;
        expect(second).toBe(Date.parse(new X509Certificate(LEAF2.cert).validTo));
        expect(second).toBeGreaterThan(first);
        expect(up.peers.at(-1)).toBe(new X509Certificate(LEAF2.cert).fingerprint256);
        // another person's file is not ours
        rewrite(file, configText("Someone Else", [CA], LEAF));
        await c.request("GET", PEERS);
        expect(c.status()).toMatchObject({ user: "Dana Lee", notAfter: second });
        // a rewrite that does not parse leaves the last good copy
        rewrite(file, "garbage");
        await c.request("GET", PEERS);
        expect(c.status()).toMatchObject({ user: "Dana Lee", notAfter: second });
        expect(up.peers.at(-1)).toBe(new X509Certificate(LEAF2.cert).fingerprint256);
        // a file that is gone is no change
        fs.rmSync(file);
        await c.request("GET", PEERS);
        expect(c.status().notAfter).toBe(second);
      });
    });
  });
});

describe("client.mjs: renewing the certificate", () => {
  /** The renewal endpoint: answers with what `answer` makes of the request, and counts the requests. */
  const renewer = (answer: (spki: string, count: number) => { status: number; headers?: Record<string, string>; body: unknown }) => {
    let count = 0;
    const handler: Handler = (req, res, text) => {
      if (req.url !== "/api/reporter/renew") return ok(req, res, text, null);
      count++;
      const a = answer(JSON.parse(text).publicKey, count);
      res.writeHead(a.status, { "content-type": "application/json", ...a.headers });
      res.end(JSON.stringify(a.body));
    };
    return { handler, count: () => count };
  };

  test("a certificate that is due is renewed: a new key, a certificate for it, the file rewritten at mode 0600, the lock let go", async () => {
    const r = renewer((spki) => ({ status: 200, body: { cert: signFor(spki, 365) } }));
    await upstream(r.handler, async (up) => {
      const file = writeConfig(configText("Dana Lee", [CA]));
      await withClient(file, up.url, async (c, log) => {
        const before = fs.readFileSync(file, "utf8");
        c.start();
        c.start(); // the check is started once
        expect(c.status().renewing).toBe(true);
        await c.settled();
        expect(log).toEqual([]);
        expect(r.count()).toBe(1);
        const after = fs.readFileSync(file, "utf8");
        expect(after).not.toBe(before);
        const cfg = parseConfig(after);
        const x = new X509Certificate(cfg.cert);
        expect(Date.parse(x.validTo) - Date.now()).toBeGreaterThan(300 * DAY);
        expect(x.checkPrivateKey(createPrivateKey(cfg.key))).toBe(true);
        expect(cfg.user).toBe("Dana Lee");
        if (POSIX) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(c.status()).toMatchObject({ renewing: false, expired: false, refused: null, notAfter: Date.parse(x.validTo) });
        // the lock is let go: no plain lock file, and the numbered one is aged
        expect(fs.existsSync(`${file}.lock`)).toBe(false);
        for (const g of generations(`${file}.lock`)) expect(olderThan(g.file, LOCK_STALE_MS - 1000)).toBe(true);
        // the next request is made with the new certificate, and the new one is not due, so there is no second renewal
        await c.request("GET", PEERS);
        expect(up.peers.at(-1)).toBe(x.fingerprint256);
        expect(r.count()).toBe(1);
      }, DUE);
    });
  });

  test("a due certificate is renewed by the first request that sees it, which does not wait for it", async () => {
    const r = renewer((spki) => ({ status: 200, body: { cert: signFor(spki, 365) } }));
    await upstream(r.handler, async (up) => {
      const file = writeConfig(configText("Dana Lee", [CA]));
      await withClient(file, up.url, async (c) => {
        expect(c.guard("GET", PEERS).route).toBeDefined();
        expect(c.status().renewing).toBe(true);
        await c.settled();
        expect(r.count()).toBe(1);
      }, DUE);
    });
  });

  test("a planned CA rotation is taken in: the file holds both CAs and the new certificate", async () => {
    const r = renewer((spki) => ({ status: 200, body: { cert: signFor(spki, 365, "newca"), rotation: { ca: NEW_CA, cross: CROSS } } }));
    await upstream(r.handler, async (up) => {
      const file = writeConfig(configText("Dana Lee", [CA]));
      await withClient(file, up.url, async (c, log) => {
        c.guard("GET", PEERS);
        await c.settled();
        expect(log).toEqual([]);
        const cfg = parseConfig(fs.readFileSync(file, "utf8"));
        expect(cfg.ca.map((p) => new X509Certificate(p).fingerprint256).sort()).toEqual([CA, NEW_CA].map((p) => new X509Certificate(p).fingerprint256).sort());
        expect(new X509Certificate(cfg.cert).issuer).toContain("Podium CA 2");
      }, DUE);
    });
  });

  test("a renewal the server refuses with 401 is not asked again, until the file is replaced", async () => {
    const r = renewer(() => ({ status: 401, body: { code: "CERT_REVOKED", error: "This certificate was revoked." } }));
    await upstream(r.handler, async (up) => {
      const file = writeConfig(configText("Dana Lee", [CA]));
      await withClient(file, up.url, async (c) => {
        c.guard("GET", PEERS);
        await c.settled();
        expect(c.status().refused).toEqual({ code: "CERT_RENEWAL_REFUSED", message: "This certificate was revoked." });
        await c.request("GET", PEERS);
        await c.settled();
        expect(r.count()).toBe(1);
        // a new file from the Admin clears it (and, being due still, is tried again)
        rewrite(file, configText("Dana Lee", [CA], LEAF));
        c.guard("GET", PEERS);
        expect(c.status().refused).toBeNull();
        await c.settled();
        expect(r.count()).toBe(2);
      }, DUE);
    });
  });

  test("a 429 is not a refusal: the next try waits as long as Retry-After says", async () => {
    const r = renewer(() => ({ status: 429, headers: { "retry-after": "7200" }, body: { error: "renewed less than an hour ago" } }));
    await upstream(r.handler, async (up) => {
      await withClient(writeConfig(configText("Dana Lee", [CA])), up.url, async (c) => {
        c.guard("GET", PEERS);
        await c.settled();
        const { retryAt, refused } = c.status();
        expect(refused).toBeNull();
        expect(retryAt - Date.now()).toBeGreaterThan(7100 * 1000);
        expect(retryAt - Date.now()).toBeLessThanOrEqual(7200 * 1000);
        c.guard("GET", PEERS);
        await c.settled();
        expect(r.count()).toBe(1);
      }, DUE);
    });
  });

  test("a certificate that does not check out is never written: for another key, not from a held CA, or an answer that is no certificate", async () => {
    const answers: Array<(spki: string) => { status: number; body: unknown }> = [
      () => ({ status: 200, body: { cert: LEAF2.cert } }), // not for the new key
      (spki: string) => ({ status: 200, body: { cert: signFor(spki, 365, "stranger") } }), // for the key, signed by a CA the file does not hold
      () => ({ status: 500, body: { error: "boom" } }),
      () => ({ status: 200, body: { cert: 5 } }),
    ];
    const expected = [/not for the new key/, /not signed by the CA in the file/, /answered 500/, /answered 200/];
    for (const [i, a] of answers.entries()) {
      const r = renewer(a);
      await upstream(r.handler, async (up) => {
        const file = writeConfig(configText("Dana Lee", [CA]));
        const before = fs.readFileSync(file, "utf8");
        await withClient(file, up.url, async (c, log) => {
          c.guard("GET", PEERS);
          await c.settled();
          expect(log).toHaveLength(1);
          expect(log[0]).toMatch(expected[i]!);
          expect(log[0]).not.toMatch(SECRET);
          expect(fs.readFileSync(file, "utf8")).toBe(before);
          // it waits before trying again, and the request itself still goes through
          expect(c.status().retryAt).toBeGreaterThan(Date.now());
          expect((await c.request("GET", PEERS)).status).toBe(200);
          expect(r.count()).toBe(1);
        }, DUE);
      });
    }
  });

  test("a certificate that has expired is not renewed: nobody would answer", async () => {
    const r = renewer((spki) => ({ status: 200, body: { cert: signFor(spki, 365) } }));
    await upstream(r.handler, async (up) => {
      await withClient(writeConfig(configText("Dana Lee", [CA])), up.url, async (c) => {
        const real = Date.now;
        Date.now = () => real() + 100 * DAY;
        try {
          c.start();
        } finally {
          Date.now = real;
        }
        await c.settled();
        expect(r.count()).toBe(0);
      }, DUE);
    });
  });

  test("two sessions of one person on one file renew once: the second takes the first's certificate", async () => {
    const r = renewer((spki) => ({ status: 200, body: { cert: signFor(spki, 365) } }));
    await upstream(r.handler, async (up) => {
      const file = writeConfig(configText("Dana Lee", [CA]));
      await withClient(file, up.url, async (a) => {
        await withClient(file, up.url, async (b) => {
          a.guard("GET", PEERS);
          b.guard("GET", PEERS);
          expect(a.status().renewing && b.status().renewing).toBe(true);
          await Promise.all([a.settled(), b.settled()]);
          expect(r.count()).toBe(1);
          const written = Date.parse(new X509Certificate(parseConfig(fs.readFileSync(file, "utf8")).cert).validTo);
          expect(a.status().notAfter).toBe(written);
          expect(b.status().notAfter).toBe(written);
        }, DUE);
      }, DUE);
    });
  });
});

describe("client.mjs: status", () => {
  test("says who, which server and when, and never a key, a certificate or a CA", async () => {
    const r = ((): Handler => (req, res, text) => (req.url === "/api/reporter/renew" ? (res.writeHead(401, { "content-type": "application/json" }), res.end(JSON.stringify({ code: "X", error: "no" }))) : ok(req, res, text, null)))();
    await upstream(r, async (up) => {
      await withClient(writeConfig(configText("Dana Lee", [CA])), up.url, async (c) => {
        for (const s of [c.status(), (c.guard("GET", PEERS), await c.settled(), c.status())]) {
          expect(Object.keys(s).sort()).toEqual(["expired", "notAfter", "refused", "renewing", "retryAt", "server", "user"]);
          expect(JSON.stringify(s)).not.toMatch(SECRET);
          expect(s).toMatchObject({ user: "Dana Lee", server: up.url, expired: false });
        }
        expect(c.status().refused?.code).toBe("CERT_RENEWAL_REFUSED");
        // what the status shows is a copy
        (c.status().refused as { code: string }).code = "changed";
        expect(c.status().refused?.code).toBe("CERT_RENEWAL_REFUSED");
      }, DUE);
    });
  });
});
