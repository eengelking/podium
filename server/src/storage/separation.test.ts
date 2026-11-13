// The Chat page's hard rule (#1034): a direct message's text (`peer_messages`) is never copied into, merged with or returned together with a
// channel's (`group_messages`, `public_messages`), and the reverse. The contract (`contractChat.ts`) shows it by what the reads return; this
// shows it by what the code can reach: a channel store never names the direct message table, and a direct message store never names a channel's.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string): string => readFileSync(path.join(here, f), 'utf8');

describe('direct messages and channel messages stay apart', () => {
  for (const adapter of ['sqlite', 'postgres', 'mariadb']) {
    it(`${adapter}: the channel store never names peer_messages, and the message store never names a channel table`, () => {
      const chat = read(`${adapter}/chat.ts`);
      expect(chat).toContain('group_messages');
      expect(chat).not.toMatch(/peer_messages|peer_requests|PeerMessages/);
      for (const f of [`${adapter}/peerMessages.ts`, `${adapter}/peerService.ts`, `${adapter}/peers.ts`]) {
        expect(read(f), f).not.toMatch(/group_messages|public_messages|chat_read_state/);
      }
    });
  }

  it('offers no channel method that takes or returns a message row of a conversation, and no conversation method that takes a channel', () => {
    const types = read('types.ts');
    const channel = types.slice(types.indexOf('export interface ChannelStoreApi'), types.indexOf('export interface ChatStoreApi'));
    expect(channel).toContain('ChannelMessage');
    expect(channel).not.toMatch(/MessageRow|ConversationSummary|MessagePage/);
    const peers = types.slice(types.indexOf('export interface PeerStoreApi'), types.indexOf('/** Who wrote a channel message.'));
    expect(peers.length).toBeGreaterThan(100);
    expect(peers).not.toMatch(/ChannelMessage|ChannelPage|ChatStoreApi/);
  });
});
