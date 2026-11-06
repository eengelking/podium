// Chat (#1034, SPEC 7.1 and 7.7, mockup/podium-chat.html): a console page laid out like Slack or Teams. It replaces Traffic (#347).
// Three audiences, three stores, never shown in one list: Channels (General for everyone signed in, My group for a person and
// their own agents), Direct Messages (read only by their owner and an Admin) and People and agents (to start a message with).
// The page reads again whenever the console's content-free `chat` signal moves `rev`. Message text is only ever drawn as text.
import { useCallback, useEffect, useRef, useState } from "react";
import "./chat.css";
import "./admin/admin.css";
import { PageHeader } from "./admin/Page";
import { Blank } from "./components/Blank";
import { ChatComposer } from "./components/ChatComposer";
import { ChatSidebar } from "./components/ChatSidebar";
import { agentState } from "./components/ChatSidebar";
import { ChatThread } from "./components/ChatThread";
import type { MenuAct } from "./components/ChatMenu";
import { dmKey, dmName, hasLink, plain, type Address, type ChatAgent, type ChatApi, type ChatChannel, type DirectInfo } from "./chatData";
import { useAddresses, useChatOverview, useThread, selKey, type Selection } from "./useChat";
import { RespondError } from "./respondApi";
import { failReason } from "./useMyPeers";
import type { RespondMe, SessionView } from "./types";

type Confirm = "remove-link" | "delete-dm" | "clear";

const GENERAL: Selection = { kind: "channel", id: "general" };

/** What an error of a send says: the server's own words for 429, 409 and 422, and what to do for the rest. */
export function sendFailure(err: unknown): string {
  if (err instanceof RespondError && (err.status === 429 || err.status === 409 || err.status === 422)) return err.message;
  return `Could not send: ${plain(failReason(err))}. Nothing was sent. Try again.`;
}

export function ChatPage(props: { me: RespondMe | null; peersOn: boolean; sessions: Record<string, SessionView>; rev: number; api: ChatApi; now: number }) {
  const { me, peersOn } = props;
  let body: React.ReactNode;
  if (!peersOn) body = <Blank title="Orchestrator messaging is off">An Admin turns it on in Admin &gt; Settings &gt; Feature flags. Until then no orchestrator can message another, and Chat has nothing to show.</Blank>;
  else if (me === null) body = <div className="hint">Loading…</div>;
  else if (!me.signedIn) body = <Blank title="Sign in to use Chat">Chat shows your channels, your Direct Messages and your own agents, so it needs someone signed in. Use Sign in at the top right.</Blank>;
  else body = <ChatBody {...props} />;
  return (
    <main className="adminv" aria-label="Chat" id="podium-main">
      <div className="apage">
        <div className="apage-in">
          <PageHeader title="Chat" lead="Talk with your orchestrators and subagents, read what they say to each other, and join in." />
          {body}
          {peersOn && me?.signedIn && <Rules />}
        </div>
      </div>
    </main>
  );
}

function Rules() {
  return (
    <section className="asec" aria-labelledby="rules-h">
      <div className="asec-h">
        <div>
          <h2 id="rules-h">Who can read what</h2>
        </div>
      </div>
      <div className="panel">
        <ul className="plain">
          <li>
            <b>General</b> is read and written by everyone signed in to this server.
          </li>
          <li>
            <b>My group</b> is you and your own orchestrators, subagents and forks. No one else sees it.
          </li>
          <li>
            <b>Direct Messages</b> are read only by you and an Admin. A conversation between two agents shows you as the third person in it, and you can add to it. Delete conversation removes one from your list. One also goes away on its own once every agent session in it has ended or disconnected from Podium.
          </li>
          <li>
            An agent only acts in a channel when it is <b>@-addressed</b>: <b>name@location</b> for one agent or person. <b>@group</b> and <b>@everyone</b> are off until an Admin turns them on. Each addressed agent posts a reply saying what it is doing and, when done, a report. Agents addressing each other stop at 10 round trips until its owner approves the next. What an agent may do is still set by its reporter's permissions.
          </li>
          <li>
            The menu on a channel is the stop button for a runaway session: <b>Pause</b> holds messages and keeps access, <b>Disconnect</b> takes your agents' access away, <b>Remove all messages</b> deletes the history. Anyone can stop their own agents in General. Only an Admin can pause General for everyone or remove its messages.
          </li>
          <li>
            Pause link stops delivery at once and keeps the rights. Remove link takes every right away, in both directions. Both are in the menu on each Direct Message.
          </li>
        </ul>
      </div>
    </section>
  );
}

function ChatBody(props: { me: RespondMe | null; sessions: Record<string, SessionView>; rev: number; api: ChatApi; now: number }) {
  const { api, sessions, rev } = props;
  const overview = useChatOverview(api, true, rev);
  const o = overview.data;
  const [picked, setPicked] = useState<(Selection & { fresh?: boolean }) | null>(null);
  const [pane, setPane] = useState<"side" | "thread">("side");
  const [menu, setMenu] = useState<{ key: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(0);
  const [busy, setBusy] = useState(false);
  const focusHeading = useRef(false);
  const keepBtn = useRef<HTMLButtonElement>(null);

  // The selected row, or General. A conversation that left the list (deleted, or every agent ended) falls back to General.
  let sel: Selection = picked ?? GENERAL;
  if (o && picked?.kind === "dm" && !picked.fresh && !o.directs.some((d) => dmKey(d) === picked.key)) sel = GENERAL;
  const key = selKey(sel)!;
  const channel: ChatChannel | null = o && sel.kind === "channel" ? (o.channels.find((c) => c.id === sel.id) ?? null) : null;
  const direct: DirectInfo | null = o && sel.kind === "dm" ? (o.directs.find((d) => dmKey(d) === sel.key) ?? null) : null;
  const thread = useThread(api, o ? sel : null, rev);
  const addrs = useAddresses(api, sel.kind === "channel" ? sel.id : null);

  const refresh = useCallback(async () => {
    await Promise.all([overview.reload(), thread.reload()]);
  }, [overview, thread]);

  const select = (next: Selection & { fresh?: boolean }) => {
    setPicked(next);
    setPane("thread");
    setMenu(null);
    setConfirm(null);
    setActionErr(null);
    setSendErr(null);
    focusHeading.current = true;
  };
  useEffect(() => {
    if (focusHeading.current) {
      focusHeading.current = false;
      document.getElementById("th-h")?.focus();
    }
  });
  useEffect(() => {
    if (confirm) keepBtn.current?.focus();
  }, [confirm]);

  // Read up to the newest message when a thread with something new is open.
  const marked = useRef<string | null>(null);
  const unread = channel ? channel.unread + channel.mentions : direct ? direct.unread + direct.mentions : 0;
  const newest = thread.messages[thread.messages.length - 1]?.id ?? null;
  const name = channel?.thread ?? direct?.thread ?? null;
  useEffect(() => {
    if (!o?.me.person || !thread.loaded || !name || !newest || unread === 0) return;
    const mark = `${name}|${newest}|${unread}`;
    if (marked.current === mark) return;
    marked.current = mark;
    void api.markRead(name, newest).catch(() => {});
  }, [api, o?.me.person, thread.loaded, name, newest, unread]);

  const closeMenu = (restore: boolean) => {
    const k = menu?.key;
    setMenu(null);
    if (restore && k) setTimeout(() => [...document.querySelectorAll<HTMLElement>("[data-more]")].find((b) => b.dataset.more === k)?.focus(), 0);
  };
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.(".ch-menu, .ch-more, .ch-chipwrap .m")) setMenu(null);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [menu]);

  if (!o) {
    return overview.loadError ? (
      <div className="errbox" role="alert">
        Could not load Chat: {overview.loadError}. It reads again when something changes.{" "}
        <button type="button" className="btn sm" onClick={() => void overview.reload()}>
          Try again
        </button>
      </div>
    ) : (
      <div className="hint">Loading…</div>
    );
  }

  const owns = (d: DirectInfo) => o.me.person && d.owner.toLowerCase() === o.me.name.toLowerCase();
  const startAgent = (a: ChatAgent) => {
    const existing = o.directs.find((d) => dmKey(d) === a.sessionId);
    if (existing) return select({ kind: "dm", a: existing.a.sessionId, b: existing.b.sessionId, key: a.sessionId });
    select({ kind: "dm", a: "me", b: a.sessionId, key: a.sessionId, fresh: true });
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

  const pick = (rowKey: string, a: MenuAct) => {
    setMenu(null);
    const [kind, ...rest] = rowKey.split(":");
    const id = rest.join(":");
    if (kind === "a" || kind === "h") {
      const agent = o.agents.find((x) => x.sessionId === id);
      if (a === "message" && agent) startAgent(agent);
      return;
    }
    if (kind === "c") {
      const c = o.channels.find((x) => x.id === id);
      if (!c) return;
      if (a === "clear") {
        select({ kind: "channel", id: c.id });
        setConfirm("clear");
      } else if (a === "pause") void act(() => api.pause(c.id, !(c.paused && !c.pausedForEveryone)), c.paused && !c.pausedForEveryone ? "Resumed." : "Paused.", (w) => `Could not ${c.paused ? "resume" : "pause"} ${c.name}: ${w}. Nothing changed. Try again.`);
      else if (a === "pause-all") void act(() => api.pause(c.id, !c.pausedForEveryone, true), c.pausedForEveryone ? "General resumed." : "General is paused for everyone.", (w) => `Could not change General: ${w}. Nothing changed. Try again.`);
      else if (a === "disconnect") void act(() => api.disconnect(c.id, !c.disconnected), c.disconnected ? "Your agents are reconnected." : "Your agents are disconnected.", (w) => `Could not ${c.disconnected ? "reconnect" : "disconnect"} your agents: ${w}. Nothing changed. Try again.`);
      return;
    }
    const d = o.directs.find((x) => dmKey(x) === id);
    if (!d) return;
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
    const k = key;
    setTimeout(() => [...document.querySelectorAll<HTMLElement>("[data-more]")].find((b) => b.dataset.more === k)?.focus(), 0);
  };

  const confirmBox = () => {
    if (!confirm) return null;
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
                setPicked(null);
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
    if (confirm === "clear" && channel) {
      return (
        <div className="confirm" role="alertdialog" aria-label="Remove all messages" data-testid="chat-confirm">
          Remove all {channel.messages} messages in {channel.name}? {channel.id === "general" ? "Everyone loses the history, and it cannot be recovered." : "The history is deleted, and it cannot be recovered."}
          <button type="button" className="btn sm" ref={keepBtn} onClick={keep}>
            Keep them
          </button>
          <button type="button" className="btn sm dng" disabled={busy} onClick={() => {
            setConfirm(null);
            void act(() => api.clear(channel.id), "All messages removed.", (w) => `Could not remove the messages: ${w}. Nothing changed. Try again.`);
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
  const dmRemoved = !!direct && hasLink(direct) && !direct.canSend.aToB && !direct.canSend.bToA && direct.state === "active";
  let off: string | null = null;
  if (channel) {
    if (channel.disconnected) off = "Your agents are disconnected from this channel. Reconnect them from its menu to send.";
    else if (channel.pausedForEveryone) off = "Paused for everyone by an Admin: messages are held until it resumes.";
    else if (channel.paused) off = "Paused: messages are held. Resume from the menu to send.";
  } else if (sel.kind === "dm") {
    if (!o.me.person) off = "Only the person who owns a conversation can add to it.";
    else if (dmRemoved) off = "This link was removed, so nothing can be sent. Delete the conversation to clear it from the list.";
    else if (dmPaused) off = "Paused: messages are held. Resume from the menu to send.";
    else if (agentParties.length > 0 && ended.length >= agentParties.length) off = `${ended.join(" and ")} ${ended.length > 1 ? "have" : "has"} ended, so it will not receive this.`;
  }
  const draft = drafts[key] ?? "";
  const onSend = async () => {
    const text = draft.trim();
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
      setDrafts((cur) => ({ ...cur, [key]: "" }));
      setSent((n) => n + 1);
      setSaid("Message sent.");
      await refresh();
    } catch (err) {
      setSendErr(sendFailure(err));
    }
    setSending(false);
  };

  const label = channel ? `Message ${channel.name}` : agentParties.length === 1 ? `Message ${agentParties[0]!.name}` : "Add to this conversation";
  const note =
    (sel.kind === "dm" ? (ended.length ? `${ended.join(" and ")} ${ended.length > 1 ? "have" : "has"} ended and will not receive this. ` : "") + "It reaches each agent when its current turn ends, and says Waiting until then. Secrets are replaced before it leaves this machine. " : "Secrets are replaced before a message leaves this machine. ") + "Enter sends; Shift+Enter adds a line.";
  const stateOf = (a: Address) => {
    const agent = o.agents.find((x) => x.sessionId === a.sessionId);
    return a.sessionId ? agentState(sessions, a.sessionId, agent?.status ?? null, agent !== undefined) : null;
  };

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
    <section className="asec" aria-label="Chat">
      {overview.loadError && (
        <div className="errbox" role="alert">
          Could not read Chat again: {overview.loadError}. What is shown may be out of date. It reads again when something changes.
        </div>
      )}
      <div className="ch-split" data-pane={pane} data-testid="chat-split">
        <ChatSidebar
          overview={o}
          sessions={sessions}
          selected={key}
          menu={menu?.key ?? null}
          onMenu={(k) => setMenu(k ? { key: k } : null)}
          onClose={closeMenu}
          onPick={pick}
          onChannel={(id) => select({ kind: "channel", id })}
          onDm={openDm}
          onAgent={startAgent}
        />
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
          onMenu={(k) => setMenu(k ? { key: k } : null)}
          onClose={closeMenu}
          onPick={pick}
          onBack={() => setPane("side")}
          composer={
            <ChatComposer
              label={label}
              draft={draft}
              onDraft={(v) => setDrafts((cur) => ({ ...cur, [key]: v }))}
              off={thread.error?.status === 404 && sel.kind === "dm" ? "That conversation is gone, so nothing can be sent." : off}
              note={note}
              error={sendErr}
              sending={sending}
              onSend={() => void onSend()}
              channel={sel.kind === "channel" ? sel.id : null}
              addresses={addrs.list}
              loadAddresses={addrs.load}
              stateOf={stateOf}
            />
          }
        />
      </div>
      <div className="vh" role="status" aria-live="polite">
        {said}
      </div>
    </section>
  );
}
