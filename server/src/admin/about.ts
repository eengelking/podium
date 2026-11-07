// Admin > About (#862): what the server and its reporters are running. Everything here is read from the server itself or from what
// reporters have already sent; nothing is collected from a machine for it. The console adds the versions of React and TypeScript it
// was built with, which only its own bundle knows.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import type { FleetStoreApi, ReporterStoreApi } from '../storage/types.js';
import type { ReporterCompat, ReporterSupport } from '../fleet/protocol.js';
import { IDLE_MS } from '../storage/rows.js';
import { canonicalReporterName } from '../fleet/reporterNames.js';
import { checkReporter, serverVersion, supportFor } from '../fleet/compat.js';
import { parseBuild } from '../fleet/parseBuild.js';

export type Runtime = 'container' | 'standalone';

export interface AboutReporter {
  reporterName: string;
  version: string;
  machines: number;
  compat: ReporterCompat;
  /** The versions this server reads for that reporter; null when it has no range for it. */
  support: ReporterSupport | null;
}

export interface AboutView {
  server: { version: string; build: string | null; runtime: Runtime; startedAt: number; system: string };
  stack: { node: string; express: string };
  database: { engine: string; version: string; schemaVersion: number; sizeBytes: number | null };
  reporters: AboutReporter[];
  serverTime: number;
}

/** Container when the image says so (`PODIUM_RUNTIME=container`) or the engine left its marker file; stand-alone otherwise. */
export function runtimeOf(env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): Runtime {
  if (env.PODIUM_RUNTIME === 'container') return 'container';
  return exists('/run/.containerenv') || exists('/.dockerenv') ? 'container' : 'standalone';
}

let expressVersion: string | null = null;
/** The installed Express's own version, read from its package (the same from src/ and dist/). */
function expressVersionOf(): string {
  if (expressVersion) return expressVersion;
  try {
    expressVersion = (createRequire(import.meta.url)('express/package.json') as { version?: string }).version ?? 'unknown';
  } catch {
    expressVersion = 'unknown';
  }
  return expressVersion;
}

/** Newest first, comparing the numbers: 1.10.0 is newer than 1.9.0. A part that is not a number counts as 0. */
function newestFirst(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return a < b ? 1 : a > b ? -1 : 0;
}

export async function buildAbout(a: { fleet: Pick<FleetStoreApi, 'engineInfo'>; reporters: Pick<ReporterStoreApi, 'versionCounts'>; now: number; env: NodeJS.ProcessEnv; uptimeMs: number }): Promise<AboutView> {
  const [info, counts] = await Promise.all([a.fleet.engineInfo(), a.reporters.versionCounts(a.now - IDLE_MS)]);
  // A row kept from before the rename holds the legacy name, so both names are one reporter here.
  const merged = new Map<string, AboutReporter>();
  for (const c of counts) {
    const reporterName = canonicalReporterName(c.reporterName);
    const k = `${reporterName}\u0000${c.version}`;
    const have = merged.get(k);
    if (have) have.machines += c.machines;
    else merged.set(k, { reporterName, version: c.version, machines: c.machines, compat: checkReporter(c.version, reporterName), support: supportFor(reporterName) });
  }
  const reporters = [...merged.values()].sort((x, y) => (x.reporterName < y.reporterName ? -1 : x.reporterName > y.reporterName ? 1 : newestFirst(x.version, y.version)));
  return {
    server: { version: serverVersion(), build: parseBuild(a.env.PODIUM_BUILD), runtime: runtimeOf(a.env), startedAt: a.now - Math.round(a.uptimeMs), system: `${process.platform} ${process.arch}` },
    stack: { node: process.versions.node, express: expressVersionOf() },
    database: { engine: info.engine, version: info.version, schemaVersion: info.schemaVersion, sizeBytes: info.sizeBytes },
    reporters,
    serverTime: a.now,
  };
}
