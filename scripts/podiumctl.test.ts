import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bootUnitStale, buildId, containerRunArgs, ENGINES, gitBuild, launchdPlist, maskConfig, OWN_KEYS, parseArgs, parseEnvFile, PASSTHROUGH, resolveConfig, serializeEnv, serverEnv, stableNodePath, systemdUnit, tlsStorageWarning,
// @ts-expect-error bin/podiumctl has no extension, so tsc cannot find it; vitest loads it as ESM
} from "../bin/podiumctl";

const BIN = path.join(__dirname, "..", "bin", "podiumctl");
function ctl(home: string, ...args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, PODIUMCTL_HOME: home } });
}

describe("podiumctl parsing", () => {
  it("splits command, args and flags", () => {
    expect(parseArgs(["logs", "-f", "--tail", "5", "--mode=standalone"])).toEqual({
      cmd: "logs", args: [], flags: { follow: true, tail: "5", mode: "standalone" },
    });
    expect(parseArgs(["config", "set", "A=b"]).args).toEqual(["set", "A=b"]);
    expect(() => parseArgs(["start", "--port"])).toThrow(/needs a value/);
  });

  it("round-trips the env file and keeps '=' inside values", () => {
    const obj = { PODIUM_TOKEN: "abc=def", PODIUMCTL_PORT: "4400" };
    expect(parseEnvFile(serializeEnv(obj))).toEqual(obj);
  });
});

describe("podiumctl config", () => {
  it("applies defaults, then file values, then flags", () => {
    expect(resolveConfig({}, {}, ["podman"])).toMatchObject({ mode: "container", port: 4317, bind: "127.0.0.1" });
    expect(resolveConfig({}, {}, []).mode).toBe("standalone");
    expect(resolveConfig({ PODIUMCTL_PORT: "5000" }, {}).port).toBe(5000);
    expect(resolveConfig({ PODIUMCTL_PORT: "5000" }, { port: "6000" }).port).toBe(6000);
  });

  it("rejects bad mode, engine and port", () => {
    expect(() => resolveConfig({}, { mode: "docker" })).toThrow(/mode/);
    expect(() => resolveConfig({}, { engine: "nerdctl" })).toThrow(/engine must be podman or docker/);
    expect(() => resolveConfig({ PODIUMCTL_ENGINE: "lxc" })).toThrow(/engine/);
    expect(() => resolveConfig({}, { port: "99999" })).toThrow(/port/);
  });

  it("keeps an empty token (auth off) distinct from no token", () => {
    expect(resolveConfig({ PODIUM_TOKEN: "" }).token).toBe("");
    expect(resolveConfig({}).token).toBeUndefined();
  });
});

describe("podiumctl container engine", () => {
  it("prefers podman, then docker, among the installed engines", () => {
    expect(ENGINES).toEqual(["podman", "docker"]);
    expect(resolveConfig({}, {}, ["podman", "docker"]).engine).toBe("podman");
    expect(resolveConfig({}, {}, ["docker"])).toMatchObject({ mode: "container", engine: "docker" });
    expect(resolveConfig({}, {}, []).engine).toBeUndefined();
  });

  it("uses a saved engine over the detected one, and a flag over both", () => {
    expect(resolveConfig({ PODIUMCTL_ENGINE: "docker" }, {}, ["podman", "docker"]).engine).toBe("docker");
    expect(resolveConfig({ PODIUMCTL_ENGINE: "docker" }, { engine: "podman" }, ["podman", "docker"]).engine).toBe("podman");
    expect(resolveConfig({ PODIUMCTL_ENGINE: "" }, {}, ["docker"]).engine).toBe("docker");
  });

  it("maps host.docker.internal to this machine under docker only", () => {
    const docker = resolveConfig({}, {}, ["docker"]);
    const args = containerRunArgs(docker, []);
    expect(args.slice(args.indexOf("--add-host"), args.indexOf("--add-host") + 2)).toEqual(["--add-host", "host.docker.internal:host-gateway"]);
    expect(containerRunArgs(resolveConfig({}, {}, ["podman"]), [])).not.toContain("--add-host");
  });

  it("keeps .dockerignore the same as .containerignore, so a docker build leaves out the same files", () => {
    const rules = (f: string) => fs.readFileSync(path.join(__dirname, "..", f), "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    expect(rules(".dockerignore")).toEqual(rules(".containerignore"));
  });

  it("can be set with `config set` and refuses an unknown one", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "podiumctl-"));
    try {
      expect(ctl(home, "config", "set", "PODIUMCTL_ENGINE=docker").status).toBe(0);
      expect(ctl(home, "config", "--mode", "container").stdout).toContain("engine=docker");
      const r = ctl(home, "config", "set", "PODIUMCTL_ENGINE=nerdctl");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/engine must be/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails clearly in container mode when neither engine is installed", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "podiumctl-"));
    try {
      // An empty PATH hides both engines.
      const r = spawnSync(process.execPath, [BIN, "logs", "--mode", "container"], { encoding: "utf8", env: { ...process.env, PODIUMCTL_HOME: home, PATH: home } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("neither podman nor docker is installed");
      const st = spawnSync(process.execPath, [BIN, "status", "--mode", "container"], { encoding: "utf8", env: { ...process.env, PODIUMCTL_HOME: home, PATH: home } });
      expect(st.status).toBe(3);
      expect(st.stdout).toContain("engine:   none");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("podiumctl with both engines installed", () => {
  // Stand-in engines on an otherwise empty PATH: `inspect` says whether each one runs a podium container.
  function fakeEngines(home: string, engines: Record<string, { running?: boolean; info?: string }>) {
    for (const [name, { running, info }] of Object.entries(engines)) {
      const file = path.join(home, name);
      fs.writeFileSync(file, `#!/bin/sh
case "$1" in
  --version) exit 0 ;;
  info) ${info ? `echo "${info}" >&2; exit 1` : "exit 0"} ;;
  container) ${running ? 'echo "running healthy"; exit 0' : "exit 1"} ;;
  *) exit 1 ;;
esac
`);
      fs.chmodSync(file, 0o755);
    }
  }
  const run = (home: string, ...args: string[]) =>
    spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, PODIUMCTL_HOME: home, PATH: home } });

  it("refuses a start under one engine while the other runs the container, and names it", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "podiumctl-"));
    try {
      fakeEngines(home, { podman: { running: true }, docker: {} });
      const r = run(home, "start", "--mode", "container", "--engine", "docker");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("already running under podman");
      expect(r.stderr).toContain("podiumctl stop --engine podman");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("points a stop at the engine that runs the container", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "podiumctl-"));
    try {
      fakeEngines(home, { podman: { running: true }, docker: {} });
      const r = run(home, "stop", "--mode", "container", "--engine", "docker");
      expect(r.stdout).toContain("Not running under docker");
      expect(r.stdout).toContain("podiumctl stop --engine podman");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("shows why `docker info` failed, such as a socket the user cannot open", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "podiumctl-"));
    try {
      fakeEngines(home, { docker: { info: "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock" } });
      const r = run(home, "logs", "--mode", "container");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("permission denied while trying to connect");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("podiumctl config set and unset with several arguments (#156)", () => {
  const read = (home: string) => parseEnvFile(fs.readFileSync(path.join(home, "config.env"), "utf8")) as Record<string, string>;
  function withHome(body: (home: string) => void) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "podiumctl-"));
    try { body(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }

  it("sets one pair", () => withHome((home) => {
    expect(ctl(home, "config", "set", "PODIUMCTL_PORT=4410").status).toBe(0);
    expect(read(home)).toEqual({ PODIUMCTL_PORT: "4410" });
  }));

  it("sets each pair when given two", () => withHome((home) => {
    const r = ctl(home, "config", "set", "PODIUM_LOG_FORMAT=json", "PODIUM_LOG_SHIP_URL=http://host:9428");
    expect(r.status).toBe(0);
    expect(read(home)).toEqual({ PODIUM_LOG_FORMAT: "json", PODIUM_LOG_SHIP_URL: "http://host:9428" });
  }));

  it("keeps '=' and spaces inside a quoted value", () => withHome((home) => {
    expect(ctl(home, "config", "set", "PODIUM_LOG_SHIP_HEADERS=Authorization=Basic a b==").status).toBe(0);
    expect(read(home)).toEqual({ PODIUM_LOG_SHIP_HEADERS: "Authorization=Basic a b==" });
  }));

  it("fails on an argument with no '=' and leaves the file unchanged", () => withHome((home) => {
    expect(ctl(home, "config", "set", "PODIUMCTL_PORT=4410").status).toBe(0);
    const before = fs.readFileSync(path.join(home, "config.env"), "utf8");
    const r = ctl(home, "config", "set", "PODIUM_LOG_FORMAT=json", "PODIUM_LOG_SHIP_URL");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage/);
    expect(fs.readFileSync(path.join(home, "config.env"), "utf8")).toBe(before);
  }));

  it("fails on one unknown key among several and leaves the file unchanged", () => withHome((home) => {
    const r = ctl(home, "config", "set", "PODIUM_LOG_FORMAT=json", "NOPE=1");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown key "NOPE"/);
    expect(fs.existsSync(path.join(home, "config.env"))).toBe(false);
  }));

  it("fails with a usage message when no pair is given", () => withHome((home) => {
    const r = ctl(home, "config", "set");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage/);
  }));

  it("unsets several keys", () => withHome((home) => {
    expect(ctl(home, "config", "set", "PODIUM_LOG_FORMAT=json", "PODIUMCTL_PORT=4410").status).toBe(0);
    expect(ctl(home, "config", "unset", "PODIUM_LOG_FORMAT", "PODIUMCTL_PORT").status).toBe(0);
    expect(read(home)).toEqual({});
  }));
});

describe("podiumctl with a retired ANTHROPIC_ADMIN_API_KEY left in the config", () => {
  function homeWithOldKey() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "podiumctl-"));
    fs.writeFileSync(path.join(home, "config.env"), "PODIUMCTL_PORT=4400\nANTHROPIC_ADMIN_API_KEY=sk-ant-admin-old\n");
    return home;
  }

  it("is ignored by the server settings", () => {
    const cfg = resolveConfig({ PODIUMCTL_PORT: "4400", ANTHROPIC_ADMIN_API_KEY: "sk-ant-admin-old" });
    expect(cfg.port).toBe(4400);
    expect(serverEnv(cfg, true)).not.toHaveProperty("ANTHROPIC_ADMIN_API_KEY");
  });

  it("still shows the config and lets the old key be unset", () => {
    const home = homeWithOldKey();
    try {
      expect(ctl(home, "config").status).toBe(0);
      const r = ctl(home, "config", "unset", "ANTHROPIC_ADMIN_API_KEY");
      expect(r.status).toBe(0);
      expect(fs.readFileSync(path.join(home, "config.env"), "utf8")).not.toContain("ANTHROPIC_ADMIN_API_KEY");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to set the retired key again, and says why", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "podiumctl-"));
    try {
      const r = ctl(home, "config", "set", "ANTHROPIC_ADMIN_API_KEY=x");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/no longer used/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("podiumctl command construction", () => {
  const cfg = resolveConfig({ PODIUM_TOKEN: "s3cret", STALE_AFTER_MS: "9000" }, { port: "4400" });

  it("never puts the token on the container engine's command line", () => {
    const env = serverEnv(cfg, true);
    const args = containerRunArgs(cfg, Object.keys(env));
    expect(args.join(" ")).not.toContain("s3cret");
    expect(args).toContain("PODIUM_TOKEN");
    expect(args).toContain("127.0.0.1:4400:4317");
    expect(env).toMatchObject({ HOST: "0.0.0.0", PORT: "4317", PODIUM_DB: "/data/podium.sqlite", STALE_AFTER_MS: "9000" });
  });

  it("runs the container with no capabilities and no way to gain privileges (#249)", () => {
    const args = containerRunArgs(cfg, Object.keys(serverEnv(cfg, true)));
    const at = args.indexOf("--cap-drop");
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe("ALL");
    const sec = args.indexOf("--security-opt");
    expect(sec).toBeGreaterThan(-1);
    expect(args[sec + 1]).toBe("no-new-privileges");
  });

  it("gives a containerised server the host's timezone so its day starts at the host's midnight (#139)", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(serverEnv(cfg, true).TZ).toBe(zone);
    expect(containerRunArgs(cfg, Object.keys(serverEnv(cfg, true)))).toContain("TZ");
    // A TZ set in the config wins, and a standalone server already runs in the host's zone.
    expect(serverEnv(resolveConfig({ TZ: "Europe/Berlin" }), true).TZ).toBe("Europe/Berlin");
    expect(serverEnv(cfg, false)).not.toHaveProperty("TZ");
  });

  it("tells a containerised server the host's home, by name only, and leaves standalone alone", () => {
    const env = serverEnv(cfg, true);
    expect(env.PODIUM_HOST_HOME).toBe(os.homedir());
    expect(containerRunArgs(cfg, Object.keys(env))).toContain("PODIUM_HOST_HOME");
    expect(containerRunArgs(cfg, Object.keys(env)).join(" ")).not.toContain(os.homedir());
    expect(serverEnv(cfg, false)).not.toHaveProperty("PODIUM_HOST_HOME");
  });

  it("passes an empty token through so auth stays off", () => {
    expect(serverEnv(resolveConfig({ PODIUM_TOKEN: "" }), false).PODIUM_TOKEN).toBe("");
    expect("PODIUM_TOKEN" in serverEnv(resolveConfig({}), false)).toBe(false);
  });

  it("gives a standalone server the host port and bind", () => {
    expect(serverEnv(cfg, false)).toMatchObject({ HOST: "127.0.0.1", PORT: "4400", PODIUM_TOKEN: "s3cret" });
  });

  it("renders a launchd plist and systemd units", () => {
    const args = ["/usr/bin/node", "/x/podiumctl", "run", "--mode", "standalone"];
    const plist = launchdPlist({ label: "dev.podium.server", args, keepAliveOnFailure: true, logPath: "/l", env: { PATH: "/a&b" } });
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("SuccessfulExit");
    expect(plist).toContain("/a&amp;b");
    expect(launchdPlist({ label: "x", args, keepAliveOnFailure: false, logPath: "/l", env: {} })).not.toContain("KeepAlive");
    const sa = systemdUnit({ args, stopArgs: [], standalone: true, env: { PATH: "/bin" } });
    expect(sa).toContain("Restart=on-failure");
    const co = systemdUnit({ args: ["/n", "/s p", "start"], stopArgs: ["/n", "/s p", "stop"], standalone: false, env: {} });
    expect(co).toContain('ExecStart=/n "/s p" start');
    expect(co).toContain('ExecStop=/n "/s p" stop');
  });
});

describe("podiumctl boot unit node path (#268)", () => {
  it("names Homebrew's unversioned opt link, not the Cellar directory a brew upgrade deletes", () => {
    expect(stableNodePath("/var/home/linuxbrew/.linuxbrew/Cellar/node@24/24.22.0/bin/node")).toBe("/var/home/linuxbrew/.linuxbrew/opt/node@24/bin/node");
    expect(stableNodePath("/opt/homebrew/Cellar/node/25.1.0/bin/node")).toBe("/opt/homebrew/opt/node/bin/node");
  });

  it("tells a systemd person disable stops the server in either mode, and a launchd one only standalone", () => {
    const src = fs.readFileSync(BIN, "utf8");
    expect(src).toContain("Disabled. The server the service was running is stopped with it");
    expect(src).toContain("(standalone mode) is stopped with it");
  });

  it("leaves a node that is not in a Cellar alone", () => {
    expect(stableNodePath("/usr/bin/node")).toBe("/usr/bin/node");
    expect(stableNodePath("/home/me/.nvm/versions/node/v24.0.0/bin/node")).toBe("/home/me/.nvm/versions/node/v24.0.0/bin/node");
  });
});

describe("podiumctl allowed hosts (#256)", () => {
  it("passes PODIUM_ALLOWED_HOSTS through to the server, in both modes", () => {
    expect(PASSTHROUGH).toContain("PODIUM_ALLOWED_HOSTS");
    const cfg = resolveConfig({ PODIUM_ALLOWED_HOSTS: "box.lan,fleet.example" });
    expect(serverEnv(cfg, true)).toMatchObject({ PODIUM_ALLOWED_HOSTS: "box.lan,fleet.example" });
    expect(serverEnv(cfg, false)).toMatchObject({ PODIUM_ALLOWED_HOSTS: "box.lan,fleet.example" });
  });

  it("documents the setting in the help text", () => {
    expect(fs.readFileSync(path.join(__dirname, "..", "bin", "podiumctl"), "utf8")).toContain("PODIUM_ALLOWED_HOSTS  ");
  });
});

describe("podiumctl trust proxy (#305)", () => {
  it("passes PODIUM_TRUST_PROXY through to the server, in both modes", () => {
    expect(PASSTHROUGH).toContain("PODIUM_TRUST_PROXY");
    const cfg = resolveConfig({ PODIUM_TRUST_PROXY: "10.0.0.5,loopback" });
    expect(serverEnv(cfg, true)).toMatchObject({ PODIUM_TRUST_PROXY: "10.0.0.5,loopback" });
    expect(serverEnv(cfg, false)).toMatchObject({ PODIUM_TRUST_PROXY: "10.0.0.5,loopback" });
  });

  it("documents the setting in the help text", () => {
    expect(fs.readFileSync(path.join(__dirname, "..", "bin", "podiumctl"), "utf8")).toContain("PODIUM_TRUST_PROXY    ");
  });
});

describe("podiumctl logging settings (#140)", () => {
  const LOG_KEYS = ["PODIUM_LOG_LEVEL", "PODIUM_LOG_FORMAT", "PODIUM_LOG_SHIP_URL", "PODIUM_LOG_SHIP_HEADERS", "PODIUM_LOG_SHIP_BUFFER"];
  const file = {
    PODIUM_LOG_LEVEL: "debug",
    PODIUM_LOG_FORMAT: "json",
    PODIUM_LOG_SHIP_URL: "http://logs.lan:9428",
    PODIUM_LOG_SHIP_HEADERS: "Authorization=Bearer hdr-s3cret;AccountID=4",
    PODIUM_LOG_SHIP_BUFFER: "500",
  };

  it("are config keys passed through to the server, in both modes", () => {
    expect(PASSTHROUGH).toEqual(expect.arrayContaining(LOG_KEYS));
    const cfg = resolveConfig(file);
    expect(serverEnv(cfg, true)).toMatchObject(file);
    expect(serverEnv(cfg, false)).toMatchObject(file);
  });

  it("never puts a header value on the podman command line", () => {
    const cfg = resolveConfig(file);
    const args = containerRunArgs(cfg, Object.keys(serverEnv(cfg, true)));
    expect(args).toContain("PODIUM_LOG_SHIP_HEADERS");
    expect(args.join(" ")).not.toContain("hdr-s3cret");
  });

  it("can be set, keep = and ; inside a value, and hide header values and URL passwords in `config`", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "podiumctl-"));
    try {
      expect(ctl(home, "config", "set", "PODIUM_LOG_SHIP_HEADERS=Authorization=Basic dXNlcjpwYXNz==;AccountID=4").status).toBe(0);
      expect(ctl(home, "config", "set", "PODIUM_LOG_SHIP_URL=https://vl:pa55word@logs.lan/vl").status).toBe(0);
      expect((parseEnvFile(fs.readFileSync(path.join(home, "config.env"), "utf8")) as Record<string, string>).PODIUM_LOG_SHIP_HEADERS).toBe("Authorization=Basic dXNlcjpwYXNz==;AccountID=4");
      const shown = ctl(home, "config").stdout;
      expect(shown).not.toContain("dXNlcjpwYXNz");
      expect(shown).not.toContain("pa55word");
      expect(shown).toContain("Authorization=(hidden)");
      expect(shown).toContain("AccountID=(hidden)");
      expect(shown).toContain("logs.lan/vl");
      const all = ctl(home, "config", "--show-token").stdout;
      expect(all).toContain("dXNlcjpwYXNz==");
      expect(all).toContain("pa55word");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("maskConfig hides a header pair with no '=', a URL's user name and its query values, and leaves a plain URL alone", () => {
    const shown = maskConfig({ PODIUM_LOG_SHIP_HEADERS: "Bearer abc123;AccountID=4", PODIUM_LOG_SHIP_URL: "https://vluser:pw@logs.lan/vl?apikey=XKEY123" }) as Record<string, string>;
    expect(shown.PODIUM_LOG_SHIP_HEADERS).not.toContain("abc123");
    expect(shown.PODIUM_LOG_SHIP_HEADERS).toContain("AccountID=(hidden)");
    expect(shown.PODIUM_LOG_SHIP_URL).not.toMatch(/vluser|pw@|XKEY123/);
    expect(shown.PODIUM_LOG_SHIP_URL).toContain("logs.lan/vl");
    expect(shown.PODIUM_LOG_SHIP_URL).toContain("apikey=");
    const plain = maskConfig({ PODIUM_LOG_SHIP_URL: "http://logs.lan:9428" }) as Record<string, string>;
    expect(plain.PODIUM_LOG_SHIP_URL).toBe("http://logs.lan:9428");
  });

  it("are listed in --help", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "podiumctl-"));
    try {
      const help = ctl(home, "--help").stdout;
      for (const k of LOG_KEYS) expect(help).toContain(k);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("podiumctl start (standalone) with the port taken", () => {
  // Async spawn: the stand-in server lives in this process, so a blocking spawnSync would starve it.
  function ctlAsync(home: string, ...args: string[]) {
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      // An empty PATH hides podman, so a real "podium" container on the host cannot trip the other-mode guard.
      const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, PODIUMCTL_HOME: home, PATH: home } });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  }

  it("fails naming the port and leaves no pid file", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "podiumctl-"));
    const other = http.createServer((_req, res) => res.end("{}"));
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const port = (other.address() as { port: number }).port;
    try {
      const r = await ctlAsync(home, "start", "--mode", "standalone", "--port", String(port));
      expect(r.status).not.toBe(0);
      expect(r.stdout).not.toContain("Podium is up");
      expect(r.stderr).toContain(String(port));
      expect(r.stderr).toContain("already in use");
      expect(fs.existsSync(path.join(home, "podium.pid"))).toBe(false);
    } finally {
      await new Promise((r) => other.close(r));
      fs.rmSync(home, { recursive: true });
    }
  });
});

describe("podiumctl boot unit staleness (#227)", () => {
  it("is stale when the unit does not point at the running script", () => {
    expect(bootUnitStale("<string>/r/bin/podiumctl.old</string>", "/r/bin/podiumctl")).toBe(true);
    expect(bootUnitStale("ExecStart=/usr/bin/node /r/bin/podiumctl run", "/r/bin/podiumctl")).toBe(false);
  });
});

describe("podiumctl CLI", () => {
  it("prints help and rejects unknown commands", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "podiumctl-"));
    expect(ctl(home, "--help").stdout).toContain("Usage: podiumctl");
    expect(ctl(home, "bogus").status).toBe(2);
    fs.rmSync(home, { recursive: true });
  });

  it("stores config with mode 0600, hides the token, and reports stopped with exit 3", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "podiumctl-"));
    expect(ctl(home, "token").status).toBe(1);
    expect(ctl(home, "token", "--rotate").stdout.trim()).toMatch(/^[0-9a-f]{48}$/);
    const file = path.join(home, "config.env");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const shown = ctl(home, "config").stdout;
    expect(shown).not.toContain(fs.readFileSync(file, "utf8").split("PODIUM_TOKEN=")[1].trim());
    expect(ctl(home, "config", "set", "NOPE=1").status).toBe(1);
    expect(ctl(home, "config", "set", "PODIUMCTL_PORT=4410").status).toBe(0);
    const st = ctl(home, "status", "--mode", "standalone");
    expect(st.status).toBe(3);
    expect(st.stdout).toContain("4410");
    fs.rmSync(home, { recursive: true });
  });
});

describe("podiumctl covers every server setting (#157)", () => {
  // Read by the server but not a user setting: podiumctl sets it itself in the container (PODIUM_BUILD comes from the image build, #400).
  const SET_BY_PODIUMCTL = ["PODIUM_HOST_HOME", "HOST", "PORT", "PODIUM_BUILD"];
  const serverSrc = path.join(__dirname, "..", "server", "src");
  function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return sources(full);
      return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [full] : [];
    });
  }
  const readByServer = [...new Set(sources(serverSrc).flatMap((f) => {
    const text = fs.readFileSync(f, "utf8");
    return [...text.matchAll(/envMs\(env, '([A-Z_]+)'|\benv\.([A-Z][A-Z_]+)|process\.env\.([A-Z][A-Z_]+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  }))];

  it("finds the settings the server reads", () => {
    expect(readByServer).toEqual(expect.arrayContaining(["STALE_AFTER_MS", "DETACHED_HIDE_AFTER_MS", "PODIUM_LOG_LEVEL"]));
  });

  it("lets `config set` take every one, or names why it does not", () => {
    const settable = new Set<string>([...PASSTHROUGH, ...OWN_KEYS, ...SET_BY_PODIUMCTL]);
    expect(readByServer.filter((k) => !settable.has(k))).toEqual([]);
  });
});

describe("podiumctl build identity (#400)", () => {
  const hash = "a1b2c3d4";

  it("is a release, with no build, only at a clean vMAJOR.MINOR.PATCH tag", () => {
    expect(buildId({ hash, tag: "v1.1.0", dirty: false })).toBe("");
    expect(buildId({ hash, tag: "v12.0.31", dirty: false })).toBe("");
  });

  it("is the hash for any other commit, whatever the branch", () => {
    expect(buildId({ hash, tag: "", dirty: false })).toBe(hash);
    expect(buildId({ hash, tag: "v1.1.0-rc1", dirty: false })).toBe(hash);
    expect(buildId({ hash, tag: "latest", dirty: false })).toBe(hash);
  });

  it("marks local edits, even on a release tag", () => {
    expect(buildId({ hash, tag: "", dirty: true })).toBe(`${hash}-dirty`);
    expect(buildId({ hash, tag: "v1.1.0", dirty: true })).toBe(`${hash}-dirty`);
  });

  it("is empty when there is no git, so the footer shows the version alone", () => {
    expect(buildId({ hash: "", tag: "", dirty: false })).toBe("");
  });

  it("reads this checkout, and reads nothing outside a repository", () => {
    expect(gitBuild(path.join(__dirname, ".."))).toMatch(/^([0-9a-f]{8}(-dirty)?)?$/);
    expect(gitBuild(fs.mkdtempSync(path.join(os.tmpdir(), "podium-nogit-")))).toBe("");
  });

  it("is passed into the image by the Containerfile, after the layers that do not depend on it", () => {
    const text = fs.readFileSync(path.join(__dirname, "..", "Containerfile"), "utf8");
    expect(text).toMatch(/^ARG PODIUM_BUILD=$/m);
    expect(text).toMatch(/^ENV PODIUM_BUILD=\$PODIUM_BUILD$/m);
    expect(text.indexOf("ARG PODIUM_BUILD")).toBeGreaterThan(text.indexOf("COPY --from=build /app/frontend/dist"));
  });
});

describe("podiumctl built-in TLS (#580)", () => {
  const tlsDir = "/home/me/.podium/tls";
  const on = resolveConfig({ PODIUM_TLS: "on" }, {}, ["podman"]);

  it("is off unless --tls or PODIUM_TLS=on, and the HTTPS port defaults to 4318", () => {
    expect(resolveConfig({}, {}, ["podman"])).toMatchObject({ tls: false, tlsPort: 4318 });
    expect(resolveConfig({ PODIUM_TLS: "off" }).tls).toBe(false);
    expect(resolveConfig({ PODIUM_TLS: "on" }).tls).toBe(true);
    expect(resolveConfig({}, { tls: true }).tls).toBe(true);
    expect(resolveConfig({ PODIUM_TLS: "on", PODIUM_TLS_PORT: "8443" }).tlsPort).toBe(8443);
  });

  it("rejects a TLS value that is not on or off, a bad HTTPS port, and the HTTP port reused", () => {
    expect(() => resolveConfig({ PODIUM_TLS: "yes" })).toThrow(/PODIUM_TLS must be on or off/);
    expect(() => resolveConfig({ PODIUM_TLS_PORT: "0" })).toThrow(/HTTPS port/);
    expect(() => resolveConfig({ PODIUM_TLS: "on" }, { port: "4318" })).toThrow(/different/);
  });

  it("reads --tls=off as off, and a saved PODIUM_TLS=on loses to it", () => {
    expect(resolveConfig({ PODIUM_TLS: "on" }, { tls: "off" }).tls).toBe(false);
    expect(resolveConfig({}, { tls: "on" }).tls).toBe(true);
    expect(parseArgs(["start", "--tls=off"]).flags.tls).toBe("off");
  });

  it("saves --tls and --tls=off in config.env", () => withEngine("[]", (home, run) => {
    run("build", "--mode", "standalone", "--tls");
    expect(parseEnvFile(fs.readFileSync(path.join(home, "config.env"), "utf8")).PODIUM_TLS).toBe("on");
    run("build", "--mode", "standalone", "--tls=off");
    expect(parseEnvFile(fs.readFileSync(path.join(home, "config.env"), "utf8")).PODIUM_TLS).toBe("off");
  }));

  it("takes PODIUM_TLS and PODIUM_TLS_PORT with `config set`", () => {
    expect(OWN_KEYS).toEqual(expect.arrayContaining(["PODIUM_TLS", "PODIUM_TLS_PORT"]));
  });

  it("publishes the HTTPS port and mounts the TLS folder only with TLS on", () => {
    const off = containerRunArgs(resolveConfig({}, {}, ["podman"]), [], tlsDir);
    expect(off.join(" ")).not.toContain("4318");
    expect(off.join(" ")).not.toContain("/data/tls");
    const args = containerRunArgs(on, [], tlsDir);
    expect(args).toContain("127.0.0.1:4317:4317");
    expect(args).toContain("127.0.0.1:4318:4318");
    expect(args).toContain(`${tlsDir}:/data/tls:U`);
  });

  it("maps the host HTTPS port to the inner one, and uses no :U under docker", () => {
    const docker = resolveConfig({ PODIUM_TLS: "on", PODIUM_TLS_PORT: "8443" }, { bind: "0.0.0.0" }, ["docker"]);
    const args = containerRunArgs(docker, [], tlsDir);
    expect(args).toContain("0.0.0.0:8443:4318");
    expect(args).toContain(`${tlsDir}:/data/tls`);
    expect(serverEnv(docker, true)).toMatchObject({ PODIUM_TLS: "on", PODIUM_TLS_PORT: "4318" });
    expect(serverEnv(docker, false)).toMatchObject({ PODIUM_TLS: "on", PODIUM_TLS_PORT: "8443" });
    expect(serverEnv(resolveConfig({}), true)).not.toHaveProperty("PODIUM_TLS");
  });

  it("warns when a started container has no mount at /data/tls, and only then", () => {
    expect(tlsStorageWarning([{ Destination: "/data" }, { Destination: "/data/tls" }])).toBeNull();
    expect(tlsStorageWarning([{ Destination: "/data" }])).toMatch(/lose the CA/);
    expect(tlsStorageWarning([])).toMatch(/lose the CA/);
  });

  it("carries openssl and exposes both ports in the image", () => {
    const text = fs.readFileSync(path.join(__dirname, "..", "Containerfile"), "utf8");
    const runtime = text.slice(text.lastIndexOf("FROM "));
    expect(runtime).toMatch(/apt-get install[^\n]*\bopenssl\b/);
    expect(runtime).toMatch(/^EXPOSE 4317 4318$/m);
    expect(runtime.indexOf("openssl")).toBeLessThan(runtime.indexOf("USER node"));
  });

  it("documents --tls and the TLS folder in --help", () => {
    const r = ctl(fs.mkdtempSync(path.join(os.tmpdir(), "podiumctl-")), "--help");
    expect(r.stdout).toContain("--tls");
    expect(r.stdout).toContain("--purge-tls");
    expect(r.stdout).toContain("PODIUM_TLS_PORT");
  });

  // Stand-in engine: records its arguments, and `container inspect --format {{json .Mounts}}` answers with MOUNTS.
  function withEngine(mounts: string, fn: (home: string, run: (...a: string[]) => ReturnType<typeof spawnSync>) => void) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "podiumctl-"));
    try {
      const bin = path.join(home, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "podman"), `#!/bin/sh
echo "$@" >> "${home}/calls"
case "$1" in
  --version|info|rm|rmi|volume) exit 0 ;;
  image) exit 0 ;;
  container) case "$*" in *Mounts*) echo '${mounts}'; exit 0 ;; *) echo "running healthy"; exit 0 ;; esac ;;
  run) exit 0 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
      fn(home, (...a) => spawnSync(process.execPath, [BIN, ...a], { encoding: "utf8", env: { ...process.env, PODIUMCTL_HOME: home, PATH: bin } }));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  it("rm says the CA is kept, and keeps the folder, unless --purge-tls --yes", () => withEngine("[]", (home, run) => {
    fs.mkdirSync(path.join(home, "tls"));
    fs.writeFileSync(path.join(home, "tls", "ca.crt"), "x");
    const kept = run("rm", "--mode", "container", "--engine", "podman");
    expect(kept.status).toBe(0);
    expect(kept.stdout).toContain(`${path.join(home, "tls")} is kept`);
    expect(fs.existsSync(path.join(home, "tls", "ca.crt"))).toBe(true);
    const refused = run("rm", "--mode", "container", "--engine", "podman", "--purge-tls");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("--purge-tls --yes");
    expect(fs.existsSync(path.join(home, "tls", "ca.crt"))).toBe(true);
    const purged = run("rm", "--mode", "container", "--engine", "podman", "--purge-tls", "--yes");
    expect(purged.status).toBe(0);
    expect(purged.stdout).toContain("every reporter config must be reissued");
    expect(fs.existsSync(path.join(home, "tls"))).toBe(false);
  }));

  it("rm --purge says the database goes but the CA stays", () => withEngine("[]", (home, run) => {
    fs.mkdirSync(path.join(home, "tls"));
    const r = run("rm", "--mode", "container", "--engine", "podman", "--purge", "--yes");
    expect(r.stdout).toContain("deletes the database");
    expect(r.stdout).toContain("is kept");
    expect(fs.existsSync(path.join(home, "tls"))).toBe(true);
  }));

  it("rm says nothing about a TLS folder that does not exist", () => withEngine("[]", (_home, run) => {
    expect(run("rm", "--mode", "container", "--engine", "podman").stdout).not.toContain("tls");
  }));

  it("rm --purge-tls --yes names `unshare` when the folder cannot be deleted, instead of a stack trace", () => withEngine("[]", (home, run) => {
    fs.mkdirSync(path.join(home, "tls"));
    fs.chmodSync(home, 0o500); // the parent is read-only, so the folder cannot be removed from it
    try {
      const r = run("rm", "--mode", "container", "--engine", "podman", "--purge-tls", "--yes");
      if (process.getuid?.() === 0) return; // root deletes it anyway
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("podman unshare rm -rf");
      expect(r.stderr).not.toContain("at ");
    } finally {
      fs.chmodSync(home, 0o700);
    }
  }));
});
