// Built-in TLS (#577, T3): the reporter listener beside the HTTP one. It is mutual TLS only (#665): a client without a valid
// certificate is dropped in the handshake, and only the reporter routes and the renewal route reach the express app, so the
// Host check (DECISIONS 33) is the same as on HTTP. Any failure to make or read the CA is logged and leaves HTTP working.
import { X509Certificate } from 'node:crypto';
import https from 'node:https';
import type { RequestListener } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { Logger } from './logging/logger.js';
import { ensureTls, serverNames, type CertInfo, type TlsMaterial } from './tlsCa.js';
import { isRenewRoute, isReporterRoute } from './tlsHttp.js';
import { ServingRenewer, SERVING_DEFAULTS, type ServingSettings } from './tlsRenew.js';
import { caCanOverlap, retireCa, rotateCa, TrustStore } from './tlsRotation.js';
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

/** Rotating and retiring the CA of a running listener (#588). */
export interface CaRotation {
  /** False for a CA made with `pathlen:0` (before #588), which a planned rotation refuses; only the hard cutover works for it (#638). */
  canOverlap(): boolean;
  /** A planned rotation keeps the old CA trusted for an overlap; `endOverlap` is the hard cutover. Closes the connections that held a client certificate when the overlap ends at once. */
  rotate(endOverlap: boolean): Promise<{ ca: CertInfo; serving: CertInfo; overlap: boolean; closed: number }>;
  /** Ends an overlap: the old CA is no longer trusted and connections that came in on its certificates are closed. Returns how many, or null when there is no overlap. */
  retire(): Promise<{ closed: number } | null>;
}

export interface TlsListener {
  server: https.Server;
  port: number;
  material: TlsMaterial;
  renewer: ServingRenewer;
  /** The CAs this listener trusts, the one source for the listener, the renewer and the certificate check (#588). */
  trust: TrustStore;
  rotation: CaRotation;
}

const isPort = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65535;

/** The HTTPS port from `PODIUM_TLS_PORT`, or an error that names what is wrong with it. */
export function tlsPortFrom(raw: string | undefined, httpPort: number): { port: number } | { error: string } {
  const port = raw === undefined || raw === '' ? DEFAULT_TLS_PORT : Number(raw);
  if (!isPort(port)) return { error: `PODIUM_TLS_PORT "${raw}" is not a port` };
  if (port === httpPort) return { error: `PODIUM_TLS_PORT is ${port}, the same as the HTTP port` };
  return { port };
}

/**
 * The HTTPS port people reach the server on, which a reporter config names. It differs from the listening port when the
 * port is mapped, as `podiumctl` does for a container (`PODIUM_TLS_PUBLIC_PORT`); a value that is not a port is ignored.
 */
export function publicTlsPort(raw: string | undefined, listenPort: number): number {
  const port = raw === undefined || raw === '' ? listenPort : Number(raw);
  return isPort(port) ? port : listenPort;
}

/** The app, but only for the calls a reporter makes and its certificate renewal; any other path is refused as if it were not there. */
function reporterPortOnly(app: RequestListener): RequestListener {
  return (req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (isReporterRoute(req.method ?? '', path) || (req.method === 'POST' && isRenewRoute(path))) return app(req, res);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"ok":false,"error":"not served on the reporter port"}');
  };
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
  // This port is for `podium-reporter` only (#665): a client certificate is required and checked in the handshake, so a
  // connection without a valid one never reaches a route. `ca` is what makes it mean "signed by Podium": without it Node
  // verifies against the public roots (#583). The console is plain HTTP on the other port.
  const trust = new TrustStore(dir, o.now);
  const server = https.createServer({ cert: trust.chain(material.cert), key: material.key, ca: trust.caCerts(), requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' }, reporterPortOnly(o.app));
  const renewer = new ServingRenewer({ dir, names, server, serving: material.serving, settings, logger: o.logger, openssl: o.openssl, now: o.now, checkEveryMs: o.checkEveryMs, trust, key: material.key }, material.cert);
  // Renew at start if it is due, before the first connection is accepted; a failure is logged and the current certificate serves.
  await renewer.start();
  server.once('close', () => renewer.stop());
  // Narrowing the client `ca` list does not drop a keep-alive connection that is already authorized, so the open ones are kept to be closed (#588).
  const open = new Set<TLSSocket>();
  server.on('secureConnection', (socket) => {
    open.add(socket);
    socket.once('close', () => open.delete(socket));
  });
  /** Destroys the connections that presented a client certificate (and, with `issuedBy`, only those it signed). */
  const closeClientConnections = (issuedBy?: string): number => {
    const key = issuedBy ? new X509Certificate(issuedBy).publicKey : null;
    let n = 0;
    for (const socket of open) {
      const raw = socket.getPeerCertificate().raw;
      if (!raw) continue;
      if (key) {
        try {
          if (!new X509Certificate(raw).verify(key)) continue;
        } catch {
          continue;
        }
      }
      socket.destroy();
      n++;
    }
    return n;
  };
  const rotation: CaRotation = {
    canOverlap: () => caCanOverlap(dir, o.openssl),
    rotate: (endOverlap) =>
      renewer.exclusive(async () => {
        const out = await rotateCa({ dir, names, servingDays: settings().lifetimeDays, endOverlap, openssl: o.openssl, now: o.now });
        trust.reload();
        renewer.adopt(out);
        // A hard cutover refuses everything the old CA signed, and an open connection stays authorized until it is closed.
        const closed = endOverlap ? closeClientConnections() : 0;
        o.logger.info('tls.ca_rotated', `podium: rotated the CA${endOverlap ? ' and ended the overlap; every reporter needs a reissued config' : '; the old CA stays trusted until it is retired'}`, { overlap: out.overlap, connections_closed: closed, ca_fingerprint_sha256: out.ca.fingerprintSha256, ca_not_after: out.ca.notAfter });
        return { ca: out.ca, serving: out.serving, overlap: out.overlap, closed };
      }),
    // Behind the same queue as a rotation or a serving renewal, which replace the same files.
    retire: () =>
      renewer.exclusive(async () => {
        const previous = trust.previousCa();
        if (!previous) return null;
        retireCa(dir);
        trust.reload();
        renewer.reapply();
        const closed = closeClientConnections(previous);
        o.logger.info('tls.ca_retired', 'podium: retired the old CA', { connections_closed: closed });
        return { closed };
      }),
  };
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
  return { server, port: p.port, material, renewer, trust, rotation };
}
