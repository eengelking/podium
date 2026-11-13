// The hard rule of the Chat page (#1034): the text of a direct message (`peer_messages`) is never returned together with a channel's, and no
// group-facing or agent-facing route can return one. The rule is held three ways: the handlers are in separate files and each side's files do not
// name the other side's store; every Chat route is in the table below (a new route fails here until someone says which audience it serves); and
// chatRoutes.test.ts seeds a direct message and reads every other route for it.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string): string => readFileSync(join(here, f), 'utf8');
/** Source without comments, so a file may say in words what it must not do. */
const code = (f: string): string => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Every Chat route, by the file that registers it and who reads its answer. `dm` may return a conversation's text; nothing else may. */
const ROUTES: { file: string; method: string; path: string; audience: 'dm' | 'channel' | 'agent' | 'counts' }[] = [
  { file: 'chatRoutes.ts', method: 'get', path: '/chat', audience: 'counts' },
  { file: 'chatRoutes.ts', method: 'post', path: '/chat/read', audience: 'counts' },
  { file: 'chatChannelRoutes.ts', method: 'get', path: '/chat/channels/:channel/messages', audience: 'channel' },
  { file: 'chatChannelRoutes.ts', method: 'post', path: '/chat/channels/:channel/messages', audience: 'channel' },
  { file: 'chatChannelRoutes.ts', method: 'post', path: '/chat/channels/:channel/reading', audience: 'channel' },
  { file: 'chatChannelRoutes.ts', method: 'put', path: '/chat/channels/:channel/pause', audience: 'channel' },
  { file: 'chatChannelRoutes.ts', method: 'put', path: '/chat/channels/:channel/disconnect', audience: 'channel' },
  { file: 'chatChannelRoutes.ts', method: 'delete', path: '/chat/channels/:channel/messages', audience: 'channel' },
  { file: 'chatChannelRoutes.ts', method: 'get', path: '/chat/addresses', audience: 'channel' },
  { file: 'chatDmRoutes.ts', method: 'get', path: '/chat/dm/:a/:b/messages', audience: 'dm' },
  { file: 'chatDmRoutes.ts', method: 'post', path: '/chat/dm/:a/:b/messages', audience: 'dm' },
  { file: 'chatDmRoutes.ts', method: 'post', path: '/chat/dm/:a/:b/reading', audience: 'dm' },
  { file: 'chatDmRoutes.ts', method: 'put', path: '/chat/dm/:a/:b/link', audience: 'dm' },
  { file: 'chatDmRoutes.ts', method: 'delete', path: '/chat/dm/:a/:b', audience: 'dm' },
  { file: 'chatAgentRoutes.ts', method: 'post', path: '/sessions/:id/chat/channels/:channel/messages', audience: 'agent' },
  { file: 'chatAgentRoutes.ts', method: 'get', path: '/sessions/:id/chat/channels/:channel/messages', audience: 'agent' },
];

const REGISTER = /\b(?:browser|router)\.(get|post|put|delete|patch)\(\s*'([^']+)'/g;
const registered = (f: string): { method: string; path: string }[] => [...code(f).matchAll(REGISTER)].map((m) => ({ method: m[1]!, path: m[2]! }));

describe('Chat keeps a direct message\'s text apart from a channel\'s (#1034)', () => {
  it('has every route in the table, and nothing in the table that is not registered', () => {
    for (const file of ['chatRoutes.ts', 'chatChannelRoutes.ts', 'chatDmRoutes.ts', 'chatAgentRoutes.ts']) {
      const want = ROUTES.filter((r) => r.file === file).map((r) => `${r.method} ${r.path}`).sort();
      expect(registered(file).map((r) => `${r.method} ${r.path}`).sort(), file).toEqual(want);
    }
  });

  it('registers no Chat route anywhere else', () => {
    for (const file of ['peerRoutes.ts', 'respondRoutes.ts', 'routes.ts']) expect(code(file), file).not.toMatch(/['"`][^'"`]*\/chat\b/);
  });

  it('keeps the channel, agent and shared files from reading or writing a direct message', () => {
    // The live directory (`peers.messages.live`) is memory and holds no text; every other member of `peers.messages` reads a conversation.
    const direct = /peer_messages|sendFromPerson|ownerConversations|\.conversation\(|\.conversations\(|deleteConversation|hideConversation|showConversation|purgeHidden|\bMessageRow\b|peers\.messages(?!\.live\b)/;
    for (const file of ['chatChannels.ts', 'chatChannelRoutes.ts', 'chatAgentRoutes.ts', 'chatCore.ts', 'chatMentions.ts', 'chatTypes.ts']) {
      expect(code(file), file).not.toMatch(direct);
    }
  });

  it('keeps the direct-message files from reading or writing a channel', () => {
    const channel = /\.group\.|\.public\.|group_messages|public_messages|ChannelChat|ChannelStoreApi|ChannelMessage\b|readState\.(?:bump|post)/;
    for (const file of ['chatDirect.ts', 'chatDmRoutes.ts']) expect(code(file), file).not.toMatch(channel);
  });

  it('answers a conversation\'s text from no route but the direct-message ones', () => {
    const textRoutes = ROUTES.filter((r) => r.audience === 'dm' && r.method === 'get');
    expect(textRoutes).toHaveLength(1);
    for (const r of ROUTES.filter((x) => x.audience !== 'dm')) expect(r.path, `${r.method} ${r.path}`).not.toContain('/dm/');
  });

  it('answers an Admin a conversation\'s text from no route that does not check for a person\'s Chat (#1051)', () => {
    // Every file outside Chat and the storage adapter that reads a stored conversation's text must refuse an Admin a person's Chat (isPersonChat), because
    // only Chat records an Admin's read and tells the people in it. A new route that reads `peer_messages` fails here until it does the same.
    const reader = /\bmessages\.(?:conversation|message|page)\(/;
    const walk = (dir: string): string[] => readdirSync(join(here, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'storage' ? [] : walk(join(dir, e.name))) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [join(dir, e.name)] : []));
    const readers = ['.', '../admin'].flatMap(walk).filter((f) => !/(^|\/)chat[A-Za-z]*\.ts$/.test(f) && reader.test(code(f)));
    expect(readers.length).toBeGreaterThan(0);
    for (const f of readers) expect(code(f), f).toMatch(/\bisPersonChat\(/);
  });
});
