// rotation.mjs: a planned CA rotation's new CA is checked before it is stored (#588, #948). The certificates are made with `openssl`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "claude-code/testing";
import { acceptRotation } from "./rotation.mjs";

const made: string[] = [];
process.on("exit", () => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

/** The held CA, a new CA that shares its name with a second one of another key, and a cross certificate for the new CA signed by the held CA (or by a stranger). */
function fixtures() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "podium-rotation-"));
  made.push(work);
  const run = (...a: string[]) => execFileSync("openssl", a, { cwd: work, stdio: "pipe" });
  const read = (n: string) => fs.readFileSync(path.join(work, n), "utf8");
  fs.writeFileSync(path.join(work, "ca.cnf"), "[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n");
  fs.writeFileSync(path.join(work, "leaf.cnf"), "[v3]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n");
  for (const n of ["old", "new", "other", "stranger", "leaf"]) run("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", `${n}.key`);
  const root = (key: string, subj: string, out: string) => run("req", "-new", "-x509", "-key", key, "-subj", subj, "-config", "ca.cnf", "-extensions", "v3_ca", "-days", "3650", "-out", out);
  root("old.key", "/CN=Podium CA/O=podium", "old.crt");
  root("stranger.key", "/CN=Podium CA/O=podium", "stranger.crt");
  root("new.key", "/CN=Podium CA 2/O=podium", "new.crt");
  root("other.key", "/CN=Podium CA 2/O=podium", "other.crt");
  run("req", "-new", "-key", "new.key", "-subj", "/CN=Podium CA 2/O=podium", "-out", "new.csr");
  const cross = (by: string) => {
    run("x509", "-req", "-in", "new.csr", "-CA", `${by}.crt`, "-CAkey", `${by}.key`, "-days", "365", "-extfile", "ca.cnf", "-extensions", "v3_ca", "-out", `cross-${by}.crt`);
    return read(`cross-${by}.crt`);
  };
  run("req", "-new", "-key", "leaf.key", "-subj", "/CN=leaf", "-out", "leaf.csr");
  run("x509", "-req", "-in", "leaf.csr", "-CA", "old.crt", "-CAkey", "old.key", "-days", "90", "-extfile", "leaf.cnf", "-extensions", "v3", "-out", "leaf.crt");
  return { held: read("old.crt"), newCa: read("new.crt"), otherCa: read("other.crt"), cross: cross("old"), strangerCross: cross("stranger"), leaf: read("leaf.crt") };
}

const F = fixtures();

/** Runs `body` with the clock at `at`, and puts the real clock back. */
function atTime<T>(at: number, body: () => T): T {
  const real = Date.now;
  Date.now = () => at;
  try {
    return body();
  } finally {
    Date.now = real;
  }
}

describe("rotation.mjs: acceptRotation (#588)", () => {
  test("accepts a new CA vouched for by a cross certificate from a held CA, and says the file does not hold it yet", () => {
    expect(acceptRotation({ ca: F.newCa, cross: F.cross }, [F.held])).toEqual({ pem: F.newCa, held: false });
  });

  test("says the file holds the CA when it already does, and does not need the cross certificate to be signed by the new one", () => {
    expect(acceptRotation({ ca: F.newCa, cross: F.cross }, [F.held, F.newCa])).toEqual({ pem: F.newCa, held: true });
  });

  test("refuses a rotation without the new CA or the cross certificate", () => {
    expect(() => acceptRotation(undefined, [F.held])).toThrow(/missing the new CA or the cross certificate/);
    expect(() => acceptRotation({ ca: F.newCa }, [F.held])).toThrow(/missing/);
    expect(() => acceptRotation({ ca: 1, cross: F.cross }, [F.held])).toThrow(/missing/);
  });

  test("refuses a certificate that cannot be read", () => {
    expect(() => acceptRotation({ ca: "nope", cross: F.cross }, [F.held])).toThrow(/cannot be read/);
    expect(() => acceptRotation({ ca: F.newCa, cross: "nope" }, [F.held])).toThrow(/cannot be read/);
  });

  test("refuses a rotation that is not made of CA certificates", () => {
    expect(() => acceptRotation({ ca: F.leaf, cross: F.cross }, [F.held])).toThrow(/not made of CA certificates/);
    expect(() => acceptRotation({ ca: F.newCa, cross: F.leaf }, [F.held])).toThrow(/not made of CA certificates/);
  });

  test("refuses a cross certificate no held CA signed", () => {
    expect(() => acceptRotation({ ca: F.newCa, cross: F.strangerCross }, [F.held])).toThrow(/not signed by a CA in the file/);
  });

  test("refuses a rotation whose CA is not the one the cross certificate vouches for", () => {
    expect(() => acceptRotation({ ca: F.otherCa, cross: F.cross }, [F.held])).toThrow(/not for the new CA/);
  });

  test("refuses a certificate that is not valid now: one that is not yet, and one that no longer is", () => {
    const day = 86_400_000;
    expect(() => atTime(Date.now() - 2 * day, () => acceptRotation({ ca: F.newCa, cross: F.cross }, [F.held]))).toThrow(/not valid now/);
    expect(() => atTime(Date.now() + 400 * day, () => acceptRotation({ ca: F.newCa, cross: F.cross }, [F.held]))).toThrow(/not valid now/);
  });
});
