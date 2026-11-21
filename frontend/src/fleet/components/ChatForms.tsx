// The two forms Chat opens in a modal (#1035, mockup/podium-channels.html): New channel (which also edits a description, with the name and the
// link fixed) and New direct message. Both are the console's Modal. A refusal is shown in the server's own words in a red banner; nothing here
// is drawn as HTML, and the person's text is only ever sent, never kept.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Modal } from "./Modal";
import { ChatAvatar } from "./ChatAvatar";
import { ChEye } from "./ChatIcons";
import { agentState, STATE_WORD } from "./ChatSidebar";
import { plain, type ChannelLink, type ChannelLinkKind, type ChatApi, type ChatChannel, type DirectTarget } from "../chatData";
import { RespondError } from "../respondApi";
import { failReason } from "../useMyPeers";
import type { SessionView } from "../types";

/** The name the server accepts, after it is lowercased (the same rule as the store's). */
const CHANNEL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DESC_MAX = 280;
const REF_MAX = 100;

const KIND_WORD: Record<ChannelLinkKind, string> = { issue: "Issue", milestone: "Milestone", project: "Project" };
/** A channel's link as the chip and the words name it: "Issue #1035". The server keeps an issue's number without its #, so a number is shown with one; any other reference is shown as it is. */
export const linkWords = (l: ChannelLink): string => `${KIND_WORD[l.kind]} ${l.kind === "issue" && /^\d+$/.test(l.ref) ? `#${l.ref}` : l.ref}`;

/** What a refusal says: the server's own words for a refusal of the form, and what to do for any other failure. */
function refusal(err: unknown, what: string): string {
  if (err instanceof RespondError && [400, 403, 404, 409, 422].includes(err.status) && typeof err.body.error === "string") return err.message;
  return `Could not ${what}: ${plain(failReason(err))}. Nothing was saved. Try again.`;
}

/**
 * The field a refusal is about, or the banner when it is about none (a 403, a 429, a network failure, the limit, an unknown reason). Only a refusal
 * that is really about a field marks it; in edit mode the name and the link are fixed, so only the description or the banner can take it.
 */
function fieldOf(reason: string, text: string, edit: boolean): "name" | "ref" | "desc" | "banner" {
  const linkWords = /link|reference|issue|milestone|project/i.test(text);
  if (reason === "invalid" && /description/i.test(text)) return "desc";
  if (edit) return "banner";
  if (reason === "name-taken" || reason === "reserved") return "name";
  if (reason === "link-taken" || (reason === "invalid" && linkWords)) return "ref";
  return reason === "invalid" ? "name" : "banner";
}

/** Moves the focus to a field once the modal's own focus (on its X) has landed. */
function useFirstFocus(ref: { current: HTMLElement | null }) {
  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 0);
    return () => clearTimeout(t);
    // The refs are stable; this runs once, when the modal opens.
  }, []);
}

export function ChannelModal(props: { api: ChatApi; edit: ChatChannel | null; onClose: () => void; onDone: (c: ChatChannel, said: string) => void | Promise<void> }) {
  const { edit } = props;
  const [name, setName] = useState(edit?.name ?? "");
  const [desc, setDesc] = useState(edit?.description ?? "");
  const [kind, setKind] = useState<"" | ChannelLinkKind>("");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<{ text: string; field: "name" | "ref" | "desc" | "banner" } | null>(null);
  const [busy, setBusy] = useState(false);
  const bannerEl = useRef<HTMLDivElement>(null);
  const nameEl = useRef<HTMLInputElement>(null);
  const descEl = useRef<HTMLTextAreaElement>(null);
  const refEl = useRef<HTMLInputElement>(null);
  useFirstFocus(edit ? descEl : nameEl);
  const fail = (text: string, field: "name" | "ref" | "desc" | "banner") => setError({ text, field });
  // The focus goes to what the refusal is about once it is drawn (the banner does not exist until then).
  useEffect(() => {
    if (error) (error.field === "name" ? nameEl : error.field === "ref" ? refEl : error.field === "desc" ? descEl : bannerEl).current?.focus();
  }, [error]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const chosen = name.trim().toLowerCase();
    const about = ref.trim();
    if (!edit) {
      if (!chosen) return fail("Name the channel.", "name");
      if (!CHANNEL_NAME.test(chosen)) return fail("A name has lowercase letters, numbers and hyphens only, starts with a letter or a number, and is at most 40 characters.", "name");
      if (kind && !about) return fail(`Say which ${kind} it is about, or choose Nothing.`, "ref");
    }
    setBusy(true);
    try {
      const r = edit ? await props.api.describeChannel(edit.id, desc.trim()) : await props.api.createChannel(chosen, desc.trim(), kind ? { kind, ref: about } : null);
      await props.onDone(r.channel, edit ? "Description saved." : `Channel ${r.channel.name} created.`);
    } catch (err) {
      const text = refusal(err, edit ? "save the description" : "create the channel");
      const reason = err instanceof RespondError && typeof err.body.reason === "string" ? err.body.reason : "";
      fail(text, fieldOf(reason, text, !!edit));
      setBusy(false);
    }
  };
  const bad = (f: "name" | "ref" | "desc") => (error?.field === f ? true : undefined);
  return (
    <Modal titleId="nc-h" title={edit ? "Edit description" : "New channel"} className="ch-dlg" onClose={props.onClose}>
      <div className="mb">
        <form className="ch-form" noValidate onSubmit={(e) => void submit(e)} data-testid="channel-form">
          <p className="ch-nav ro">
            <ChEye />
            <span>Every person and Admin signed in to this server can read and post in a channel, and so can an orchestrator for the hour after an @ calls it in. Do not put anything here you would not want all of them to read.</span>
          </p>
          <label>
            Name
            <input className="field" ref={nameEl} maxLength={40} autoComplete="off" value={name} placeholder="staging-incident" disabled={!!edit} aria-describedby="nc-name-hint" aria-invalid={bad("name")} onChange={(e) => setName(e.target.value.toLowerCase())} />
          </label>
          <p className="hint" id="nc-name-hint">
            {edit ? "A name cannot be changed after the channel is made." : "Lowercase letters, numbers and hyphens. It cannot be changed later."}
          </p>
          <label>
            Description
            <textarea className="field" ref={descEl} maxLength={DESC_MAX} rows={3} value={desc} placeholder="What this channel is for, and what belongs here." aria-invalid={bad("desc")} onChange={(e) => setDesc(e.target.value)} />
          </label>
          <span className="count" aria-live="off">
            {desc.length} of {DESC_MAX}
          </span>
          {edit ? (
            edit.link && <p className="hint">Linked to {linkWords(edit.link)}. The link cannot be changed.</p>
          ) : (
            <div className="row2">
              <label>
                <span>
                  About <span className="cr-opt">(optional)</span>
                </span>
                <select className="field" value={kind} onChange={(e) => setKind(e.target.value as "" | ChannelLinkKind)}>
                  <option value="">Nothing</option>
                  <option value="issue">Issue</option>
                  <option value="milestone">Milestone</option>
                  <option value="project">Project</option>
                </select>
              </label>
              <label>
                Which one
                <input className="field" ref={refEl} maxLength={REF_MAX} autoComplete="off" value={ref} placeholder="1035, v1.7 or podium" aria-invalid={bad("ref")} onChange={(e) => setRef(e.target.value)} />
              </label>
            </div>
          )}
          {error && (
            <div className="banner bad" role="alert" tabIndex={-1} ref={bannerEl} data-testid="channel-form-error">
              {error.text}
            </div>
          )}
          <div className="acts">
            <button type="button" className="btn" onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" className="btn pri" disabled={busy}>
              {edit ? "Save description" : "Create channel"}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

/** What the New direct message dialog did: opened (or found) a conversation of people and agents, or sent to one of the viewer's own agents on its own. */
export type DirectDone = { kind: "convo"; id: string; said: string } | { kind: "agent"; target: DirectTarget; said: string } | { kind: "added"; said: string };

/**
 * New direct message (#1278, DECISIONS 74, mockup/podium-chat-person-dm.html): one or more people and, on purpose, the viewer's own agents. Every person who can sign
 * in is listed, whether or not an orchestrator of theirs is running. People only, or people and agents, open a conversation; a single agent of your own and nobody else
 * is the Direct Message with that agent, as before. `person` is a person chosen elsewhere, ticked when the list lands. With `addTo` it adds to that conversation
 * instead (the people already in it are left out and there is no first message). The state lives in the dialog, so closing it resets everything.
 */
export function DirectModal(props: { api: ChatApi; sessions: Record<string, SessionView>; person?: string; search?: string; addTo?: { id: string; members: string[] }; onClose: () => void; onDone: (r: DirectDone) => void | Promise<void> }) {
  const add = !!props.addTo;
  const [q, setQ] = useState(props.search ?? "");
  const [people, setPeople] = useState<{ name: string; conversation: string | null }[] | null>(null);
  const [targets, setTargets] = useState<DirectTarget[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>(props.person ? [`p:${props.person}`] : []);
  const [text, setText] = useState("");
  const [error, setError] = useState<{ text: string; field: "q" | "msg" } | null>(null);
  const [busy, setBusy] = useState(false);
  const qEl = useRef<HTMLInputElement>(null);
  useFirstFocus(qEl);
  const msgEl = useRef<HTMLTextAreaElement>(null);
  // The lists are asked for as the person types; an answer to an older question never replaces a newer one.
  const asked = useRef(0);
  useEffect(() => {
    const mine = ++asked.current;
    Promise.all([props.api.chatPeople(q.trim()), props.api.directTargets(q.trim())])
      .then(([a, b]) => {
        if (asked.current !== mine) return;
        setPeople(a.people);
        setTargets(b.targets);
        setLoadError(null);
      })
      .catch((err) => {
        if (asked.current !== mine) return;
        setLoadError(`Could not read who you can message: ${plain(failReason(err))}. Try again.`);
      });
    // props.api is stable for the page's life.
  }, [q]);
  const inIt = new Set(props.addTo?.members ?? []);
  const shownPeople = (people ?? []).filter((x) => !inIt.has(x.name));
  const live = (targets ?? []).filter((t) => t.own || t.status !== "done");
  const mine = live.filter((t) => t.own && t.canMessage);
  const theirs = live.filter((t) => !t.own);
  const toggle = (key: string) => setPicked((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  const names = picked.map((k) => (k.startsWith("p:") ? k.slice(2) : (live.find((t) => t.sessionId === k.slice(2))?.name ?? "an agent")));
  const hasAgent = picked.some((k) => k.startsWith("a:"));
  const sole = picked.length === 1 && people !== null && picked[0]!.startsWith("p:") ? people.find((x) => `p:${x.name}` === picked[0]) : undefined;
  const list = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const fail = (text: string, field: "q" | "msg") => {
    setError({ text, field });
    (field === "q" ? qEl : msgEl).current?.focus();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (picked.length === 0) return fail(add ? "Choose at least one person or agent to add." : "Choose at least one person or agent.", "q");
    if (!add && !text.trim()) return fail("Write the first message.", "msg");
    const members = picked.map((k) => (k.startsWith("p:") ? { kind: "person" as const, name: k.slice(2) } : { kind: "agent" as const, sessionId: k.slice(2) }));
    setBusy(true);
    try {
      if (add) {
        await props.api.addConversationMembers(props.addTo!.id, members);
        await props.onDone({ kind: "added", said: `Added ${list(names)}.` });
        return;
      }
      // One agent of your own and nobody else is the Direct Message with that agent, which it can answer.
      const only = picked.length === 1 && picked[0]!.startsWith("a:") ? mine.find((t) => t.sessionId === picked[0]!.slice(2)) : undefined;
      if (only) {
        const r = await props.api.sendDm("me", only.sessionId, text.trim());
        const bad = [...r.errors.map((x) => `${x.name}: ${x.error}`), ...r.skipped.map((s) => s.why)];
        await props.onDone({ kind: "agent", target: only, said: bad.length ? `Sent, but ${bad.join(" ")}` : `Sent to ${only.name}.` });
        return;
      }
      const r = await props.api.openConversation(members, text.trim());
      const bad = r.skipped;
      await props.onDone({ kind: "convo", id: r.conversation.id, said: bad.length ? `Sent, but ${bad.join(" ")}` : `Sent to ${list(names)}.` });
    } catch (err) {
      fail(refusal(err, add ? "add them" : "send the message").replace("Nothing was saved.", add ? "Nothing was added." : "Nothing was sent."), add ? "q" : "msg");
      setBusy(false);
    }
  };
  const personOption = (x: { name: string }) => (
    <li key={`p:${x.name}`}>
      <label>
        <input type="checkbox" name="dm-to" value={`p:${x.name}`} checked={picked.includes(`p:${x.name}`)} onChange={() => toggle(`p:${x.name}`)} />
        <ChatAvatar kind="person" name={x.name} size={30} />
        <span className="stack">
          <span>
            <bdi>{x.name}</bdi>
          </span>
        </span>
      </label>
    </li>
  );
  const agentOption = (t: DirectTarget) => {
    const kind = agentState(props.sessions, t.sessionId, t.status);
    const ok = t.own && t.canMessage;
    return (
      <li key={`a:${t.sessionId}`}>
        <label aria-disabled={!ok ? true : undefined}>
          <input type="checkbox" name="dm-to" value={`a:${t.sessionId}`} checked={picked.includes(`a:${t.sessionId}`)} disabled={!ok} onChange={() => toggle(`a:${t.sessionId}`)} />
          <ChatAvatar kind="agent" name={t.name} family={props.sessions[t.sessionId]?.modelFamily} state={kind} size={30} />
          <span className="stack">
            <span>
              <bdi>{t.name}</bdi>
              {!t.own && (
                <>
                  {" "}
                  (<bdi>{t.owner}</bdi>&apos;s)
                </>
              )}
            </span>
            <span className="sub">{!t.own ? "Adding another person's agent is not available yet." : t.canMessage ? `Your orchestrator, ${STATE_WORD[kind]}` : (t.why ?? "It takes no messages now.")}</span>
          </span>
        </label>
      </li>
    );
  };
  const empty = people !== null && targets !== null && shownPeople.length + mine.length + theirs.length === 0;
  return (
    <Modal titleId="dm-h" title={add ? "Add to this conversation" : "New direct message"} className="ch-dlg" onClose={props.onClose}>
      <div className="mb">
        <form className="ch-form" noValidate onSubmit={(e) => void submit(e)} data-testid="dm-form">
          <p className="hint">Choose one or more people or agents. Between people only, a direct message is read by them alone and an Admin cannot read it. People see it in Chat when they next open it, whether or not an orchestrator of theirs is running.</p>
          <label>
            Find a person or an agent
            <input className="field" ref={qEl} type="search" autoComplete="off" value={q} placeholder="Search by name" aria-invalid={error?.field === "q" ? true : undefined} onChange={(e) => setQ(e.target.value)} />
          </label>
          <fieldset className="dm-set">
            <legend className="vh">To</legend>
            <ul className="dm-pick">
              {shownPeople.length > 0 && (
                <li>
                  <h3>People</h3>
                </li>
              )}
              {shownPeople.map(personOption)}
              {mine.length > 0 && (
                <li>
                  <h3>Your agents</h3>
                </li>
              )}
              {mine.map(agentOption)}
              {theirs.length > 0 && (
                <li>
                  <h3>Other people&apos;s agents</h3>
                </li>
              )}
              {theirs.map(agentOption)}
              {empty && <li className="none">{q.trim() ? "No person or agent matches that." : "There is no one to message yet."}</li>}
              {(people === null || targets === null) && !loadError && <li className="none">Loading…</li>}
            </ul>
          </fieldset>
          {loadError && (
            <div className="banner bad" role="alert">
              {loadError}
            </div>
          )}
          <p className="hint" role="status" aria-live="polite" data-testid="dm-summary">
            {picked.length > 0 && (add ? `Add ${list(names)} to this conversation.` : `To ${list(names)}.${picked.length > 1 ? ` This makes a conversation of ${picked.length + 1} with you.` : ""}`)}
          </p>
          {hasAgent && (
            <p className="ch-warn" data-testid="dm-agent-warn">
              <ChEye />
              <span>An agent is in this conversation, so an Admin can read it. Everyone in it is told in the console and in their reporter when one does.</span>
            </p>
          )}
          {sole?.conversation && !add && (
            <p className="ch-warn" data-testid="dm-exists">
              <span>
                You already have a conversation with <bdi>{sole.name}</bdi>. Your message goes into it.
              </span>
            </p>
          )}
          {!add && (
            <label>
              Message
              <textarea className="field" ref={msgEl} rows={3} value={text} placeholder="Write the first message." aria-invalid={error?.field === "msg" ? true : undefined} onChange={(e) => setText(e.target.value)} />
            </label>
          )}
          {!add && <p className="hint">Secrets are replaced before a message is stored.</p>}
          {error && (
            <div className="banner bad" role="alert" data-testid="dm-form-error">
              {error.text}
            </div>
          )}
          <div className="acts">
            <button type="button" className="btn" onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" className="btn pri" disabled={busy}>
              {add ? "Add" : "Send message"}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
