// A conversation of people and agents (#1278, DECISIONS 74, mockup/podium-chat-person-dm.html): the thread of a Direct Message that is between people, with no agent
// in it unless a person added one. It is read only by its members; an Admin reads one only when an agent is in it, and then everyone in it is told. Message text is
// only ever drawn as text. The page reads it again whenever the console's content-free `chat` signal moves.
import { useEffect, useRef, useState } from "react";
import { RespondError } from "../respondApi";
import { failReason } from "../useMyPeers";
import { conversationAddresses, conversationDelivery, conversationFor, conversationName, conversationSummary, dayLabel, liveReaders, plain, sameDay, stamp, type Address, type ChatApi, type ChatOverview, type ConversationInfo, type ConversationMessage } from "../chatData";
import { useConversation } from "../useChat";
import type { SessionView } from "../types";
import { AdminTags } from "./ChatAdmin";
import { ChatAvatar } from "./ChatAvatar";
import { ChatComposer } from "./ChatComposer";
import { ChatMembersPanel, ChatMembersStack, type Member } from "./ChatMembers";
import { agentState } from "./ChatSidebar";
import { StateIcon } from "./Chips";
import { Editor, Text, DeleteMessageDialog } from "./ChatThread";
import { ChAt, ChClock, ChGroup, ChLock, ChNo, ChTrash } from "./ChatIcons";
import { hm } from "../trafficData";

const KEEP_ALIVE_MS = 15_000;

/** The members of a conversation as the shared members panel lists them. */
function conversationMembers(c: ConversationInfo, sessions: Record<string, SessionView>): Member[] {
  return c.members.map((m, i) => ({
    key: `${m.kind}:${m.name}:${i}`,
    kind: m.you ? "you" : m.kind,
    name: m.name,
    line: m.kind === "agent" ? "Agent" : m.you ? "You" : m.addedBy ? `Added by ${m.addedBy}` : "Started it",
    state: null,
    word: null,
    ...(m.kind === "agent" ? { family: Object.values(sessions).find((s) => s.name === m.name)?.modelFamily } : {}),
  }));
}

export interface ConversationProps {
  api: ChatApi;
  id: string;
  overview: ChatOverview;
  sessions: Record<string, SessionView>;
  rev: number;
  now: number;
  /** An Admin is reading this person's conversations: nothing can be sent. */
  readAs: string | null;
  members: boolean;
  onMembers: (open: boolean) => void;
  onBack: () => void;
  /** The conversation was left or no longer exists: the page goes back to the list. */
  onGone: () => void;
  /** Opens the dialog that adds people or agents to this conversation. */
  onAdd: () => void;
  /** The page reads again (the overview's counts). */
  onChanged: () => Promise<void>;
  onSaid: (words: string) => void;
}

export function ChatConversation(p: ConversationProps) {
  const t = useConversation(p.api, p.id, p.rev);
  const o = p.overview;
  const listed = (o.conversations ?? []).find((c) => c.id === p.id) ?? null;
  const info = t.info ?? listed;
  const ro = p.readAs !== null;
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; error: string | null; busy: boolean } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; error: string | null; busy: boolean } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const near = useRef(true);

  // The conversation is gone for this viewer (left, deleted, or never theirs): back to the list.
  useEffect(() => {
    if (t.loaded && t.error?.status === 404) p.onGone();
  }, [t.loaded, t.error, p]);

  // Read up to the newest message when something new is open.
  const newest = t.messages[t.messages.length - 1]?.id ?? null;
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

  // Stay at the bottom while new messages arrive, unless the person has scrolled up.
  useEffect(() => {
    const el = body.current;
    if (el && near.current) el.scrollTop = el.scrollHeight;
  }, [t.messages.length, p.id]);

  if (!info) return <section className="ch-thread" aria-label="Conversation"><div className="hint">{t.error ? `Could not load the conversation: ${t.error.text}.` : "Loading…"}</div></section>;

  const title = conversationName(info);
  const members = conversationMembers(info, p.sessions);
  const readers = ro ? [] : liveReaders(listed?.adminReading ?? [], p.now);
  const fail = (e: unknown, what: string, stays: string): string => (e instanceof RespondError && e.status < 500 ? e.message : `Could not ${what}: ${plain(failReason(e))}. ${stays} Try again.`);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    setErr(null);
    try {
      const r = await p.api.sendConversation(p.id, text);
      setDraft("");
      if (r.skipped.length) setErr(`Sent, but ${r.skipped.join(" ")}`);
      p.onSaid("Message sent.");
      await t.reload();
      await p.onChanged();
    } catch (e) {
      setErr(fail(e, "send", "Nothing was sent."));
    }
    setSending(false);
  };

  const save = async (id: string, text: string) => {
    const was = t.messages.find((m) => m.id === id)?.text ?? "";
    if (text.trim() === was.trim()) return setEditing(null);
    setEditing({ id, error: null, busy: true });
    try {
      const r = await p.api.editConversationMessage(p.id, id, text.trim());
      t.patch(r.message);
      setEditing(null);
    } catch (e) {
      setEditing({ id, error: fail(e, "save", "Your message is unchanged."), busy: false });
    }
  };

  const doDelete = async () => {
    if (!deleting) return;
    const { id } = deleting;
    setDeleting({ id, error: null, busy: true });
    try {
      const r = await p.api.deleteConversationMessage(p.id, id);
      t.patch(r.message);
      setDeleting(null);
    } catch (e) {
      setDeleting({ id, error: fail(e, "delete", "Your message is still there."), busy: false });
    }
  };

  const leave = async () => {
    setLeaving(true);
    try {
      await p.api.leaveConversation(p.id);
      p.onSaid("You left the conversation.");
      await p.onChanged();
      p.onGone();
    } catch (e) {
      setErr(fail(e, "leave", "You are still in it."));
    }
    setLeaving(false);
  };

  const stopped = ro ? "You are reading as an Admin, so nothing can be sent here." : !o.me.person ? "Only a person in a conversation can write in it." : null;
  const rows: React.ReactNode[] = [];
  let prev: ConversationMessage | null = null;
  for (const m of t.messages) {
    if (!prev || !sameDay(prev.createdAt, m.createdAt)) rows.push(<li key={`day-${m.createdAt}`} className="ch-day"><span>{dayLabel(m.createdAt, p.now)}</span></li>);
    const cont = !!prev && prev.author.name === m.author.name && prev.author.kind === m.author.kind && m.createdAt - prev.createdAt < 5 * 60_000 && sameDay(prev.createdAt, m.createdAt);
    const mine = m.author.you;
    const gone = m.deletedAt !== null;
    const isEditing = editing?.id === m.id;
    rows.push(
      <li key={m.id} className={`ch-msg${mine ? " mine" : ""}${cont ? " cont" : " first"}${isEditing ? " editing" : ""}`} data-testid="chat-message">
        {cont ? (
          <span className="ch-gut" aria-hidden="true" title={new Date(m.createdAt).toLocaleString()}>{hm(m.createdAt)}</span>
        ) : (
          <span className="ch-gut"><ChatAvatar kind={mine ? "you" : m.author.kind} name={mine ? o.me.name : m.author.name} size={40} /></span>
        )}
        <div className="ch-col">
          {!cont && (
            <div className="ch-mh">
              <span className={`who${mine ? " me" : ""}`}><bdi>{mine ? "You" : m.author.name}</bdi></span>
              <span className="at" title={new Date(m.createdAt).toLocaleString()}>{stamp(m.createdAt, p.now)}</span>
            </div>
          )}
          {gone ? (
            <div className="ed-del"><ChTrash />{mine ? "You deleted this message." : `${m.author.name} deleted this message.`}</div>
          ) : isEditing ? (
            <Editor initial={m.text} error={editing!.error} busy={editing!.busy} onSave={(text) => void save(m.id, text)} onCancel={() => setEditing(null)} />
          ) : (
            <div className="ch-tx">
              <Text text={m.text} />
              {m.editedAt ? <span className="ed-edited" title={new Date(m.editedAt).toLocaleString()}>edited {hm(m.editedAt)}</span> : null}
            </div>
          )}
          {!gone && !isEditing && (() => {
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
          {mine && !gone && !isEditing && !ro && (
            <div className="ch-own">
              {m.canChange ? (
                <>
                  <button type="button" className="btn sm" onClick={() => { setDeleting(null); setEditing({ id: m.id, error: null, busy: false }); }}>Edit message</button>
                  <button type="button" className="btn sm" onClick={() => { setEditing(null); setDeleting({ id: m.id, error: null, busy: false }); }}>Delete message</button>
                </>
              ) : m.changeWhy ? (
                <span className="hint">{m.changeWhy}</span>
              ) : null}
            </div>
          )}
        </div>
      </li>,
    );
    prev = m;
  }

  const withAgent = info.hasAgent;
  const addresses = conversationAddresses(info);
  return (
    <>
      <section className="ch-thread" aria-labelledby="th-h" data-testid="chat-conversation">
        <button type="button" className="btn sm ch-back" onClick={p.onBack}>Back to the list</button>
        <div className="ch-head">
          <div className="ch-head-top">
            <h2 id="th-h" tabIndex={-1}>
              <span className="nm"><bdi>{title}</bdi></span>
            </h2>
            <ChatMembersStack members={members} open={p.members} controls="ch-members" onToggle={() => p.onMembers(!p.members)} />
          </div>
          <div className="sub">
            <span data-testid="chat-conversation-privacy">
              {withAgent ? null : <ChLock />}{" "}
              {withAgent ? conversationSummary(info) : `Only ${info.members.length === 2 ? "you and " + title : "you and these " + (info.members.length - 1) + " people"} can read this. An Admin cannot.`}
            </span>
            <span>{t.total} {t.total === 1 ? "message" : "messages"}</span>
            <AdminTags readers={readers} pause={null} />
          </div>
        </div>
        {ro && (
          <div className="ch-nav ro crit" role="status">
            <b>Reading {p.readAs}&apos;s conversation as an Admin. You cannot send here.</b> {p.readAs} and everyone in it is told while you read, and a line stays in the conversation afterward.
          </div>
        )}
        <div
          className="ch-scroll"
          ref={body}
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
                {t.older && <button type="button" className="btn sm" disabled={t.loadingEarlier} onClick={() => void t.loadEarlier()}>Earlier messages</button>}
              </div>
              <div role="log" aria-label="Messages" aria-live="polite" aria-relevant="additions" aria-atomic="false">
                <ol className="ch-msgs">{rows}</ol>
              </div>
              {t.messages.length === 0 && (
                <div className="ch-intro" data-testid="chat-intro">
                  <h3>This is the start of <bdi>{title}</bdi></h3>
                  <p>{withAgent ? "Say something. Each agent in it is handed what you write." : "Say something. They see it in Chat when they next open it, whether or not an orchestrator of theirs is running."}</p>
                </div>
              )}
            </div>
          )}
        </div>
        {!ro && (
          <div className="ch-actions">
            <button type="button" className="btn sm" disabled={leaving} onClick={() => void leave()}>Leave conversation</button>
          </div>
        )}
        <ChatComposer
          label={`Message ${title}`}
          draft={draft}
          onDraft={setDraft}
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
        />
        {deleting && (() => {
          const m = t.messages.find((x) => x.id === deleting.id);
          return m ? <DeleteMessageDialog text={m.text} who={`It will be deleted for everyone in ${title}.`} error={deleting.error} busy={deleting.busy} onCancel={() => setDeleting(null)} onDelete={() => void doDelete()} /> : null;
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


