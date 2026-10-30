// The Cypress tasks: they run in Node, inside the Cypress container, outside the browser. They ask scripts/e2e-up.sh (through the
// mounted /ctl folder, never a port or an engine socket) to restart, pause or resume the server, report as a reporter would, and
// answer diff requests as the reporter mod would. The admin secret stays in this process; a spec gets only the seed's fake tokens.
const fs = require('node:fs');
const path = require('node:path');
const { startDiffMod } = require('./diffs.cjs');

const CTL = '/ctl';
const SEED = '/repo/scripts/e2e-seed.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Writes a control request and waits for scripts/e2e-up.sh's answer. */
async function control(cmd, opts = {}) {
  const lines = [cmd];
  for (const e of opts.env ?? []) lines.push(`env=${e}`);
  if (opts.seedArgs) lines.push(`seed=${opts.seedArgs}`);
  if (opts.noSeed) lines.push('noseed=1');
  try {
    fs.unlinkSync(path.join(CTL, 'ack'));
  } catch {
    // none yet
  }
  fs.writeFileSync(path.join(CTL, 'req.tmp'), `${lines.join('\n')}\n`);
  fs.renameSync(path.join(CTL, 'req.tmp'), path.join(CTL, 'req'));
  for (let i = 0; i < 1200; i++) {
    if (fs.existsSync(path.join(CTL, 'ack'))) {
      const answer = fs.readFileSync(path.join(CTL, 'ack'), 'utf8').trim();
      if (answer !== 'ok') throw new Error(`the server control request "${cmd}" failed (see the run log)`);
      return;
    }
    await sleep(100);
  }
  throw new Error(`the server control request "${cmd}" got no answer in 120 s`);
}

function registerTasks(on, config) {
  const origin = config.baseUrl;
  let seedMod = null;
  let manifest = null;
  let stopDiffs = null;
  const seedModule = async () => (seedMod ??= await import(SEED));
  const readManifest = () => JSON.parse(fs.readFileSync(path.join(CTL, 'seed.json'), 'utf8'));

  on('task', {
    /** Restarts the server on a wiped database and reseeds it. Returns the manifest: person tokens, session ids, machine ids. */
    async 'server:reset'(opts) {
      await stopDiffs?.();
      stopDiffs = null;
      const o = opts ?? {};
      await control('restart', o);
      manifest = o.noSeed ? null : readManifest();
      return manifest;
    },
    async 'server:pause'() {
      await control('pause');
      return null;
    },
    async 'server:resume'() {
      await control('resume');
      return null;
    },
    /** Reports one seeded session again with `over` merged into its `session` and `agents` merged into its agents, as the reporter's next report would. */
    async 'fleet:report'({ key, over, who, agents, steps }) {
      const seed = await seedModule();
      const m = manifest ?? readManifest();
      const r = seed.fleetReports({}, { rich: true, reporters: true }).find((x) => x.key === key);
      if (!r) throw new Error(`no seeded session "${key}"`);
      const body = { ...r.body, sentAt: Date.now(), session: { ...r.body.session, ...over } };
      // `steps` maps a plan step id to its new state.
      if (steps && body.session.plan) body.session.plan = { ...body.session.plan, steps: body.session.plan.steps.map((st) => (steps[st.id] ? { ...st, state: steps[st.id] } : st)) };
      // `agents` maps an agent id to the fields to change on it.
      if (agents) body.agents = r.body.agents.map((a) => (agents[a.id] ? { ...a, ...agents[a.id] } : a));
      const res = await seed.client(origin).mod(m.people[who ?? r.who].token, 'POST', '/report', body);
      if (res.status >= 300) throw new Error(`report ${key}: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    },
    /** Sends as a signed-in person from Node (a second browser): `as` is Ed, Alex or Admin, `path` is under /api/fleet/respond, `body` is the JSON. Yields { status, body }. */
    async 'respond:as'({ as, method, path, body }) {
      const seed = await seedModule();
      const m = manifest ?? readManifest();
      const c = seed.client(origin);
      const token = as === 'Admin' ? config.env.ADMIN_SECRET : m.people[as].token;
      const login = await c.browser('POST', '/sign-in', { name: as, token });
      if (login.status !== 200) throw new Error(`sign-in as ${as}: ${login.status}`);
      return c.browser(method ?? 'POST', path, body);
    },
    /** Posts as the reporter mod of a seeded person (their token), under /api/fleet: for a delivery's result, which the feed turns into a note. */
    async 'mod:post'({ who, path, body }) {
      const seed = await seedModule();
      const m = manifest ?? readManifest();
      return seed.client(origin).mod(m.people[who ?? 'Ed'].token, 'POST', path, body);
    },
    /** Reads as the reporter mod of a seeded person (their token), under /api/fleet: the answer to an ask is read this way (the hook's long poll). Yields { status, body }. */
    async 'mod:get'({ who, path }) {
      const seed = await seedModule();
      const m = manifest ?? readManifest();
      return seed.client(origin).mod(m.people[who ?? 'Ed'].token, 'GET', path);
    },
    /** Starts answering the console's diff requests for the invoice session, as the reporter mod would. */
    async 'diffs:start'(over) {
      const m = manifest ?? readManifest();
      await stopDiffs?.();
      stopDiffs = startDiffMod(origin, m.people.Ed.token, await seedModule(), over ?? {});
      return null;
    },
    async 'diffs:stop'() {
      await stopDiffs?.();
      stopDiffs = null;
      return null;
    },
    /** The text of the newest file the browser downloaded (an export) whose name holds `name`; waits up to 8 s for it. */
    async 'download:read'(name) {
      const dir = '/out/downloads';
      for (let i = 0; i < 80; i++) {
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.includes(name) && !f.endsWith('.crdownload')) : [];
        if (files.length) {
          files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
          return { name: files[0], text: fs.readFileSync(path.join(dir, files[0]), 'utf8') };
        }
        await sleep(100);
      }
      throw new Error(`no downloaded file with "${name}" in its name`);
    },
    'download:clear'() {
      fs.rmSync('/out/downloads', { recursive: true, force: true });
      return null;
    },
    /** Reads axe-core's source so a spec can inject it into the page (mounted read-only from the repo's node_modules). */
    'axe:source'() {
      return fs.readFileSync('/repo/axe.min.js', 'utf8');
    },
  });
  on('after:run', () => stopDiffs?.());
}

module.exports = { registerTasks };
