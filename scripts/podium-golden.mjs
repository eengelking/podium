#!/usr/bin/env node
// Golden snapshot of a running Podium server's read behavior and database contents, for differential tests (#313):
// capture one from the old build and one from the new build over the same data, then diff them. A refactor with no
// behavior change gives an empty diff.
//
// capture reads, over HTTP (admin session via POST /api/admin/unlock, respond session via POST /api/fleet/respond/sign-in,
// both signed in as "Admin" with the admin secret, the respond one as --person when given; both are signed out again at the end):
//   Fleet (open):      GET /api/health, /api/fleet/health, /api/fleet/state, /api/fleet/events (all, and per session),
//                      /api/fleet/history (the days the sessions started on), /api/fleet/sessions/:id,
//                      /api/fleet/sessions/:id/agents/:agentId/text, /api/fleet/peers/traffic?range=live|24h|30d,
//                      /api/tls/status
//   Fleet (token):     GET /api/fleet/sessions/:id/peers (X-Podium-Token: the admin secret, or --person's token)
//   Fleet stream:      the first SSE event of GET /api/fleet/stream, then the connection is closed
//   Respond (signed in): GET /api/fleet/respond/me, /peers, /peers/conversations?range=..., /peers/conversations/:a/:b (each
//                      pair listed), /sessions/:id/recording, /sessions/:id/recording/consent, /sessions/:id/activity-history
//   Admin (unlocked):  GET /api/admin/session, /people, /groups, /reporters, /reporters/ignores, /reporters/:key,
//                      /reporters/:key/peers, /peers/conversations?range=..., /peers/conversations/:a/:b, /settings,
//                      /stored-activity (both sources), /certificates, /recordings, /log,
//                      /reports/{usage,spend,people,sessions,failures,activity} (JSON and CSV), /reports/retention,
//                      /reports/spend/projection, /reports/spend/today/:owner
//   Not read: routes that change state or take a lease (POST/PUT/PATCH/DELETE; GET /sessions/:id/agents/:agentId/activity
//   takes a viewer lease), routes that need an id only a live ask or a file path gives (/respond/sessions/:id/files/diff,
//   /respond/sessions/:id/asks/:askId, /sessions/:id/asks/:askId/answer), and the certificate downloads.
// Then it opens the database file(s) read-only with node:sqlite and dumps every table row by row, in primary key order,
// plus PRAGMA user_version, and the activity database too when it is given or sits next to the main one.
//
// The capture writes admin_log rows of its own (unlock, respond_sign_in, recording_read), so those kinds are left out of
// both the log route and the table dump; the output lists them under meta.excluded. Volatile values are replaced by
// placeholders and every rule that fired is listed under meta.normalized, so nothing is hidden.
//
// diff compares two captures (everything except meta.normalized and meta.tool) and exits 1 on any difference.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const HELP = `Usage: node scripts/podium-golden.mjs capture --url <server> --secret <admin secret> --db <podium.sqlite> [--activity-db <path>] [--person NAME=TOKEN] --out <file.json>
       node scripts/podium-golden.mjs diff <a.json> <b.json>

Captures a normalized snapshot of a running throwaway Podium server (its read routes, the first SSE event and every table of
its database) so a snapshot from one build can be diffed against one from another over the same data. Never point it at a
server you use: it signs in as Admin and the capture adds log rows to the database (and removes them from the snapshot).

capture
  --url          the throwaway Podium server, such as http://127.0.0.1:4391
  --secret       its admin secret (PODIUM_TOKEN; default: the PODIUM_TOKEN environment variable)
  --db           the main SQLite file the server runs on (PODIUM_DB); opened read-only
  --activity-db  the activity SQLite file (default: activity.sqlite next to --db, when it exists)
  --person       NAME=TOKEN of a person: also signs them in to respond and sends their token on the mod routes, so owner-only
                 reads are covered (without it those routes answer as the admin secret and mostly refuse)
  --out          where to write the snapshot (JSON)
  Volatile values (epoch-ms times, generated ids, tokens, key ids, durations, ports, versions, paths) become placeholders such
  as <epoch-ms>; the rules that fired are listed under meta.normalized in the output.

diff
  Prints each difference as a path with the two values, and exits 1 when there is any, 0 when there is none.

  -h, --help     show this help`;

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
  console.log(HELP);
  process.exit(argv.length === 0 ? 2 : 0);
}
const cmd = argv[0];
// Plain string order for stable output; a Map entry sorts by its key.
const byText = (a, b) => a.localeCompare(b);
const byKey = ([a], [b]) => byText(a, b);

const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);

// ---------------------------------------------------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------------------------------------------------

const EPOCH_MIN = 1e12; // 2001
const EPOCH_MAX = 4e12; // 2096
const ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PDM = /\bpdm_[A-Za-z0-9_-]{6,}\b/g;
const HEX = /\b[0-9a-f]{24,}\b/gi;
const PEM = /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g;

// Keys whose value is replaced whatever it is: [regex on the key, placeholder].
const KEY_RULES = [
  [/^(token|tokenHash|token_hash|secret|cookie|nonce)$/i, '<secret>'],
  [/^(keyId|key_id|credential)$/i, '<key-id>'],
  [/^(fingerprint\w*|serial|issuer_?fingerprint\w*|fingerprint_sha256|cert_pem|certPem|pem)$/i, '<cert-field>'],
  [/^(port|\w+Port)$/, '<port>'],
  [/^(serverVersion|serverBuild|build|version)$/, '<version>'],
  [/^(dbPath|db_path|dataDir)$/, '<path>'],
];
// Numbers under these keys are durations or ages that depend on when the capture ran.
const DURATION_WORDS = new Set(['duration', 'elapsed', 'uptime', 'ago', 'since', 'remaining', 'retryafter', 'skew', 'age']);
const DURATION_EXACT = /^(serverTime)$/;
const SERIES_KEYS = new Set(['series', 'kpis']);
/** True for a key that names an age or a duration, by its camelCase or snake_case words (so "page" and "agents" do not count). */
const isDurationKey = (k) => DURATION_EXACT.test(k) || k.split(/(?=[A-Z])|_/).some((w) => DURATION_WORDS.has(w.toLowerCase()));

function makeNormalizer(ctx) {
  const hits = new Map(); // rule name -> count
  const hit = (name) => hits.set(name, (hits.get(name) ?? 0) + 1);
  const fields = new Map(); // key name -> placeholder
  const markField = (key, ph) => {
    const k = `${key} -> ${ph}`;
    fields.set(k, (fields.get(k) ?? 0) + 1);
  };
  const origin = ctx.origin;
  const hostPort = new URL(origin).host;
  const dirs = ctx.dirs;

  function str(s, key) {
    let out = s;
    const sub = (re, ph, name) => {
      out = out.replace(re, () => {
        hit(name);
        return ph;
      });
    };
    sub(PEM, '<pem>', 'pem block');
    if (out.includes(origin)) sub(new RegExp(origin.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<server>', 'server origin');
    if (out.includes(hostPort)) sub(new RegExp(hostPort.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<host:port>', 'server host:port');
    for (const d of dirs) if (d && out.includes(d)) sub(new RegExp(d.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<dbdir>', 'database directory');
    sub(PDM, 'pdm_<token>', 'pdm_ token in text');
    sub(UUID, '<uuid>', 'uuid in text');
    sub(ISO, '<iso-time>', 'ISO time in text');
    sub(HEX, '<hex>', 'long hex string in text');
    return out;
  }

  function walk(v, key) {
    if (v === null || v === undefined) return v;
    if (key !== undefined) {
      for (const [re, ph] of KEY_RULES) {
        if (re.test(key) && v !== '' && typeof v !== 'boolean') {
          hit(`key ${ph}`);
          markField(key, ph);
          return ph;
        }
      }
    }
    if (typeof v === 'number') {
      if (key !== undefined && isDurationKey(key)) {
        hit('duration key');
        markField(key, '<duration>');
        return '<duration>';
      }
      if (Number.isInteger(v) && v >= EPOCH_MIN && v < EPOCH_MAX) {
        hit('epoch-ms value');
        if (key !== undefined) markField(key, '<epoch-ms>');
        return '<epoch-ms>';
      }
      return v;
    }
    if (typeof v === 'string') {
      // A JSON document kept in a text column (git_json, plan_json, ...): normalize what is inside it.
      if (key !== undefined && /json$/i.test(key) && /^[[{]/.test(v)) {
        try {
          return JSON.stringify(walk(JSON.parse(v), undefined));
        } catch {
          /* not JSON after all */
        }
      }
      if (/^\d{13}$/.test(v) && Number(v) >= EPOCH_MIN && Number(v) < EPOCH_MAX) {
        hit('epoch-ms value');
        return '<epoch-ms>';
      }
      return str(v, key);
    }
    if (typeof v === 'bigint') return walk(Number(v), key);
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) {
        // A rolling window of samples (the sparklines) moves with the clock; only its length is kept.
        if (SERIES_KEYS.has(k) && v[k] && typeof v[k] === 'object' && !Array.isArray(v[k])) {
          o[k] = {};
          for (const kk of Object.keys(v[k])) {
            const arr = v[k][kk];
            if (Array.isArray(arr) && arr.every((x) => typeof x === 'number')) {
              hit('rolling series');
              markField(`${k}.${kk}`, '<series of N>');
              o[k][kk] = `<series of ${arr.length}>`;
            } else o[k][kk] = walk(arr, kk);
          }
        } else o[k] = walk(v[k], k);
      }
      return o;
    }
    return v;
  }
  return {
    walk,
    report: () => ({
      rules: Object.fromEntries([...hits].sort(byKey)),
      fields: Object.fromEntries([...fields].sort(byKey)),
      // Names that are always replaced when present, and the number ranges treated as epoch-ms and durations.
      keyRules: KEY_RULES.map(([re, ph]) => `${re.source} -> ${ph}`),
      durationKeys: [...DURATION_WORDS, 'serverTime'],
      epochMsRange: [EPOCH_MIN, EPOCH_MAX],
    }),
  };
}

/** A cheap, order-insensitive tag for a normalized value, used to order rows whose primary key was normalized away. */
const canon = (v) => JSON.stringify(v);

// ---------------------------------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------------------------------

async function capture() {
  const url = opt('--url', '');
  const secret = opt('--secret', process.env.PODIUM_TOKEN);
  const dbPath = opt('--db', '');
  const out = opt('--out', '');
  if (!url || !secret || !dbPath || !out) {
    console.error(HELP);
    process.exit(2);
  }
  const origin = new URL(url).origin;
  // --person NAME=TOKEN also signs a person in to respond, and sends their token on the mod routes, so owner-only reads are covered.
  const personArg = opt('--person', '');
  const person = personArg.includes('=') ? { name: personArg.slice(0, personArg.indexOf('=')), token: personArg.slice(personArg.indexOf('=') + 1) } : null;
  let activityPath = opt('--activity-db', '');
  if (!activityPath) {
    const guess = path.join(path.dirname(path.resolve(dbPath)), 'activity.sqlite');
    if (existsSync(guess)) activityPath = guess;
  }
  const norm = makeNormalizer({ origin, dirs: [path.dirname(path.resolve(dbPath)), path.dirname(path.resolve(dbPath)).replace(/^\/private/, '')] });
  // Log rows the capture itself causes: left out so a second capture sees the same log as the first.
  const SELF_LOG_KINDS = ['unlock', 'respond_sign_in', 'recording_read'];

  /** Drops the capture's own log rows from any reply that lists log rows (the log, the activity report), and their csv lines. */
  function withoutSelfLog(body) {
    if (typeof body === 'string') {
      return /^Time,Kind,/.test(body) ? body.split('\r\n').filter((l) => !SELF_LOG_KINDS.some((k) => l.includes(`,${k},`))).join('\r\n') : body;
    }
    if (!body || !Array.isArray(body.rows) || !body.rows.some((x) => x && SELF_LOG_KINDS.includes(x.kind))) return body;
    const rows = body.rows.filter((x) => !SELF_LOG_KINDS.includes(x.kind));
    const dropped = body.rows.length - rows.length;
    const out = { ...body, rows };
    if (typeof out.total === 'number') out.total -= dropped;
    else if (out.total && typeof out.total.count === 'number') out.total = { ...out.total, count: out.total.count - dropped };
    return out;
  }

  const jars = { admin: '', respond: '' };
  // A later Set-Cookie for a name replaces an earlier one (a sign-in first clears the old-path cookie, then sets the new one).
  const cookieOf = (res) => {
    const m = new Map();
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [nv] = c.split(';');
      const i = nv.indexOf('=');
      if (i > 0) m.set(nv.slice(0, i), nv);
    }
    return [...m.values()].join('; ');
  };

  async function get(p, who, extra = {}) {
    const headers = { Accept: 'application/json, text/csv, */*', ...extra };
    if (who && jars[who]) headers.cookie = jars[who];
    const res = await fetch(new URL(p, origin), { headers, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    const type = (res.headers.get('content-type') ?? '').split(';')[0];
    let body = text;
    if (type.includes('json') && text) {
      try {
        body = JSON.parse(text);
      } catch {
        /* keep the text */
      }
    }
    return { status: res.status, type, body };
  }
  async function post(p, body, headers) {
    const res = await fetch(new URL(p, origin), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const jar = cookieOf(res);
    await res.text();
    return { status: res.status, jar };
  }

  const routes = {}; // "GET /path" -> normalized response
  const rawSeen = {}; // raw bodies, for discovering ids
  async function read(p, who, extra) {
    let r;
    try {
      r = await get(p, who, extra);
    } catch (e) {
      r = { status: 0, type: '', body: `request failed: ${e.name}` };
    }
    rawSeen[p] = r;
    let body = r.body;
    body = withoutSelfLog(body);
    routes[`GET ${norm.walk(p)}`] = { status: r.status, type: r.type, body: norm.walk(body) };
    return r;
  }

  // Sign in. Both calls leave a log row that the dump and the log route skip.
  const unlock = await post('/api/admin/unlock', { name: 'Admin', token: secret }, { 'X-Podium-Admin': '1' });
  jars.admin = unlock.jar;
  const signin = await post('/api/fleet/respond/sign-in', person ?? { name: 'Admin', token: secret }, { 'X-Podium-Respond': '1' });
  jars.respond = signin.jar;
  routes['signIn'] = { adminUnlock: unlock.status, respondSignIn: signin.status };

  const F = '/api/fleet';
  const A = '/api/admin';
  const R = `${F}/respond`;
  const tok = { 'X-Podium-Token': person ? person.token : secret };

  await read('/api/health');
  await read(`${F}/health`);
  const state = await read(`${F}/state`);
  await read(`${F}/events?limit=200`);
  await read(`${F}/peers/traffic?range=live`);
  await read(`${F}/peers/traffic?range=24h`);
  await read(`${F}/peers/traffic?range=30d`);
  await read('/api/tls/status');

  const sessions = Array.isArray(state.body?.sessions) ? state.body.sessions : [];
  sessions.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const days = new Set();
  const pad = (n) => String(n).padStart(2, '0');
  for (const s of sessions) {
    if (typeof s.startedAt === 'number') {
      const d = new Date(s.startedAt);
      days.add(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    }
  }
  const today = new Date();
  days.add(`${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`);
  for (const day of [...days].sort(byText)) await read(`${F}/history?day=${day}`);
  await read(`${F}/history?day=2026-02-31`); // an error path
  await read(`${F}/events?before=abc`); // an error path

  // The first SSE event, then close.
  routes[`SSE ${F}/stream first event`] = norm.walk(await firstSse(new URL(`${F}/stream`, origin)));

  await read(`${R}/me`, 'respond');
  await read(`${R}/peers`, 'respond');
  for (const range of ['live', '24h', '30d']) {
    const c = await read(`${R}/peers/conversations?range=${range}`, 'respond');
    for (const conv of (Array.isArray(c.body?.conversations) ? c.body.conversations : []).slice(0, 5)) {
      const a = conv.a?.sessionId;
      const b = conv.b?.sessionId;
      if (a && b) await read(`${R}/peers/conversations/${encodeURIComponent(a)}/${encodeURIComponent(b)}`, 'respond');
    }
  }

  for (const s of sessions) {
    const id = encodeURIComponent(s.id);
    await read(`${F}/events?sessionId=${id}&limit=200`);
    const view = await read(`${F}/sessions/${id}`);
    for (const a of (Array.isArray(view.body?.agents) ? view.body.agents : []).sort((x, y) => String(x.id).localeCompare(String(y.id)))) {
      await read(`${F}/sessions/${id}/agents/${encodeURIComponent(a.id)}/text`);
    }
    await read(`${F}/sessions/${id}/peers`, undefined, tok);
    await read(`${R}/sessions/${id}/recording`, 'respond');
    await read(`${R}/sessions/${id}/recording/consent`, 'respond');
    await read(`${R}/sessions/${id}/activity-history`, 'respond');
  }
  await read(`${F}/sessions/no-such-session`);

  // Admin.
  const page = 'page=1&pageSize=100';
  await read(`${A}/session`, 'admin');
  const people = await read(`${A}/people?${page}`, 'admin');
  await read(`${A}/groups?${page}`, 'admin');
  const reps = await read(`${A}/reporters?${page}`, 'admin');
  await read(`${A}/reporters/ignores`, 'admin');
  for (const r of (Array.isArray(reps.body?.rows) ? reps.body.rows : []).slice(0, 50)) {
    if (r.key === undefined) continue;
    await read(`${A}/reporters/${encodeURIComponent(r.key)}`, 'admin');
    await read(`${A}/reporters/${encodeURIComponent(r.key)}/peers`, 'admin');
  }
  for (const range of ['live', '24h', '30d']) {
    const c = await read(`${A}/peers/conversations?range=${range}`, 'admin');
    for (const conv of (Array.isArray(c.body?.conversations) ? c.body.conversations : []).slice(0, 5)) {
      const a = conv.a?.sessionId;
      const b = conv.b?.sessionId;
      if (a && b) await read(`${A}/peers/conversations/${encodeURIComponent(a)}/${encodeURIComponent(b)}`, 'admin');
    }
  }
  await read(`${A}/settings`, 'admin');
  await read(`${A}/stored-activity?${page}`, 'admin');
  await read(`${A}/stored-activity?${page}&source=recordings`, 'admin');
  await read(`${A}/certificates`, 'admin');
  await read(`${A}/recordings?${page}`, 'admin');
  await read(`${A}/log?${page}`, 'admin');
  for (const name of ['usage', 'spend', 'people', 'sessions', 'failures', 'activity']) {
    await read(`${A}/reports/${name}`, 'admin');
    await read(`${A}/reports/${name}?format=csv`, 'admin');
  }
  await read(`${A}/reports/retention`, 'admin');
  await read(`${A}/reports/spend/projection`, 'admin');
  const owners = new Set(['Admin']);
  for (const s of sessions) if (typeof s.owner === 'string' && s.owner) owners.add(s.owner);
  for (const r of Array.isArray(people.body?.rows) ? people.body.rows : []) if (typeof r.name === 'string') owners.add(r.name);
  for (const o of [...owners].sort(byText)) await read(`${A}/reports/spend/today/${encodeURIComponent(o)}`, 'admin');
  await read(`${A}/reports/nope`, 'admin'); // an error path
  await read(`${A}/people/999999/certificate.pem`, 'admin'); // an error path

  // Sign out (neither logs).
  await post('/api/admin/lock', {}, { 'X-Podium-Admin': '1', cookie: jars.admin }).catch(() => {});
  await post('/api/fleet/respond/sign-out', {}, { 'X-Podium-Respond': '1', cookie: jars.respond }).catch(() => {});

  // Databases.
  const sqlite = process.getBuiltinModule('node:sqlite');
  if (!sqlite) throw new Error('node:sqlite is not available in this Node (need 22.5 or later)');
  const dbs = {};
  dbs.main = dumpDb(sqlite, dbPath, norm, SELF_LOG_KINDS);
  if (activityPath) dbs.activity = dumpDb(sqlite, activityPath, norm, SELF_LOG_KINDS);

  const sortedRoutes = Object.fromEntries(Object.entries(routes).sort(([a], [b]) => a.localeCompare(b)));
  const snapshot = {
    meta: {
      tool: 'podium-golden 1',
      databases: Object.keys(dbs),
      excluded: { 'admin_log.kind (written by the capture itself)': SELF_LOG_KINDS },
      notRead: ['POST/PUT/PATCH/DELETE routes', 'GET .../agents/:agentId/activity (takes a viewer lease)', 'GET /respond/sessions/:id/files/diff', 'GET /respond/sessions/:id/asks/:askId', 'GET /sessions/:id/asks/:askId/answer', 'certificate downloads'],
      normalized: norm.report(),
    },
    routes: sortedRoutes,
    db: dbs,
  };
  writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);
  const nTables = Object.values(dbs).reduce((n, d) => n + Object.keys(d.tables).length, 0);
  const nRows = Object.values(dbs).reduce((n, d) => n + Object.values(d.tables).reduce((m, t) => m + t.length, 0), 0);
  console.log(`podium-golden: wrote ${out}: ${Object.keys(sortedRoutes).length} routes, ${nTables} tables, ${nRows} rows`);
  const bad = Object.entries(sortedRoutes).filter(([, r]) => r.status === 0);
  if (bad.length) console.log(`podium-golden: ${bad.length} request(s) failed to connect: ${bad.map(([k]) => k).join(', ')}`);
}

/** Reads the first `data:` event of an SSE response and closes the connection. */
async function firstSse(u) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(u, { headers: { Accept: 'text/event-stream' }, signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const end = buf.indexOf('\n\n');
      if (end >= 0) {
        const block = buf.slice(0, end);
        const eventLine = block.split('\n').find((l) => l.startsWith('event:'));
        const event = eventLine === undefined ? 'message' : eventLine.slice(6).trimStart();
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        let parsed = data;
        try {
          parsed = JSON.parse(data);
        } catch {
          /* keep text */
        }
        ac.abort();
        return { status: res.status, event, data: parsed };
      }
    }
    return { status: res.status, event: null, data: null };
  } catch (e) {
    return { status: 0, event: null, data: `stream failed: ${e.name}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------------------------------------------------

function dumpDb(sqlite, file, norm, selfKinds) {
  if (!existsSync(file)) throw new Error(`no such database: ${file}`);
  // readOnly on a WAL file: the -wal and -shm files beside it are read too, so rows not yet checkpointed are seen.
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    const q = (s) => db.prepare(s);
    const version = q('PRAGMA user_version').get().user_version;
    const tables = {};
    const names = q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all().map((r) => r.name);
    const schema = {};
    for (const t of names) {
      const cols = q(`PRAGMA table_info("${t}")`).all();
      schema[t] = cols.map((c) => `${c.name} ${c.type}${c.pk ? ` pk${c.pk}` : ''}${c.notnull ? ' notnull' : ''}`);
      const pks = cols.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => `"${c.name}"`);
      const order = pks.length ? pks.join(', ') : 'rowid';
      let rows = q(`SELECT * FROM "${t}" ORDER BY ${order}`).all();
      if (t === 'admin_log') rows = rows.filter((r) => !selfKinds.includes(r.kind));
      const normed = rows.map((r) => {
        const o = {};
        for (const k of Object.keys(r)) o[k] = r[k] instanceof Uint8Array ? `<blob ${r[k].length} bytes>` : r[k];
        return norm.walk(o);
      });
      // Rows whose primary key was normalized away have no stable order from the key; order them by their content.
      const pkNames = cols.filter((c) => c.pk).map((c) => c.name);
      const volatilePk = normed.some((r) => pkNames.some((k) => typeof r[k] === 'string' && r[k].includes('<')) || pkNames.some((k) => r[k] === '<epoch-ms>'));
      if (volatilePk) normed.sort((a, b) => (canon(a) < canon(b) ? -1 : canon(a) > canon(b) ? 1 : 0));
      tables[t] = normed;
    }
    return { userVersion: version, schema, tables };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------------------------------------------------

function diffValues(a, b, at, out) {
  if (Object.is(a, b)) return;
  const ta = Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a;
  const tb = Array.isArray(b) ? 'array' : b === null ? 'null' : typeof b;
  if (ta !== tb) return void out.push(`${at}: ${show(a)}  !=  ${show(b)}`);
  if (ta === 'array') {
    if (a.length !== b.length) out.push(`${at}: length ${a.length}  !=  ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffValues(a[i], b[i], `${at}[${i}]`, out);
    return;
  }
  if (ta === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = /^[A-Za-z_]\w*$/.test(k) ? `${at}.${k}` : `${at}[${JSON.stringify(k)}]`;
      if (!(k in a)) out.push(`${p}: (missing)  !=  ${show(b[k])}`);
      else if (!(k in b)) out.push(`${p}: ${show(a[k])}  !=  (missing)`);
      else diffValues(a[k], b[k], p, out);
    }
    return;
  }
  out.push(`${at}: ${show(a)}  !=  ${show(b)}`);
}
const show = (v) => {
  const s = v === undefined ? 'undefined' : JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
};

function runDiff() {
  const [fa, fb] = [argv[1], argv[2]];
  if (!fa || !fb) {
    console.error(HELP);
    process.exit(2);
  }
  const a = JSON.parse(readFileSync(fa, 'utf8'));
  const b = JSON.parse(readFileSync(fb, 'utf8'));
  const out = [];
  diffValues(a.routes, b.routes, 'routes', out);
  diffValues(a.db, b.db, 'db', out);
  diffValues(a.meta?.databases, b.meta?.databases, 'meta.databases', out);
  diffValues(a.meta?.excluded, b.meta?.excluded, 'meta.excluded', out);
  if (out.length === 0) {
    console.log('podium-golden: no differences');
    return 0;
  }
  for (const l of out) console.log(l);
  console.log(`podium-golden: ${out.length} difference${out.length === 1 ? '' : 's'}`);
  return 1;
}

if (cmd === 'capture') {
  capture().catch((e) => {
    console.error(`podium-golden: ${e.message}`);
    process.exit(1);
  });
} else if (cmd === 'diff') {
  process.exit(runDiff());
} else {
  console.error(HELP);
  process.exit(2);
}
