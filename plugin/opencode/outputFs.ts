// The Node file system as `readTail` (core/background.ts) takes it (#897). The Claude Code mod reaches files through the host's `$.fs` instead; the
// rules about which file may be read are core's, so they are the same for both.
import { lstat, open, readFile, realpath, stat } from 'node:fs/promises';
import type { OutputFs, OutputStat } from '../core/background.ts';

export const nodeOutputFs: OutputFs = {
  async stat(path: string, options?: { resolve?: boolean }): Promise<OutputStat> {
    const own = await lstat(path);
    // A link is followed for what it leads to; one that leads nowhere is `other`, as the host's `$.fs.stat` says.
    const target = own.isSymbolicLink() ? await stat(path).catch(() => null) : own;
    const kind = target?.isFile() ? 'file' : target?.isDirectory() ? 'dir' : 'other';
    const real = options?.resolve && target ? await realpath(path) : undefined;
    return { kind, size: target?.size ?? 0, mtimeMs: target?.mtimeMs ?? 0, isLink: own.isSymbolicLink(), ...(real ? { realPath: real } : {}) };
  },
  read: (path: string) => readFile(path, 'utf8'),
  async tail(path: string, bytes: number): Promise<string> {
    const handle = await open(path, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, bytes);
      const buf = Buffer.alloc(length);
      if (length > 0) await handle.read(buf, 0, length, size - length);
      return buf.toString('utf8');
    } finally {
      await handle.close();
    }
  },
};
