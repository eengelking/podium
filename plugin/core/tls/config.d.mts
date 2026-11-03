// Types for config.mjs, so TypeScript can import it. (NodeNext looks for `config.d.mts` beside `config.mjs`.)
import type { Agent } from 'node:https';

/** An error with a code the helper prints as `error <CODE> <why>`. */
export class StartError extends Error {
  code: string;
  constructor(code: string, message: string);
}
export interface ParsedConfig {
  ca: string[];
  cert: string;
  key: string;
  user: string;
  notAfter: number;
  notBefore: number;
}
export interface LoadedConfig extends ParsedConfig {
  mtimeMs: number;
}
/** The name in the file's `# user: Name` line, or ''. */
export function headerUser(text: string): string;
/** The CA certificates, the person's certificate and the key, by block type and role, never by position. */
export function parseConfig(text: string): ParsedConfig;
/** Reads the file, refusing one that group or others can read. Throws a StartError. */
export function readConfig(file: string): LoadedConfig;
/** One keep-alive agent per config; verification is forced on. */
export function agentFor(cfg: Pick<ParsedConfig, 'ca' | 'cert' | 'key'>): Agent;
