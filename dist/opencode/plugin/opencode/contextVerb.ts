// `/podium context ...` for the OpenCode reporter (#606, #999): the contexts file is read and written on disk. A file that is not there
// reads as null, the folder is made when it is missing, and a write goes through a temporary file and a rename, as Claude Code's does.
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { contextCommand, type ContextIO } from '../core/tls/contexts.ts';
import { writeAtomic } from '../core/tls/atomic.mjs';

const io: ContextIO = {
  read: (path) => readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : Promise.reject(err))),
  write: async (path, text) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeAtomic(path, text);
  },
};

/** Runs one `/podium context` command; every failure is a line of text, never a throw. An empty `home` is said plainly. */
export async function runContext(args: string, home: string, fromEnv: string | undefined): Promise<string> {
  if (!home) return 'Podium: cannot find your home folder (HOME, USERPROFILE and the operating system have none), so contexts cannot be read or changed.';
  try {
    return await contextCommand(io, home, args, fromEnv);
  } catch (err) {
    return `Podium: the context command failed (${err instanceof Error ? err.message : String(err)}).`;
  }
}
