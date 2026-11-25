// A conversation of people and agents (#1278, DECISIONS 74, mockup/podium-chat-person-dm.html): the thread of a Direct Message that is between people, with no agent
// in it unless a person added one. It is read only by its members; an Admin reads one only when an agent is in it, and then everyone in it is told. Message text is
// only ever drawn as text. The page reads it again whenever the console's content-free `chat` signal moves.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { RespondError } from "../respondApi";
import type { Landing } from "../landing";
import { failReason } from "../useMyPeers";
import { conversationAddresses, conversationDelivery, conversationFor, conversationName, conversationSummary, dayLabel, liveReaders, plain, sameDay, stamp, type Address, type ChatApi, type ChatOverview, type ConversationInfo, type ConversationMessage } from "../chatData";
import { useConversation } from "../useChat";
import type { SessionView } from "../types";
import { AdminTags } from "./ChatAdmin";
import { ChatAvatar } from "./ChatAvatar";
import { ChatComposer } from "./ChatComposer";
import { ChatMembersPanel, ChatMembersStack, type Member } from "./ChatMembers";
import { agentState, ConversationAvatar } from "./ChatSidebar";
import { ChatIntro } from "./ChatIntro";
import { ChatMenu, agentMenu, messageMenu, personMenu, type MenuAct, type MenuAt } from "./ChatMenu";
import { useOwnMessageNav } from "./useOwnMessageNav";
import { StateIcon } from "./Chips";
import { Editor, Text, DeleteMessageDialog } from "./ChatThread";
import { ChAt, ChClock, ChGroup, ChInfo, ChLock, ChNo, ChTrash } from "./ChatIcons";
import { hm } from "../trafficData";

const KEEP_ALIVE_MS = 15_000;

/** The members of a conversation as the shared members panel lists them. */
function conversationMembers(c: ConversationInfo, sessions: Record<string, SessionView>): Member[] {
  return c.members.map((m, i) => ({
    key: `${m.kind}:${m.name}:${i}`,
    kind: m.you ? "you" : m.kind,
    name: m.name,
    line: m.kind === "agent" ? (m.ended ? "Agent, ended" : "Agent") : m.you ? "You" : m.addedBy ? `Added by ${m.addedBy}` : "Started it",
    state: null,
    word: m.ended ? "Ended" : null,
    ...(m.kind === "agent" ? { family: Object.values(sessions).find((s) => s.name === m.name)?.modelFamily } : {}),
  }));
}

const fail = (e: unknown, what: string, stays: string): string => (e instanceof RespondError && e.status < 500 ? e.message : `Could not ${what}: ${plain(failReason(e))}. ${stays} Try again.`);

/** What every row does, as one object that keeps its identity and acts on the page's latest props, so a row that is not drawn again is never stale (#1296). */
interface RowActs {
  onSave: (id: string, text: string) => void;
  onCancel: (id: string) => void;
  onContext: (m: ConversationMessage, e: MouseEvent<HTMLElement>) => void;
  onSender: (m: ConversationMessage, at: MenuAt) => void;
}

/** Whether the viewer wrote a message, and whether it has a menu: it stands, and the server either lets you change it or says why not (#1269, #1345). */
const hasMenu = (m: ConversationMessage): boolean => m.author.you && m.deletedAt === null && (m.canChange || !!m.changeWhy);
/** Why one of your own messages cannot be edited or deleted now, or "" when it can. */
const whyNot = (m: ConversationMessage): string => (m.deletedAt !== null ? "There is nothing left to change." : m.canChange ? "" : (m.changeWhy ?? "This message cannot be changed."));

/** One message. Its props are the message object and plain values, never an object new on each render, so `memo` skips it unless it or what it shows changed (#1296). */
const Row = memo(function Row({ m, cont, meName, now, tab, idx, marked, editing, menu, sender, acts }: { m: ConversationMessage; cont: boolean; meName: string; now: number; tab: number; idx: number; marked: boolean; editing: { error: string | null; busy: boolean } | null; menu: boolean; sender: boolean; acts: RowActs }) {
  const mine = m.author.you;
  const gone = m.deletedAt !== null;
  return (
    <li
      className={`ch-msg${mine ? " mine" : ""}${cont ? " cont" : " first"}${marked ? " menu-open ch-sel" : ""}${editing ? " editing" : ""}`}
      data-testid="chat-message"
      aria-haspopup={menu ? "menu" : undefined}
      onContextMenu={menu ? (e) => acts.onContext(m, e) : undefined}
      tabIndex={tab}
      data-roving={idx}
    >
      {cont ? (
        <span className="ch-gut" aria-hidden="true" title={new Date(m.createdAt).toLocaleString()}>{hm(m.createdAt)}</span>
      ) : (
        // A right-click on the avatar opens its sender's menu at the pointer; the keyboard reaches it from the message (Enter, the ContextMenu key, Shift+F10).
        <span
          className="ch-gut"
          onContextMenu={
            sender
              ? (e) => {
                  e.preventDefault();
                  acts.onSender(m, { x: e.clientX, y: e.clientY, from: e.currentTarget.closest("li") });
                }
              : undefined
          }
        >
          <ChatAvatar kind={mine ? "you" : m.author.kind} name={mine ? meName : m.author.name} size={40} />
        </span>
      )}
      <div className="ch-col">
        {!cont && (
          <div className="ch-mh">
            <span className={`who${mine ? " me" : ""}`}><bdi>{mine ? "You" : m.author.name}</bdi></span>
            <span className="at" title={new Date(m.createdAt).toLocaleString()}>{stamp(m.createdAt, now)}</span>
          </div>
        )}
        {gone ? (
          <div className="ed-del"><ChTrash />{mine ? "You deleted this message." : `${m.author.name} deleted this message.`}</div>
        ) : editing ? (
          <Editor initial={m.text} error={editing.error} busy={editing.busy} onSave={(text) => acts.onSave(m.id, text)} onCancel={() => acts.onCancel(m.id)} />
        ) : (
          <div className="ch-tx">
            <Text text={m.text} />
            {m.editedAt ? <span className="ed-edited" title={new Date(m.editedAt).toLocaleString()}>edited {hm(m.editedAt)}</span> : null}
          </div>
        )}
        {!gone && !editing && (() => {
          // Who it was for, and what became of it for each agent it was handed to (#1282). A message with no agent to hand it to keeps no such line.
          const who = conversationFor(m);
          const dl = conversationDelivery(m);
          if (!who && !dl) return null;
          return (
            <>
              {who && (
                <div className="ch-for" data-testid="chat-for">
                  {who.everyone ? <ChGroup /> : <ChAt />}
                  <span>{who.text}</span>
                </div>
              )}
              {dl && (
                <div className="ch-st" data-testid="chat-delivery">
                  <span className={`s ${dl.state}`}>
                    {dl.state === "done" ? <StateIcon kind="done" /> : dl.state === "wait" ? <ChClock /> : <ChNo />}
                    <span>{dl.text}</span>
                  </span>
                </div>
              )}
            </>
          );
        })()}
      </div>
    </li>
  );
});

export interface ConversationProps {
  api: ChatApi;
  id: string;
  overview: ChatOverview;
  sessions: Record<string, SessionView>;
  rev: number;
  /** The Chat page's clock: the date, which is all a message prints of the time, so a read does not draw the rows again. */
  now: number;
  /** The server's clock at the last read, for hiding an Admin's reading that has ended. */
  serverNow: number;
  /** The Landing the page's reads share, so the overview and this conversation are drawn once for one signal (#1311). */
  landing: Landing;
  /** An Admin is reading this person's conversations: nothing can be sent. */
  readAs: string | null;
  members: boolean;
  onMembers: (open: boolean) => void;
  onBack: () => void;
  /** The conversation was left or no longer exists: the page goes back to the list. */
  onGone: () => void;
  /** Leaves it, as the row's menu does: the page says so, or says why not, and goes back to the list. */
  onLeave: () => void;
  leaving: boolean;
  /** The page's own confirmations and errors, above the messages, as every thread has them. */
  alert: ReactNode;
  /** What is typed in the box, kept by the page for each thread so it survives a switch. */
  draft: string;
  onDraft: (text: string) => void;
  /** A sender's menu: a person's Message opens New direct message to them, an agent's opens a message to it. */
  onMessagePerson: (name: string, from: HTMLElement | null) => void;
  onMessageAgent: (sessionId: string, name: string, from: HTMLElement | null) => void;
  /** Stops an Admin's reading of this person's conversations. */
  onStopReading: () => void;
  /** Opens the dialog that adds people or agents to this conversation. */
  onAdd: () => void;
  /** The page reads again (the overview's counts). */
  onChanged: () => Promise<void>;
  onSaid: (words: string) => void;
}

export function ChatConversation(p: ConversationProps) {
  const t = useConversation(p.api, p.id, p.rev, p.landing);
  const o = p.overview;
  const listed = (o.conversations ?? []).find((c) => c.id === p.id) ?? null;
  const info = t.info ?? listed;
  const ro = p.readAs !== null;
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; error: string | null; busy: boolean } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; error: string | null; busy: boolean } | null>(null);
  const [menu, setMenu] = useState<{ key: string; at: MenuAt } | null>(null);
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const section = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const near = useRef(true);
  const grew = useRef<number | null>(null);
  const lastNewest = useRef<string | null>(null);
  const lastOldest = useRef<string | null>(null);
  const refocus = (id: string) => setFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }));

  const save = async (id: string, text: string) => {
    const was = t.messages.find((m) => m.id === id)?.text ?? "";
    if (text.trim() === was.trim()) {
      setEditing(null);
      return refocus(id);
    }
    setEditing({ id, error: null, busy: true });
    try {
      const r = await p.api.editConversationMessage(p.id, id, text.trim());
      t.patch(r.message);
      setEditing(null);
      refocus(id);
    } catch (e) {
      setEditing({ id, error: fail(e, "save", "Your message is unchanged."), busy: false });
    }
  };
  const live = useRef(save);
  useLayoutEffect(() => {
    live.current = save;
  });
  const startEdit = (id: string) => {
    setMenu(null);
    setDeleting(null);
    setEditing({ id, error: null, busy: false });
  };
  const askDelete = (id: string) => {
    setMenu(null);
    setEditing(null);
    setDeleting({ id, error: null, busy: false });
  };
  const closeMenu = (restore: boolean) => {
    const from = menu?.at.from;
    setMenu(null);
    if (restore && from) setTimeout(() => from.focus(), 0);
  };
  // A click away from an open menu closes it.
  useEffect(() => {
    if (!menu) return;
    const away = (e: Event) => {
      if (!(e.target as Element | null)?.closest?.(".ch-menu")) setMenu(null);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [menu]);

  const members = useMemo(() => (info ? conversationMembers(info, p.sessions) : []), [info, p.sessions]);
  const senderRef = (m: ConversationMessage): { person: boolean; ref: string } | null => {
    if (m.author.you) return null;
    if (m.author.kind === "person") return { person: true, ref: m.author.name };
    const sid = info?.members.find((x) => x.kind === "agent" && x.name === m.author.name)?.sessionId ?? null;
    return sid ? { person: false, ref: sid } : null;
  };
  const nav = useOwnMessageNav<ConversationMessage>({
    messages: t.messages,
    isMine: (m) => m.author.you,
    whyNot,
    hasMenu,
    hasSender: (m) => senderRef(m) !== null,
    readOnly: ro,
    saidOf: (m) => {
      const dl = conversationDelivery(m);
      const gone = m.deletedAt !== null;
      return `Your message, ${hm(m.createdAt)}: ${gone ? "You deleted this message" : plain(m.text.trim())}${!gone && m.editedAt ? ` (edited ${hm(m.editedAt)})` : ""}. ${!gone && dl ? `${plain(dl.text)}. ` : ""}${whyNot(m) || "Press E to edit or Delete to delete."}`;
    },
    focus,
    onEdit: startEdit,
    onDelete: askDelete,
    openMenu: (m, which, _by, at) => setMenu({ key: which === "own" ? `m:${m.id}` : `t:${m.id}`, at }),
    list: body,
    section,
  });
  const acts = useMemo<RowActs>(
    () => ({
      onSave: (id, text) => void live.current(id, text),
      onCancel: (id) => {
        setEditing(null);
        refocus(id);
      },
      onContext: nav.acts.onContext,
      onSender: nav.acts.onSender,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nav.acts never changes
    [],
  );

  // The conversation is gone for this viewer (left, deleted, or never theirs): back to the list.
  useEffect(() => {
    if (t.loaded && t.error?.status === 404) p.onGone();
  }, [t.loaded, t.error, p]);

  // Read up to the newest message when something new is open.
  const newest = t.messages[t.messages.length - 1]?.id ?? null;
  const oldest = t.messages[0]?.id ?? null;
  const unread = (listed?.unread ?? 0) + (listed?.mentions ?? 0);
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (ro || !o.me.person || !t.loaded || !newest || unread === 0) return;
    const mark = `${newest}|${unread}`;
    if (marked.current === mark) return;
    marked.current = mark;
    void p.api.markRead(`convo:${p.id}`, newest).catch(() => {});
  }, [p.api, p.id, ro, o.me.person, t.loaded, newest, unread]);

  // An Admin's open conversation says every 15 seconds that it is still being read.
  useEffect(() => {
    if (!ro || !t.loaded || t.error) return;
    const ping = () => {
      if (document.visibilityState === "hidden") return;
      p.api.readingConversation(p.id).catch(() => {});
    };
    const timer = setInterval(ping, KEEP_ALIVE_MS);
    document.addEventListener("visibilitychange", ping);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", ping);
    };
  }, [p.api, p.id, ro, t.loaded, t.error]);

  // The newest message is in view when something new arrives, unless the person has scrolled up; earlier messages that come in above keep the place being read.
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    if (grew.current !== null && oldest !== lastOldest.current) el.scrollTop += el.scrollHeight - grew.current;
    else if (newest !== lastNewest.current && near.current) el.scrollTop = el.scrollHeight;
    grew.current = null;
    lastNewest.current = newest;
    lastOldest.current = oldest;
  });

  if (!info) return <section className="ch-thread" aria-label="Conversation"><div className="hint">{t.error ? `Could not load the conversation: ${t.error.text}.` : "Loading…"}</div></section>;

  const title = conversationName(info);
  const readers = ro ? [] : liveReaders(listed?.adminReading ?? [], p.serverNow);

  const send = async () => {
    const text = p.draft.trim();
    if (!text) return;
    setSending(true);
    setErr(null);
    try {
      const r = await p.api.sendConversation(p.id, text);
      p.onDraft("");
      near.current = true;
      if (r.skipped.length) setErr(`Sent, but ${r.skipped.join(" ")}`);
      p.onSaid("Message sent.");
      // Both land together, so the sent message and the new counts are drawn once.
      await Promise.all([t.reload(), p.onChanged()]);
    } catch (e) {
      setErr(fail(e, "send", "Nothing was sent."));
    }
    setSending(false);
  };

  const doDelete = async () => {
    if (!deleting) return;
    const { id } = deleting;
    setDeleting({ id, error: null, busy: true });
    try {
      const r = await p.api.deleteConversationMessage(p.id, id);
      t.patch(r.message);
      setDeleting(null);
      refocus(id);
    } catch (e) {
      setDeleting({ id, error: fail(e, "delete", "Your message is still there."), busy: false });
    }
  };

  const stopped = ro ? "You are reading as an Admin, so nothing can be sent here." : !o.me.person ? "Only a person in a conversation can write in it." : null;
  const rows: ReactNode[] = [];
  let prev: ConversationMessage | null = null;
  let at = 0;
  for (const m of t.messages) {
    if (!prev || !sameDay(prev.createdAt, m.createdAt)) rows.push(<li key={`day-${m.createdAt}`} className="ch-day"><span>{dayLabel(m.createdAt, p.now)}</span></li>);
    const cont = !!prev && prev.author.name === m.author.name && prev.author.kind === m.author.kind && m.createdAt - prev.createdAt < 5 * 60_000 && sameDay(prev.createdAt, m.createdAt);
    const yours = m.author.you && !ro;
    rows.push(
      <Row
        key={m.id}
        m={m}
        cont={cont}
        meName={o.me.name}
        now={p.now}
        tab={nav.roving.itemProps(at).tabIndex}
        idx={at}
        marked={yours && (menu?.key === `m:${m.id}` || deleting?.id === m.id)}
        editing={yours && editing?.id === m.id ? editing : null}
        menu={yours && hasMenu(m) && editing?.id !== m.id}
        sender={senderRef(m) !== null}
        acts={acts}
      />,
    );
    at++;
    prev = m;
  }

  const withAgent = info.hasAgent;
  // An agent that ended for good stays listed, marked, with a line in the thread (#1283); the people in it can keep writing.
  const ended = info.members.filter((m) => m.kind === "agent" && m.ended);
  const stayers = info.members.filter((m) => m.kind === "person").map((m) => (m.you ? "You" : m.name)).join(" and ");
  const addresses = conversationAddresses(info);
  const introWho = [...new Set([o.me.name, ...info.members.filter((m) => !m.you).map((m) => m.name)])];
  const openOwn = menu?.key.startsWith("m:") ? (t.messages.find((m) => m.id === menu.key.slice(2)) ?? null) : null;
  const openSenderMsg = menu?.key.startsWith("t:") ? (t.messages.find((m) => m.id === menu.key.slice(2)) ?? null) : null;
  const openSender = openSenderMsg ? senderRef(openSenderMsg) : null;
  const senderOpts = { reading: ro };
  const pickSender = (act: MenuAct) => {
    const from = menu?.at.from ?? null;
    const m = openSenderMsg;
    setMenu(null);
    if (act !== "message" || !m || !openSender) return;
    if (openSender.person) p.onMessagePerson(m.author.name, from);
    else p.onMessageAgent(openSender.ref, m.author.name, from);
  };
  return (
    <>
      <section className="ch-thread" aria-labelledby="th-h" data-testid="chat-conversation" ref={section} onKeyDown={nav.fromBox}>
        <button type="button" className="btn sm ch-back" onClick={p.onBack}>Back to the list</button>
        <div className="ch-head">
          <div className="ch-head-top">
            <h2 id="th-h" tabIndex={-1}>
              <ConversationAvatar c={info} />
              <span className="nm"><bdi>{title}</bdi></span>
            </h2>
            {!ro && <button type="button" className="btn sm" disabled={p.leaving} onClick={p.onLeave}>Leave conversation</button>}
            <ChatMembersStack members={members} open={p.members} controls="ch-members" onToggle={() => p.onMembers(!p.members)} />
          </div>
          <div className="sub">
            <span>{t.total} {t.total === 1 ? "message" : "messages"}</span>
            {ended.map((m) => (
              <span className="tag" key={`ended-${m.name}`} data-testid="chat-conversation-ended">
                <ChNo />
                <span>
                  <bdi>{m.name}</bdi>: Ended. It can no longer be written to.
                </span>
              </span>
            ))}
            <AdminTags readers={readers} pause={null} />
          </div>
          <div className="sub">
            <span data-testid="chat-conversation-privacy">
              {withAgent ? null : <ChLock />}{" "}
              {withAgent ? conversationSummary(info) : `Only ${info.members.length === 2 ? "you and " + title : "you and these " + (info.members.length - 1) + " people"} can read this. An Admin cannot.`}
            </span>
          </div>
        </div>
        {ro && (
          <div className="ch-nav ro crit" role="status">
            <b>Reading {p.readAs}&apos;s conversation as an Admin. You cannot send here.</b> {p.readAs} and everyone in it is told while you read, and a line stays in the conversation afterward.
          </div>
        )}
        <div className="ch-alert">{p.alert}</div>
        <div
          className="ch-body"
          ref={body}
          role="region"
          tabIndex={0} /* NOSONAR S6845: a focusable scroll region, by design (the same as the thread of a channel) */
          aria-label="Messages, oldest first"
          onScroll={(e) => {
            const el = e.currentTarget;
            near.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
        >
          {t.error && t.error.status !== 404 && <div className="errbox" role="alert">Could not load the messages: {t.error.text}. It reads again when something changes.</div>}
          {!t.loaded ? (
            <div className="hint">Loading…</div>
          ) : (
            <div className="ch-flow">
              <div className="ch-earlier">
                <span role="status">Showing {t.messages.length} of {t.total}</span>
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
              <div role="log" aria-label="Messages" aria-live="polite" aria-relevant="additions" aria-atomic="false">
                <ol className="ch-msgs" {...nav.listProps}>{rows}</ol>
                {ended.length > 0 && (
                  <ol className="ch-msgs">
                    {ended.map((m) => (
                      <li className="ch-rec" key={`ended-line-${m.name}`} data-testid="chat-conversation-ended-line">
                        <ChInfo />
                        <span>
                          <bdi>{m.name}</bdi> ended. This direct message has been concluded for <bdi>{m.name}</bdi>. {stayers} can keep writing here.
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              {t.messages.length === 0 && (
                <ChatIntro who={introWho} title={title}>
                  {withAgent ? "Say something. Each agent in it is handed what you write." : "Say something. They see it in Chat when they next open it, whether or not an orchestrator of theirs is running."}
                </ChatIntro>
              )}
            </div>
          )}
        </div>
        <ChatComposer
          label={`Message ${title}`}
          draft={p.draft}
          onDraft={p.onDraft}
          off={stopped}
          offWord={ro ? "An Admin cannot send here" : "Read only"}
          note={withAgent ? "Each agent in it is handed this when its turn ends. Secrets are replaced before a message leaves this machine." : "Secrets are replaced before a message leaves this machine."}
          error={err}
          sending={sending}
          onSend={() => void send()}
          channel={withAgent && !ro ? p.id : null}
          addresses={addresses}
          loadAddresses={async () => {}}
          stateOf={(a: Address) => (a.sessionId && !a.disabled ? agentState(p.sessions, a.sessionId, null, true) : null)}
          familyOf={(a: Address) => (a.sessionId ? p.sessions[a.sessionId]?.modelFamily : undefined)}
          {...(ro ? { noteAction: <button type="button" className="btn sm" data-testid="chat-stop-reading-thread" onClick={p.onStopReading}>Stop reading</button> } : {})}
        />
        {openSender && openSenderMsg && (
          <ChatMenu
            spec={openSender.person ? personMenu(openSenderMsg.author.name, senderOpts) : agentMenu(openSenderMsg.author.name, openSender.ref, agentState(p.sessions, openSender.ref, null, false), true, senderOpts)}
            at={menu?.at}
            onPick={pickSender}
            onClose={closeMenu}
          />
        )}
        {openOwn && <ChatMenu key={openOwn.id} spec={messageMenu(openOwn)} at={menu?.at} onPick={(act) => (act === "delete-message" ? askDelete(openOwn.id) : startEdit(openOwn.id))} onClose={closeMenu} onBlocked={() => nav.setSaid(whyNot(openOwn))} closeOnScroll />}
        <span className="vh" role="status" aria-live="polite" data-testid="chat-msg-said">
          {nav.said}
        </span>
        {deleting && (() => {
          const m = t.messages.find((x) => x.id === deleting.id);
          return m ? <DeleteMessageDialog text={m.text} who={`It will be deleted for everyone in ${title}.`} error={deleting.error} busy={deleting.busy} onCancel={() => { setDeleting(null); refocus(deleting.id); }} onDelete={() => void doDelete()} /> : null;
        })()}
      </section>
      {p.members && (
        <ChatMembersPanel
          id="ch-members"
          label={title}
          members={members}
          partial={false}
          menu={null}
          mention={false}
          reading={ro}
          onMenu={() => {}}
          onMenuClose={() => {}}
          onPick={() => {}}
          onClose={() => p.onMembers(false)}
          plain
          {...(!ro && o.me.person ? { action: <button type="button" className="btn sm" onClick={p.onAdd}>Add people or agents</button> } : {})}
        />
      )}
    </>
  );
}
