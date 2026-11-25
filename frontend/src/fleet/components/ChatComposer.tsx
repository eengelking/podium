// Chat's message box (#1034, mockup/podium-chat.html). Enter sends, Shift+Enter adds a line, and a key press that is choosing an
// IME character is left alone. In a channel, typing `@` opens a combobox of what the server says can be addressed: arrow keys move,
// Enter or Tab picks, Escape closes. In a message to the person's own agent, `/` opens the Activity window's command list instead
// (/clear after a confirmation, /compact at once; #1051). A name may hold spaces and two agents may share a name at different places; both are listed
// and the list narrows as you type. @group and @everyone are listed but cannot be picked while the Admin has them off.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChatAvatar } from "./ChatAvatar";
import { ChAt, ChGroup, ChSend, ChSlash } from "./ChatIcons";
import { StateIcon, type StateKind } from "./Chips";
import { addressMatches, mentionQuery, type Address } from "../chatData";
import type { ModelFamily } from "../types";
import { ClearConfirm, CommandList, useSlashCommands } from "./SlashCommands";

/** The one word beside a state's shape in the @ list, so a state is never shape or color alone. */
const STATE_WORD: Record<StateKind, string> = { running: "Running", waiting: "Waiting", deleg: "Delegating", bg: "Background", stale: "Stale", done: "Done" };

/** The most a message box grows to (px) before it scrolls inside; chat.css `.ch-box textarea` says the same number. */
const BOX_MAX_PX = 180;

export interface ComposerProps {
  /** The box's accessible name ("Message My group"); it is not drawn. */
  label: string;
  draft: string;
  onDraft: (v: string) => void;
  /** Why the box is off, or null. It disables the box and says why under it. */
  off: string | null;
  /** The one word for the box's placeholder while it is off ("Paused"); the reason is the note under it. */
  offWord?: string | null;
  note: string;
  /** A button beside the note while the box is off (an Admin's Stop reading, #1238). */
  noteAction?: ReactNode;
  /** An error in words, shown above the box; the draft stays. */
  error: string | null;
  sending: boolean;
  onSend: () => void;
  /** The channel `@` is for; null where `@` means nothing (a Direct Message). */
  channel: string | null;
  addresses: Address[];
  loadAddresses: () => Promise<void>;
  stateOf: (a: Address) => StateKind | null;
  /** An agent's model family, for the color of its tile in the @ list. */
  familyOf?: (a: Address) => ModelFamily | undefined;
  /** A request to write text at the caret and focus the box (a Mention from a sender's menu, #1235). Each request has its own `n`; the same `n` is never applied twice. */
  insert?: { n: number; text: string } | null;
  /** Set for a message to the person's own agent, where `/clear` and `/compact` are commands; absent everywhere else, where `/` is text. */
  commands?: {
    /** The agent's name, for the words /clear asks with. */
    agent: string;
    /** The commands its reporter declared, without the slash; null lists every command (see useSlashCommands). */
    declared: readonly string[] | null;
    confirmClear: boolean;
    onConfirmClear: (on: boolean) => void;
    /** Sends `/clear`, after the person confirmed. */
    onClear: () => void;
  };
}

export function ChatComposer(p: ComposerProps) {
  const uid = useId();
  const listId = `${uid}-ac`;
  const box = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const [range, setRange] = useState<{ from: number; to: number; q: string } | null>(null);
  const [at, setAt] = useState(0);
  const items = range && p.channel ? addressMatches(p.addresses, range.q) : [];
  const open = items.length > 0;
  const active = Math.min(at, Math.max(0, items.length - 1));
  const cmd = useSlashCommands(p.draft, p.onDraft, p.commands?.declared, !!p.commands);
  const asking = !!p.commands?.confirmClear;
  const cmdOpen = cmd.matches.length > 0 && !asking;
  const cmdId = `${uid}-cmd`;
  const popup = open || cmdOpen;
  const problem = p.commands !== undefined && cmd.problem !== null;
  /** Sends the draft, except a command that is not on offer, and /clear, which asks first. */
  const submit = () => {
    const text = p.draft.trim();
    if (p.off !== null || p.sending || !text) return;
    if (p.commands && text.startsWith("/")) {
      if (!cmd.offered.some((c) => c.name === text)) return;
      if (text === "/clear") return p.commands.onConfirmClear(true);
    }
    p.onSend();
  };

  // One line to start, growing with the text up to BOX_MAX_PX and scrolling inside after that. A pane that is not drawn measures 0, and is left alone.
  useLayoutEffect(() => {
    const t = box.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = t.scrollHeight > 0 ? `${Math.min(t.scrollHeight, BOX_MAX_PX)}px` : "";
  }, [p.draft]);

  useEffect(() => {
    if (caret.current !== null && box.current) {
      box.current.selectionStart = box.current.selectionEnd = caret.current;
      caret.current = null;
    }
  });
  // A Mention: the address goes in at the caret (or the end, when the box never had one) with a space before it unless one is there and a space after unless one follows.
  const inserted = useRef(0);
  useEffect(() => {
    const req = p.insert;
    const t = box.current;
    if (!req || req.n === inserted.current || !t) return;
    inserted.current = req.n;
    const at = t.selectionStart ?? p.draft.length;
    const end = t.selectionEnd ?? at;
    const lead = at > 0 && !/\s/.test(p.draft[at - 1]!) ? " " : "";
    // The caret ends after one space past the address, which is the space already there when the text goes in before one.
    const trail = /^\s/.test(p.draft.slice(end)) ? "" : " ";
    p.onDraft(p.draft.slice(0, at) + lead + req.text + trail + p.draft.slice(end));
    caret.current = at + lead.length + req.text.length + 1;
    t.focus();
  }, [p.insert]);

  // A send clears the draft without a keystroke; the open @ range is over with it, so the next @ loads the addresses again.
  useEffect(() => {
    if (!p.draft) setRange(null);
  }, [p.draft]);

  const track = (value: string, pos: number) => {
    const q = p.channel ? mentionQuery(value, pos) : null;
    if (!q) return void setRange(null);
    if (!range) void p.loadAddresses();
    setRange(q);
  };
  const pick = (n: number) => {
    const a = items[n];
    if (!a || a.disabled || !range) return;
    const ins = `@${a.typed} `;
    p.onDraft(p.draft.slice(0, range.from) + ins + p.draft.slice(range.to));
    caret.current = range.from + ins.length;
    setRange(null);
    setAt(0);
    box.current?.focus();
  };
  /** The @ tool: writes an @ at the end of the draft (after a space, when the draft does not end in one) and opens the list. */
  const tool = (ins: string) => {
    const t = box.current;
    if (!t || p.off !== null) return;
    const v = ins === "@" && p.draft && !/\s$/.test(p.draft) ? `${p.draft} @` : p.draft + ins;
    p.onDraft(v);
    caret.current = v.length;
    t.focus();
    track(v, v.length);
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = e.nativeEvent.isComposing;
    if (p.commands && !asking && !composing && cmd.onListKey(e)) return;
    if (open) {
      if (e.key === "ArrowDown") {
        setAt((active + 1) % items.length);
        return e.preventDefault();
      }
      if (e.key === "ArrowUp") {
        setAt((active + items.length - 1) % items.length);
        return e.preventDefault();
      }
      if (e.key === "Escape") {
        setRange(null);
        return e.preventDefault();
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !composing) {
        pick(active);
        return e.preventDefault();
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !composing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="ch-composer">
      <label className="vh" htmlFor={`${uid}-msg`}>
        {p.label}
      </label>
      {p.error && (
        <div className="errbox" role="alert" data-testid="chat-send-error">
          {p.error}
        </div>
      )}
      {p.commands &&
        (asking ? (
          <ClearConfirm
            name={p.commands.agent}
            onCancel={() => p.commands!.onConfirmClear(false)}
            onClear={() => {
              p.commands!.onConfirmClear(false);
              p.commands!.onClear();
            }}
          />
        ) : (
          cmd.problem && (
            <div className="err" role="alert">
              {cmd.problem}
            </div>
          )
        ))}
      <div className="cr-wrap">
        {cmdOpen && <CommandList id={cmdId} matches={cmd.matches} active={cmd.ta} onChoose={cmd.choose} />}
        <ul className="ch-ac" id={listId} role="listbox" aria-label="People and agents" hidden={!open} data-testid="chat-listbox">
          {items.map((a, n) => {
            const state = a.sessionId ? p.stateOf(a) : null;
            const name = a.typed.split("@")[0]!;
            return (
              <li
                key={`${a.typed}|${a.sessionId ?? ""}`}
                role="option"
                id={`${listId}-${n}`}
                aria-selected={n === active}
                aria-disabled={a.disabled || undefined}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(n);
                }}
              >
                {a.role === "orchestrator" ? (
                  <ChatAvatar kind="agent" name={name} size={28} family={p.familyOf?.(a)} />
                ) : a.role === "person" ? (
                  <ChatAvatar kind="person" name={name} size={28} />
                ) : (
                  <span className="ch-av person s28" aria-hidden="true">
                    <ChGroup />
                  </span>
                )}
                <span className="t">
                  <b className="h">
                    @<bdi>{a.typed}</bdi>
                  </b>
                  <span className="r">{a.label}</span>
                  {a.disabled && <span className="off">{a.why ?? "Off."}</span>}
                </span>
                {state && (
                  <span className="stw">
                    <StateIcon kind={state} />
                    {STATE_WORD[state]}
                  </span>
                )}
              </li>
            );
          })}
          <li className="ft" aria-hidden="true">
            Up and down to choose, Tab or Enter to mention, Esc to close
          </li>
        </ul>
        <div className="ch-box">
          <textarea
            id={`${uid}-msg`}
            ref={box}
            rows={1}
            role={popup ? "combobox" : undefined}
            aria-expanded={popup || undefined}
            aria-autocomplete="list"
            data-keeps-tab={popup ? "" : undefined}
            aria-describedby={`${uid}-note ${uid}-hint`}
            aria-controls={open ? listId : cmdOpen ? cmdId : undefined}
            aria-activedescendant={open ? `${listId}-${active}` : cmdOpen ? `${cmdId}-${Math.min(cmd.ta, cmd.matches.length - 1)}` : undefined}
            disabled={p.off !== null}
            placeholder={p.off !== null ? (p.offWord ?? "Off") : p.channel ? "Write a message. Type @ to address someone." : p.commands ? "Write a message, or type / for a command." : "Write a message."}
            value={p.draft}
            data-testid="chat-box"
            onChange={(e) => {
              p.onDraft(e.target.value);
              setAt(0);
              cmd.resetTa();
              track(e.target.value, e.target.selectionStart);
            }}
            onKeyDown={key}
            onBlur={() => setRange(null)}
          />
          <div className="cr-tools">
            {p.channel && (
              <button type="button" className="cr-tool" aria-label="Mention someone" title="Mention someone" disabled={p.off !== null} data-testid="chat-tool-at" onMouseDown={(e) => e.preventDefault()} onClick={() => tool("@")}>
                <ChAt />
              </button>
            )}
            {p.commands && (
              <button type="button" className="cr-tool" aria-label="Session commands" title="Session commands (/clear, /compact)" disabled={p.off !== null || (p.draft !== "" && !p.draft.startsWith("/"))} data-testid="chat-tool-slash" onMouseDown={(e) => e.preventDefault()} onClick={() => (p.draft ? box.current?.focus() : tool("/"))}>
                <ChSlash />
              </button>
            )}
            <span className="hint" id={`${uid}-hint`}>
              <kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> for a new line
            </span>
            <button type="button" className="btn pri ch-send" aria-label="Send message" title="Send message" disabled={p.off !== null || p.sending || !p.draft.trim() || problem} aria-busy={p.sending || undefined} data-testid="chat-send" onClick={submit}>
              <ChSend />
            </button>
          </div>
        </div>
      </div>
      {p.noteAction ? (
        <div className="note warn with-btn" id={`${uid}-note`} data-testid="chat-ro-note">
          <span>{p.off ?? p.note}</span>
          {p.noteAction}
        </div>
      ) : (
        <div className={`note${p.off !== null ? " warn" : ""}`} id={`${uid}-note`}>
          {p.off ?? p.note}
        </div>
      )}
      {/* The list is not a combobox's popup, so how many matches there are is said here. */}
      <div className="vh" role="status" aria-live="polite" data-testid="chat-matches">
        {open ? `${items.length} ${items.length === 1 ? "person or agent" : "people and agents"}. Use the arrow keys.` : cmdOpen ? `${cmd.matches.length} ${cmd.matches.length === 1 ? "command" : "commands"}. Use the arrow keys.` : ""}
      </div>
    </div>
  );
}
