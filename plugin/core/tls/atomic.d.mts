// Types for atomic.mjs, so TypeScript can import it. (NodeNext looks for `atomic.d.mts` beside `atomic.mjs`.)
export interface RenewedConfig {
  ca: readonly string[];
  cert: string;
  key: string;
  notAfter: string;
  fingerprint: string;
  now: number;
}
/** The config file after a renewal: the header lines updated, then the CA certificate(s), the new certificate and the new key. */
export function rewriteConfig(text: string, n: RenewedConfig): string;
/** Writes `text` to `file` through a temporary file and a rename at mode 0600; a symlinked destination is followed. */
export function writeAtomic(file: string, text: string): void;
