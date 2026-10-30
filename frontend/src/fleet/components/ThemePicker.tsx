import { Fragment, useId, useRef, useState, type KeyboardEvent } from "react";
import type { ModeChoice } from "../themes";
import { THEMES } from "../themes";
import type { useTheme } from "../useTheme";
import { Modal } from "./Modal";

const MODES: { id: ModeChoice; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

// Arrow keys move through the radios and select as they go, as a native radio group does. Only the
// checked one is in the tab order.
function onRadioKey(e: KeyboardEvent<HTMLButtonElement>, mode: ModeChoice, set: (m: ModeChoice) => void) {
  const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  const next = MODES[(MODES.findIndex((m) => m.id === mode) + step + MODES.length) % MODES.length].id;
  set(next);
  const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]");
  buttons?.[MODES.findIndex((m) => m.id === next)]?.focus();
}

// A theme dropdown plus a light/dark/system radio group, shown at the right of the info row under the
// top bar. The palette credits are in the rail footer.
export function ThemePicker({ theme }: { theme: ReturnType<typeof useTheme> }) {
  const current = THEMES.find((t) => t.id === theme.theme);
  return (
    <div className="themepick">
      <label className="field">
        <span>Theme</span>
        <select className="sel" value={theme.theme} onChange={(e) => theme.setTheme(e.target.value)} title={current?.credit}>
          {THEMES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <div className="modeseg" role="radiogroup" aria-label="Mode">
        {MODES.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={theme.mode === m.id} tabIndex={theme.mode === m.id ? 0 : -1} onClick={() => theme.setMode(m.id)} onKeyDown={(e) => onRadioKey(e, theme.mode, theme.setMode)}>
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One keyboard shortcut. `hint` is the phrase the switch's hint uses for it; entries that share one are joined ("[ and ] for the side panes"). */
export type Shortcut = { keys: string; label: string; note?: string; column: 0 | 1; hint: string; printable: boolean };

/** Every keyboard shortcut, in the order the list shows them (#828). The "Keyboard shortcuts" list and SHORTCUTS_HINT both come from it. */
export const SHORTCUTS: Shortcut[] = [
  { keys: "\\", label: "Show or hide the top bar", column: 0, hint: "for the top bar", printable: true },
  { keys: "[", label: "Show or hide the left pane", note: "Does nothing on Traffic, which has no rail.", column: 0, hint: "for the side panes", printable: true },
  { keys: "]", label: "Show or hide the right pane", note: "Does nothing on Traffic, which has no side panel.", column: 0, hint: "for the side panes", printable: true },
  { keys: "w", label: "Start or stop wall mode", note: "Does nothing on Traffic or My reporters, which draw no wall.", column: 1, hint: "for wall mode", printable: true },
  { keys: "Esc", label: "Leave wall mode", note: "Works with Shortcuts Off too.", column: 1, hint: "Esc leaves wall mode.", printable: false },
];

/** The keys the Shortcuts switch turns on, named in its hint so a person can find them (#636), built from SHORTCUTS. */
export const SHORTCUTS_HINT = (() => {
  const phrases: { keys: string[]; hint: string }[] = [];
  for (const s of SHORTCUTS.filter((x) => x.printable)) {
    const last = phrases[phrases.length - 1];
    if (last?.hint === s.hint) last.keys.push(s.keys);
    else phrases.push({ keys: [s.keys], hint: s.hint });
  }
  const parts = phrases.map((p) => `${p.keys.join(" and ")} ${p.hint}`);
  const lead = parts.length > 1 ? `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}` : parts.join("");
  return `Press ${lead}. ${SHORTCUTS.filter((x) => !x.printable)
    .map((x) => x.hint)
    .join(" ")}`;
})();

/** The list of every keyboard shortcut: two columns split by a pipe, which stack under 480 px (#828, mockup/podium-shortcuts-help.html). */
function ShortcutsList({ onClose }: { onClose: () => void }) {
  const id = useId();
  const columns = [
    { name: "Panes", items: SHORTCUTS.filter((s) => s.column === 0) },
    { name: "Wall mode", items: SHORTCUTS.filter((s) => s.column === 1) },
  ];
  return (
    <Modal titleId={`${id}-t`} title="Keyboard shortcuts" sub="Work anywhere outside a text field while Shortcuts is On." onClose={onClose}>
      <div className="mb">
        <div className="kbd-cols">
          {columns.map((c, i) => (
            <Fragment key={c.name}>
              {i > 0 && <span className="pipe" aria-hidden="true" />}
              <ul className="kbd-col" aria-label={c.name}>
                {c.items.map((s) => (
                  <li key={s.keys}>
                    <span className="what">{s.label}</span>
                    <span className="keys">
                      <code>{s.keys}</code>
                    </span>
                    {s.note && <span className="note">{s.note}</span>}
                  </li>
                ))}
              </ul>
            </Fragment>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/** The Shortcuts field in the Display settings row, beside the Theme controls (#636): the Admin switch (`.sw`) in a `.field`. Off by default; the choice is per browser. While it is On the word "Shortcuts" is a button that opens the list of keys (#828); Off, it is a plain label. */
export function ShortcutsSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const link = useRef<HTMLButtonElement>(null);
  // Focus goes back after the browser's own mousedown focus change: a press on the dimmed area closes the modal on mousedown,
  // and the browser then moves focus to the page, so focusing the link at once would be undone.
  const close = () => {
    setOpen(false);
    setTimeout(() => link.current?.focus(), 0);
  };
  return (
    <span className="field">
      <span id={`${id}-n`}>
        {on ? (
          <button type="button" className="kbd-link" ref={link} aria-haspopup="dialog" onClick={() => setOpen(true)}>
            Shortcuts
          </button>
        ) : (
          "Shortcuts"
        )}
      </span>
      <span className="sw">
        <button type="button" role="switch" aria-checked={on} aria-labelledby={`${id}-n ${id}-s`} aria-describedby={`${id}-d`} title={SHORTCUTS_HINT} onClick={() => onChange(!on)} />
        <span id={`${id}-s`}>{on ? "On" : "Off"}</span>
      </span>
      <span id={`${id}-d`} className="vh">
        {SHORTCUTS_HINT}
      </span>
      {on && open && <ShortcutsList onClose={close} />}
    </span>
  );
}
