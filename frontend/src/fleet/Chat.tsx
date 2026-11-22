// Chat (#1034, SPEC 7.1 and 7.7, mockup/podium-chat.html): a console page laid out like Slack or Teams. It replaces Traffic (#347).
// Three audiences, three stores, never shown in one list: Channels (General for everyone signed in, My group for a person and
// their own agents), Direct Messages (read only by their owner and an Admin) and People and agents (to start a message with).
// The page reads again whenever the console's content-free `chat` signal moves `rev`. Message text is only ever drawn as text.
import { memo, useCallback, useEffect, useRef, useState } from "react";
import "./chat.css";
import "./admin/admin.css";
import { Blank } from "./components/Blank";
import { ChatComposer } from "./components/ChatComposer";
import { ChatSidebar } from "./components/ChatSidebar";
import { agentState } from "./components/ChatSidebar";
import { ChatThread, DeleteMessageDialog } from "./components/ChatThread";
import { ChatConversation } from "./components/ChatConversation";
import { ConcludedBanner } from "./components/ChatEnded";
import type { ConcludedRead } from "./useConcluded";
import { ChannelModal, DirectModal, type DirectDone } from "./components/ChatForms";
import { GoneRecordLines, ListReadingBanner, ListRecordLines } from "./components/ChatAdmin";
import type { MenuAct, MenuAt } from "./components/ChatMenu";
import { adminPauseOf, adminWho, crossNote, crossOff, dmKey, dmName, hasLink, liveReaders, ownDmWith, plain, type Address, type ChatAgent, type ChatApi, type ChatChannel, type DirectInfo } from "./chatData";
import { useAddresses, useChatOverview, useLanding, useThread, selKey, type Selection } from "./useChat";
import { RespondError } from "./respondApi";
import { failReason } from "./useMyPeers";
import type { RespondMe, SessionView } from "./types";

type Confirm = "remove-link" | "delete-dm" | "clear" | "remove-channel";

/** How often an Admin's open thread says it is still being read. */
const KEEP_ALIVE_MS = 15_000;

const GENERAL: Selection = { kind: "channel", id: "general" };

/** A conversation of people and agents is open (#1278). It has its own thread view, so it is not one of the old `Selection`s. */
type ConvoSel = { kind: "convo"; id: string };

/** What an error of a send says: the server's own words for 429, 409 and 422, and what to do for the rest. */
function sendFailure(err: unknown): string {
  if (err instanceof RespondError && (err.status === 429 || err.status === 409 || err.status === 422)) return err.message;
  return `Could not send: ${plain(failReason(err))}. Nothing was sent. Try again.`;
}

interface ChatPageProps {
  me: RespondMe | null;
  peersOn: boolean;
  sessions: Record<string, SessionView>;
  rev: number;
  api: ChatApi;
  /** Moves with the date, not the 2 second tick: the page prints a time only as a time of day or a day's name (#1311). */
  now: number;
  /** What was concluded, read once by the console for the wall and this page (#1311). */
  concluded: ConcludedRead;
  openWith?: string | null;
}

// Memoized so a commit of the console that changes nothing this page draws (the top bar's count, the tick) leaves it alone (#1311).
export const ChatPage = memo(function ChatPage(props: ChatPageProps) {
  const { me, peersOn } = props;
  let body: React.ReactNode;
  if (!peersOn) body = <Blank title="Orchestrator messaging is off">An Admin turns it on in Admin &gt; Settings &gt; Feature flags. Until then no orchestrator can message another, and Chat has nothing to show.</Blank>;
  else if (me === null) body = <div className="hint">Loading…</div>;
  else if (!me.signedIn) body = <Blank title="Sign in to use Chat">Chat shows your channels, your Direct Messages and your own agents, so it needs someone signed in. Use Sign in at the top right.</Blank>;
  else body = <ChatBody {...props} />;
  return (
    <main className="adminv" aria-label="Chat" id="podium-main">
      <div className="apage ch-fill">
        <div className="apage-in ch-page">
          <h1 className="vh">Chat</h1>
          {body}
        </div>
      </div>
    </main>
  );
});

function ChatBody(props: ChatPageProps) {
  const { api, sessions, rev } = props;
  // An Admin reads a person's conversations by choosing the person: the overview and the open thread are then that person's.
  const [readAs, setReadAs] = useState<string | null>(null);
  // The overview and the open thread answer one signal and land together, so the page is drawn once for the two (#1311).
  const landing = useLanding();
  const overview = useChatOverview(api, true, rev, readAs, landing);
  const o = overview.data;
  // The data on hand belongs to the person last read; until the chosen person's own list lands, none of it is drawn (#1051).
  const stale = !!o && overview.owner !== readAs;
  const ro = !!o && o.me.admin && readAs !== null && overview.owner === readAs;
  // A reading is hidden when its time has passed and a read has landed since, never on the clock alone (#1051).
  // A reading's end is judged by the server's clock at the last read that landed (the browser's before the first, or when the server sends none).
  const serverNow = overview.readAt || Date.now();
  // The records of a conversation that has since been deleted come once, and the server marks them seen; they stay while this page is open (#1051).
  const gone = overview.gone;
  const [picked, setPicked] = useState<((Selection & { fresh?: boolean }) | ConvoSel) | null>(null);
  const [pane, setPane] = useState<"side" | "thread">("side");
  // `at` is where a sender's menu (a `t:` key, on an avatar in the thread) hangs; a row's own menu hangs under the row.
  const [menu, setMenu] = useState<{ key: string; at?: MenuAt } | null>(null);
  // A Mention asks the message box to write an address at the caret; each request has its own number (#1235).
  const [mention, setMention] = useState<{ n: number; text: string } | null>(null);
  // The members panel is closed when a conversation opens and is not remembered (#1236).
  const [members, setMembers] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  // /clear in a message to the person's own agent asks first (#1051); the question belongs to the open conversation.
  const [clearAsk, setClearAsk] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(0);
  const [busy, setBusy] = useState(false);
  // The New channel form (`edit` is the channel whose description it changes) and the New direct message form (#1035).
  const [form, setForm] = useState<{ kind: "channel"; edit: ChatChannel | null } | { kind: "dm"; person?: string; search?: string; addTo?: { id: string; members: string[] } } | null>(null);
  const formFrom = useRef<HTMLElement | null>(null);
  const formFallback = useRef<string | null>(null);
  // Counts the times a thread was opened; each one asks for the focus to move to its heading (see the effect below).
  const [focusAsk, setFocusAsk] = useState(0);
  const keepBtn = useRef<HTMLButtonElement>(null);
  // Editing and deleting a message of one's own (#1269): the one being edited with the server's refusal, the one whose delete is asked about,
  // and a request to put the focus back on a message when either ends (each has its own number).
  const [editing, setEditing] = useState<{ id: string; error: string | null; busy: boolean } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; error: string | null; busy: boolean } | null>(null);
  const [focusMsg, setFocusMsg] = useState<{ id: string; n: number } | null>(null);

  // The selected row, or General. A conversation that left the list (deleted, or every agent ended) falls back to General.
  let sel: Selection = picked && picked.kind !== "convo" ? picked : GENERAL;
  // A Direct Message that was concluded because an agent in it ended stays open with a banner that says so, until the person leaves it (#1283).
  const { concluded } = props;
  const endedHere = picked?.kind === "dm" && !picked.fresh ? (concluded.items.find((c) => c.thread === picked.key) ?? null) : null;
  if (o && picked?.kind === "dm" && !picked.fresh && !endedHere && !o.directs.some((d) => dmKey(d) === picked.key)) sel = GENERAL;
  // A channel an Admin removed leaves the list, and the page falls back to General.
  if (o && picked?.kind === "channel" && !o.channels.some((c) => c.id === picked.id)) sel = GENERAL;
  // A conversation of people and agents is open while the overview lists it; one left or deleted falls back to General (#1278).
  const cv: ConvoSel | null = picked?.kind === "convo" && o?.conversations?.some((c) => c.id === picked.id) ? picked : null;
  const key = cv ? `v:${cv.id}` : selKey(sel)!;
  useEffect(() => {
    setMembers(false);
    setEditing(null);
    setDeleting(null);
  }, [key, readAs]);
  const channel: ChatChannel | null = o && sel.kind === "channel" ? (o.channels.find((c) => c.id === sel.id) ?? null) : null;
  // A message to an agent not yet talked to has the agent's id as its key; once the server lists the conversation it is that row.
  const direct: DirectInfo | null = o && sel.kind === "dm" ? (o.directs.find((d) => dmKey(d) === sel.key) ?? (picked?.kind === "dm" && picked.fresh ? (ownDmWith(o.directs, sel.b) ?? null) : null)) : null;
  const rowKey = cv ? key : direct ? `d:${dmKey(direct)}` : key;
  // An Admin with no person of their own, who has not chosen anything, has no thread open: the area says what to do (#1238).
  const idle = !!o && o.me.admin && !o.me.person && readAs === null && picked === null;
  // A concluded Direct Message is deleted: nothing is read for it, and what was shown of it goes (#1340).
  const thread = useThread(api, o && !stale && !idle && !cv && !endedHere ? sel : null, rev, ro ? readAs : null, landing);
  const addrs = useAddresses(api, sel.kind === "channel" && !idle ? sel.id : null);

  const refresh = useCallback(async () => {
    await Promise.all([overview.reload(), thread.reload()]);
  }, [overview, thread]);

  const select = (next: (Selection & { fresh?: boolean }) | ConvoSel) => {
    setPicked(next);
    setPane("thread");
    setMenu(null);
    setConfirm(null);
    setClearAsk(false);
    setActionErr(null);
    setSendErr(null);
    setFocusAsk((n) => n + 1);
  };
  // The orchestrator page's "Chat with Agent" button opens #/chat?with=<id> (#1067): the person's own conversation with that agent, or one
  // ready to start when there is none. It applies once per address, so a later choice is never undone; an id Chat does not list leaves General.
  const opened = useRef<string | null>(null);
  const want = props.openWith ?? null;
  useEffect(() => {
    if (want === null) opened.current = null; // leaving the address forgets it, so the same button opens the chat again later
    if (!o || stale || want === null || opened.current === want) return;
    opened.current = want;
    const a = o.agents.find((x) => x.sessionId === want);
    if (!a) return;
    const existing = ownDmWith(o.directs, a.sessionId);
    select(existing ? { kind: "dm", a: existing.a.sessionId, b: existing.b.sessionId, key: dmKey(existing) } : { kind: "dm", a: "me", b: a.sessionId, key: a.sessionId, fresh: true });
  }, [o, stale, want]);
  // The request is state, so this runs only in the commit that carries the open (the thread's screen showing at 400 px). A ref read by an
  // effect of every render could be spent by an earlier commit's effects that ran late, on a heading still hidden, and the open then found it spent.
  useEffect(() => {
    if (focusAsk > 0) document.getElementById("th-h")?.focus();
  }, [focusAsk]);
  useEffect(() => {
    if (confirm) keepBtn.current?.focus();
  }, [confirm]);

  // Read up to the newest message when a thread with something new is open.
  const marked = useRef<string | null>(null);
  const unread = channel ? channel.unread + channel.mentions : direct ? direct.unread + direct.mentions : 0;
  const newest = thread.messages[thread.messages.length - 1]?.id ?? null;
  const name = channel?.thread ?? direct?.thread ?? null;
  useEffect(() => {
    if (ro || !o?.me.person || !thread.loaded || !name || !newest || unread === 0) return;
    const mark = `${name}|${newest}|${unread}`;
    if (marked.current === mark) return;
    marked.current = mark;
    void api.markRead(name, newest).catch(() => {});
  }, [api, ro, o?.me.person, thread.loaded, name, newest, unread]);

  // An Admin's open thread says every 15 seconds that it is still being read, so its people keep seeing it. It stops with the thread, and
  // while the tab is hidden. A ping that fails shows nothing: the next one tries again.
  const reading = ro && thread.loaded && !thread.error && readAs !== null && !(sel.kind === "channel" && sel.id !== "group");
  const selId = sel.kind === "channel" ? sel.id : `${sel.a}|${sel.b}`;
  useEffect(() => {
    if (!reading || !readAs) return;
    const ping = () => {
      if (document.visibilityState === "hidden") return;
      const sent = sel.kind === "channel" ? api.readingChannel(sel.id, readAs) : api.readingDm(sel.a, sel.b, readAs);
      sent.catch(() => {});
    };
    const timer = setInterval(ping, KEEP_ALIVE_MS);
    document.addEventListener("visibilitychange", ping);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", ping);
    };
    // The thread is named by selId; `sel` itself is a new object on every render.
  }, [api, reading, readAs, selId]);

  const closeMenu = (restore: boolean) => {
    const k = menu?.key;
    const from = menu?.at?.from;
    setMenu(null);
    // A sender's menu gives the focus back to the message it opened from.
    if (restore && from) setTimeout(() => from.focus(), 0);
    else if (restore && k) setTimeout(() => [...document.querySelectorAll<HTMLElement>("[data-more]")].find((b) => b.dataset.more === k)?.focus(), 0);
  };
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.(".ch-menu, .ch-more, .ch-mem .ch-av-btn")) setMenu(null);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [menu]);

  if (!o || stale) {
    return overview.loadError ? (
      <div className="errbox" role="alert">
        Could not load Chat: {overview.loadError}. It reads again when something changes.{" "}
        <button type="button" className="btn sm" onClick={() => void overview.reload()}>
          Try again
        </button>
        {readAs !== null && (
          <>
            {" "}
            <button type="button" className="btn sm" onClick={() => {
                setReadAs(null);
                setPicked(null);
              }}>
              Back to your own conversations
            </button>
          </>
        )}
      </div>
    ) : (
      <div className="hint">Loading…</div>
    );
  }

  const own = (c: ChatChannel): boolean => ro && c.id === "group";
  const startAgent = (a: ChatAgent) => {
    const existing = ownDmWith(o.directs, a.sessionId);
    if (existing) return select({ kind: "dm", a: existing.a.sessionId, b: existing.b.sessionId, key: dmKey(existing) });
    select({ kind: "dm", a: "me", b: a.sessionId, key: a.sessionId, fresh: true });
  };
  const chooseReader = (name: string | null) => {
    setReadAs(name);
    setPicked(null);
    setMenu(null);
    setConfirm(null);
    setClearAsk(false);
    setActionErr(null);
    setPane("side");
    setSaid(name ? `Reading ${name}'s conversations as an Admin. Read only.` : "Back to your own conversations.");
    if (!name) setTimeout(() => document.getElementById("read-as")?.focus(), 0);
  };
  const openDm = (d: DirectInfo) => select({ kind: "dm", a: d.a.sessionId, b: d.b.sessionId, key: dmKey(d) });

  /** Runs one action of a menu and reads again. A refusal is said in words, with what to try. */
  const act = async (run: () => Promise<unknown>, ok: string, failed: (why: string) => string) => {
    setBusy(true);
    setActionErr(null);
    try {
      await run();
      setSaid(ok);
    } catch (err) {
      setActionErr(failed(plain(failReason(err))));
    }
    await refresh();
    setBusy(false);
  };

  /** Opens a form; the focus goes back to what opened it, or to the row's "..." when that is gone, on closing. */
  const openForm = (next: NonNullable<typeof form>, fallback?: string, back?: HTMLElement | null) => {
    const from = back ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);
    formFrom.current = from;
    formFallback.current = fallback ?? null;
    setMenu(null);
    setForm(next);
  };
  /** `restore` is false once a thread was opened, which takes the focus to its heading itself. */
  const closeForm = (restore = true) => {
    setForm(null);
    if (!restore) return;
    const from = formFrom.current;
    const fb = formFallback.current;
    setTimeout(() => {
      if (from?.isConnected) from.focus();
      else if (fb) [...document.querySelectorAll<HTMLElement>("[data-more]")].find((b) => b.dataset.more === fb)?.focus();
    }, 0);
  };

  /** Writes `@<typed> ` in the channel's message box: the address the channel's own list gives for this person or agent (no new route). */
  const mentionIt = async (person: boolean, id: string) => {
    if (sel.kind !== "channel") return;
    try {
      const { addresses } = await api.addresses(sel.id);
      const hit = addresses.find((x) => !x.disabled && (person ? x.role === "person" && x.typed.toLowerCase().startsWith(`${id.toLowerCase()}@`) : x.sessionId === id));
      if (!hit) return setActionErr(`Could not find an address for ${id} in this channel. Nothing was written.`);
      setActionErr(null);
      setMention((m) => ({ n: (m?.n ?? 0) + 1, text: `@${hit.typed}` }));
    } catch (err) {
      setActionErr(`Could not read who can be mentioned: ${plain(failReason(err))}. Nothing was written. Try again.`);
    }
  };

  // ---- One's own messages (#1269) -----------------------------------------------------------------------------------------------
  const refocus = (id: string) => setFocusMsg((f) => ({ id, n: (f?.n ?? 0) + 1 }));
  /** A refusal in the server's own words (they say what to do), or what failed and that nothing changed. */
  const changeFail = (err: unknown, what: string, stays: string): string => (err instanceof RespondError && err.status < 500 ? err.message : `Could not ${what}: ${plain(failReason(err))}. ${stays} Try again.`);
  const startEdit = (id: string) => {
    setMenu(null);
    setDeleting(null);
    setEditing({ id, error: null, busy: false });
  };
  const cancelEdit = (id: string) => {
    setEditing(null);
    refocus(id);
  };
  const saveEdit = async (id: string, text: string) => {
    const m = thread.messages.find((x) => x.id === id);
    if (!m) return setEditing(null);
    const was = (m.channel ?? m.direct)!.text;
    // Nothing changed: the box closes and nothing is sent.
    if (text.trim() === was.trim()) return cancelEdit(id);
    setEditing({ id, error: null, busy: true });
    try {
      const r = sel.kind === "channel" ? await api.editChannelMessage(sel.id, id, text.trim()) : await api.editDmMessage(sel.a, sel.b, id, text.trim());
      thread.patch(r.message);
      setEditing(null);
      refocus(id);
    } catch (err) {
      setEditing({ id, error: changeFail(err, "save", "Your message is unchanged."), busy: false });
    }
  };
  const askDelete = (id: string) => {
    setMenu(null);
    setEditing(null);
    setDeleting({ id, error: null, busy: false });
  };
  const cancelDelete = () => {
    const id = deleting?.id;
    setDeleting(null);
    if (id) refocus(id);
  };
  const doDelete = async () => {
    if (!deleting) return;
    const { id } = deleting;
    setDeleting({ id, error: null, busy: true });
    try {
      const r = sel.kind === "channel" ? await api.deleteChannelMessage(sel.id, id) : await api.deleteDmMessage(sel.a, sel.b, id);
      thread.patch(r.message);
      setDeleting(null);
      refocus(id);
    } catch (err) {
      setDeleting({ id, error: changeFail(err, "delete", "Your message is still there."), busy: false });
    }
  };
  /** Who loses a deleted message: everyone in a channel, and in a Direct Message the person and the agents it went to. */
  const lostBy = (m: (typeof thread.messages)[number]): string => {
    if (m.channel) return `It will be deleted for everyone in ${channel?.kind === "public" && channel.id !== "general" ? `#${channel.name}` : (channel?.name ?? "this channel")}, and the agents there will not see it.`;
    const names = [...new Set(m.direct!.to.map((x) => x.name))];
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "the other party");
    return `It will be deleted for you and for ${list}, and ${names.length > 1 ? "each" : (names[0] ?? "they")} will not see it.`;
  };
  const deletingMsg = deleting ? (thread.messages.find((x) => x.id === deleting.id) ?? null) : null;

  const pick = (menuKey: string, a: MenuAct) => {
    // One of your own messages: Edit message or Delete message.
    if (menuKey.startsWith("m:")) {
      const id = menuKey.slice(2);
      if (a === "delete-message") askDelete(id);
      else startEdit(id);
      return;
    }
    const [kind, ...rest] = (menuKey.startsWith("t:") ? menuKey.slice(2) : menuKey).split(":");
    const from = menu?.at?.from;
    setMenu(null);
    const id = rest.join(":");
    if (a === "mention" && (kind === "p" || kind === "mp" || kind === "a" || kind === "h")) {
      void mentionIt(kind === "p" || kind === "mp", id);
      return;
    }
    if (kind === "p" || kind === "mp") {
      // From a sender's avatar the focus returns to its message; from a row, to the row's "...".
      if (a === "message") openForm({ kind: "dm", person: id }, `p:${id}`, from);
      return;
    }
    if (kind === "a" || kind === "h") {
      const agent = o.agents.find((x) => x.sessionId === id);
      if (a !== "message") return;
      const named = thread.messages.find((m) => (m.channel ? m.channel.authorRef === id : m.direct?.from.sessionId === id))?.channel?.authorName ?? thread.messages.find((m) => m.direct?.from.sessionId === id)?.direct?.from.name ?? id;
      // An agent this person does not own (another's orchestrator that wrote in a channel) is found in New direct message by its name instead.
      if (agent) startAgent(agent);
      else openForm({ kind: "dm", search: named }, `h:${id}`, from);
      return;
    }
    if (kind === "c") {
      const c = o.channels.find((x) => x.id === id);
      if (!c) return;
      if (a === "clear") {
        select({ kind: "channel", id: c.id });
        setConfirm("clear");
      } else if (a === "pause") void act(() => (own(c) ? api.pause(c.id, !(c.paused && !c.pausedForEveryone), false, readAs) : api.pause(c.id, !(c.paused && !c.pausedForEveryone))), c.paused && !c.pausedForEveryone ? "Resumed." : "Paused.", (w) => `Could not ${c.paused ? "resume" : "pause"} ${c.name}: ${w}. Nothing changed. Try again.`);
      else if (a === "pause-all") void act(() => api.pause(c.id, !c.pausedForEveryone, true), c.pausedForEveryone ? `${c.name} resumed.` : `${c.name} is paused for everyone.`, (w) => `Could not change ${c.name}: ${w}. Nothing changed. Try again.`);
      else if (a === "edit") openForm({ kind: "channel", edit: c }, `c:${c.id}`);
      else if (a === "remove-channel") {
        select({ kind: "channel", id: c.id });
        setConfirm("remove-channel");
      }
      else if (a === "disconnect") void act(() => (own(c) ? api.disconnect(c.id, !c.disconnected, readAs) : api.disconnect(c.id, !c.disconnected)), c.disconnected ? "Your agents are reconnected." : "Your agents are disconnected.", (w) => `Could not ${c.disconnected ? "reconnect" : "disconnect"} your agents: ${w}. Nothing changed. Try again.`);
      return;
    }
    const d = o.directs.find((x) => dmKey(x) === id);
    if (!d) return;
    if (ro) {
      // An Admin pauses or resumes any link through Chat's own route, by the conversation's two ids. Nothing else is an Admin's.
      if (a !== "pause-link") return;
      const paused = d.cross ? d.cross.link === "paused" : d.state === "paused" || d.paused;
      openDm(d);
      void act(() => api.link(d.a.sessionId, d.b.sessionId, paused ? "resume" : "pause"), paused ? "Link resumed." : "Link paused.", (w) => `Could not ${paused ? "resume" : "pause"} the link: ${w}. The link is still ${paused ? "paused" : "active"}. Try again.`);
      return;
    }
    if (d.cross) {
      // Across owners the link is between a person and an agent, so it is changed through Chat's own route, by the conversation's two ids.
      openDm(d);
      const c = d.cross;
      if (a === "pause-link") {
        const paused = c.link === "paused";
        void act(() => api.link(d.a.sessionId, d.b.sessionId, paused ? "resume" : "pause"), paused ? "Link resumed." : "Link paused.", (w) => `Could not ${paused ? "resume" : "pause"} the link: ${w}. The link is still ${paused ? "paused" : "active"}. Try again.`);
      } else if (a === "allow-link") {
        void act(() => api.link(d.a.sessionId, d.b.sessionId, "allow"), `Link opened. ${c.person} can message the agent again.`, (w) => `Could not open the link again: ${w}. Nothing changed. Try again.`);
      } else if (a === "remove-link") setConfirm("remove-link");
      else if (a === "delete-dm") setConfirm("delete-dm");
      return;
    }
    if (a === "pause-link") {
      const paused = d.state === "paused" || d.paused;
      openDm(d);
      void act(() => api.pauseLink(d.a.reporterKey, d.b.reporterKey, !paused), paused ? "Link resumed." : "Link paused.", (w) => `Could not ${paused ? "resume" : "pause"} the link: ${w}. The link is still ${paused ? "paused" : "active"}. Try again.`);
    } else if (a === "remove-link") {
      openDm(d);
      setConfirm("remove-link");
    } else if (a === "delete-dm") {
      openDm(d);
      setConfirm("delete-dm");
    }
  };

  const keep = () => {
    setConfirm(null);
    const k = rowKey;
    setTimeout(() => [...document.querySelectorAll<HTMLElement>("[data-more]")].find((b) => b.dataset.more === k)?.focus(), 0);
  };

  const confirmBox = () => {
    if (!confirm) return null;
    if (confirm === "remove-link" && direct?.cross) {
      const c = direct.cross;
      const agent = [direct.a, direct.b].find((x) => x.kind === "agent")!;
      return (
        <div className="confirm" role="alertdialog" aria-label="Remove link" data-testid="chat-confirm">
          Remove the link between {c.person} and {agent.name}? {c.person} can no longer message it, a message still waiting is dropped, and only {c.owner} can open it again.
          <button type="button" className="btn sm" ref={keepBtn} onClick={keep}>
            Keep it
          </button>
          <button type="button" className="btn sm dng" disabled={busy} onClick={() => {
            setConfirm(null);
            void act(() => api.link(direct.a.sessionId, direct.b.sessionId, "remove"), "Link removed. The conversation stays until you delete it or it expires.", (w) => `Could not remove the link: ${w}. Nothing changed. Try again.`);
          }}>
            Remove link
          </button>
        </div>
      );
    }
    if (confirm === "remove-link" && direct) {
      const [x, y] = [direct.a, direct.b];
      return (
        <div className="confirm" role="alertdialog" aria-label="Remove link" data-testid="chat-confirm">
          Remove the link between {x.name} and {y.name}? Both directions lose every right, a message still waiting is dropped, and this conversation stays here until it expires.
          <button type="button" className="btn sm" ref={keepBtn} onClick={keep}>
            Keep it
          </button>
          <button type="button" className="btn sm dng" disabled={busy} onClick={() => {
            setConfirm(null);
            void act(() => api.removeLink(x.reporterKey, y.reporterKey), "Link removed. The conversation stays until you delete it or it expires.", (w) => `Could not remove the link: ${w}. Nothing changed. Try again.`);
          }}>
            Remove link
          </button>
        </div>
      );
    }
    if (confirm === "delete-dm" && direct) {
      return (
        <div className="confirm" role="alertdialog" aria-label="Delete conversation" data-testid="chat-confirm">
          Delete the conversation {dmName(direct)}? Its {direct.messages} messages are removed for you and an Admin, and it leaves your list. Deleting does not remove the link: if the link is still active, a new message starts a new conversation.
          <button type="button" className="btn sm" ref={keepBtn} onClick={keep}>
            Keep it
          </button>
          <button type="button" className="btn sm dng" disabled={busy} onClick={() => {
            setConfirm(null);
            const at = direct;
            void act(
              async () => {
                await api.deleteDm(at.a.sessionId, at.b.sessionId);
                setPicked(GENERAL);
              },
              "Conversation deleted.",
              (w) => `Could not delete the conversation: ${w}. Nothing changed. Try again.`,
            );
          }}>
            Delete conversation
          </button>
        </div>
      );
    }
    if (confirm === "remove-channel" && channel) {
      return (
        <div className="confirm" role="alertdialog" aria-label="Remove channel" data-testid="chat-confirm">
          Remove the channel {channel.name}? Its {channel.messages} messages are removed for everyone, and it cannot be recovered.{channel.openedBy ? ` ${channel.openedBy} is told that an Admin removed it.` : ""}
          <button type="button" className="btn sm" ref={keepBtn} onClick={keep}>
            Keep it
          </button>
          <button type="button" className="btn sm dng" disabled={busy} onClick={() => {
            setConfirm(null);
            const at = channel;
            void act(
              async () => {
                await api.removeChannel(at.id);
                setPicked(GENERAL);
              },
              "Channel removed.",
              (w) => `Could not remove the channel: ${w}. Nothing changed. Try again.`,
            );
          }}>
            Remove channel
          </button>
        </div>
      );
    }
    if (confirm === "clear" && channel) {
      return (
        <div className="confirm" role="alertdialog" aria-label="Remove all messages" data-testid="chat-confirm">
          Remove all {channel.messages} messages in {channel.name}? {channel.kind === "public" ? "Everyone loses the history, and it cannot be recovered." : "The history is deleted, and it cannot be recovered."}
          <button type="button" className="btn sm" ref={keepBtn} onClick={keep}>
            Keep them
          </button>
          <button type="button" className="btn sm dng" disabled={busy} onClick={() => {
            setConfirm(null);
            void act(() => (own(channel) ? api.clear(channel.id, readAs) : api.clear(channel.id)), "All messages removed.", (w) => `Could not remove the messages: ${w}. Nothing changed. Try again.`);
          }}>
            Remove all messages
          </button>
        </div>
      );
    }
    return null;
  };

  // ---- The box -----------------------------------------------------------------------------------------------------------
  const head = thread.head;
  const ended = head?.ended ?? direct?.ended ?? [];
  const parties = direct ? [direct.a, direct.b] : head?.a && head.b ? [head.a, head.b] : [];
  const agentParties = parties.filter((x) => x.kind === "agent");
  const dmPaused = direct ? direct.state === "paused" || direct.paused : (head?.paused ?? false);
  const cross = (direct?.cross ?? head?.cross) || null;
  const dmRemoved = !!direct && hasLink(direct) && !direct.canSend.aToB && !direct.canSend.bToA && direct.state === "active";
  let off: string | null = null;
  let offWord: string | null = null;
  const stop = (word: string, why: string) => {
    off = why;
    offWord = word;
  };
  const heldBy = channel ? (channel.id === "group" && channel.paused ? adminPauseOf({ paused: true, pausedByAdmin: channel.pausedByAdmin }) : null) : adminPauseOf({ ...(direct ?? {}), paused: dmPaused, pausedBy: head?.pausedBy ?? direct?.pausedBy, pausedByAdmin: head?.pausedByAdmin ?? direct?.pausedByAdmin, cross });
  const heldWords = heldBy ? `Paused by ${adminWho(heldBy.name)}: messages are held. Only an Admin can resume it.` : null;
  if (channel) {
    if (channel.disconnected) stop("Disconnected", "Your agents are disconnected from this channel. Reconnect them from its menu to send.");
    else if (channel.pausedForEveryone) stop("Paused", "Paused for everyone by an Admin: messages are held until it resumes.");
    else if (heldWords) stop("Paused", heldWords);
    else if (channel.paused) stop("Paused", "Paused: messages are held. Resume from the menu to send.");
  } else if (sel.kind === "dm") {
    const across = cross ? crossOff(cross) : null;
    if (!o.me.person) stop("Read only", "Only the person who owns a conversation can add to it.");
    else if (across) stop(across.word, across.why);
    else if (dmRemoved) stop("Link removed", "This link was removed, so nothing can be sent. Delete the conversation to clear it from the list.");
    else if (heldWords) stop("Paused", heldWords);
    else if (dmPaused) stop("Paused", "Paused: messages are held. Resume from the menu to send.");
    else if (agentParties.length > 0 && ended.length >= agentParties.length) stop("Ended", `${ended.join(" and ")} ${ended.length > 1 ? "have" : "has"} ended, so it will not receive this.`);
  }
  const roThread = ro && !(sel.kind === "channel" && sel.id !== "group");
  // An Admin reading a person's thread has the message box in view, off, so it is plain that nothing can be sent (mockup/podium-chat-redesign.html).
  if (roThread) {
    off = `You are reading as an Admin, so nothing can be sent here.${heldBy ? " The link is paused; you can resume it from its menu." : ""}`;
    offWord = "An Admin cannot send here";
  }
  const draft = drafts[key] ?? "";
  // `/clear` and `/compact` are commands only in a message to the person's own agent: one agent and the person, no other person.
  const ownAgent = sel.kind === "dm" && !ro && o.me.person && !cross && parties.length === 2 && agentParties.length === 1 ? agentParties[0]! : null;
  const onSend = async (override?: string) => {
    const text = (override ?? draft).trim();
    if (!text) return;
    setSending(true);
    setSendErr(null);
    try {
      if (sel.kind === "channel") {
        const r = await api.post(sel.id, text);
        if (r.warnings.length) setSendErr(`Posted, but ${r.warnings.join(" ")}`);
      } else {
        const r = await api.sendDm(sel.a, sel.b, text);
        const bad = [...r.errors.map((e) => `${e.name}: ${e.error}`), ...r.skipped.map((s) => s.why)];
        if (bad.length) setSendErr(`Sent, but ${bad.join(" ")}`);
      }
      if (override === undefined) setDrafts((cur) => ({ ...cur, [key]: "" }));
      else setDrafts((cur) => (cur[key] === override ? { ...cur, [key]: "" } : cur));
      setSent((n) => n + 1);
      setSaid("Message sent.");
      await refresh();
    } catch (err) {
      setSendErr(sendFailure(err));
    }
    setSending(false);
  };

  const label = channel ? `Message ${channel.name}` : agentParties.length === 1 ? `Message ${agentParties[0]!.name}` : "Add to this conversation";
  const waitNote = cross ? crossNote(cross) : null;
  const note =
    waitNote ??
    (sel.kind === "dm" ? (ended.length ? `${ended.join(" and ")} ${ended.length > 1 ? "have" : "has"} ended and will not receive this. ` : "") + "It reaches each agent when its current turn ends, and says Waiting until then. Secrets are replaced before it leaves this machine. " : "Secrets are replaced before a message leaves this machine. ").trimEnd();
  const stateOf = (a: Address) => {
    const agent = o.agents.find((x) => x.sessionId === a.sessionId);
    return a.sessionId ? agentState(sessions, a.sessionId, agent?.status ?? null, agent !== undefined) : null;
  };

  const familyOf = (a: Address) => (a.sessionId ? sessions[a.sessionId]?.modelFamily : undefined);

  const alert = (
    <>
      {confirmBox()}
      {actionErr && (
        <div className="errbox" role="alert" data-testid="chat-action-error">
          {actionErr}
        </div>
      )}
    </>
  );

  return (
    <section className="asec ch-asec" aria-label="Chat">
      {overview.loadError && (
        <div className="errbox" role="alert">
          Could not read Chat again: {overview.loadError}. What is shown may be out of date. It reads again when something changes.
        </div>
      )}
      {!ro && <ListReadingBanner readers={liveReaders(o.listReading, serverNow)} />}
      {!ro && <GoneRecordLines reads={gone} />}
      {!ro && endedHere && <ConcludedBanner agent={endedHere.agent} undelivered={endedHere.undelivered} onBack={() => { setPicked(null); setPane("side"); }} />}
      <div className={`ch-split${members ? " mem-open" : ""}`} data-pane={pane} data-testid="chat-split">
        <ChatSidebar
          overview={o}
          sessions={sessions}
          selected={idle ? null : rowKey}
          menu={menu?.key ?? null}
          onMenu={(k) => setMenu(k ? { key: k } : null)}
          onClose={closeMenu}
          onPick={pick}
          onChannel={(id) => select({ kind: "channel", id })}
          onNewChannel={() => openForm({ kind: "channel", edit: null })}
          onNewDm={() => openForm({ kind: "dm" })}
          onPerson={(name) => openForm({ kind: "dm", person: name }, `p:${name}`)}
          onDm={openDm}
          onConvo={(id) => select({ kind: "convo", id })}
          onAgent={startAgent}
          readAs={ro ? readAs : null}
          mention={sel.kind === "channel"}
          picked={readAs}
          onReadAs={chooseReader}
          serverNow={serverNow}
        />
        {idle ? (
          <section className="ch-thread" aria-label="Chat" data-testid="chat-idle">
            <div className="ch-blank">
              <p>Choose General or a channel to read it.</p>
              <p>To read a person&apos;s conversations, choose a person under Read as an Admin.</p>
            </div>
          </section>
        ) : cv ? (
          <ChatConversation
            key={cv.id}
            api={api}
            id={cv.id}
            overview={o}
            sessions={sessions}
            rev={rev}
            now={props.now}
            serverNow={serverNow}
            landing={landing}
            readAs={ro ? readAs : null}
            members={members}
            onMembers={setMembers}
            onBack={() => {
              setMembers(false);
              setPane("side");
            }}
            onGone={() => {
              setPicked(null);
              setPane("side");
            }}
            onAdd={() => {
              const c = o.conversations?.find((x) => x.id === cv.id);
              openForm({ kind: "dm", addTo: { id: cv.id, members: (c?.members ?? []).map((m) => m.name) } });
            }}
            onChanged={() => overview.reload()}
            onSaid={setSaid}
          />
        ) : (
          <ChatThread
            sel={sel}
            overview={o}
            channel={channel}
            direct={direct}
            thread={thread}
            sessions={sessions}
            now={props.now}
            alert={alert}
            scrollToken={`${key}|${sent}`}
            menu={menu?.key ?? null}
            menuAt={menu?.at ?? null}
            onMenu={(k, _by, at) => setMenu(k ? { key: k, ...(at ? { at } : {}) } : null)}
            onClose={closeMenu}
            onPick={pick}
            members={members}
            onMembers={setMembers}
            onBack={() => {
              setMembers(false);
              setPane("side");
            }}
            concluded={endedHere !== null}
            readAs={ro ? readAs : null}
            serverNow={serverNow}
            change={{ editing, deleting: deleting?.id ?? null, focus: focusMsg, onEdit: startEdit, onSave: (id, text) => void saveEdit(id, text), onCancel: cancelEdit, onDelete: askDelete }}
            composer={
              <ChatComposer
                label={label}
                draft={draft}
                onDraft={(v) => setDrafts((cur) => ({ ...cur, [key]: v }))}
                off={endedHere ? "This direct message has ended." : thread.error?.status === 404 && sel.kind === "dm" ? "That conversation is gone, so nothing can be sent." : off}
                offWord={endedHere ? "Ended" : thread.error?.status === 404 && sel.kind === "dm" ? "Gone" : offWord}
                note={note}
                error={sendErr}
                sending={sending}
                onSend={() => void onSend()}
                channel={sel.kind === "channel" ? sel.id : null}
                addresses={addrs.list}
                loadAddresses={addrs.load}
                stateOf={stateOf}
                familyOf={familyOf}
                insert={mention}
                commands={ownAgent ? { agent: ownAgent.name, declared: sessions[ownAgent.sessionId]?.capabilities?.commands ?? null, confirmClear: clearAsk, onConfirmClear: setClearAsk, onClear: () => void onSend("/clear") } : undefined}
                noteAction={roThread ? (
                  <button type="button" className="btn sm" data-testid="chat-stop-reading-thread" onClick={() => chooseReader(null)}>
                    Stop reading
                  </button>
                ) : undefined}
              />
            }
          />
        )}
      </div>
      {!ro && <ListRecordLines reads={o.listReads ?? []} />}
      {form?.kind === "channel" && (
        <ChannelModal
          api={api}
          edit={form.edit}
          onClose={() => closeForm()}
          onDone={async (c, say) => {
            // The list is read again first, so the channel is in it when it is selected.
            await overview.reload();
            if (!form.edit) select({ kind: "channel", id: c.id });
            setSaid(say);
            closeForm(!!form.edit);
          }}
        />
      )}
      {form?.kind === "dm" && (
        <DirectModal
          api={api}
          sessions={sessions}
          person={form.person}
          onClose={() => closeForm()}
          search={form.search}
          addTo={form.addTo}
          onDone={async (r: DirectDone) => {
            await overview.reload();
            if (r.kind === "added") {
              await refresh();
              setSaid(r.said);
              closeForm();
              return;
            }
            if (r.kind === "convo") select({ kind: "convo", id: r.id });
            // The conversation is the one the overview lists now, found by this key (an own agent's by the agent), or the fresh one that opens it.
            else select({ kind: "dm", a: "me", b: r.target.sessionId, key: r.target.own ? r.target.sessionId : r.target.thread, fresh: true });
            setSaid(r.said);
            closeForm(false);
          }}
        />
      )}
      {deleting && deletingMsg && <DeleteMessageDialog text={(deletingMsg.channel ?? deletingMsg.direct)!.text} who={lostBy(deletingMsg)} error={deleting.error} busy={deleting.busy} onCancel={cancelDelete} onDelete={() => void doDelete()} />}
      <div className="vh" role="status" aria-live="polite">
        {said}
      </div>
    </section>
  );
}
