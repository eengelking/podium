import { useState, type KeyboardEvent } from "react";
import { COMMANDS } from "../respond";

// The slash commands a message box offers (#206 for the Activity window's box, #1051 for Chat's message to your own agent): the list
// that opens on `/`, how a draft is judged, and the warning box /clear asks first with. Compose and ChatComposer both use these, so
// the two boxes list the same commands, filter them by the reporter's declared capabilities the same way, and say the same words.

/**
 * The state of a box's commands. `commands` is what the session's reporter declared, without the slash: null or left out lists every
 * command, an empty list lists none. `enabled` false is a box that takes no commands (it is plain text, even when it starts with `/`).
 */
export function useSlashCommands(draft: string, onDraft: (t: string) => void, commands?: readonly string[] | null, enabled = true) {
  const [ta, setTa] = useState(0);
  const slash = enabled && draft.startsWith("/") ? (draft.split(/\s/)[0] ?? "") : null;
  const offered = commands ? COMMANDS.filter((c) => commands.includes(c.name.slice(1))) : COMMANDS;
  const known = slash !== null && offered.some((c) => c.name === slash);
  const matches = slash !== null && !draft.includes(" ") && !known ? offered.filter((c) => c.name.startsWith(slash)) : [];
  const choose = (name: string) => {
    onDraft(name);
    setTa(0);
  };
  /** The arrow, Tab and Enter keys of an open list. True when it handled the key, which is then not a send. */
  const onListKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (matches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setTa((n) => (n + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
      return true;
    }
    if (matches.length && (e.key === "Tab" || e.key === "Enter")) {
      e.preventDefault();
      choose(matches[Math.min(ta, matches.length - 1)]!.name);
      return true;
    }
    return false;
  };
  /** What a draft that starts with `/` gets wrong, in words, or null. */
  let problem: string | null = null;
  if (slash && !known && draft.length > 1 && !matches.length) problem = `${slash} runs only in the terminal. From here you can send ${offered.map((c) => c.name).join(" and ") || "no commands"}.`;
  else if (known && draft.trim() !== slash) problem = `${slash} takes nothing after it from here. Send ${slash} on its own, or use the terminal.`;
  return { ta, resetTa: () => setTa(0), slash, offered, known, matches, choose, onListKey, problem };
}

/** The list that opens above a message box on `/`. */
export function CommandList(props: { matches: readonly { name: string; desc: string }[]; active: number; onChoose: (name: string) => void }) {
  return (
    <div className="typeahead" role="listbox" aria-label="Commands">
      {props.matches.map((m, i) => (
        <button key={m.name} type="button" role="option" aria-selected={i === props.active} className={i === props.active ? "on" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => props.onChoose(m.name)}>
          <span className="cn">{m.name}</span>
          <span className="cd">{m.desc}</span>
        </button>
      ))}
      <div className="tf">Other commands run only in the terminal.</div>
    </div>
  );
}

/** What /clear asks first, in the words the Activity window uses. */
export function ClearConfirm(props: { name: string; onCancel: () => void; onClear: () => void }) {
  return (
    <div className="confirm" role="alertdialog" aria-label="Clear the conversation?">
      <span>
        <b>Clear the conversation?</b> {props.name} starts over with an empty context. Podium shows the cleared part as its own session in History, linked to this one.
      </span>
      <span className="acts">
        <button className="btn" type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button className="btn bad" type="button" autoFocus onClick={props.onClear}>
          Clear conversation
        </button>
      </span>
    </div>
  );
}
