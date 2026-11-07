// Chat's message box (#1034, mockup/podium-chat.html). Enter sends, Shift+Enter adds a line, and a key press that is choosing an
// IME character is left alone. In a channel, typing `@` opens a combobox of what the server says can be addressed: arrow keys move,
// Enter or Tab picks, Escape closes. In a message to the person's own agent, `/` opens the Activity window's command list instead
// (/clear after a confirmation, /compact at once; #1051). A name may hold spaces and two agents may share a name at different places; both are listed
// and the list narrows as you type. @group and @everyone are listed but cannot be picked while the Admin has them off.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Monogram } from "./People";
import { StateIcon, type StateKind } from "./Chips";
import { addressMatches, mentionQuery, type Address } from "../chatData";
import { ClearConfirm, CommandList, useSlashCommands } from "./SlashCommands";

export interface ComposerProps {
  label: string;
  draft: string;
  onDraft: (v: string) => void;
  /** Why the box is off, or null. It disables the box and says why under it. */
  off: string | null;
  /** The one word for the box's placeholder while it is off ("Paused"); the reason is the note under it. */
  offWord?: string | null;
  note: string;
  /** An error in words, shown above the box; the draft stays. */
  error: string | null;
  sending: boolean;
  onSend: () => void;
  /** The channel `@` is for; null where `@` means nothing (a Direct Message). */
  channel: "general" | "group" | null;
  addresses: Address[];
  loadAddresses: () => Promise<void>;
  stateOf: (a: Address) => StateKind | null;
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

  useEffect(() => {
    if (caret.current !== null && box.current) {
      box.current.selectionStart = box.current.selectionEnd = caret.current;
      caret.current = null;
    }
  });

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
      <label htmlFor={`${uid}-msg`}>{p.label}</label>
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
      <div className="row">
        {cmdOpen && <CommandList matches={cmd.matches} active={cmd.ta} onChoose={cmd.choose} />}
        <ul className="ch-ac" id={listId} role="listbox" aria-label="People and agents" hidden={!open} data-testid="chat-listbox">
          {items.map((a, n) => {
            const state = a.sessionId ? p.stateOf(a) : null;
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
                <span className="ic0">{state ? <StateIcon kind={state} /> : a.role === "person" ? <Monogram name={a.typed.split("@")[0]!} size="sm" /> : null}</span>
                <span className="h">
                  @<bdi>{a.typed}</bdi>
                </span>
                <span className="r">{a.label}</span>
                {a.disabled && <span className="off">{a.why ?? "Off."}</span>}
              </li>
            );
          })}
        </ul>
        <textarea
          id={`${uid}-msg`}
          ref={box}
          rows={2}
          role={cmdOpen ? "combobox" : undefined}
          aria-expanded={cmdOpen || undefined}
          aria-autocomplete="list"
          data-keeps-tab={cmdOpen ? "" : undefined}
          aria-describedby={`${uid}-note`}
          aria-controls={listId}
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
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
        <button type="button" className="btn pri" disabled={p.off !== null || p.sending || (p.commands !== undefined && cmd.problem !== null)} aria-busy={p.sending || undefined} data-testid="chat-send" onClick={submit}>
          Send
        </button>
      </div>
      <div className={`note${p.off !== null ? " warn" : ""}`} id={`${uid}-note`}>
        {p.off ?? p.note}
      </div>
      {/* The list is not a combobox's popup, so how many matches there are is said here. */}
      <div className="vh" role="status" aria-live="polite" data-testid="chat-matches">
        {open ? `${items.length} ${items.length === 1 ? "person or agent" : "people and agents"}. Use the arrow keys.` : cmdOpen ? `${cmd.matches.length} ${cmd.matches.length === 1 ? "command" : "commands"}. Use the arrow keys.` : ""}
      </div>
    </div>
  );
}
