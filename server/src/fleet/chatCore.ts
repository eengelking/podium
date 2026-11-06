// What Chat's channel and direct-message sides share (#1034): the Admin's limits, redaction of a person's text, the rate limit, telling the
// console that something changed (a count, never text), the audit callback, and delivering text to an agent through the console's message path.
// Nothing here reads a direct message or a channel message.
import { cleanPeerText } from '../storage/peerText.js';
import { scrubStored } from '../logging/redact.js';
import { CHAT_EVERYONE } from '../storage/features.js';
import { nameKey } from '../storage/rows.js';
import type { ChatSettings, ChatStoreApi, MentionState, PeopleStoreApi } from '../storage/types.js';
import type { Delivery } from './protocol.js';
import type { AnswerError, DeliveryTrail } from './respond.js';
import { AdminNotices } from './chatAdminNotices.js';
import { fail, type ChatEvent, type ChatHost, type ChatSignal, type ChatViewer, type Fail } from './chatTypes.js';

const MINUTE = 60_000;

/**
 * What the channel side asks of the direct-message side when a person @-addresses another person's agent (#1034): the text goes to the agent's owner for
 * approval (or over a link the owner already opened). The channel never sees a conversation; it gets only whether that worked.
 */
export type AcrossAsk = (viewer: ChatViewer, sessionId: string, text: string, opts: { rate: boolean }) => Promise<{ ok: true; state: 'approval' | 'ready'; owner: string } | Fail>;

/** What became of such a message, told to the channel side so the mention the person wrote can move: the person (folded), the agent, and the states it may move from. */
export interface AcrossUpdate {
  person: string;
  sessionId: string;
  from: MentionState[];
  state: MentionState;
  why: string | null;
}

export interface ChatLimits extends ChatSettings {
  /** Whether @group and @everyone are allowed (the Admin's flag). */
  everyone: boolean;
}

/** What became of a text handed to an agent, as the one who handed it wants to hear it. */
export type DeliveryOutcome = { kind: 'took' } | { kind: 'queued' } | { kind: 'not-delivered'; why: string } | { kind: 'dropped'; why: string };

const RESULT_WHY: Record<string, string> = {
  'not-taken': 'the agent did not take it',
  refused: 'the agent refused it',
  closed: 'it had closed before the agent got it',
};
const DROP_WHY: Record<string, string> = {
  discarded: 'it was discarded before the agent got it',
  'ask-closed': 'it was dropped before the agent got it',
  'session-ended': 'the agent ended before it got the message',
  'queued-session-ended': 'the agent ended while the message was queued',
  'session-deleted': 'the agent was deleted before it got the message',
  'responding-off': 'responding was turned off before the agent got the message',
};

export class ChatCore {
  /** Replaced by the routes, so an event reaches the Admin log and the server log. */
  onEvent: (e: ChatEvent) => void = () => {};
  /** What an Admin's reading or stopping tells the person's reporter sessions (#1034); the report reply carries it, to the person only. */
  readonly notices: AdminNotices;
  /** Replaced by the routes: the names of everyone who can sign in, for the counts a post changes for all of them. */
  people: Pick<PeopleStoreApi, 'list'> | null = null;
  /** Replaced by the Chat service: hands a person's @ of another person's agent to the direct-message side. */
  across: AcrossAsk | null = null;
  private readonly acrossHearers: ((u: AcrossUpdate) => void)[] = [];
  private rev = 0;
  private readonly recent = new Map<string, number[]>();
  private readonly following = new Map<string, (o: DeliveryOutcome) => void>();

  constructor(
    readonly host: ChatHost,
    readonly store: ChatStoreApi,
  ) {
    this.notices = new AdminNotices(host.now);
    host.respond.watch((t) => this.onTrail(t));
  }

  /** The channel side hears what became of a person's message to another person's agent. */
  hearAcross(fn: (u: AcrossUpdate) => void): void {
    this.acrossHearers.push(fn);
  }

  tellAcross(u: AcrossUpdate): void {
    for (const h of this.acrossHearers) h(u);
  }

  async limits(): Promise<ChatLimits> {
    return { ...(await this.store.settings.get()), everyone: this.host.featureOn(CHAT_EVERYONE) };
  }

  /** The person's text with control characters removed and secrets replaced by `[redacted]`. The caller has checked its length. */
  redact(raw: string): string {
    return scrubStored(cleanPeerText(raw), this.host.secrets(), true);
  }

  /** Counts one post by `who` and returns the seconds to wait when it is over `perMinute`, or null when it is within. */
  rate(who: string, perMinute: number): number | null {
    const now = this.host.now();
    const mine = (this.recent.get(who) ?? []).filter((t) => now - t < MINUTE);
    if (mine.length >= perMinute) {
      this.recent.set(who, mine);
      return Math.max(1, Math.ceil((mine[0]! + MINUTE - now) / 1000));
    }
    mine.push(now);
    this.recent.set(who, mine);
    return null;
  }

  /** Tells open consoles that a thread changed. `owner` and counts are for one person's badges; there is never text. */
  signal(s: ChatSignal): void {
    this.host.signal({ ...s, rev: ++this.rev });
  }

  /** One more unread message in a thread for a person (and a mention when it is addressed to them), and the stream signal with their counts. Counts only. */
  async count(who: string, thread: string, scope: 'public' | 'group' | 'dm', mention: boolean): Promise<void> {
    const row = await this.store.readState.bump(who, thread, mention);
    this.signal({ scope, owner: who, unread: row.unread, mentions: row.mentions });
  }

  /** Every person who can sign in, with the name as typed and folded. */
  async persons(): Promise<{ name: string; key: string }[]> {
    const out: { name: string; key: string }[] = [];
    if (!this.people) return out;
    for (let page = 1; page <= 20; page++) {
      const got = await this.people.list({ page, pageSize: 100 });
      for (const p of got.rows) if (p.revokedAt === null) out.push({ name: p.name, key: nameKey(p.name) });
      if (got.rows.length < 100) break;
    }
    return out;
  }

  /** Every person's name, folded, for a post to General. */
  async everyone(): Promise<string[]> {
    return (await this.persons()).map((p) => p.key);
  }

  /**
   * Hands `text` to an agent as a message of the console (the existing delivery and consent rules: the Admin's respond flags, and what the
   * session's reporter says it accepts). Fails with words for the person, never a status code of the store.
   */
  deliver(sessionId: string, by: string, name: string, text: string): { ok: true; delivery: Delivery } | Fail {
    if (!this.host.respondFlagsOn()) return fail(403, 'Responding is off, so Podium cannot hand a message to an agent. An Admin turns it on in Admin > Settings.');
    const out = this.host.respond.message(sessionId, by, { text });
    if (!out.ok) return fail(out.err.status === 429 ? 429 : out.err.status, answerWords(out.err, name));
    return { ok: true, delivery: out.delivery };
  }

  /** Follows what becomes of a delivery: `follow` hears the final outcome, and `queued` on the way. */
  watch(deliveryId: string, follow: (o: DeliveryOutcome) => void): void {
    this.following.set(deliveryId, follow);
  }

  private onTrail(t: DeliveryTrail): void {
    const f = this.following.get(t.delivery.id);
    if (!f) return;
    if (t.kind === 'dropped') {
      this.following.delete(t.delivery.id);
      f({ kind: 'dropped', why: DROP_WHY[t.why] ?? t.why });
    } else if (t.result === 'took') {
      this.following.delete(t.delivery.id);
      f({ kind: 'took' });
    } else if (t.result === 'queued') f({ kind: 'queued' });
    else {
      this.following.delete(t.delivery.id);
      f({ kind: 'not-delivered', why: RESULT_WHY[t.result] ?? t.result });
    }
  }
}

/** The words for a person when the console's message path refuses a text. */
function answerWords(err: AnswerError, name: string): string {
  if (err.status === 429) return `${name} already has 20 messages waiting. Wait until it has taken some, then send again.`;
  if (err.status === 422) return `${name}'s reporter does not take messages from Podium. Turn on its respond option on that machine.`;
  return err.error;
}
