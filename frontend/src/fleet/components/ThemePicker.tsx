import { useId, type KeyboardEvent } from "react";
import type { ModeChoice } from "../themes";
import { THEMES } from "../themes";
import type { useTheme } from "../useTheme";

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

/** The keys the Shortcuts switch turns on, named in its hint so a person can find them (#636). */
export const SHORTCUTS_HINT = "Press \\ for the top bar, [ and ] for the side panes, and w for wall mode. Esc leaves wall mode.";

/** The Shortcuts field in the Display settings row, beside the Theme controls (#636): the Admin switch (`.sw`) in a `.field`. Off by default; the choice is per browser. */
export function ShortcutsSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const id = useId();
  return (
    <span className="field">
      <span id={`${id}-n`}>Shortcuts</span>
      <span className="sw">
        <button type="button" role="switch" aria-checked={on} aria-labelledby={`${id}-n ${id}-s`} aria-describedby={`${id}-d`} title={SHORTCUTS_HINT} onClick={() => onChange(!on)} />
        <span id={`${id}-s`}>{on ? "On" : "Off"}</span>
      </span>
      <span id={`${id}-d`} className="vh">
        {SHORTCUTS_HINT}
      </span>
    </span>
  );
}
