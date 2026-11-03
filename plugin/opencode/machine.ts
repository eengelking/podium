// This machine as the report names it (#856): the id every reporter on it shares, kept in `~/.podium/machine-id`.
// An id a Claude install already made is taken over, so that install keeps its row; the Claude Code reporter's id always wins (#967).
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { chooseSharedMachineId, machineIdPath, machineInfo, machineNamePath, newMachineId, parseMachineIdFile, platformRandom, sharedMachineIdPath, type RandomSource } from '../core/machine.ts';
import { pinnedMachineName, readOsName, type HostIO } from '../core/machineHost.ts';
import type { MachineInfo } from '../core/protocol.ts';
import { settingsPath, tooOpen } from '../core/settings.ts';

const read = (p: string | null): string | null => {
  try { return p ? readFileSync(p, 'utf8') : null; } catch { return null; }
};

/** The shared id: read it, else take a Claude install's, else make one; then write it back (0600 file, 0700 folder). */
export function sharedMachineId(home: string = homedir(), claudeConfigDir: string | undefined = process.env.CLAUDE_CONFIG_DIR): string {
  const path = sharedMachineIdPath(home);
  const shared = parseMachineIdFile(read(path));
  const found = chooseSharedMachineId({ shared, legacyFile: parseMachineIdFile(read(machineIdPath(claudeConfigDir, home))) });
  const id = found ?? newMachineId(() => platformRandom(globalThis.crypto as RandomSource));
  if (!path || id === shared) return id;
  try {
    mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o700 });
    // Create-exclusive: when another reporter wrote first, its id stands and is the one read back.
    writeFileSync(path, `${id}\n`, { mode: 0o600, flag: 'wx' });
  } catch { /* Either another reporter wrote first, or the file cannot be used and the id holds for this load. */ }
  return parseMachineIdFile(read(path)) ?? id;
}

/** The files and processes the shared name and OS readers use here (`core/machineHost.ts`); a missing file or executable rejects. */
const hostIO: HostIO = {
  read: async (p) => readFileSync(p, 'utf8'),
  write: async (p, text) => {
    // Only the shared `~/.podium` folder is made here; the Claude Code reporter's own file is written only where that folder already exists.
    const dir = p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));
    if (dir.endsWith('/.podium')) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(p, text, { mode: 0o600 });
  },
  run: (argv) =>
    new Promise((resolve, reject) => {
      execFile(argv[0]!, argv.slice(1), { timeout: 2000, maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err && (err as { code?: unknown }).code === 'ENOENT') reject(err);
        else resolve(err ? null : String(stdout ?? ''));
      });
    }),
};

/**
 * This machine, or null when no user name is set: an unnamed reporter sends nothing that identifies the machine. The name and the OS
 * are read the way the Claude Code reporter reads them (#967), so one machine id never shows two names.
 */
export async function readMachine(userName: string | null, home: string = homedir(), claudeConfigDir: string | undefined = process.env.CLAUDE_CONFIG_DIR): Promise<MachineInfo | null> {
  if (!userName?.trim()) return null;
  const [host, os] = await Promise.all([pinnedMachineName(hostIO, home, machineNamePath(claudeConfigDir, home)), readOsName(hostIO)]);
  return machineInfo(host, sharedMachineId(home, claudeConfigDir), os);
}

/** The text of `~/.podium/config.env` and whether its permissions let anyone but the owner read it. */
export function readSettingsFile(home: string = homedir()): { text: string | null; open: boolean } {
  const path = settingsPath(home);
  if (!path) return { text: null, open: false };
  try { return { text: readFileSync(path, 'utf8'), open: tooOpen(statSync(path).mode) }; } catch { return { text: null, open: false }; }
}
