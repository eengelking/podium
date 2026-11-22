// What Chat's channel and direct-message sides share (#1034): the Admin's limits, redaction of a person's text, the rate limit, telling the
// console that something changed (a count, never text), the audit callback, and delivering text to an agent through the console's message path.
// Nothing here reads a direct message or a channel message.
import { cleanNameText, cleanPeerText } from '../storage/peerText.js';
import { overLimitWords } from '../storage/peerEdit.js';
import { scrubStored } from '../logging/redact.js';
import { CHAT_EVERYONE } from '../storage/features.js';
import { nameKey } from '../storage/rows.js';
import type { ChatSettings, ChatStoreApi, MentionState, PeopleStoreApi } from '../storage/types.js';
import { ENDED_NOTICE_MARK, type Delivery } from './protocol.js';
import type { AnswerError, DeliveryTrail } from './respond.js';
import { AdminNotices } from './chatAdminNotices.js';
import { ConcludedList } from './chatConcluded.js';
import { emptyMessage, fail, type ChatEvent, type ChatHost, type ChatScope, type ChatViewer, type Fail, type PersonRef } from './chatTypes.js';

const MINUTE = 60_000;

/**
 * What the channel side asks of the direct-message side when a person @-addresses another person's agent (#1034): the text goes to the agent's owner for
 * approval (or over a link the owner already opened). The channel never sees a conversation; it gets only whether that worked.
 */
export type AcrossAsk = (viewer: ChatViewer, sessionId: string, text: string, opts: { rate: boolean }) => Promise<{ ok: true; state: 'approval' | 'ready'; owner: string; messageId: string } | Fail>;

/**
 * What the channel side asks of the direct-message side when the author changes a channel message whose mention waits for another person's approval (#1269): the copy of its
 * text that the agent's owner was asked about, named by the id the channel kept (`copyId`), is edited or deleted with it. The channel never sees a conversation.
 */
export type AcrossChange = (viewer: ChatViewer, copyId: string, op: { kind: 'edit'; text: string } | { kind: 'delete' }) => Promise<{ ok: true } | Fail>;

/** What became of such a message, told to the channel side so the mention the person wrote can move: the person (`people.id`, #1284), the agent, and the states it may move from. */
export interface AcrossUpdate {
  personId: number;
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

/** What a text refused for its length or its rate is answered with: a channel and a Direct Message say it one way, a conversation (#1278) shorter. */
const TEXT_WORDS = {
  chat: {
    long: overLimitWords,
    fast: (perMinute: number, wait: number) => `That is more than ${perMinute} messages a minute, the limit here. Try again in ${wait} seconds.`,
  },
  convo: {
    long: (_length: number, max: number) => `A message is at most ${max} characters.`,
    fast: (_perMinute: number, wait: number) => `You are sending too fast. Wait ${wait} seconds.`,
  },
} as const;
type TextWords = keyof typeof TEXT_WORDS;

/** Why a store refuses to change a message: the same four for every audience (#1269). */
export type ChangeRefusal = 'not-found' | 'not-yours' | 'locked' | 'deleted';

/** The words of a refused change in one audience. A message an agent has been handed is said by the caller, since it may name the agents. */
export interface ChangeWords {
  notFound: string;
  notYours: string;
  deleted: string;
}

/** The refusal for a reason a store gives: not found (404), not the author's (403), deleted and locked (409, with the reason a form reads). */
export async function changeRefusal(why: ChangeRefusal, words: ChangeWords, locked: () => string | Promise<string>): Promise<Fail> {
  if (why === 'not-found') return fail(404, words.notFound);
  if (why === 'not-yours') return fail(403, words.notYours);
  return why === 'deleted' ? fail(409, words.deleted, 'deleted') : fail(409, await locked(), 'locked');
}

/** The words for a message that went to agents, which a channel and a Direct Message say the same way: it names them. */
export function sentWords(names: string[]): string {
  const who = names.length === 0 ? 'the agent' : names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `Podium has already sent this message to ${who}, so it can no longer be changed.`;
}

/** Whether the viewer may change a message, and when not, why: `mine` is the author's own live message (by id), `locked` that an agent has it, `waiting` another reason in words. */
export function changeState(mine: boolean, locked: boolean, lockedWords: () => string, waiting: string | null = null): { canChange: boolean; changeWhy: string | null } {
  if (!mine) return { canChange: false, changeWhy: null };
  const why = locked ? lockedWords() : waiting;
  return { canChange: why === null, changeWhy: why };
}

/** What an agent still in a conversation is told when another agent ended (#1283): it was concluded, or (`stays`, two or more people) it goes on without it. */
export function endedNotice(gone: string, stays = false): string {
  const rest = stays ? 'It can no longer be written to, and you should not send it anything. The people in the conversation can keep writing.' : `This direct message has been concluded. Do not try to continue it, and do not open a new direct message to ${gone}.`;
  return `${ENDED_NOTICE_MARK} ${gone} ended. ${rest}`;
}

/** The longest issue, project or milestone a post may carry, in characters. */
const MAX_LABEL = 200;

export class ChatCore {
  /** Replaced by the routes, so an event reaches the Admin log and the server log. */
  onEvent: (e: ChatEvent) => void = () => {};
  /** What an Admin's reading or stopping tells the person's reporter sessions (#1034); the report reply carries it, to the person only. */
  readonly notices: AdminNotices;
  /** Conversations concluded because an agent in them ended, for each person (#1283); memory only, never any text. */
  readonly concluded: ConcludedList;
  /** Which agent was told which agent ended, per conversation that stayed (#1283), so a second end of the same session does not tell it again. Memory only. */
  readonly noticed = new Set<string>();
  /** Replaced by the routes: the names of everyone who can sign in, for the counts a post changes for all of them. */
  people: (Pick<PeopleStoreApi, 'list'> & Partial<Pick<PeopleStoreApi, 'findByName'>>) | null = null;
  /** Replaced by the Chat service: hands a person's @ of another person's agent to the direct-message side. */
  across: AcrossAsk | null = null;
  /** Replaced by the Chat service: edits or deletes the copy of a channel message that waits for another person's approval (#1269). */
  changeAcross: AcrossChange | null = null;
  private readonly acrossHearers: ((u: AcrossUpdate) => void)[] = [];
  private rev = 0;
  private readonly recent = new Map<string, number[]>();
  private readonly following = new Map<string, (o: DeliveryOutcome) => void>();

  constructor(
    readonly host: ChatHost,
    readonly store: ChatStoreApi,
  ) {
    this.notices = new AdminNotices(host.now);
    this.concluded = new ConcludedList(host.now);
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

  /**
   * A short label a person sets on a post (its issue, project or milestone): cut to `MAX_LABEL` first, so the scan reads a bounded string, then one line with no
   * format character and no secret. Null when nothing is left, or when it is not a string (#1051).
   */
  label(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const clean = scrubStored(cleanNameText(raw.slice(0, MAX_LABEL * 4)), this.host.secrets(), true).trim().slice(0, MAX_LABEL);
    return clean || null;
  }

  /** Refuses a text longer than Chat's limit, in the audience's own words (`TextWords`), or returns null. Nothing has read the text yet. */
  tooLong(length: number, limits: ChatLimits, words: TextWords = 'chat'): Fail | null {
    return length > limits.maxChars ? fail(422, TEXT_WORDS[words].long(length, limits.maxChars)) : null;
  }

  /**
   * The checks of a person's or an agent's text that cost nothing, in the order every writing path keeps (#1051): a string with something in it (400), within Chat's length (422),
   * under the per-minute limit of `rateKey` (429, and counted; null counts none). The scan for secrets (`cleaned`) follows. `limits` is read here unless the caller has them.
   */
  async screen(raw: unknown, rateKey: string | null, limits?: ChatLimits): Promise<{ raw: string } | Fail> {
    if (typeof raw !== 'string' || !raw.trim()) return emptyMessage();
    const l = limits ?? (await this.limits());
    return this.tooLong(raw.length, l) ?? (rateKey === null ? null : this.tooFast(rateKey, l)) ?? { raw };
  }

  /** The scan for secrets, and the check that something is left: a text of nothing but characters that draw nothing is as empty as a blank one. */
  cleaned(raw: string): string | Fail {
    const text = this.redact(raw);
    return text.trim() ? text : emptyMessage();
  }

  /** Counts one post by `who` and refuses it (429) in the audience's own words when it is over the per-minute limit, or returns null when it is within. */
  tooFast(who: string, limits: ChatLimits, words: TextWords = 'chat'): Fail | null {
    const wait = this.rate(who, limits.perMinute);
    return wait === null ? null : fail(429, TEXT_WORDS[words].fast(limits.perMinute, wait));
  }

  /** Counts one post by `who` and returns the seconds to wait when it is over `perMinute`, or null when it is within. */
  private rate(who: string, perMinute: number): number | null {
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

  /** Forgets the people and agents whose posts are all older than the rate window, so the map does not keep a key for every session that ever posted. */
  forgetIdle(): void {
    const now = this.host.now();
    for (const [who, times] of this.recent) if (times.every((t) => now - t >= MINUTE)) this.recent.delete(who);
  }

  /** Tells open consoles that something in `scope` changed, once for each of `times` people it concerns: a counter and the scope, never a name, a count or text. */
  signal(scope: ChatScope, times = 1): void {
    for (let i = 0; i < times; i++) this.host.signal({ scope, rev: ++this.rev });
  }

  /** One more unread message in a thread for a person (and a mention when it is addressed to them), and the stream signal. The count is kept under the person's id (#1284). */
  count(who: PersonRef, thread: string, scope: ChatScope, mention: boolean): Promise<void> {
    return this.countMany([{ who, mention }], thread, scope);
  }

  /** `count` for several people at once, in one store call (#1309): one signal for each whose count came back. */
  async countMany(people: { who: PersonRef; mention: boolean }[], thread: string, scope: ChatScope): Promise<void> {
    if (people.length === 0) return;
    const rows = await this.store.readState.bumpMany(thread, people.map((p) => ({ personId: p.who.id, mention: p.mention })));
    const counted = new Set(rows.map((r) => r.personId));
    this.signal(scope, people.filter((p) => counted.has(p.who.id)).length);
  }

  /**
   * The person with this name now, or null: the one place a typed name becomes an id. A person whose access is revoked is still a person (their group is still theirs to an Admin), so the
   * directory of people who can sign in is tried first, then the store's own lookup by name.
   */
  async personNamed(name: string): Promise<(PersonRef & { key: string }) | null> {
    const key = nameKey(name);
    const listed = (await this.persons()).find((x) => x.key === key);
    if (listed) return listed;
    const found = await this.people?.findByName?.(name);
    return found ? { id: found.id, name: found.name, key } : null;
  }

  /** Every person who can sign in, by id, with the name as typed and folded. */
  async persons(): Promise<(PersonRef & { key: string })[]> {
    const out: (PersonRef & { key: string })[] = [];
    if (!this.people) return out;
    for (let page = 1; page <= 20; page++) {
      const got = await this.people.list({ page, pageSize: 100 });
      for (const p of got.rows) if (p.revokedAt === null) out.push({ id: p.id, name: p.name, key: nameKey(p.name) });
      if (got.rows.length < 100) break;
    }
    return out;
  }

  /**
   * Hands `text` to an agent as a message of the console (the existing delivery and consent rules: the Admin's respond flags, and what the
   * session's reporter says it accepts). Fails with words for the person, never a status code of the store.
   */
  deliver(sessionId: string, by: string, name: string, text: string, via: 'chat' | 'channel', chat = false, channel: string | null = null, byId: number | null = null, convo: string | null = null): { ok: true; delivery: Delivery } | Fail {
    if (!this.host.respondFlagsOn()) return fail(403, 'Responding is off, so Podium cannot hand a message to an agent. An Admin turns it on in Admin > Settings.');
    const out = this.host.respond.message(sessionId, by, { text }, chat, channel, { via, ...(convo ? { convo } : {}) }, byId);
    if (!out.ok) return fail(out.err.status === 429 ? 429 : out.err.status, answerWords(out.err, name, text));
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
function answerWords(err: AnswerError, name: string, text: string): string {
  // A command the reporter does not take is said in the respond route's words, not as a reporter that takes no messages (#1051).
  if (err.status === 422 && err.kind === 'command') return err.message ?? `This session's reporter does not take /${/^\s*\/(\w+)/.exec(text)?.[1] ?? 'that command'} from Podium. Send it in the terminal.`;
  if (err.status === 429) return `${name} already has 20 messages waiting. Wait until it has taken some, then send again.`;
  if (err.status === 422) return `${name}'s reporter does not take messages from Podium. Turn on its respond option on that machine.`;
  return err.error;
}
