// The two forms Chat opens in a modal (#1035, mockup/podium-channels.html): New channel (which also edits a description, with the name and the
// link fixed) and New direct message. Both are the console's Modal. A refusal is shown in the server's own words in a red banner; nothing here
// is drawn as HTML, and the person's text is only ever sent, never kept.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Modal } from "./Modal";
import { StateIcon } from "./Chips";
import { agentState, STATE_WORD } from "./ChatSidebar";
import { plain, type ChannelLink, type ChannelLinkKind, type ChatApi, type ChatChannel, type DirectTarget } from "../chatData";
import { RespondError } from "../respondApi";
import { failReason } from "../useMyPeers";
import type { SessionView } from "../types";

/** The name the server accepts, after it is lowercased (the same rule as the store's). */
export const CHANNEL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const DESC_MAX = 280;
export const REF_MAX = 100;

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
export function fieldOf(reason: string, text: string, edit: boolean): "name" | "ref" | "desc" | "banner" {
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
    <Modal titleId="nc-h" title={edit ? "Edit description" : "New channel"} onClose={props.onClose}>
      <div className="mb">
        <form className="ch-form" noValidate onSubmit={(e) => void submit(e)} data-testid="channel-form">
          <p className="hint">Everyone signed in to this server can read and post in a channel, including every Admin and every orchestrator. Do not put anything here you would not want all of them to read.</p>
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
                About (optional)
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

export function DirectModal(props: { api: ChatApi; sessions: Record<string, SessionView>; onClose: () => void; onDone: (t: DirectTarget, said: string) => void | Promise<void> }) {
  const [q, setQ] = useState("");
  const [targets, setTargets] = useState<DirectTarget[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<{ text: string; field: "q" | "msg" } | null>(null);
  const [busy, setBusy] = useState(false);
  const qEl = useRef<HTMLInputElement>(null);
  useFirstFocus(qEl);
  const msgEl = useRef<HTMLTextAreaElement>(null);
  // The list is asked for as the person types; an answer to an older question never replaces a newer one.
  const asked = useRef(0);
  useEffect(() => {
    const mine = ++asked.current;
    props.api
      .directTargets(q.trim())
      .then((r) => {
        if (asked.current !== mine) return;
        setTargets(r.targets);
        setLoadError(null);
      })
      .catch((err) => {
        if (asked.current !== mine) return;
        setLoadError(`Could not read who you can message: ${plain(failReason(err))}. Try again.`);
      });
    // props.api is stable for the page's life.
  }, [q]);
  const shown = (targets ?? []).filter((t) => t.own || t.status !== "done");
  const mine = shown.filter((t) => t.own);
  const theirs = shown.filter((t) => !t.own);
  const fail = (text: string, field: "q" | "msg") => {
    setError({ text, field });
    (field === "q" ? qEl : msgEl).current?.focus();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const target = shown.find((t) => t.sessionId === to);
    if (!target) return fail("Choose who to message.", "q");
    if (!text.trim()) return fail("Write the first message.", "msg");
    setBusy(true);
    try {
      const r = await props.api.sendDm("me", target.sessionId, text.trim());
      const bad = [...r.errors.map((x) => `${x.name}: ${x.error}`), ...r.skipped.map((s) => s.why)];
      const said = bad.length ? `Sent, but ${bad.join(" ")}` : target.own ? `Sent to ${target.name}.` : `Sent. It waits for ${r.message.waitingFor ?? target.owner} to approve it.`;
      await props.onDone(target, said);
    } catch (err) {
      fail(refusal(err, "send the message").replace("Nothing was saved.", "Nothing was sent."), "msg");
      setBusy(false);
    }
  };
  const option = (t: DirectTarget) => {
    const kind = agentState(props.sessions, t.sessionId, t.status);
    return (
      <li key={t.sessionId}>
        <label aria-disabled={!t.canMessage ? true : undefined}>
          <input type="radio" name="dm-to" value={t.sessionId} checked={to === t.sessionId} disabled={!t.canMessage} onChange={() => setTo(t.sessionId)} />
          <StateIcon kind={kind} />
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
            <span className="sub">
              {t.canMessage ? (t.own ? `Your orchestrator, ${STATE_WORD[kind]}` : `Orchestrator, ${STATE_WORD[kind]}. ${t.owner} approves before it is delivered.`) : (t.why ?? "It takes no messages now.")}
            </span>
          </span>
        </label>
      </li>
    );
  };
  return (
    <Modal titleId="dm-h" title="New direct message" onClose={props.onClose}>
      <div className="mb">
        <form className="ch-form" noValidate onSubmit={(e) => void submit(e)} data-testid="dm-form">
          <p className="hint">A Direct Message is read only by you, the agent&apos;s owner and an Admin. A subagent or a fork is not offered: message its orchestrator.</p>
          <label>
            Find an agent
            <input className="field" ref={qEl} type="search" autoComplete="off" value={q} placeholder="Search by agent or person" aria-invalid={error?.field === "q" ? true : undefined} onChange={(e) => setQ(e.target.value)} />
          </label>
          <fieldset className="dm-set">
            <legend className="vh">To</legend>
            <ul className="dm-pick">
              {mine.length > 0 && (
                <li>
                  <h3>Your agents</h3>
                </li>
              )}
              {mine.map(option)}
              {theirs.length > 0 && (
                <li>
                  <h3>Other people&apos;s agents</h3>
                </li>
              )}
              {theirs.map(option)}
              {targets !== null && shown.length === 0 && <li className="none">{q.trim() ? "No agent matches that." : "No orchestrator is reporting yet."}</li>}
              {targets === null && !loadError && <li className="none">Loading…</li>}
            </ul>
          </fieldset>
          {loadError && (
            <div className="banner bad" role="alert">
              {loadError}
            </div>
          )}
          <label>
            Message
            <textarea className="field" ref={msgEl} rows={3} value={text} placeholder="Write the first message." aria-invalid={error?.field === "msg" ? true : undefined} onChange={(e) => setText(e.target.value)} />
          </label>
          <p className="hint">Secrets are replaced before a message leaves this machine. Another person&apos;s agent gets it only after its owner approves, in their My reporters.</p>
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
              Send message
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
