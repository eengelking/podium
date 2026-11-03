// config.mjs: reading the reporter config file (#584, #948). The certificates are made with `openssl`, as server/src/tlsTesting.ts does.
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type https from "node:https";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "claude-code/testing";
import { rewriteConfig } from "./atomic.mjs";
import { StartError, agentFor, headerUser, parseConfig, readConfig } from "./config.mjs";

const made: string[] = [];
process.on("exit", () => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "podium-config-"));
  made.push(d);
  return d;
};

interface Pki {
  ca: string;
  secondCa: string;
  cert: string;
  key: string;
}

/** Two CAs, and a person certificate and key for the first. */
function pki(): Pki {
  const work = tmp();
  const run = (...a: string[]) => execFileSync("openssl", a, { cwd: work, stdio: "pipe" });
  const read = (n: string) => fs.readFileSync(path.join(work, n), "utf8");
  fs.writeFileSync(path.join(work, "ca.cnf"), "[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n");
  fs.writeFileSync(path.join(work, "leaf.cnf"), "[v3]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n");
  for (const n of ["ca", "ca2", "leaf"]) run("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", `${n}.key`);
  run("req", "-new", "-x509", "-key", "ca.key", "-subj", "/CN=Podium CA/O=podium", "-config", "ca.cnf", "-extensions", "v3_ca", "-days", "3650", "-out", "ca.crt");
  run("req", "-new", "-x509", "-key", "ca2.key", "-subj", "/CN=Podium CA 2/O=podium", "-config", "ca.cnf", "-extensions", "v3_ca", "-days", "3650", "-out", "ca2.crt");
  run("req", "-new", "-key", "leaf.key", "-subj", "/CN=pdm_a1b2c3d4e5f6/O=podium", "-out", "leaf.csr");
  run("x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-days", "90", "-extfile", "leaf.cnf", "-extensions", "v3", "-out", "leaf.crt");
  return { ca: read("ca.crt"), secondCa: read("ca2.crt"), cert: read("leaf.crt"), key: read("leaf.key") };
}

const P = pki();
const header = "# podium-reporter-config v1\n# user: Dana Lee\n# server: https://h:4318\n";
const file = (...blocks: string[]) => `${header}${blocks.join("")}`;
/** The StartError a call throws; fails when it throws nothing. */
function thrown(f: () => unknown): StartError {
  try {
    f();
  } catch (err) {
    return err as StartError;
  }
  throw new Error("expected a throw");
}
const fingerprints =(pems: string[]) => pems.map((c) => new X509Certificate(c).fingerprint256);

describe("config.mjs: headerUser", () => {
  test("reads the name from the user line, line by line, however many blanks surround it", () => {
    expect(headerUser("# podium-reporter-config v1\n# user: Dana Lee \n# server: x\n")).toBe("Dana Lee");
    expect(headerUser("#user:Dana\r\n")).toBe("Dana");
    expect(headerUser("# user:\n#   user:   Second   \n")).toBe("Second");
    expect(headerUser("x # user: no\n# users: no\n")).toBe("");
    expect(headerUser("")).toBe("");
    const t = process.hrtime.bigint();
    headerUser(`${"#".repeat(100000)}\n${"#" + " \n".repeat(50000)}#${" ".repeat(100000)}!`);
    expect(Number(process.hrtime.bigint() - t) / 1e6).toBeLessThan(250);
  });
});

describe("config.mjs: parseConfig", () => {
  test("reads the CA certificates, the person's certificate and the key by role, not position", () => {
    const got = parseConfig(file(P.cert, P.key, P.secondCa, P.ca));
    expect(fingerprints(got.ca)).toEqual(fingerprints([P.secondCa, P.ca]));
    expect(got.cert).toBe(P.cert.trimEnd());
    expect(got.key).toBe(P.key.trimEnd());
    expect(got.user).toBe("Dana Lee");
    const x = new X509Certificate(P.cert);
    expect(got.notAfter).toBe(Date.parse(x.validTo));
    expect(got.notBefore).toBe(Date.parse(x.validFrom));
  });

  test("refuses a file with no CA, no person certificate or no key, and says which", () => {
    expect(() => parseConfig(file(P.cert, P.key))).toThrow(/no CA certificate/);
    expect(() => parseConfig(file(P.ca, P.key))).toThrow(/no person certificate/);
    expect(() => parseConfig(file(P.ca, P.cert))).toThrow(/no private key/);
    const err = thrown(() => parseConfig(""));
    expect(err).toBeInstanceOf(StartError);
    expect(err.code).toBe("CONFIG_INVALID");
  });

  test("refuses more than one person certificate or private key, and a certificate block that cannot be read", () => {
    expect(() => parseConfig(file(P.ca, P.cert, P.cert, P.key))).toThrow(/more than one person certificate/);
    expect(() => parseConfig(file(P.ca, P.cert, P.key, P.key))).toThrow(/more than one private key/);
    expect(() => parseConfig(file(P.ca, P.cert, P.key, "-----BEGIN CERTIFICATE-----\nnot a certificate\n-----END CERTIFICATE-----\n"))).toThrow(/cannot be read/);
  });

  test("ignores a block that is neither a certificate nor a private key", () => {
    const got = parseConfig(file(P.ca, P.cert, P.key, "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n"));
    expect(got.ca).toHaveLength(1);
  });

  test("reads back what rewriteConfig wrote: two CAs, beside one person certificate and one key", () => {
    const out = rewriteConfig(file(P.ca, P.cert, P.key), { ca: [P.ca, P.secondCa], cert: P.cert, key: P.key, notAfter: "2030-01-01T00:00:00.000Z", fingerprint: "AA", now: Date.now() });
    const got = parseConfig(out);
    expect(fingerprints(got.ca)).toEqual(fingerprints([P.ca, P.secondCa]));
    expect(new X509Certificate(got.cert).fingerprint256).toBe(new X509Certificate(P.cert).fingerprint256);
    expect(got.user).toBe("Dana Lee");
  });
});

describe("config.mjs: readConfig", () => {
  const write = (mode: number, text = file(P.ca, P.cert, P.key)) => {
    const f = path.join(tmp(), "reporter-config.pem");
    fs.writeFileSync(f, text, { mode });
    fs.chmodSync(f, mode);
    return f;
  };

  test("reads a file only its owner can read, and returns its modification time", () => {
    const f = write(0o600);
    const got = readConfig(f);
    expect(got.cert).toBe(P.cert.trimEnd());
    expect(got.mtimeMs).toBe(fs.statSync(f).mtimeMs);
  });

  // Windows has no file modes to check, and the helper does not check them there.
  test("refuses a file that group or others can read, and says how to fix it", () => {
    if (process.platform === "win32") return;
    const f = write(0o644);
    const err = thrown(() => readConfig(f));
    expect(err.code).toBe("CONFIG_PERMISSIONS");
    expect(err.message).toContain("mode 644");
    expect(err.message).toContain(`chmod 600 ${f}`);
  });

  test("says CONFIG_MISSING for a file that is not there, and for one that cannot be read as text", () => {
    const dir = tmp();
    expect(thrown(() => readConfig(path.join(dir, "gone.pem"))).code).toBe("CONFIG_MISSING");
    // a folder opens, but reading it fails
    fs.chmodSync(dir, 0o700);
    expect(thrown(() => readConfig(dir)).code).toBe("CONFIG_MISSING");
  });

  test("passes on the parse error of a file that is readable but is not a config", () => {
    expect(thrown(() => readConfig(write(0o600, "nothing here"))).code).toBe("CONFIG_INVALID");
  });
});

describe("config.mjs: agentFor", () => {
  test("is one keep-alive agent that holds the CA, the certificate and the key, with verification on", () => {
    const agent = agentFor(parseConfig(file(P.ca, P.cert, P.key))) as https.Agent & { options: https.AgentOptions };
    try {
      expect(agent.options.rejectUnauthorized).toBe(true);
      expect(agent.options.keepAlive).toBe(true);
      expect(agent.options.cert).toBe(P.cert.trimEnd());
      expect(agent.options.key).toBe(P.key.trimEnd());
      expect(agent.options.ca).toHaveLength(1);
    } finally {
      agent.destroy();
    }
  });
});
