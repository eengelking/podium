// atomic.mjs: the safe write of the reporter config file, and the text a renewal puts in it (#672, #948).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "claude-code/testing";
import { rewriteConfig, writeAtomic } from "./atomic.mjs";

const made: string[] = [];
process.on("exit", () => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "podium-atomic-"));
  made.push(d);
  return d;
};

describe("atomic.mjs: writeAtomic (#672)", () => {
  test("writes the file at mode 0600 and leaves no temporary file", () => {
    const dir = tmp();
    const file = path.join(dir, "config.pem");
    writeAtomic(file, "one");
    writeAtomic(file, "two");
    expect(fs.readFileSync(file, "utf8")).toBe("two");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["config.pem"]);
  });

  test("follows a destination that is a symlink: the target changes, the link stays a link, and no temporary file is left in either folder", () => {
    const dir = tmp();
    const other = tmp();
    const target = path.join(other, "target.pem");
    const link = path.join(dir, "config.pem");
    fs.writeFileSync(target, "original");
    fs.symlinkSync(target, link);
    writeAtomic(link, "new");
    expect(fs.readFileSync(target, "utf8")).toBe("new");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(["config.pem"]);
    expect(fs.readdirSync(other)).toEqual(["target.pem"]);
  });

  test("throws for a symlink whose target is missing, and creates nothing", () => {
    const dir = tmp();
    const link = path.join(dir, "config.pem");
    fs.symlinkSync(path.join(dir, "gone.pem"), link);
    expect(() => writeAtomic(link, "new")).toThrow();
    expect(fs.readdirSync(dir)).toEqual(["config.pem"]);
  });

  test("does not write through a symlink planted at the temporary name", () => {
    const dir = tmp();
    const file = path.join(dir, "config.pem");
    const victim = path.join(dir, "victim.txt");
    fs.writeFileSync(victim, "untouched");
    fs.symlinkSync(victim, `${file}.${process.pid}.tmp`);
    writeAtomic(file, "new");
    expect(fs.readFileSync(victim, "utf8")).toBe("untouched");
    expect(fs.readFileSync(file, "utf8")).toBe("new");
  });

  test("throws when the folder is missing, and when the rename fails it removes its temporary file", () => {
    const dir = tmp();
    expect(() => writeAtomic(path.join(dir, "missing", "config.pem"), "x")).toThrow(/ENOENT/);
    // a folder where the file should go: the rename cannot replace it
    const asFolder = path.join(dir, "config.pem");
    fs.mkdirSync(asFolder);
    expect(() => writeAtomic(asFolder, "x")).toThrow();
    expect(fs.readdirSync(dir)).toEqual(["config.pem"]);
  });
});

describe("atomic.mjs: rewriteConfig", () => {
  const n = {
    ca: ["-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n"],
    cert: "-----BEGIN CERTIFICATE-----\nNEW\n-----END CERTIFICATE-----\n",
    key: "-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----\n",
    notAfter: "2026-07-01T00:00:00.000Z",
    fingerprint: "BB",
    now: Date.parse("2026-05-01T00:00:00.000Z"),
  };

  test("keeps the name and the server, and updates the issued-at, expires and fingerprint lines", () => {
    const old = "# podium-reporter-config v1\n# user: Dana Lee\n# server: https://h:4318\n# issued-at: 2026-01-01T00:00:00.000Z 1767225600\n# expires: 2026-04-01T00:00:00.000Z\n# fingerprint: AA\n-----BEGIN CERTIFICATE-----\nOLD\n-----END CERTIFICATE-----\n";
    const out = rewriteConfig(old, n);
    expect(out.split("\n").slice(0, 6)).toEqual(["# podium-reporter-config v1", "# user: Dana Lee", "# server: https://h:4318", "# issued-at: 2026-05-01T00:00:00.000Z 1777593600", "# expires: 2026-07-01T00:00:00.000Z", "# fingerprint: BB"]);
    expect(out).not.toContain("OLD");
    expect(out.indexOf("CA")).toBeLessThan(out.indexOf("NEW"));
    expect(out.indexOf("NEW")).toBeLessThan(out.indexOf("PRIVATE KEY"));
  });

  test("adds the lines a file does not have, drops blank header lines, and ends every block with one newline", () => {
    const out = rewriteConfig("# user: Dana\r\n\r\n# server: https://h\r\n", { ...n, ca: ["-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----"], cert: n.cert.trimEnd() });
    expect(out.split("\n").slice(0, 6)).toEqual(["# user: Dana", "# server: https://h", "# issued-at: 2026-05-01T00:00:00.000Z 1777593600", "# expires: 2026-07-01T00:00:00.000Z", "# fingerprint: BB", "-----BEGIN CERTIFICATE-----"]);
    expect(out.endsWith("-----END PRIVATE KEY-----\n")).toBe(true);
    expect(out).not.toContain("\n\n");
  });
});
