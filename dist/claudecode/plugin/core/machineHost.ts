// The machine's name and OS, read the same way by every reporter (#967), so one machine id never shows two names or two OS strings
// (the drift #715 fixed for Claude Code). Pure: the caller passes what it can read, write and run.
import { hostOf, localHostNameOf, osFromOsRelease, osFromSwVers, osFromVer, SHARED_MACHINE_NAME_FILE, sharedPodiumDir } from './machine.ts';

/** What a reporter lets the reader do. Every call may reject or return null; the reader treats both as "not there". */
export interface HostIO {
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  /** Runs a command and returns its stdout, or null when it exits non-zero. A missing executable rejects. */
  run(argv: string[]): Promise<string | null>;
}

const attempt = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

/**
 * The machine's short host name, pinned (#715, #967). The pin is `~/.podium/machine-name`, shared by every reporter, with the
 * Claude Code reporter's own `podium-machine-name` as the fallback, so an install keeps the name it already reported. With no pin the
 * live name is read (macOS `scutil LocalHostName` first, which does not follow the network, then `hostname`), pinned in the shared
 * file and in each extra path, and reported. Delete the pin to take a new name. `ownFirst` reads the caller's own pin first, which the Claude
 * Code reporter sets so a name it already reported is never changed by another reporter's pin (the order of its machine id).
 */
export async function pinnedMachineName(io: HostIO, home: string | undefined, fallbackPath: string | null, opts: { ownFirst?: boolean } = {}): Promise<string | null> {
  const dir = sharedPodiumDir(home);
  const sharedPath = dir ? `${dir}/${SHARED_MACHINE_NAME_FILE}` : null;
  const pinned = async () => {
    for (const p of opts.ownFirst ? [fallbackPath, sharedPath] : [sharedPath, fallbackPath]) {
      const name = p ? hostOf(await attempt(() => io.read(p), null)) : null;
      if (name) return name;
    }
    return null;
  };
  const found = await pinned();
  if (found) {
    // An install that pinned its name before the shared file existed shares it now.
    if (sharedPath && found !== hostOf(await attempt(() => io.read(sharedPath), null))) await attempt(() => io.write(sharedPath, `${found}\n`), undefined);
    return found;
  }
  const live =
    (await attempt(async () => localHostNameOf(await io.run(['scutil', '--get', 'LocalHostName'])), null)) ??
    (await attempt(async () => hostOf(await io.run(['hostname'])), null));
  if (!live) return null;
  for (const p of [sharedPath, fallbackPath]) if (p) await attempt(() => io.write(p, `${live}\n`), undefined);
  // Two loads starting together both write; each reports whichever name the file ended with.
  return (await pinned()) ?? live;
}

/** The machine's OS and version: the first of `sw_vers` (macOS), `/etc/os-release` (Linux) and `cmd /c ver` (Windows) that works. */
export async function readOsName(io: HostIO): Promise<string | null> {
  return (
    (await attempt(async () => osFromSwVers(await io.run(['sw_vers'])), null)) ??
    (await attempt(async () => osFromOsRelease(await io.read('/etc/os-release')), null)) ??
    (await attempt(async () => osFromVer(await io.run(['cmd', '/c', 'ver'])), null))
  );
}
