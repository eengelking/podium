// This machine as the report names it (#856): the id every reporter on it shares, kept in `~/.podium/machine-id`.
// An id a Claude install already made is taken over, so that install keeps its row.
import { hostname, homedir, type, release } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { chooseMachineId, hostOf, machineIdPath, machineInfo, newMachineId, parseMachineIdFile, platformRandom, sharedMachineIdPath, type RandomSource } from '../core/machine.ts';
import type { MachineInfo } from '../core/protocol.ts';
import { settingsPath, tooOpen } from '../core/settings.ts';

const read = (p: string | null): string | null => {
  try { return p ? readFileSync(p, 'utf8') : null; } catch { return null; }
};

/** The shared id: read it, else take a Claude install's, else make one; then write it back (0600 file, 0700 folder). */
export function sharedMachineId(home: string = homedir(), claudeConfigDir: string | undefined = process.env.CLAUDE_CONFIG_DIR): string {
  const path = sharedMachineIdPath(home);
  const shared = parseMachineIdFile(read(path));
  const found = chooseMachineId({ shared, legacyFile: parseMachineIdFile(read(machineIdPath(claudeConfigDir, home))) });
  const id = found ?? newMachineId(() => platformRandom(globalThis.crypto as RandomSource));
  if (!path || id === shared) return id;
  try {
    mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o700 });
    // Create-exclusive: when another reporter wrote first, its id stands and is the one read back.
    writeFileSync(path, `${id}\n`, { mode: 0o600, flag: 'wx' });
  } catch { /* Either another reporter wrote first, or the file cannot be used and the id holds for this load. */ }
  return parseMachineIdFile(read(path)) ?? id;
}

/** This machine, or null when no user name is set: an unnamed reporter sends nothing that identifies the machine. */
export function readMachine(userName: string | null, home: string = homedir()): MachineInfo | null {
  if (!userName?.trim()) return null;
  return machineInfo(hostOf(hostname()), sharedMachineId(home), `${type()} ${release()}`.trim() || null);
}

/** The text of `~/.podium/config.env` and whether its permissions let anyone but the owner read it. */
export function readSettingsFile(home: string = homedir()): { text: string | null; open: boolean } {
  const path = settingsPath(home);
  if (!path) return { text: null, open: false };
  try { return { text: readFileSync(path, 'utf8'), open: tooOpen(statSync(path).mode) }; } catch { return { text: null, open: false }; }
}
