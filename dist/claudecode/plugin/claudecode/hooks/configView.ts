// `/podium config` in Claude Code (#1001): what the settings pane shows, from the engine's `/config` rows. Pure; configPane.tsx draws
// it and makes the change. The rows and words are the shared ones in core/settingsWindow.ts.
//
// The pane changes a row only through `$.config.set`, from the person's own pick in it, which writes where Claude Code keeps the
// plugin's options. The token has no row there (the engine lists none for a `sensitive` option) and none here.
import { checkValue, settingsFor, WRITABLE_OPTIONS, type Setting } from '../../core/settingsWindow.ts';

export const PLUGIN = 'podium-reporter';

/** One `/config` row as this module reads it: `ConfigRow` from the engine, the fields used. */
export interface EngineRow {
  key: string;
  value: unknown;
  isLocked: boolean;
}

/** What the reporter runs with now, for the rows the pane only shows. */
export interface Live {
  serverUrl: string;
  userName: string;
  context: string | null;
}

/** A row of the pane: the setting, its value as text, the engine's key for it, and what decides it when the pane cannot. */
export interface PaneRow {
  setting: Setting;
  value: string;
  key: string | null;
  lock: string | null;
}

/** The engine names a plugin's row `<plugin>.<field>`; the plugin part carries the marketplace for an installed copy. */
export function rowFor(rows: readonly EngineRow[], option: string): EngineRow | undefined {
  return rows.find((r) => {
    const dot = r.key.lastIndexOf('.');
    const plugin = r.key.slice(0, dot);
    return r.key.slice(dot + 1) === option && (plugin === PLUGIN || plugin.startsWith(`${PLUGIN}@`));
  });
}

const text = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

/**
 * The pane's rows. A row the engine says a trusted source owns (managed settings) is shown with that and offers no change. The
 * server and the name are what the reporter holds now: the name was taken at the session's start, from the option or `PODIUM_USER`.
 */
export function paneRows(rows: readonly EngineRow[], live: Live): PaneRow[] {
  return settingsFor('claudecode').map((s) => {
    if (s.id === 'server') return { setting: s, value: live.serverUrl, key: null, lock: null };
    if (s.id === 'userName') return { setting: s, value: live.userName, key: null, lock: null };
    if (s.id === 'context') return { setting: s, value: live.context ?? '', key: null, lock: null };
    const r = rowFor(rows, s.option!);
    // A switch the engine holds as anything but true reads as off, as readOptions does.
    const value = s.kind === 'switch' ? String(r?.value === true) : text(r?.value);
    return { setting: s, value, key: r?.key ?? null, lock: r?.isLocked ? 'managed settings' : null };
  });
}

/** Whether the pane offers a control for a row: a setting the window changes, with a row in the engine, that nothing else decides. */
export const changeable = (r: PaneRow): boolean => r.setting.editable && WRITABLE_OPTIONS.has(r.setting.option ?? '') && r.key !== null && r.lock === null;

/** The value `$.config.set` takes for a pick or an entry: the row's own kind. A refusal says why, and nothing is set. */
export function engineValue(r: PaneRow, raw: string): { ok: true; value: string | number | boolean } | { ok: false; reason: string } {
  if (!changeable(r)) return { ok: false, reason: `${r.setting.label} cannot be changed here.` };
  const checked = checkValue(r.setting, raw);
  if (!checked.ok) return checked;
  if (r.setting.kind === 'switch') return { ok: true, value: checked.value === 'true' };
  if (r.setting.kind === 'number') return { ok: true, value: Number(checked.value) };
  return { ok: true, value: checked.value };
}

/** The rows the pane asks for: one per line it draws, and room for the longest list to open under its control. */
export function paneHeight(rows: readonly PaneRow[]): number {
  const groups = new Set(rows.map((r) => r.setting.group));
  const hints = ['connection', 'context'].filter((g) => groups.has(g as never)).length;
  const longest = Math.max(0, ...rows.map((r) => r.setting.choices?.length ?? 0));
  // Each row and group heading, the hint under Connection and Context, the two footer lines, and the open list.
  return rows.length + groups.size + hints + 2 + longest;
}
