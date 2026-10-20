// One way to write a size in a sentence, for the Admin log (#432): `512 B`, `2.0 KB`, `1.8 MB`, `3.2 GB`, `1.0 TB`.
const UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/** A byte count as words: whole bytes below 1 KB, otherwise one decimal in the largest unit that keeps it under 1024. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${UNITS[i]}`;
}
