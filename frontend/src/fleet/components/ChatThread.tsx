// Chat's thread (#1034, mockup/podium-chat.html): the header, who may read it, who is in it, the newest messages at the bottom with
// "Earlier messages" above, and the box under them. A message's text is always a text node, never HTML. The feed keeps the
// reader's place when something is selected or a menu opens; it goes to the newest message on opening a thread and after a send.
import { useLayoutEffect, useRef, type ReactNode } from "react";
import {
  channelDelivery,
  dmDelivery,
  dmName,
  mentionChip,
  messageParts,
  stamp,
  type ChatChannel,
  type ChatOverview,
  type DirectInfo,
  type Party,
} from "../chatData";
import type { Selection, ThreadMessage, ThreadRead } from "../useChat";
import type { SessionView } from "../types";
import { ChMsg, ChNo, ChClock, DeliveryGlyph, TagGlyph } from "./ChatIcons";
import { ChatMenu, agentMenu, type MenuAct } from "./ChatMenu";
import { agentState, STATE_WORD } from "./ChatSidebar";
import { StateIcon } from "./Chips";
import { Monogram, YouTag } from "./People";
import { channelTag, dmTag } from "../chatData";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function Text({ text }: { text: string }) {
  return (
    <>
      {messageParts(text).map((p, i) =>
        p.kind === "mention" ? (
          <span key={i} className="ch-mention">
            {p.text}
          </span>
        ) : p.kind === "redacted" ? (
          <span key={i} className="rd" title="Replaced on the sending machine. The original never left it.">
            {p.text}
          </span>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

function Message({ m, all, me, now, paused, owner }: { m: ThreadMessage; all: ThreadMessage[]; me: string; now: number; paused: boolean; owner: string }) {
  const c = m.channel;
  const d = m.direct;
  const mine = c ? c.mine : d ? d.from.kind === "person" && d.from.name.toLowerCase() === me.toLowerCase() : false;
  const name = mine ? "You" : c ? c.authorName : d!.from.name;
  let re: string | null = null;
  if (c?.replyTo) {
    const target = all.find((x) => x.id === c.replyTo)?.channel;
    re = target ? (target.mine ? "you" : target.authorName) : "an earlier message";
  }
  const dl = c ? channelDelivery(c) : dmDelivery(d!, paused, owner);
  const text = (c ?? d)!.text;
  return (
    <li className={`txt${mine ? " mine" : ""}${re ? " reply" : ""}`} data-testid="chat-message">
      <span className="at" title={new Date(m.at).toLocaleString()}>
        {stamp(m.at, now)}
      </span>
      <span className="k" role="img" aria-label="Message" title="Message">
        <ChMsg />
      </span>
      <span className="body">
        <span className={`who${mine ? " me" : ""}`}>
          {name}
          {re && <span className="re"> replying to {re}</span>}
        </span>
        <Text text={text} />
        {c && c.mentions.length > 0 && (
          <div className="ch-st">
            {c.mentions.map((x, i) => {
              const chip = mentionChip(x);
              return (
                <span key={`${x.typed}${i}`} className={`s${chip.kind === "done" ? " done" : chip.kind === "wait" ? " wait" : chip.kind === "bad" ? " bad" : ""}`}>
                  {chip.kind === "done" ? <StateIcon kind="done" /> : chip.kind === "run" ? <StateIcon kind="running" /> : chip.kind === "wait" ? <ChClock /> : <ChNo />}
                  <span>{chip.text}</span>
                </span>
              );
            })}
          </div>
        )}
        <span className={`ds${dl.wait ? " wait" : ""}`}>
          <DeliveryGlyph icon={dl.icon} />
          <span>{dl.text}</span>
        </span>
      </span>
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
  const fresh = p.sel.kind === "dm" ? o.agents.find((x) => x.sessionId === (p.sel as { b: string }).b)?.name : undefined;
  const title = p.channel ? p.channel.name : p.direct ? dmName(p.direct) : dmHead?.a && dmHead.b ? dmName({ a: dmHead.a, b: dmHead.b }) : (fresh ?? "Direct message");
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
          <b>Only the person who owns this conversation and an Admin can read it.</b>
          <p className="hint">Messages can hold source code and paths, so the text is not open to everyone who can see the console. {t.error?.text}</p>
        </div>
      </section>
    );
  }

  const parties: Party[] = p.direct ? [p.direct.a, p.direct.b] : dmHead?.a && dmHead.b ? [dmHead.a, dmHead.b] : [];
  const agents = parties.filter((x) => x.kind === "agent");
  // A conversation between two agents has the viewer in it as the third person; one with the person has them as a party.
  const person = parties.find((x) => x.kind === "person") ?? (o.me.person ? ({ name: o.me.name } as Party) : undefined);
  const machines = [...new Set(agents.map((x) => x.machine))];
  const tag = p.channel ? channelTag(p.channel) : p.direct ? dmTag(p.direct) : null;
  const scope =
    p.sel.kind === "channel"
      ? p.sel.id === "general"
        ? "Everyone signed in to this server can read and post here."
        : "Only you and your own orchestrators, subagents and forks can read and post here."
      : "Only you and an Admin can read this. The two agents and you are the only ones in it. It is removed when every agent session in it has ended.";
  const trips = dmHead?.roundTrips ?? p.direct?.roundTrips;
  const total = t.total;
  const sub =
    p.sel.kind === "channel"
      ? p.sel.id === "general"
        ? "Everyone signed in to this server"
        : `You and your ${plural(o.agents.length, "orchestrator")} and subagents`
      : machines.join(" and ");

  return (
    <section className="ch-thread" aria-labelledby="th-h" data-testid="chat-thread">
      {back}
      <div className="ch-head">
        <h2 id="th-h" tabIndex={-1}>
          <span className="nm">{title}</span>
        </h2>
        <div className="sub">
          <span>{sub}</span>
          <span>{plural(total, "message")}</span>
          {tag && (
            <span className={`tag${tag.warn ? " warn" : ""}`}>
              <TagGlyph icon={tag.icon} /> {tag.text}
            </span>
          )}
        </div>
        <div className="sub">
          <span>{scope}</span>
        </div>
        {p.sel.kind === "dm" && trips && trips.cap > 0 && agents.length === 2 && (
          <div className="sub">
            <span>
              Agents addressing each other: {trips.used} of {trips.cap} round trips. At {trips.cap}, {dmHead?.owner ?? p.direct?.owner ?? "its owner"} approves the next one, so agents cannot keep going on their own.
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
              <span className="ch-chipwrap" key={key} onContextMenu={(e) => {
                e.preventDefault();
                p.onMenu(key, "context");
              }}>
                <button type="button" className="m" data-more={key} aria-haspopup="menu" aria-expanded={p.menu === key} title={`${a.name}, ${STATE_WORD[kind]}. Actions`} onClick={() => p.onMenu(p.menu === key ? null : key, "button")}>
                  <StateIcon kind={kind} />
                  {a.name}
                </button>
                {p.menu === key && <ChatMenu spec={agentMenu(a.name, a.sessionId, kind, false)} onPick={(act) => p.onPick(key, act)} onClose={p.onClose} />}
              </span>
            );
          })}
          {person && (
            <span className="m">
              <Monogram name={person.name} size="sm" />
              {person.name} {person.name.toLowerCase() === o.me.name.toLowerCase() && <YouTag kind="person" />}
            </span>
          )}
        </div>
      )}
      <div className="ch-alert">{p.alert}</div>
      <div
        className="ch-body"
        ref={body}
        tabIndex={0}
        aria-label="Messages, oldest first"
        onScroll={(e) => {
          const el = e.currentTarget;
          near.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {t.error && !unreadable && (
          <div className="errbox" role="alert">
            Could not load the messages: {t.error.text}. {t.messages.length ? "The ones below may be out of date. " : ""}It reads again when something changes.
          </div>
        )}
        {!t.loaded ? (
          <div className="hint">Loading…</div>
        ) : (
          <>
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
            <ol className="feed" aria-label="Messages">
              {t.messages.length === 0 && <li className="empty">No messages yet. Write the first one below.</li>}
              {t.messages.map((m) => (
                <Message key={m.id} m={m} all={t.messages} me={o.me.name} now={p.now} paused={dmHead?.paused ?? p.direct?.paused ?? false} owner={dmHead?.owner ?? p.direct?.owner ?? o.me.name} />
              ))}
            </ol>
          </>
        )}
      </div>
      {p.composer}
    </section>
  );
}
