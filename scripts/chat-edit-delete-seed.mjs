#!/usr/bin/env node
// Seeds a throwaway Podium server's My group with the messages the Chat edit and delete menu has to tell apart (#1269): messages that mention no agent
// (changeable), one that mentions an agent (sent to it, so locked) and an optional second one for the keyboard walk. Run it after scripts/podium-peers-seed.mjs,
// which makes the person and the live reporters and prints the name and token. Never point it at a server you use: it signs in as that person and posts.
import { fileURLToPath } from 'node:url';

export const HELP = `Usage: node scripts/chat-edit-delete-seed.mjs --url <server> --name <person> --token <person token> [--agent <name>]

Signs in as the person and posts into My group: a message with no @ (can be edited and deleted), one that mentions the agent (locked once sent),
and two more with no @ so the arrow keys have several messages of yours to walk through. Prints each message's id and whether it can be changed.

  --url    the throwaway Podium server, such as http://127.0.0.1:4391 (required)
  --name   the person's name, as scripts/podium-peers-seed.mjs printed it (required)
  --token  the person's token, as it printed it (required)
  --agent  the agent to mention (default: the first one with a name starting "tester")
  -h       show this help`;

const arg = (argv, flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : dflt;
};

/** Signs in and returns a function that calls the browser routes with the cookie. Sign-in clears an old cookie and sets a new one under the same name: the last value per name is kept. */
async function signIn(base, name, token) {
  const res = await fetch(new URL('/api/fleet/respond/sign-in', base), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Podium-Respond': '1' }, body: JSON.stringify({ name, token }) });
  if (!res.ok) throw new Error(`sign-in answered ${res.status}`);
  const jar = new Map();
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return async (method, path, body) => {
    const r = await fetch(new URL(`/api/fleet/respond${path}`, base), { method, headers: { 'Content-Type': 'application/json', 'X-Podium-Respond': '1', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) return void console.log(HELP);
  const url = arg(argv, '--url');
  const name = arg(argv, '--name');
  const token = arg(argv, '--token');
  if (!url || !name || !token) {
    console.error(HELP);
    process.exit(2);
  }
  const call = await signIn(url, name, token);
  const book = await call('GET', '/chat/addresses?q=');
  const wanted = (arg(argv, '--agent', 'tester') ?? 'tester').toLowerCase();
  const agent = (book.body.addresses ?? []).find((a) => a.typed.toLowerCase().startsWith(wanted));
  if (!agent) throw new Error(`no address starts with "${wanted}": ${JSON.stringify(book.body).slice(0, 300)}`);
  const posts = [
    ['no @, so it can still be changed', 'Good. Start on the chat mockup tomorrow.'],
    [`mentions ${agent.typed}, so it is sent to the agent and locked`, `@${agent.typed} yes, run it on every adapter and report the counts.`],
    ['no @, so it can still be changed', 'Keep the container up until I say.'],
    ['no @, so it can still be changed', 'Never mind, I will restart the container myself.'],
  ];
  for (const [why, text] of posts) {
    const out = await call('POST', '/chat/channels/group/messages', { text });
    console.log(`${out.status} ${out.body.message?.id ?? JSON.stringify(out.body)}  ${why}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
