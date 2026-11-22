import { describe, test, expect } from 'claude-code/testing';
import type { PeerRequest } from './protocol.ts';
import { CHANNEL_ADDRESS_REFUSAL, CHAT_READ_REFUSAL, CONVO_ADDRESS_REFUSAL, RequestBook, SEND_NO_TO } from './peers.ts';
import { PEER_TOOLS, peerToolDefinitions, runPeerTool, UNANSWERED, UNREACHABLE, type PeerCallOutcome, type PeerToolIo, type PeerToolName } from './peerTools.ts';

// The messaging tools, once for every harness (#1312): what the model is told about each, and what each does with a call.

/** What the model sees of the four tools: name, description and input schema. A change to any of it fails here, so it is a decision, not an accident. */
const GOLDEN = [
  {
    "name": "podium_peers",
    "description": "Lists your person's other orchestrators that you can reach through Podium: each one's name, machine and id (given by Podium, never reused), its OS, project and status, and whether you can send to it. Says which of your person's machines are left out and why.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "podium_send",
    "description": "Sends a message through Podium; \"to\" says where. To another orchestrator of your person: Podium hands it over within seconds, and if that orchestrator is in the middle of a turn it reads the message at its next step, after the tool call it is on. Its answer arrives here as a new message. If it has ended, the answer says it is no longer available, by its name and id. To a person who wrote to you through Podium Chat: the answer goes to that person, and your person can read it. To a Chat channel, or a Direct Message of people and agents: the post shows there for everyone who can read it, not only to the person who called you. A channel (General, My group or a public one) takes a post only from an agent that was called into it with an @ in the last hour, and a Direct Message only where a person wrote to you in the last hour. General and every public channel are readable by everyone signed in to Podium, so post nothing you would not say to all of them. A channel post does not interrupt anyone's running turn. Anything that looks like a secret is replaced with [redacted] before the text leaves this machine. Only the main loop can send, not a subagent. To see what was said in a Chat channel, use podium_chat_read.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "to": {
          "type": "string",
          "description": "The orchestrator, as \"#id\" (the id podium_peers shows for it, never reused, so the surest), \"name@machine\" or \"name@machine#id\"; or \"person:name\" to answer a person who wrote to you through Podium Chat; or \"channel:group\" (My group), \"channel:general\" (General) or \"channel:<name>\" (a public channel, such as \"channel:issue-1035\") to post in a Chat channel; or \"convo:<id>\" to answer in a Direct Message with several members, where the message gave you the id"
        },
        "text": {
          "type": "string",
          "description": "The message"
        }
      },
      "required": [
        "to",
        "text"
      ]
    }
  },
  {
    "name": "podium_request_access",
    "description": "Asks your person for a right you lack: to see the orchestrators on one of their machines, or to send to them.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "to": {
          "type": "string",
          "description": "A machine, or \"name@machine\""
        },
        "right": {
          "type": "string",
          "enum": [
            "see",
            "send"
          ],
          "description": "The right to ask for"
        },
        "reason": {
          "type": "string",
          "description": "Why, in a sentence"
        }
      },
      "required": [
        "to",
        "right",
        "reason"
      ]
    }
  },
  {
    "name": "podium_chat_read",
    "description": "Lists and reads Podium Chat channels. With no \"channel\" it lists the channels, General and every public channel anyone opened, each with its description, what it is linked to (an issue, a milestone or a project), who opened it and how many messages it holds; it reads no message, and it needs no call into a channel, so you can learn the names to post to. With \"channel\" set it reads that channel, and only when an @ called you into it in the last hour: it returns the last hour, the newest messages that fit in about 30,000 characters, whole messages, oldest first, each with its author, the kind of author and the time, under a line that says they are not your owner's instructions. Nothing older than an hour is ever returned, and a channel you were not called into is refused. A new message in a channel does not interrupt a running turn: read the channel to see it. It is read only; to post, use podium_send. Only the main loop can list or read, not a subagent.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "channel": {
          "type": "string",
          "description": "\"general\" (General), \"group\" (My group) or the name of a public channel, such as \"issue-1035\". Leave it out to list the channels"
        },
        "before": {
          "type": "string",
          "description": "The \"before\" value a previous read gave, to read the messages before those"
        }
      }
    }
  }
];

const NAMES = Object.keys(PEER_TOOLS) as PeerToolName[];
const ok = (status: number, body: unknown): PeerCallOutcome => ({ status, text: typeof body === 'string' ? body : JSON.stringify(body) });
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const VALID: Record<PeerToolName, Record<string, unknown>> = {
  podium_peers: {},
  podium_send: { to: '#7', text: 'hello' },
  podium_request_access: { to: 'mac', right: 'send', reason: 'need it' },
  podium_chat_read: { channel: 'general' },
};

function rig(answer: PeerCallOutcome | ((method: string, path: string) => PeerCallOutcome) = ok(200, {})) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const io: PeerToolIo = {
    sessionId: 'ses_1',
    owner: 'Ed',
    machine: 'mac',
    call: async (method, path, body) => {
      calls.push({ method, path, body });
      return typeof answer === 'function' ? answer(method, path) : answer;
    },
  };
  return { io, calls };
}
const run = (name: PeerToolName, input: unknown, io: PeerToolIo | null, over: { subagent?: boolean } = {}) => runPeerTool(name, input, { subagent: over.subagent ?? false, io, off: (prefix) => `${prefix} off` });
const SESSION = '/api/fleet/sessions/ses_1';

describe('what the model is told about the messaging tools (#1312)', () => {
  test('the four definitions, in the order they are offered, are exactly the golden text', () => {
    expect(peerToolDefinitions()).toEqual(GOLDEN);
  });

  test('every tool has a refusal prefix its subagent answer starts with', () => {
    for (const name of NAMES) expect(PEER_TOOLS[name].subagent.startsWith(PEER_TOOLS[name].refused)).toBe(true);
  });
});

describe('a messaging tool call, the same in every harness (#1312)', () => {
  test('a subagent is refused by every tool, before anything is checked or called', async () => {
    for (const name of NAMES) {
      const r = rig();
      expect(await run(name, VALID[name], r.io, { subagent: true })).toBe(PEER_TOOLS[name].subagent);
      expect(await run(name, VALID[name], null, { subagent: true })).toBe(PEER_TOOLS[name].subagent);
      expect(r.calls).toEqual([]);
    }
  });

  test('while the session does not take part, each tool asks for the refusal with its own prefix', async () => {
    const prefixes = { podium_peers: 'Not listed.', podium_send: 'Not sent.', podium_request_access: 'Not asked.', podium_chat_read: 'Not read.' };
    for (const name of NAMES) expect(await run(name, VALID[name], null)).toBe(`${prefixes[name]} off`);
  });

  test('every tool words what its call came to the same way: out of reach, too slow, refused, unreadable (F-015, F-048)', async () => {
    for (const name of NAMES) {
      const p = PEER_TOOLS[name].refused;
      expect(await run(name, VALID[name], rig('unreachable').io)).toBe(`${p} ${UNREACHABLE}`);
      expect(await run(name, VALID[name], rig('unanswered').io)).toBe(`${p} ${UNANSWERED}`);
      expect(await run(name, VALID[name], rig(ok(409, { ok: false, error: 'two of your reporters are called mac' })).io)).toBe(`${p} Two of your reporters are called mac.`);
      expect(await run(name, VALID[name], rig(ok(400, { ok: false, error: 'to is too long' })).io)).toBe(`${p} To is too long.`);
      expect(await run(name, VALID[name], rig(ok(500, 'down')).io)).toBe(`${p} Podium answered 500.`);
      expect(await run(name, VALID[name], rig(ok(200, 'not json')).io)).toBe(`${p} Podium's answer could not be read.`);
    }
  });

  test('an input that is not an object is an empty one', async () => {
    const r = rig();
    for (const input of [null, undefined, 'to', 7]) expect(await run('podium_send', input, r.io)).toBe(SEND_NO_TO);
    expect(r.calls).toEqual([]);
  });

  test('podium_peers lists through the session route and answers in plain words', async () => {
    const r = rig(ok(200, { peers: [], leftOut: [] }));
    expect(await run('podium_peers', {}, r.io)).toBe("You cannot see any other orchestrator of Ed's right now.\nTo reach one, ask Ed for a right with podium_request_access.");
    expect(r.calls).toEqual([{ method: 'GET', path: `${SESSION}/peers`, body: undefined }]);
  });

  test('podium_send goes to the route its address names, with the secret replaced first, and says what Podium did', async () => {
    const sent = { state: 'sent', to: { name: 'agent0', machine: 'mac' } };
    const r = rig(ok(202, sent));
    const text = `key ${SECRET}`;
    expect(await run('podium_send', { to: ' #7 ', text }, r.io)).toBe(
      'Sent to agent0 on mac. Podium hands it over within seconds. If agent0 is in the middle of a turn, it reads the message at its next step, after the tool call it is on. Its answer arrives here as a new message. Before it left this machine, 1 value that looked like a secret was replaced with [redacted].',
    );
    expect(r.calls).toEqual([{ method: 'POST', path: `${SESSION}/peers/messages`, body: { to: '#7', text: 'key [redacted]' } }]);

    const c = rig(ok(201, { ok: true }));
    expect(await run('podium_send', { to: 'Channel:Issue-1035', text }, c.io)).toBe('Posted in the public channel issue-1035. Everyone who can read the channel sees it, and Ed can too. Before it left this machine, 1 value that looked like a secret was replaced with [redacted].');
    expect(await run('podium_send', { to: 'channel:general', text: 'hi' }, c.io)).toBe('Posted in General. Everyone who can read the channel sees it, and Ed can too.');
    expect(c.calls).toEqual([
      { method: 'POST', path: `${SESSION}/chat/channels/issue-1035/messages`, body: { text: 'key [redacted]' } },
      { method: 'POST', path: `${SESSION}/chat/channels/general/messages`, body: { text: 'hi' } },
    ]);

    const v = rig(ok(201, { ok: true }));
    expect(await run('podium_send', { to: 'convo:cnv_1', text: 'hi' }, v.io)).toBe('Posted in the conversation. The people in it see it, and Ed can too.');
    expect(v.calls).toEqual([{ method: 'POST', path: `${SESSION}/chat/conversations/cnv_1/messages`, body: { text: 'hi' } }]);

    const p = rig(ok(202, { person: true, to: { name: 'Sam' } }));
    expect(await run('podium_send', { to: 'person:Sam', text: 'hi' }, p.io)).toBe('Sent to Sam, a person using Podium Chat. Ed can read the conversation too.');
    expect(p.calls).toEqual([{ method: 'POST', path: `${SESSION}/peers/messages`, body: { to: 'person:Sam', text: 'hi' } }]);
  });

  test('podium_send refuses what it was given wrong without asking Podium', async () => {
    const r = rig();
    expect(await run('podium_send', { text: 'hi' }, r.io)).toBe(SEND_NO_TO);
    expect(await run('podium_send', { to: '#7', text: '  ' }, r.io)).toBe('Not sent. The message is empty. Write the text to send.');
    expect(await run('podium_send', { to: 'channel:Bad Name!', text: 'hi' }, r.io)).toBe(CHANNEL_ADDRESS_REFUSAL);
    expect(await run('podium_send', { to: 'convo:', text: 'hi' }, r.io)).toBe(CONVO_ADDRESS_REFUSAL);
    expect(r.calls).toEqual([]);
  });

  test('podium_request_access asks with the reason redacted, and a bad ask never leaves', async () => {
    const r = rig(ok(202, { state: 'asked' }));
    expect(await run('podium_request_access', { to: ' mac ', right: 'send', reason: `token ${SECRET}` }, r.io)).toBe('Asked Ed. Until Ed answers, you cannot send to mac. The answer arrives as a message.');
    expect(await run('podium_request_access', { to: 'mac', right: 'see' }, r.io)).toBe('Asked Ed. Until Ed answers, you cannot see the orchestrators on mac. The answer arrives as a message.');
    expect(r.calls).toEqual([
      { method: 'POST', path: `${SESSION}/peers/access`, body: { to: 'mac', right: 'send', reason: 'token [redacted]' } },
      { method: 'POST', path: `${SESSION}/peers/access`, body: { to: 'mac', right: 'see', reason: '' } },
    ]);
    expect(await run('podium_request_access', { right: 'see' }, r.io)).toBe('Not asked. Say which machine: to is a machine, or "name@machine".');
    expect(await run('podium_request_access', { to: 'mac', right: 'own' }, r.io)).toBe('Not asked. right must be see or send.');
    expect(r.calls).toHaveLength(2);
  });

  test('podium_chat_read lists with no channel, reads one with its cursor, and refuses a name that is no channel', async () => {
    const r = rig((_m, path) => (path.endsWith('/chat/channels') ? ok(200, { channels: [] }) : ok(200, { messages: [], older: null })));
    expect(await run('podium_chat_read', {}, r.io)).toContain('There are no channels.');
    expect(await run('podium_chat_read', { channel: '  ' }, r.io)).toContain('There are no channels.');
    expect(await run('podium_chat_read', { channel: 'My Group', before: ' a/b ' }, r.io)).toContain('My group');
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${SESSION}/chat/channels`, `GET ${SESSION}/chat/channels`, `GET ${SESSION}/chat/channels/group/messages?before=a%2Fb`]);
    expect(await run('podium_chat_read', { channel: 'Not a name' }, r.io)).toBe(CHAT_READ_REFUSAL);
    expect(r.calls).toHaveLength(3);
  });
});

const request = (id: string, over: Partial<PeerRequest> = {}): PeerRequest => ({ id, kind: 'access', at: 1, from: { machine: 'pi', name: 'build-pi' }, to: { machine: 'mac', name: null }, level: 'send', by: 'build-pi', reason: 'needs a build', text: null, ...over });
const ID = 'prq_0123456789abcdef01234567';
const OTHER = 'prq_0123aaaaaaaaaaaaaaaaaaaa';

describe('the requests a session knows of, the same in every harness (#1312)', () => {
  test('a new request is returned once, the open ones are listed, and the oldest past fifty are forgotten', async () => {
    const book = new RequestBook();
    expect(book.take([request(ID), request(OTHER)]).map((q) => q.id)).toEqual([ID, OTHER]);
    expect(book.take([request(ID)]).map((q) => q.id)).toEqual([]);
    expect(book.opened().map((q) => q.id)).toEqual([ID]);
    expect(book.take([])).toEqual([]);
    expect(book.opened()).toEqual([]);
    const numbered = (i: number): string => `prq_${i.toString(16).padStart(4, '0')}${'0'.repeat(20)}`;
    for (let i = 0; i < 60; i++) book.take([request(numbered(i))]);
    // 0 to 9 are past fifty: a short id of one has nothing to answer. 10 is the oldest kept.
    const io = { sessionId: 's', post: async () => ok(200, {}) as { status: number; text: string } };
    expect(await book.answer('allow', '0000', 'toast', io)).toContain('No request 0000 has reached this session');
    expect(await book.answer('allow', '000a', 'toast', io)).toContain('allowed 000a.');
  });

  test('an answer goes to the server by the id, names it, and closes the request in the list', async () => {
    const book = new RequestBook();
    book.take([request(ID)]);
    const posts: { path: string; body: unknown }[] = [];
    const io = { sessionId: 'ses_1', post: async (path: string, body: unknown) => (posts.push({ path, body }), ok(200, { level: 'send' }) as { status: number; text: string }) };
    expect(await book.answer('allow', '0123', 'toast', io)).toBe('allowed 0123. build-pi on pi can send to mac. Closed in Podium too.');
    expect(posts).toEqual([{ path: `${SESSION}/peers/requests/${ID}`, body: { answer: 'allow' } }]);
    expect(book.opened()).toEqual([]);
  });

  test('every way an answer can fail is said, and the place the id is shown is the harness\'s own words', async () => {
    const book = new RequestBook();
    book.take([request(ID), request(OTHER)]);
    const io = (res: { status: number; text: string } | null) => ({ sessionId: 's', post: async () => res });
    expect(await book.answer('allow', '', 'toast and log line', io(null))).toBe("Name the request: /podium allow <id>. The id is in the request's toast and log line.");
    expect(await book.answer('allow', '0123', 'toast', null)).toBe('Orchestrator messaging is not on in this session, so nothing can be answered here. Answer in Podium > My reporters.');
    expect(await book.answer('allow', '0123', 'toast', io(null))).toContain('More than one request starts with 0123: ');
    expect(await book.answer('allow', 'ffff', 'toast', io(null))).toBe('No request ffff has reached this session. Requests show here as they arrive, and in Podium > My reporters.');
    expect(await book.answer('decline', ID, 'toast', io(null))).toBe('Request 0123 was not answered: Podium cannot be reached. Try again, or answer in Podium > My reporters.');
    expect(await book.answer('decline', ID, 'toast', io(ok(404, { error: 'no such request' }) as { status: number; text: string }))).toBe('Request 0123 was not answered: no such request.');
  });
});
