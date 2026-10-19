#!/usr/bin/env node
// Orchestrator messaging, end to end (#412, designed on #347, SPEC 7.7 "Orchestrator messaging"). It plays the
// reporters against a running Podium server: it turns the Admin's Orchestrator messaging flag on, makes two people,
// reports three machines with peers on, signs the owner in to respond, and walks four scenarios (a message sent and
// taken, a message held for approval, a message to another person's session, and the flag turned off). It prints one
// PASS or FAIL line per check and exits 1 if any fail. Nothing reaches a real session.
//
// Never point it at a server you use: it changes the Admin's settings and adds people.

const HELP = `Usage: node scripts/podium-peers-demo.mjs [--url <server>] [--secret <admin secret>]

Proves orchestrator messaging (#412) works end to end by playing reporters against a running Podium server.
It turns the Orchestrator messaging flag on, makes two people (Ed and Alex, with a random suffix so it can run
again), reports Ed's two machines and Alex's one with peers on, signs Ed in to respond, then checks:
  1. a message Ed's Mac sends to Ed's Linux box is delivered once the Linux session is idle, and its result is taken;
  2. with the right set to ask, a message waits for Ed's approval and is delivered only after Ed delivers it;
  3. a message to Alex's session is refused with 404 and no conversation with it is kept;
  4. with the flag off, replies say peers is false, a waiting message is dropped and a send is refused.
Prints one PASS or FAIL line per check and exits 1 if any check fails.

It needs a server started with authentication on (PODIUM_TOKEN set) and a throwaway database: it changes the
Admin's settings and adds people. Never point it at a server you use.

  --url      the Podium server (default PODIUM_URL, else http://127.0.0.1:4317)
  --secret   the server's admin secret (default PODIUM_TOKEN)
  -h, --help show this help`;

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(HELP);
  process.exit(0);
}
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const URL_ = (arg('--url', process.env.PODIUM_URL || 'http://127.0.0.1:4317') ?? '').replace(/\/+$/, '');
const SECRET = arg('--secret', process.env.PODIUM_TOKEN);
if (!URL_ || !SECRET) {
  console.error(HELP);
  process.exit(2);
}

/** A failure that stops the run before the checks can mean anything; printed as one line. */
class Stop extends Error {}

// ---- HTTP ------------------------------------------------------------------------------------

/** Keeps one cookie per name from Set-Cookie, so the Admin and respond sessions stay apart. */
function jar() {
  const cookies = new Map();
  return {
    take(res) {
      const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
      for (const c of all) {
        const pair = c.split(';')[0];
        const eq = pair.indexOf('=');
        if (eq > 0) cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    },
    header() {
      return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    },
  };
}

async function call(method, path, { headers = {}, body, cookies } = {}) {
  let res;
  try {
    const cookie = cookies?.header();
    res = await fetch(`${URL_}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers, ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    const why = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(e);
    throw new Stop(`cannot reach ${URL_} (${why}); start a server with PODIUM_TOKEN set, or pass --url`);
  }
  cookies?.take(res);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { nonJson: text.slice(0, 120) };
  }
  return { status: res.status, body: json };
}

const adminJar = jar();
const admin = (method, path, body) => call(method, `/api/admin${path}`, { headers: { 'X-Podium-Admin': '1' }, body, cookies: adminJar });
const mod = (token, method, path, body) => call(method, `/api/fleet${path}`, { headers: { 'X-Podium-Token': token }, body });
function browser(cookies) {
  return (method, path, body) => call(method, `/api/fleet/respond${path}`, { headers: method === 'GET' ? {} : { 'X-Podium-Respond': '1' }, body, cookies });
}

// ---- Checks ----------------------------------------------------------------------------------

let failed = 0;
function check(label, ok, detail) {
  if (ok) console.log(`PASS  ${label}`);
  else {
    failed++;
    console.log(`FAIL  ${label}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  }
  return !!ok;
}
const show = (r) => `${r.status} ${JSON.stringify(r.body)}`.slice(0, 300);

// ---- The fleet -------------------------------------------------------------------------------

const sfx = Math.random().toString(36).slice(2, 7);
const rid = () => Math.random().toString(36).slice(2, 14);
const now = Date.now();

const people = { ed: { name: `Ed-${sfx}`, token: '' }, alex: { name: `Alex-${sfx}`, token: '' } };
const mac = { who: people.ed, machine: { name: `ed-mac-${sfx}`, id: `mac${rid()}`, os: 'macOS 27.0.1' } };
const linux = { who: people.ed, machine: { name: `ed-linux-${sfx}`, id: `lnx${rid()}`, os: 'Ubuntu 26.04' } };
const alexBox = { who: people.alex, machine: { name: `alex-box-${sfx}`, id: `alx${rid()}`, os: 'Fedora 44' } };
const dev = { reporter: mac, id: `peers-dev-${rid()}`, name: 'dev' };
const tester = { reporter: linux, id: `peers-tester-${rid()}`, name: 'Tester' };
const review = { reporter: alexBox, id: `peers-review-${rid()}`, name: 'review' };

function report(s, status, waitReason) {
  return {
    v: 1,
    sentAt: Date.now(),
    reporter: { name: 'podium-reporter', version: '1.1.0', engineVersion: '2.1.301', hostSurface: 'terminal' },
    userName: s.reporter.who.name,
    machine: s.reporter.machine,
    session: {
      id: s.id, name: s.name, status, waitReason, waitNote: null, endReason: null, resumeId: null, peers: true,
      startedAt: now - 600_000, cwd: `/Users/dev/${s.name}`, projectRoot: `/Users/dev/${s.name}`, repoName: `eengelking/${s.name}`,
      git: { branch: 'issue/412-peer-messaging', detached: false, isWorktree: false, worktreePath: null, ahead: 0, behind: 0, dirty: 0 },
      model: 'claude-opus-5-5', effort: 'high', context: { tokens: 120_000, window: 1_000_000, percent: 12 }, costUsd: 1.2,
      tokens: { input: 300_000, output: 30_000, cacheRead: 0, cacheWrite: 0 }, rateLimits: [], blowouts: 0, plan: null,
      loop: { skills: [], lastTool: 'Read', toolCalls: 4, toolCounts: { Read: 4 }, steps: { done: 6, total: null } },
      files: null, attached: true,
    },
    agents: [],
    events: [],
  };
}
const running = (s) => mod(s.reporter.who.token, 'POST', '/report', report(s, 'running', null));
const idle = (s) => mod(s.reporter.who.token, 'POST', '/report', report(s, 'waiting', 'input'));
const send = (from, to, text) => mod(from.reporter.who.token, 'POST', `/sessions/${from.id}/peers/messages`, { to: `${to.name}@${to.reporter.machine.name}`, text });
const result = (s, deliveryId, r) => mod(s.reporter.who.token, 'POST', `/sessions/${s.id}/peers/deliveries/${deliveryId}/result`, { result: r, at: Date.now() });
const deliveriesOf = (r) => (Array.isArray(r.body?.peerDeliveries) ? r.body.peerDeliveries : []);
const messageIn = (r, text) => deliveriesOf(r).find((d) => d.kind === 'message' && typeof d.text === 'string' && d.text.includes(text));
const setFlag = (on) => admin('PUT', '/settings', { features: { 'peer-messaging': on } });

async function setup() {
  const unlocked = await admin('POST', '/unlock', { name: 'Admin', token: SECRET });
  if (!unlocked.body?.ok) throw new Stop(`could not unlock Admin (${show(unlocked)}); is --secret the server's PODIUM_TOKEN?`);
  // Signing in to respond needs Respond from Podium on (SPEC 7.7); messaging needs its own flag.
  const flags = await admin('PUT', '/settings', { features: { 'peer-messaging': true, respond: true, 'activity-feed': true } });
  if (flags.status !== 200) throw new Stop(`could not turn the flags on (${show(flags)})`);
  for (const p of Object.values(people)) {
    const made = await admin('POST', '/people', { name: p.name });
    if (!made.body?.token) throw new Stop(`could not make ${p.name} (${show(made)}); is authentication on?`);
    p.token = made.body.token;
  }
  for (const [s, r] of [[dev, running], [tester, idle], [review, idle]]) {
    const res = await r(s);
    if (res.status !== 200) throw new Stop(`the report for ${s.name}@${s.reporter.machine.name} was refused (${show(res)})`);
  }
  const edJar = jar();
  const ed = browser(edJar);
  const signed = await ed('POST', '/sign-in', { name: people.ed.name, token: people.ed.token });
  if (!signed.body?.ok) throw new Stop(`${people.ed.name} could not sign in to respond (${show(signed)})`);
  console.log(`Run ${sfx}: ${people.ed.name} (${mac.machine.name}, ${linux.machine.name}) and ${people.alex.name} (${alexBox.machine.name}) on ${URL_}`);
  return ed;
}

// ---- Scenarios -------------------------------------------------------------------------------

async function sentAndTaken(ed) {
  console.log('\n1. A message sent and taken');
  const right = await ed('PUT', '/peers/rights', { from: mac.machine.id, to: linux.machine.id, level: 'send' });
  check('Ed gives Mac to Linux send', right.status === 200 && right.body?.ok === true, show(right));
  const text = `Hello from dev (${rid()})`;
  const sent = await send(dev, tester, text);
  check('dev sends to Tester: 202, state sent', sent.status === 202 && sent.body?.ok === true && sent.body?.state === 'sent', show(sent));
  const got = await idle(tester);
  check('Linux reports idle: peers true', got.body?.peers === true, show(got));
  const d = messageIn(got, text);
  check('the message is in peerDeliveries, from dev', d && d.from?.name === 'dev', deliveriesOf(got));
  if (d) {
    const took = await result(tester, d.id, 'took');
    check('Linux posts took: 200', took.status === 200 && took.body?.ok === true, show(took));
    const again = await result(tester, d.id, 'took');
    check('the same took again: 200', again.status === 200, show(again));
  } else {
    check('Linux posts took: 200', false, 'no delivery to take');
    check('the same took again: 200', false, 'no delivery to take');
  }
  const own = await running(dev);
  check("Mac's own reply has peers true", own.body?.peers === true, show(own));
}

async function heldForApproval(ed) {
  console.log('\n2. A message held for approval');
  const right = await ed('PUT', '/peers/rights', { from: mac.machine.id, to: linux.machine.id, level: 'ask' });
  check('Ed sets Mac to Linux ask', right.status === 200 && right.body?.ok === true, show(right));
  const text = `Needs approval (${rid()})`;
  const sent = await send(dev, tester, text);
  const requestId = sent.body?.requestId;
  check('dev sends: 202, state approval, a requestId', sent.status === 202 && sent.body?.state === 'approval' && !!requestId, show(sent));
  const before = await idle(tester);
  check('Linux reports idle: the message is not delivered', before.status === 200 && !messageIn(before, text), deliveriesOf(before));
  const list = await ed('GET', '/peers');
  const requests = Array.isArray(list.body?.requests) ? list.body.requests : [];
  const req = requests.find((r) => r.kind === 'message' && (r.id === requestId || (sent.body?.id && r.messageId === sent.body.id)));
  check('GET /respond/peers lists the request', list.status === 200 && !!req, show(list));
  const answered = await ed('POST', `/peers/requests/${req?.id ?? requestId}`, { answer: 'deliver' });
  check('Ed answers deliver', answered.status === 200 && answered.body?.ok === true, show(answered));
  const after = await idle(tester);
  const d = messageIn(after, text);
  check('Linux reports idle: delivered', !!d, deliveriesOf(after));
  if (d) await result(tester, d.id, 'took');
}

async function twoOwners() {
  console.log('\n3. Two owners');
  const sent = await send(dev, review, `To another person (${rid()})`);
  // The route's own refusal is `{ ok: false, error }`; the fleet router's 404 for a route that does not exist also
  // carries `path: "$"`, so a server without the route does not pass this check.
  const refusal = sent.status === 404 && sent.body?.ok === false && sent.body?.path === undefined;
  check(`dev sends to ${review.name}@${alexBox.machine.name}: 404`, refusal, show(sent));
  const conv = await admin('GET', '/peers/conversations');
  const list = Array.isArray(conv.body?.conversations) ? conv.body.conversations : null;
  const marks = [alexBox.machine.id, alexBox.machine.name, review.id, people.alex.name];
  const withAlex = (list ?? []).filter((c) => marks.some((m) => JSON.stringify(c).includes(m)));
  check("the admin conversations list has none with Alex's session", conv.status === 200 && list !== null && withAlex.length === 0, list === null ? show(conv) : withAlex);
  const edMarks = [linux.machine.id, linux.machine.name, tester.id];
  const ours = (list ?? []).find((c) => edMarks.some((m) => JSON.stringify(c).includes(m)));
  check("the list has Ed's Mac to Linux conversation, with messages", !!ours && Number(ours.messages) >= 1, list ?? show(conv));
}

async function flagOff() {
  console.log('\n4. The flag turned off');
  const text = `Dropped when the flag goes off (${rid()})`;
  const sent = await send(dev, tester, text);
  check('dev sends with Mac to Linux still ask: state approval', sent.status === 202 && sent.body?.state === 'approval', show(sent));
  const off = await setFlag(false);
  check('the Admin turns the flag off', off.status === 200, show(off));
  const got = await idle(tester);
  check("Linux's next reply says peers false", got.status === 200 && got.body?.peers === false, show(got));
  check('and peerDeliveries is empty', deliveriesOf(got).length === 0, deliveriesOf(got));
  const refused = await send(dev, tester, `Sent with the flag off (${rid()})`);
  check("Mac's send is refused: 403", refused.status === 403 && refused.body?.ok === false, show(refused));
  const on = await setFlag(true);
  check('the Admin turns the flag back on', on.status === 200, show(on));
  const later = await idle(tester);
  check('Linux reports idle: the dropped message is not delivered', later.status === 200 && !messageIn(later, text), deliveriesOf(later));
  // Not a check: the sender is told a held message was dropped, and notices are handed over only while it is idle.
  const told = deliveriesOf(await idle(dev)).filter((d) => d.kind === 'notice');
  for (const n of told) console.log(`      (Mac was told: ${n.text})`);
}

try {
  const ed = await setup();
  await sentAndTaken(ed);
  await heldForApproval(ed);
  await twoOwners();
  await flagOff();
} catch (e) {
  console.error(`podium-peers-demo: ${e instanceof Stop ? e.message : e?.message ?? String(e)}`);
  process.exit(1);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
