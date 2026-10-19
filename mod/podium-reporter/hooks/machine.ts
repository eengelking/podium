// Which machine a session runs on (issue #34). Pure: the mod passes in what `hostname` printed and a
// random source. The id is random and kept in one file under the Claude config directory (and in the
// mod's own store as a fallback), so two machines that share a host name stay apart, two loads of the
// mod on one machine agree, and nothing about the hardware is read.
import type { MachineInfo } from './protocol.ts';
import { oneLine } from './peers.ts';

/** The `$.store` key the machine id is kept under. */
export const MACHINE_ID_KEY = 'machineId';
const HOST_MAX = 64;

/** The short host name from `hostname` output: the first line, up to the first dot (`Eds-MBP.local` is `Eds-MBP`). Null when empty. */
export function hostOf(stdout: string | null | undefined): string | null {
  const line = (stdout ?? '').split(/\r?\n/)[0] ?? '';
  // eslint-disable-next-line no-control-regex
  const host = line.replace(/[\u0000-\u001f\u007f]/g, '').trim().split('.')[0]!.trim();
  return host ? host.slice(0, HOST_MAX) : null;
}

/** `s` without the `/` characters at its end. A loop, not `/\/+$/`, which is quadratic on a long run of slashes (#362). */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}

/** A stored id this reporter made: 8 to 32 lowercase hex characters. */
export function isMachineId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8,32}$/.test(v);
}

/** The file name the machine id is shared under, in the Claude config directory (#267). */
export const MACHINE_ID_FILE = 'podium-machine-id';

/**
 * Where the shared machine id file lives: `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. Null when
 * neither is known, in which case the id stays in the mod's store alone.
 */
export function machineIdPath(configDir: string | undefined, home: string | undefined): string | null {
  const trim = (p: string | undefined) => trimTrailingSlashes((p ?? '').trim());
  const dir = trim(configDir) || (trim(home) ? `${trim(home)}/.claude` : '');
  // A relative directory would land under each session's own working directory, so loads would disagree.
  return /^(\/|[A-Za-z]:[\\/])/.test(dir) ? `${dir}/${MACHINE_ID_FILE}` : null;
}

/** The id the shared file holds: its one line, when that is an id this reporter made. Null otherwise. */
export function parseMachineIdFile(text: string | null | undefined): string | null {
  const id = (text ?? '').trim();
  return isMachineId(id) ? id : null;
}

/** A new random id of 12 hex characters. */
export function newMachineId(random: () => number): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += Math.floor(random() * 16).toString(16);
  return s;
}

/** The machine as the report carries it; a host with no name is labelled by its id. The OS is left out when it could not be read (#414). */
export function machineInfo(host: string | null, id: string, os: string | null = null): MachineInfo {
  return { name: host ?? `machine-${id.slice(0, 4)}`, id, ...(os ? { os } : {}) };
}

// ---- The OS (#347, #414, SPEC 5.3 "The OS") -----------------------------------------------------
// The mods API has no call for it, so the mod runs a command and takes the first that works.

/** The longest OS string a report carries (PEER_LIMITS.os). */
export const OS_MAX = 80;

/** One line of free text, without control characters, cut to 80. Null when nothing is left. */
export function cleanOs(v: string | null | undefined): string | null {
  return oneLine(v, OS_MAX) || null;
}

/** `sw_vers` on macOS: `ProductName` and `ProductVersion`, as `macOS 27.0.1`. Null without the name. */
export function osFromSwVers(stdout: string | null | undefined): string | null {
  const field = (key: string) => new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(stdout ?? '')?.[1]?.trim() ?? '';
  const name = field('ProductName');
  return name ? cleanOs(`${name} ${field('ProductVersion')}`) : null;
}

/** `/etc/os-release` on Linux: its `PRETTY_NAME`, quotes taken off. */
export function osFromOsRelease(text: string | null | undefined): string | null {
  const raw = /^PRETTY_NAME=(.*)$/m.exec(text ?? '')?.[1]?.trim() ?? '';
  return cleanOs(raw.replace(/^(["'])(.*)\1$/, '$2'));
}

/** `cmd /c ver` on Windows: its one non-empty line, such as `Microsoft Windows [Version 10.0.26100.1]`. */
export function osFromVer(stdout: string | null | undefined): string | null {
  return cleanOs((stdout ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '');
}
