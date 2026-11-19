// Chat's thread (#1034, mockup/podium-chat.html): the header, who may read it, who is in it, the newest messages at the bottom with
// "Earlier messages" above, and the box under them. A message's text is always a text node, never HTML. The feed keeps the
// reader's place when something is selected or a menu opens; it goes to the newest message on opening a thread and after a send.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  adminPauseOf,
  adminWho,
  AUTHOR_CHIP_TITLE,
  authorKey,
  authorMarks,
  channelDelivery,
  continuesRun,
  dayLabel,
  liveReaders,
  dmDelivery,
  crossLine,
  dmName,
  mentionChip,
  messageParts,
  sameDay,
  stamp,
  type ChatChannel,
  type AdminRead,
  type ChatOverview,
  type DirectInfo,
  type Party,
} from "../chatData";
import type { Selection, ThreadMessage, ThreadRead } from "../useChat";
import type { SessionView } from "../types";
import {
  AdminPauseBanner,
  AdminTags,
  ReadOnlyBanner,
  ReadingBanner,
  RecordLine,
} from "./ChatAdmin";
import {
  ChLink,
  ChNo,
  ChClock,
  ChWarn,
  DeliveryGlyph,
  TagGlyph,
} from "./ChatIcons";
import { linkWords } from "./ChatForms";
import { ChatMenu, agentMenu, type MenuAct } from "./ChatMenu";
import { agentState, STATE_WORD } from "./ChatSidebar";
import { ChatAvatar } from "./ChatAvatar";
import { ModelChip, StateIcon } from "./Chips";
import { familyName } from "../logic";
import { hm } from "../trafficData";
import { Monogram, YouTag } from "./People";
import { channelTag, dmTag } from "../chatData";

/** The messages and the Admin's records in time order: a record comes after every message sent before it. Earlier pages not loaded hide the records older than the oldest message shown. */
function recordsAmong(
  messages: ThreadMessage[],
  reads: AdminRead[],
  hasEarlier: boolean,
): (
  { m: ThreadMessage; rec?: undefined } | { rec: AdminRead; m?: undefined }
)[] {
  const first = messages[0]?.at ?? 0;
  const recs = reads
    .filter((r) => !hasEarlier || r.startedAt >= first)
    .sort((a, b) => a.startedAt - b.startedAt);
  const out: (
    { m: ThreadMessage; rec?: undefined } | { rec: AdminRead; m?: undefined }
  )[] = [];
  let i = 0;
  for (const m of messages) {
    while (i < recs.length && recs[i]!.startedAt < m.at)
      out.push({ rec: recs[i++]! });
    out.push({ m });
  }
  while (i < recs.length) out.push({ rec: recs[i++]! });
  return out;
}

/** How long the list stays "off" after it draws something that is not announced. */
const QUIET_MS = 150;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Whether the viewer wrote this message: a channel says so itself; a Direct Message is yours when a person with your name sent it. */
function mineOf(m: ThreadMessage, me: string): boolean {
  if (m.channel) return m.channel.mine;
  const d = m.direct!;
  return (
    d.from.kind === "person" && d.from.name.toLowerCase() === me.toLowerCase()
  );
}

type Row =
  | { k: "msg"; m: ThreadMessage }
  | { k: "rec"; rec: AdminRead }
  | { k: "day"; at: number }
  | { k: "new" };

/** The rows of the list: the messages and records in time order, a day divider before the first message of each day, and the New line before the first unread one. */
function rowsOf(
  items: ReturnType<typeof recordsAmong>,
  newId: string | null,
): Row[] {
  const rows: Row[] = [];
  let prev: number | null = null;
  for (const it of items) {
    if (it.rec) {
      rows.push({ k: "rec", rec: it.rec });
      continue;
    }
    if (prev === null || !sameDay(prev, it.m.at))
      rows.push({ k: "day", at: it.m.at });
    prev = it.m.at;
    if (it.m.id === newId) rows.push({ k: "new" });
    rows.push({ k: "msg", m: it.m });
  }
  return rows;
}

/** A fenced block: plain text in a monospace block that scrolls sideways, with the language word and a Copy button (the clipboard can be refused). */
function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => void (timer.current && clearTimeout(timer.current)),
    [],
  );
  const done = (next: "copied" | "manual") => {
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2500);
  };
  const copy = () => {
    const clip =
      typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clip) return done("manual");
    clip.writeText(text).then(
      () => done("copied"),
      () => done("manual"),
    );
  };
  return (
    <div className="ch-code" data-testid="chat-code">
      <div className="ch-code-h">
        <span className="ch-code-lang">{lang ?? ""}</span>
        <button type="button" className="btn sm ch-copy" onClick={copy}>
          {state === "copied"
            ? "Copied"
            : state === "manual"
              ? "Select and copy"
              : "Copy"}
        </button>
      </div>
      <pre
        tabIndex={0}
        /* NOSONAR S6845: a focusable scroll region, so the arrow keys scroll it */ role="region"
        aria-label={lang ? `Code, ${lang}` : "Code"}
      >
        <code>{text}</code>
      </pre>
    </div>
  );
}

function Text({ text }: { text: string }) {
  const parts = messageParts(text);
  return (
    <>
      {parts.map((p, i) => {
        if (p.kind === "code")
          return <CodeBlock key={i} text={p.text} lang={p.lang} />;
        if (p.kind === "mention")
          return (
            <span key={i} className="ch-mention">
              {p.text}
            </span>
          );
        if (p.kind === "inline")
          return (
            <code key={i} className="ch-inline">
              {p.text}
            </code>
          );
        if (p.kind === "redacted")
          return (
            <span
              key={i}
              className="rd"
              title="Replaced on the sending machine. The original never left it."
            >
              {p.text}
            </span>
          );
        // The line break that sits against a block is the block's own edge, not a blank line.
        let t = p.text;
        if (parts[i - 1]?.kind === "code") t = t.replace(/^\r?\n/, "");
        if (parts[i + 1]?.kind === "code") t = t.replace(/\r?\n$/, "");
        return t ? t : null;
      })}
    </>
  );
}

function Message({
  m,
  all,
  me,
  now,
  paused,
  owner,
  across,
  heldBy,
  people,
  machineOf,
  sessions,
  cont,
}: {
  m: ThreadMessage;
  all: ThreadMessage[];
  me: string;
  now: number;
  paused: boolean;
  owner: string;
  across: boolean;
  heldBy?: string;
  people: readonly string[];
  machineOf: (ref: string) => string | null;
  sessions: Record<string, SessionView>;
  cont: boolean;
}) {
  const c = m.channel;
  const d = m.direct;
  const mine = mineOf(m, me);
  const name = mine ? "You" : c ? c.authorName : d!.from.name;
  let re: string | null = null;
  if (c?.replyTo) {
    const target = all.find((x) => x.id === c.replyTo)?.channel;
    re = target
      ? target.mine
        ? "you"
        : target.authorName
      : "an earlier message";
  }
  const dl = c
    ? channelDelivery(c)
    : dmDelivery(d!, paused, owner, undefined, across, heldBy);
  const text = (c ?? d)!.text;
  const marks =
    c && !mine ? authorMarks(c, people, machineOf(c.authorRef)) : null;
  // The avatar: you are the inverted disc, another person a ring and a disc, an agent a tile in its model's color with its state.
  const isAgent =
    !mine && (c ? c.authorKind !== "person" : d!.from.kind === "agent");
  const ref = c ? c.authorRef : (d!.from.sessionId ?? "");
  const session = isAgent ? sessions[ref] : undefined;
  const avatar = isAgent ? (
    <ChatAvatar
      kind="agent"
      name={name}
      size={40}
      family={session?.modelFamily}
      state={agentState(sessions, ref, null, false)}
    />
  ) : (
    <ChatAvatar
      kind={mine ? "you" : "person"}
      name={mine ? me : name}
      size={40}
    />
  );
  const when = new Date(m.at).toLocaleString();
  const failed = dl.icon === "no";
  return (
    <li
      className={`ch-msg${mine ? " mine" : ""}${cont ? " cont" : " first"}${re ? " reply" : ""}`}
      data-testid="chat-message"
    >
      {cont ? (
        <span className="ch-gut" aria-hidden="true" title={when}>
          {hm(m.at)}
        </span>
      ) : (
        <span className="ch-gut">{avatar}</span>
      )}
      <div className="ch-col">
        {!cont && (
          <div className="ch-mh">
            <span className={`who${mine ? " me" : ""}`}>
              <bdi>{name}</bdi>
              {marks && (
                <>
                  {" "}
                  <span className="chip" title={AUTHOR_CHIP_TITLE}>
                    {marks.chip}
                  </span>
                  {marks.warns.map((w) => (
                    <span key={w.text}>
                      {" "}
                      <span className="chip warn" title={w.title}>
                        <ChWarn />
                        {w.text}
                      </span>
                    </span>
                  ))}
                </>
              )}
              {c?.authorOwner && !mine && (
                <span className="re">
                  {" "}
                  orchestrator of <bdi>{c.authorOwner}</bdi>
                </span>
              )}
              {re && (
                <span className="re">
                  {" "}
                  replying to <bdi>{re}</bdi>
                </span>
              )}
            </span>
            {session && (
              <ModelChip
                family={session.modelFamily}
                model={session.model}
                label={`Agent · ${familyName(session.modelFamily, session.model)}`}
              />
            )}
            <span className="at" title={when}>
              {stamp(m.at, now)}
            </span>
          </div>
        )}
        {cont && re && (
          <div className="ch-mh">
            <span className="who re">
              replying to <bdi>{re}</bdi>
            </span>
          </div>
        )}
        <div className="ch-tx">
          <Text text={text} />
        </div>
        {c && c.mentions.length > 0 && (
          <div className="ch-st">
            {c.mentions.map((x, i) => {
              const chip = mentionChip(x);
              return (
                <span
                  key={`${x.typed}${i}`}
                  className={`s${chip.kind === "done" ? " done" : chip.kind === "wait" ? " wait" : chip.kind === "bad" ? " bad" : ""}`}
                >
                  {chip.kind === "done" ? (
                    <StateIcon kind="done" />
                  ) : chip.kind === "run" ? (
                    <StateIcon kind="running" />
                  ) : chip.kind === "wait" ? (
                    <ChClock />
                  ) : (
                    <ChNo />
                  )}
                  <span>{chip.text}</span>
                </span>
              );
            })}
          </div>
        )}
        <div className="ch-st">
          <span
            className={`s ds${dl.wait ? " wait" : ""}${failed ? " bad" : ""}`}
          >
            <DeliveryGlyph icon={dl.icon} />
            <span>{dl.text}</span>
          </span>
        </div>
      </div>
    </li>
  );
}

export interface ThreadProps {
  sel: Selection;
  overview: ChatOverview;
  channel: ChatChannel | null;
  direct: DirectInfo | null;
  thread: ThreadRead;
  sessions: Record<string, SessionView>;
  now: number;
  /** Confirmations and errors, above the scroll area. */
  alert: ReactNode;
  /** The message box, under the feed. */
  composer: ReactNode;
  /** Moves to the newest message when it changes: the thread opened, or the person sent. */
  scrollToken: string;
  menu: string | null;
  onMenu: (key: string | null, by: "button" | "context") => void;
  onClose: (restoreFocus: boolean) => void;
  onPick: (key: string, act: MenuAct) => void;
  onBack: () => void;
  /** The person an Admin reads, or null. The thread is read only while it is set. */
  readAs: string | null;
  /** The server's clock now, for hiding a reading whose time has passed. */
  serverNow: number;
}

export function ChatThread(p: ThreadProps) {
  const { overview: o, thread: t } = p;
  const body = useRef<HTMLDivElement>(null);
  const near = useRef(true);
  const grew = useRef<number | null>(null);
  const newest = t.messages[t.messages.length - 1]?.id ?? null;
  const oldest = t.messages[0]?.id ?? null;
  const lastNewest = useRef<string | null>(null);
  const lastOldest = useRef<string | null>(null);
  const lastToken = useRef<string | null>(null);
  // Which thread this is, so what is remembered about one (its New line, what it announced) is not carried to another.
  const threadKey =
    p.channel?.thread ??
    p.direct?.thread ??
    (p.sel.kind === "channel" ? p.sel.id : `${p.sel.a}|${p.sel.b}`);
  // The New line: the first message that was unread when the thread opened. It is decided once, on the first read of the thread that
  // has loaded, because the thread is marked read right after and the overview's count then drops to zero.
  const newLine = useRef<{ key: string; id: string | null; decided: boolean }>({
    key: "",
    id: null,
    decided: false,
  });
  if (newLine.current.key !== threadKey)
    newLine.current = { key: threadKey, id: null, decided: false };
  if (!newLine.current.decided && t.loaded) {
    const unreadNow = p.channel
      ? p.channel.unread + p.channel.mentions
      : p.direct
        ? p.direct.unread + p.direct.mentions
        : 0;
    newLine.current.decided = true;
    newLine.current.id =
      unreadNow > 0 && unreadNow < t.messages.length
        ? (t.messages[t.messages.length - unreadNow]?.id ?? null)
        : null;
  }
  // The live region: a message that arrives while the thread is open is announced. The first read, the earlier pages a person asks for, a
  // message they sent and a record line are not, so the list says "off" for the commit that draws them and "polite" again right after.
  const sig = `${threadKey}|${t.loaded}|${t.messages.length}|${oldest}|${newest}|${t.reads.length}`;
  const seen = useRef<{
    sig: string;
    key: string;
    newest: string | null;
    loaded: boolean;
  } | null>(null);
  const [, settle] = useState(0);
  const was = seen.current;
  let announce = false;
  if (
    was &&
    was.key === threadKey &&
    was.loaded &&
    t.loaded &&
    was.newest !== null &&
    newest !== was.newest
  ) {
    const at = t.messages.findIndex((x) => x.id === was.newest);
    announce =
      at >= 0 && t.messages.slice(at + 1).some((x) => !mineOf(x, o.me.name));
  }
  // A commit that draws what is not announced holds the list "off" for a moment, so a render right behind it does not turn it back on early.
  const hold = useRef(false);
  const quiet = !announce && (hold.current || was?.sig !== sig);
  useEffect(() => {
    if (!quiet) return;
    hold.current = true;
    const id = setTimeout(() => {
      hold.current = false;
      settle((n) => n + 1);
    }, QUIET_MS);
    return () => clearTimeout(id);
  }, [quiet, sig]);
  useLayoutEffect(() => {
    seen.current = { sig, key: threadKey, newest, loaded: t.loaded };
  });

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    if (lastToken.current !== p.scrollToken && t.loaded) {
      // Opened, or sent: the newest message is in view.
      lastToken.current = p.scrollToken;
      el.scrollTop = el.scrollHeight;
    } else if (grew.current !== null && oldest !== lastOldest.current) {
      // Earlier messages came in above: stay on what was being read.
      el.scrollTop += el.scrollHeight - grew.current;
    } else if (newest !== lastNewest.current && near.current) {
      el.scrollTop = el.scrollHeight;
    }
    grew.current = null;
    lastNewest.current = newest;
    lastOldest.current = oldest;
  });

  const unreadable = t.error?.status === 403 && p.sel.kind === "dm";
  const dmHead = t.head;
  const fresh =
    p.sel.kind === "dm"
      ? o.agents.find((x) => x.sessionId === (p.sel as { b: string }).b)?.name
      : undefined;
  const title = p.channel
    ? p.channel.name
    : p.direct
      ? dmName(p.direct)
      : dmHead?.a && dmHead.b
        ? dmName({ a: dmHead.a, b: dmHead.b, cross: dmHead.cross })
        : (fresh ?? "Direct message");
  const back = (
    <button type="button" className="btn sm ch-back" onClick={p.onBack}>
      Back to the list
    </button>
  );

  if (unreadable) {
    return (
      <section className="ch-thread" aria-labelledby="th-h">
        {back}
        <div className="ch-head">
          <h2 id="th-h">Direct message</h2>
        </div>
        <div className="ch-blank" data-testid="chat-unreadable">
          <b>
            Only the person who owns this conversation and an Admin can read it.
          </b>
          <p className="hint">
            Messages can hold source code and paths, so the text is not open to
            everyone who can see the console. {t.error?.text}
          </p>
        </div>
      </section>
    );
  }

  const parties: Party[] = p.direct
    ? [p.direct.a, p.direct.b]
    : dmHead?.a && dmHead.b
      ? [dmHead.a, dmHead.b]
      : [];
  const agents = parties.filter((x) => x.kind === "agent");
  const cross = (p.direct?.cross ?? dmHead?.cross) || null;
  // General and a public channel are readable by everyone, so an Admin reading someone's conversations has nothing to be told about in them (#1035).
  const publicChannel = p.sel.kind === "channel" && p.sel.id !== "group";
  const ro = p.readAs !== null && !publicChannel;
  const ownerName = dmHead?.owner ?? p.direct?.owner ?? p.readAs ?? o.me.name;
  // A conversation between two agents has the viewer in it as the third person; one with the person has them as a party.
  const person =
    parties.find((x) => x.kind === "person") ??
    (ro
      ? ({ name: ownerName } as Party)
      : o.me.person
        ? ({ name: o.me.name } as Party)
        : undefined);
  const machines = [...new Set(agents.map((x) => x.machine))];
  const tag = p.channel
    ? channelTag(p.channel)
    : p.direct
      ? dmTag(p.direct)
      : null;
  const scope = ro
    ? cross && agents[0]
      ? `Only ${cross.person}, ${cross.owner} and an Admin can read this.`
      : p.sel.kind === "channel"
        ? `Only ${p.readAs} and ${p.readAs}'s own orchestrators, subagents and forks can post here. You are reading it as an Admin.`
        : `Only ${ownerName} and an Admin can read this.`
    : cross && agents[0]
      ? crossLine(cross, agents[0].name)
      : p.sel.kind === "channel"
        ? p.sel.id === "general"
          ? "Everyone signed in to this server can read and post here."
          : p.sel.id !== "group"
            ? "Every person and Admin signed in to this server can read and post here. An orchestrator reads or posts here only when an @ called it in during the last hour, and sees at most that hour. A subagent does not post here; its orchestrator does."
            : "Only you and your own orchestrators, subagents and forks can read and post here."
        : "Only you and an Admin can read this. The two agents and you are the only ones in it. It is removed when every agent session in it has ended.";
  const trips = dmHead?.roundTrips ?? p.direct?.roundTrips;
  const total = t.total;
  const sub =
    p.sel.kind === "channel"
      ? p.sel.id === "general"
        ? "Everyone signed in to this server"
        : p.sel.id !== "group"
          ? p.channel?.openedBy
            ? `Opened by ${p.channel.openedBy}`
            : null
          : ro
            ? `${p.readAs}'s own orchestrators and subagents`
            : `You and your ${plural(o.agents.length, "orchestrator")} and subagents`
      : machines.join(" and ");
  // What an Admin did or is doing here: the people in the thread are told, and an Admin's pause shows to all.
  const readers = ro
    ? []
    : liveReaders(
        p.channel?.adminReading ?? p.direct?.adminReading,
        p.serverNow,
      );
  const pause = p.channel
    ? p.channel.id === "group" && p.channel.paused
      ? adminPauseOf({ paused: true, pausedByAdmin: p.channel.pausedByAdmin })
      : null
    : adminPauseOf({
        ...(p.direct ?? {}),
        ...(dmHead
          ? {
              paused: dmHead.paused || p.direct?.paused,
              pausedBy: dmHead.pausedBy ?? p.direct?.pausedBy,
              pausedByAdmin: dmHead.pausedByAdmin ?? p.direct?.pausedByAdmin,
            }
          : {}),
        cross: dmHead?.cross ?? p.direct?.cross ?? null,
      });
  const also = cross
    ? cross.viewerIs === "sender"
      ? cross.owner
      : cross.person
    : null;
  // Where an author runs: the overview's agent when it lists it, else the console's session; null when neither does (an ended session).
  const machineOf = (ref: string): string | null =>
    o.agents.find((x) => x.sessionId === ref)?.machine ??
    p.sessions[ref]?.machine?.name ??
    null;
  // Who is in the conversation, for the introduction a thread with no messages shows; the viewer, or the person an Admin reads as, is always one of them.
  const introWho = [
    ...new Set([
      ro ? ownerName : o.me.name,
      ...(p.sel.kind === "dm"
        ? parties.map((x) => x.name)
        : p.sel.id === "group"
          ? o.agents.slice(0, 3).map((x) => x.name)
          : []),
    ]),
  ];
  const rows = rowsOf(
    recordsAmong(t.messages, t.reads, t.older !== null),
    newLine.current.id,
  );
  const conts = continuesRun(
    rows.map((r) =>
      r.k === "msg"
        ? { author: authorKey(r.m), at: r.m.at }
        : { author: null, at: 0 },
    ),
  );

  return (
    <section
      className="ch-thread"
      aria-labelledby="th-h"
      data-testid="chat-thread"
    >
      {back}
      <div className="ch-head">
        <h2 id="th-h" tabIndex={-1}>
          <span className="nm">
            <bdi>{title}</bdi>
          </span>
          {p.channel?.link && (
            <span className="ch-link" data-testid="chat-link-chip">
              <ChLink />
              {linkWords(p.channel.link)}
            </span>
          )}
        </h2>
        <div className="sub">
          {sub && <span>{sub}</span>}
          <span>{plural(total, "message")}</span>
          {tag && (
            <span className={`tag${tag.warn ? " warn" : ""}`}>
              <TagGlyph icon={tag.icon} /> {tag.text}
            </span>
          )}
          <AdminTags readers={readers} pause={pause} />
        </div>
        {p.channel?.kind === "public" && p.channel.description && (
          <div className="ch-desc" data-testid="chat-desc">
            {p.channel.description}
          </div>
        )}
        <div className="sub">
          <span>{scope}</span>
        </div>
        {p.sel.kind === "dm" &&
          trips &&
          trips.cap > 0 &&
          agents.length === 2 && (
            <div className="sub">
              <span>
                Agents addressing each other: {trips.used} of {trips.cap} round
                trips. At {trips.cap},{" "}
                {dmHead?.owner ?? p.direct?.owner ?? "its owner"} approves the
                next one, so agents cannot keep going on their own.
              </span>
            </div>
          )}
      </div>
      {p.sel.kind === "dm" && parties.length > 0 && (
        <div className="ch-who" aria-label="In this conversation">
          {agents.map((a) => {
            const kind = agentState(p.sessions, a.sessionId, a.status, a.live);
            const key = `h:${a.sessionId}`;
            return (
              <span
                className="ch-chipwrap"
                key={key}
                onContextMenu={(e) => {
                  e.preventDefault();
                  p.onMenu(key, "context");
                }}
              >
                <button
                  type="button"
                  className="m"
                  data-more={key}
                  aria-haspopup="menu"
                  aria-expanded={p.menu === key}
                  title={`${a.name}, ${STATE_WORD[kind]}. Actions`}
                  onClick={() =>
                    p.onMenu(p.menu === key ? null : key, "button")
                  }
                >
                  <StateIcon kind={kind} />
                  <bdi>{a.name}</bdi>
                </button>
                {p.menu === key && (
                  <ChatMenu
                    spec={agentMenu(a.name, a.sessionId, kind, false)}
                    onPick={(act) => p.onPick(key, act)}
                    onClose={p.onClose}
                  />
                )}
              </span>
            );
          })}
          {person && (
            <span className="m">
              <Monogram name={person.name} size="sm" />
              <bdi>{person.name}</bdi>{" "}
              {person.name.toLowerCase() === o.me.name.toLowerCase() && (
                <YouTag kind="person" />
              )}
            </span>
          )}
        </div>
      )}
      {ro && (
        <ReadOnlyBanner
          owner={cross ? cross.owner : ownerName}
          also={cross ? cross.person : null}
        />
      )}
      <ReadingBanner readers={readers} also={also} now={p.now} />
      {pause && (
        <AdminPauseBanner
          name={pause.name}
          group={p.sel.kind === "channel"}
          you={
            ro &&
            pause.name !== null &&
            pause.name.toLowerCase() === (o.me.actor ?? o.me.name).toLowerCase()
          }
        />
      )}
      <div className="ch-alert">{p.alert}</div>
      <div
        className="ch-body"
        ref={body}
        role="region"
        tabIndex={0} /* NOSONAR S6845: a focusable scroll region, by design */
        aria-label="Messages, oldest first"
        onScroll={(e) => {
          const el = e.currentTarget;
          near.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {t.error && !unreadable && (
          <div className="errbox" role="alert">
            Could not load the messages: {t.error.text}.{" "}
            {t.messages.length ? "The ones below may be out of date. " : ""}It
            reads again when something changes.
          </div>
        )}
        {!t.loaded ? (
          <div className="hint">Loading…</div>
        ) : (
          <div className="ch-flow">
            <div className="ch-earlier">
              <span role="status">
                Showing {t.messages.length} of {total}
              </span>
              {t.older && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={t.loadingEarlier}
                  onClick={() => {
                    grew.current = body.current?.scrollHeight ?? null;
                    void t.loadEarlier();
                  }}
                >
                  Earlier messages
                </button>
              )}
            </div>
            <div
              role="log"
              aria-label="Messages"
              aria-live={quiet ? "off" : "polite"}
              aria-relevant="additions"
              aria-atomic="false"
            >
              <ol className="ch-msgs">
                {rows.map((r, i) =>
                  r.k === "rec" ? (
                    <RecordLine
                      key={`rec-${r.rec.admin}-${r.rec.startedAt}-${r.rec.kind ?? "read"}`}
                      r={r.rec}
                    />
                  ) : r.k === "day" ? (
                    <li key={`day-${r.at}`} className="ch-day">
                      <span>{dayLabel(r.at, p.now)}</span>
                    </li>
                  ) : r.k === "new" ? (
                    <li key="new" className="ch-newline">
                      <span>New</span>
                    </li>
                  ) : (
                    <Message
                      key={r.m.id}
                      m={r.m}
                      all={t.messages}
                      cont={conts[i]!}
                      sessions={p.sessions}
                      people={o.people.map((x) => x.name)}
                      machineOf={machineOf}
                      me={o.me.name}
                      now={p.now}
                      across={cross !== null}
                      heldBy={pause ? adminWho(pause.name) : undefined}
                      paused={dmHead?.paused ?? p.direct?.paused ?? false}
                      owner={dmHead?.owner ?? p.direct?.owner ?? o.me.name}
                    />
                  ),
                )}
              </ol>
            </div>
            {t.messages.length === 0 && (
              <div className="ch-intro" data-testid="chat-intro">
                <div className="ch-intro-av" aria-hidden="true">
                  {introWho.map((n) => (
                    <Monogram key={n} name={n} size="lg" />
                  ))}
                </div>
                <h3>
                  This is the start of <bdi>{title}</bdi>
                </h3>
                <p>
                  {sub && p.sel.kind === "channel" ? `${sub}.` : scope}
                  {p.sel.kind === "channel" && !ro
                    ? " Say something, or type @ to hand work to an agent."
                    : ""}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
      {p.composer}
    </section>
  );
}
