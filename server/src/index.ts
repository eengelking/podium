import { config as loadEnv } from "dotenv";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");
// quiet: dotenv 17 and later print an "injected env" line at startup, which the logger's text output pins (#11).
loadEnv({ path: path.join(REPO_ROOT, ".env"), quiet: true });

import fs from "node:fs";
import express from "express";
import { createRouter } from "./routes.js";
import { dataDir, openStorage, storageSpec } from "./storage/index.js";
import { configFromEnv, Fleet } from "./fleet/fleet.js";
import { createFleetRouter } from "./fleet/routes.js";
import { reportDepsOf } from "./fleet/reportDeps.js";
import { createAdminRouter } from "./admin/adminRouter.js";
import { Lockout } from "./fleet/lockout.js";
import { failureLimiter, pageLimiter, parseFailureLimit } from "./failureLimiter.js";
import { createRespondBridge } from "./fleet/respondBridge.js";
import { forgetReporters, purgeStored, startSweeper } from "./fleet/sweeper.js";
import { REPORTER_SUPPORT } from "./fleet/compat.js";
import { createServerLogging } from "./logging/setup.js";
import { requestLog } from "./logging/requestLog.js";
import { inlineScriptHashes, securityHeaders } from "./securityHeaders.js";
import { hostCheck, parseAllowedHosts } from "./hostCheck.js";
import { createPlainHttpWatch } from "./plainHttp.js";
import { parseTrustProxy } from "./trustProxy.js";
import { tlsDir, warnIfTlsNotPersistent } from "./tlsStorage.js";
import { createReporterRenewRouter } from "./tlsReporterRenew.js";
import { publicTlsPort, startTls } from "./tlsServer.js";
import { TlsBoot } from "./tlsBoot.js";
import { LiveTlsSettings } from "./tlsLive.js";
import { createTlsStatusRouter } from "./tlsStatus.js";
import { reporterHttpGate, ReporterTransport } from "./tlsHttp.js";
import { RESPOND } from "./storage/rows.js";
import { startUpdateCheck } from "./fleet/updateCheck.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 4317;
const HOST = process.env.HOST || "127.0.0.1";
// PODIUM_DB is read once, here, before anything else uses it: an unknown kind throws now. DB_PATH is its target (a plain path, or what follows `sqlite://`), which only labels the database in the log and the health check. DATA_DIR (PODIUM_DATA_DIR, else the database file's folder) is where the TLS folder lives.
const DB_PATH = storageSpec(process.env).target;
const DATA_DIR = dataDir(process.env);
const TOKEN = process.env.PODIUM_TOKEN || null;

// Logging (#140): levels, a text or JSON format, and optional shipping to a central platform such as VictoriaLogs.
const logging = createServerLogging(process.env, { secrets: TOKEN ? [TOKEN] : [] });
const { logger } = logging;
// A short hand-set secret can be guessed (#255); `podiumctl` makes a 192-bit one. Never print the secret.
if (TOKEN && TOKEN.length < 24) {
  logger.warn("server.weak_token", `podium: PODIUM_TOKEN is only ${TOKEN.length} characters; use at least 24 (podiumctl makes a long one for you)`, { length: TOKEN.length });
}

warnIfTlsNotPersistent({ env: process.env, dataDir: DATA_DIR, logger });

const storage = await openStorage(process.env);
const fleetConfig = configFromEnv(process.env, { home: os.homedir(), dbPath: DB_PATH });
// The Activity history lives in its own file beside the database (#432), opened by the storage; nothing is written to it under the default policy.
const fleet = new Fleet(storage, fleetConfig, Date.now, logger, { authOn: TOKEN !== null, secret: TOKEN });
// The live set is read from the database before anything listens or sweeps.
await fleet.init();
const people = storage.people;
const tlsSettings = new LiveTlsSettings(storage.tlsSettings, storage.tx);
// The TLS settings are read synchronously (by the HTTP gate on every request, and the renewer); load them before anything listens.
await tlsSettings.load();
// Holds the listener from the turn it starts serving; the HTTP gate opens once the first-run decision is stored (tlsBoot.ts).
const tlsBoot = new TlsBoot();
// Which reporters are on HTTP and which on HTTPS, for the Admin's switch and its count (#589).
const reporterTransport = new ReporterTransport();
// People's client certificates (#583). A certificate is trusted only if the running CA issued it; both read the listener when asked, since it starts after this.
const personCerts = storage.personCerts;
const trustedIssuers = () => tlsBoot.listener?.trust.trustedIssuers() ?? [];
// What signs a person's certificate, for the Admin and for a reporter renewing its own. Its lifetime is tls.reporter.lifetimeDays.
const personIssuer = () => (tlsBoot.listener ? { dir: tlsDir(DATA_DIR), port: publicTlsPort(process.env.PODIUM_TLS_PUBLIC_PORT, tlsBoot.listener.port), caCerts: () => [tlsBoot.listener!.trust.currentCa()], rotation: () => tlsBoot.listener!.trust.deliverable(), days: tlsSettings.getReporter().lifetimeDays } : null);
const reporters = storage.reporters;
const stopSweeper = startSweeper(
  fleet,
  undefined,
  logger,
  () => forgetReporters(storage, logger, Date.now()),
  // The same 5-minute run purges session recordings (#353), each on its own so one failing does not stop the other.
  () => purgeStored(fleet.activityHistory, fleet.recordings, people, logger, Date.now()),
);
// The release check (#499): once a day, and only while the Admin's Release check switch is on.
const stopUpdateCheck = startUpdateCheck(fleet.updates);

const app = express();
app.disable("x-powered-by");
// Off unless the owner names the proxy hops to trust, so a client cannot choose its own source address (#305).
app.set("trust proxy", parseTrustProxy(process.env.PODIUM_TRUST_PROXY));
const frontendDist = path.join(REPO_ROOT, "frontend", "dist");
// The page's one inline script (it sets the theme before first paint) is allowed by hash; no other inline script runs (#249).
let pageScripts: string[] = [];
const pagePath = path.join(frontendDist, "index.html");
// With no built UI (the server alone, or the dev server serving the UI) there is no page to allow scripts for.
if (fs.existsSync(pagePath)) {
  try {
    pageScripts = inlineScriptHashes(fs.readFileSync(pagePath, "utf8"));
  } catch (err) {
    logger.warn("server.csp", `podium: no inline script allowed by the content security policy: ${(err as Error).message}`, { reason: (err as Error).message });
  }
}
// First, ahead of every route: a name that is not ours is a page on another site rebound to this address (#256).
app.use(hostCheck({ bind: HOST, allowed: parseAllowedHosts(process.env.PODIUM_ALLOWED_HOSTS), logger }));
app.use(securityHeaders({ scriptHashes: pageScripts }));
// With TLS on and the Admin's switch off, the HTTP listener refuses the routes a reporter calls, except from loopback (#589).
app.use(reporterHttpGate({ active: () => tlsBoot.gateActive, allowed: () => tlsSettings.allowReportersOverHttp(), logger, rejected: (source, reason) => void reporters.rejected(source, reason, Date.now()).catch((err: Error) => logger.warn("reporters.reject_note_failed", `podium: could not note a refused reporter request: ${err.message}`, { reason: err.message })) }));
app.use(requestLog(logger));
// Five wrong credentials from one address lock it out of Admin's unlock and the sign-in to respond together (#206).
const lockout = new Lockout();
// Admin opens without a second sign-in for a browser already signed in to respond as an Administrator (#215).
const respondBridge = createRespondBridge();
// Responding over plain HTTP beyond loopback sends the sign-in unencrypted: say so, never block (#306).
const plainHttp = createPlainHttpWatch({ bind: HOST, respondOn: () => fleet.features.featureOn(RESPOND), logger });
// Failed requests from one address are limited ahead of every /api route; successful ones are never counted. PODIUM_FAILURE_LIMIT raises it.
app.use("/api", failureLimiter({ logger, max: parseFailureLimit(process.env.PODIUM_FAILURE_LIMIT) }));
app.use("/api/fleet", createFleetRouter(fleet, { token: TOKEN, people, reporters, logger, lockout, respondBridge, onSignIn: plainHttp.onSignIn, certs: { store: personCerts, trustedIssuers }, transport: reporterTransport }));
// A reporter renews its own certificate, authenticated by the one it holds (#585).
app.use("/api/reporter", createReporterRenewRouter({ certs: personCerts, people, tx: storage.tx, logger, now: Date.now, settings: () => tlsSettings.getReporter(), trustedIssuers, issuer: personIssuer }));
app.use("/api/admin", createAdminRouter({ secret: TOKEN, storage, people, reporters, peers: fleet.peers, activityHistory: { history: fleet.activityHistory, settings: fleet.activityHistorySettings }, onActivityHistoryChanged: () => void fleet.activityHistoryChanged(), recordings: { service: fleet.recordings, settings: fleet.recordingSettings, changed: (sid) => fleet.recordingChanged(sid) }, logRetainMs: fleetConfig.retention.adminLogMs, wall: fleet.wall, prices: fleet.prices, features: fleet.features, reports: reportDepsOf(fleet), certificates: { settings: tlsSettings, transport: reporterTransport, renewer: () => tlsBoot.listener?.renewer ?? null, rotation: () => tlsBoot.listener?.rotation ?? null, people: { store: personCerts, issuer: personIssuer } }, logger, lockout, respondBridge, onRespondOn: plainHttp.onFlagOn }));
// The header's certificate countdown: the dates and a few flags, no token, like the other reads the console makes (T8).
app.use("/api/tls", createTlsStatusRouter({ view: () => tlsBoot.listener?.renewer.statusView() ?? null }));
app.use(createRouter());

app.use(express.static(frontendDist));
app.get("*", pageLimiter(), (_req, res) => {
  res.sendFile(path.join(frontendDist, "index.html"));
});

const server = app.listen(PORT, HOST, () => {
  // The settings an agent needs to read a deployment; never the token, a header value or a ship URL's password.
  const s = logging.settings;
  logger.info("server.start", `Podium server listening on http://${HOST}:${PORT}`, {
    bind: HOST,
    port: PORT,
    db_path: DB_PATH,
    auth: TOKEN !== null,
    node_version: process.version,
    reporter_min: REPORTER_SUPPORT.min,
    reporter_max: REPORTER_SUPPORT.max,
    log_level: s.level,
    log_format: s.format,
    log_shipping: s.shipping,
    log_ship_endpoint: s.shipEndpoint,
    log_ship_buffer: s.shipBuffer,
    stale_after_ms: fleetConfig.staleAfterMs,
    hook_stale_after_ms: fleetConfig.hookStaleAfterMs,
    drop_after_ms: fleetConfig.dropAfterMs,
    linger_ms: fleetConfig.lingerMs,
    detached_hide_after_ms: fleetConfig.detachedHideAfterMs,
    retain_samples_ms: fleetConfig.retention.samplesMs,
    retain_events_ms: fleetConfig.retention.eventsMs,
    retain_sessions_ms: fleetConfig.retention.sessionsMs,
    retain_admin_log_ms: fleetConfig.retention.adminLogMs,
    retain_rollup_ms: fleetConfig.retention.rollupMs,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  logger.info("server.console", `Podium fleet console: http://${HOST}:${PORT}/#/  (database ${DB_PATH})`, { url: `http://${HOST}:${PORT}/#/` });
  plainHttp.atStart();
});

// Built-in TLS (#577): with PODIUM_TLS=on, HTTPS on a second port serves the same app. A failure is logged and HTTP stays up.
void startTls({ settings: () => tlsSettings.get(), env: process.env, app, dataDir: DATA_DIR, bind: HOST, httpPort: PORT, allowedHosts: parseAllowedHosts(process.env.PODIUM_ALLOWED_HOSTS), logger }).then(async (l) => {
  // The first time TLS runs, an install that already has reporters keeps them working over HTTP; a fresh one does not (SPEC 6).
  await tlsBoot.adopt(l, async () => tlsSettings.seedAllowReportersOverHttp(await reporters.hasAny()));
  // A signal that arrived while the CA was being made has already started the shutdown.
  if (closing) l?.server.close();
}).catch((err: Error) => logger.error("tls.start_failed", `podium: could not finish starting TLS: ${err.message}`, { reason: err.message }));

let closing = false;
function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  logger.info("server.stop", `Received ${signal}, shutting down`, { signal });
  stopSweeper();
  stopUpdateCheck();
  fleet.close();
  tlsBoot.listener?.server.close();
  server.close(() => {
    // Messages and writes already asked for finish before the databases close; the storage closes both files, each after its own queue is drained.
    void fleet.flush().then(() => storage.close()).catch(() => undefined).then(() => {
      // The last lines (this shutdown among them) go out before the process does, for at most a second.
      void logging.close(1000).finally(() => process.exit(0));
    });
  });
  // SSE sockets were ended above; anything still open after 2 s is cut.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
