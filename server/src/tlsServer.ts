// Built-in TLS (#577, T3): the HTTPS listener beside the HTTP one. The same express app serves both, so the routes and the
// Host check (DECISIONS 33) are the same. Any failure to make or read the CA is logged and leaves HTTP working.
import https from 'node:https';
import type { RequestListener } from 'node:http';
import type { Logger } from './logging/logger.js';
import { ensureTls, serverNames, type TlsMaterial } from './tlsCa.js';
import { ServingRenewer, SERVING_DEFAULTS, type ServingSettings } from './tlsRenew.js';
import { tlsDir } from './tlsStorage.js';

export const DEFAULT_TLS_PORT = 4318;

export interface StartTlsOptions {
  env: NodeJS.ProcessEnv;
  app: RequestListener;
  dbPath: string;
  bind: string;
  httpPort: number;
  allowedHosts: string[];
  logger: Logger;
  openssl?: string;
  /** The Admin's serving-certificate settings, read each time they are needed. */
  settings?: () => ServingSettings;
  now?: () => number;
  /** How often the renewal check runs; a day unless a test says otherwise. */
  checkEveryMs?: number;
}

export interface TlsListener {
  server: https.Server;
  port: number;
  material: TlsMaterial;
  renewer: ServingRenewer;
}

/** The HTTPS port from `PODIUM_TLS_PORT`, or an error that names what is wrong with it. */
export function tlsPortFrom(raw: string | undefined, httpPort: number): { port: number } | { error: string } {
  const port = raw === undefined || raw === '' ? DEFAULT_TLS_PORT : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `PODIUM_TLS_PORT "${raw}" is not a port` };
  if (port === httpPort) return { error: `PODIUM_TLS_PORT is ${port}, the same as the HTTP port` };
  return { port };
}

/** Starts HTTPS when `PODIUM_TLS=on`. Resolves to null when it is off or could not start; HTTP is never touched. */
export async function startTls(o: StartTlsOptions): Promise<TlsListener | null> {
  if (o.env.PODIUM_TLS !== 'on') return null;
  const p = tlsPortFrom(o.env.PODIUM_TLS_PORT, o.httpPort);
  if ('error' in p) {
    o.logger.error('tls.failed', `podium: TLS is not started: ${p.error}; HTTP keeps working`, { reason: p.error });
    return null;
  }
  const dir = tlsDir(o.dbPath);
  const settings = o.settings ?? (() => SERVING_DEFAULTS);
  const names = serverNames(o.bind, o.allowedHosts);
  let material: TlsMaterial;
  try {
    material = await ensureTls({ dir, names, servingDays: settings().lifetimeDays, openssl: o.openssl });
  } catch (err) {
    const reason = (err as Error).message;
    o.logger.error('tls.failed', `podium: TLS is not started: ${reason}; HTTP keeps working`, { dir, reason });
    return null;
  }
  if (material.createdCa) {
    o.logger.info('tls.ca_created', `podium: made a CA in ${dir}; back the folder up and keep it private (it holds the CA key)`, { dir, fingerprint_sha256: material.ca.fingerprintSha256, not_after: material.ca.notAfter });
  }
  if (material.createdServing) {
    o.logger.info('tls.serving_created', 'podium: made a serving certificate', { fingerprint_sha256: material.serving.fingerprintSha256, not_after: material.serving.notAfter });
  }
  const server = https.createServer({ cert: material.cert, key: material.key, minVersion: 'TLSv1.2' }, o.app);
  const renewer = new ServingRenewer({ dir, names, server, serving: material.serving, settings, logger: o.logger, openssl: o.openssl, now: o.now, checkEveryMs: o.checkEveryMs }, material.cert);
  // Renew at start if it is due, before the first connection is accepted; a failure is logged and the current certificate serves.
  await renewer.start();
  server.once('close', () => renewer.stop());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(p.port, o.bind, () => {
        server.off('error', reject); // a later error must not be swallowed by a settled promise's reject
        resolve();
      });
    });
  } catch (err) {
    const reason = (err as Error).message;
    o.logger.error('tls.failed', `podium: HTTPS could not listen on port ${p.port}: ${reason}; HTTP keeps working`, { port: p.port, reason });
    renewer.stop();
    return null;
  }
  // Without a handler a later socket-level error would be an uncaught exception that takes HTTP down with it.
  server.on('error', (err) => o.logger.error('tls.server_error', `podium: the HTTPS server reported an error: ${err.message}`, { reason: err.message }));
  server.on('tlsClientError', (err) => o.logger.warn('tls.handshake_failed', `podium: a TLS handshake failed: ${err.message}`, { reason: err.message }));
  const serving = renewer.view().serving;
  o.logger.info('tls.listening', `Podium HTTPS listening on https://${o.bind}:${p.port}`, {
    bind: o.bind,
    port: p.port,
    ca_fingerprint_sha256: material.ca.fingerprintSha256,
    ca_not_before: material.ca.notBefore,
    ca_not_after: material.ca.notAfter,
    serving_fingerprint_sha256: serving.fingerprintSha256,
    serving_not_after: serving.notAfter,
  });
  return { server, port: p.port, material, renewer };
}
