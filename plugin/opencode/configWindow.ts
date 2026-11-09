// `/podium config` in OpenCode (#1001): the settings window, as a stack of the terminal UI's dialogs. The rows and words are the shared
// ones in core/settingsWindow.ts; this module builds what the server part hands the TUI part, runs the dialogs, and writes a change.
//
// Who writes: the TUI part, from the person's own press in a dialog, to the `~/.podium/config.env` of the machine it runs on, and only
// when that is the file the reporter reads (the same host and path the server part named). The server part offers no RPC method that
// writes: a bridge method is a route on OpenCode's local HTTP API (`POST /api/rpc/podium-reporter/<method>`), which any process that can
// reach that API, another plugin or a project's script included, can call. An event only opens the dialogs; it changes nothing.
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { OpenCodeOptions } from './options.ts';
import {
  checkValue,
  envLock,
  hintOf,
  isNarrow,
  labelOf,
  LOCKED_NOTE,
  NEXT_START_NOTE,
  noWindowText,
  rowLine,
  SETTING_GROUPS,
  settingById,
  settingsFor,
  writeSettingsLine,
  WINDOW_TITLE,
  type Setting,
} from '../core/settingsWindow.ts';

type Env = Readonly<Record<string, string | undefined>>;

/** One row as the server part sees it now: the value the reporter runs with, and what decides it when the window cannot. */
export interface ConfigRow {
  id: string;
  value: string;
  lock: string | null;
}

/** What `/podium config` hands the TUI part. `host` and `path` say which file the reporter reads, so a TUI on another machine writes nothing. */
export interface ConfigEvent {
  sessionID?: string;
  host: string;
  path: string | null;
  rows: ConfigRow[];
}

/** The reporter's live settings as rows: what it read at its start, not what the file says now. */
export function configEvent(o: { options: OpenCodeOptions; env: Env; projectOptions: Readonly<Record<string, unknown>> | null | undefined; context: string | null; host: string; path: string | null; sessionID?: string }): ConfigEvent {
  const live: Record<string, string> = {
    respond: o.options.respondLevel,
    peers: String(o.options.consent.peers),
    activityFeed: String(o.options.consent.activityFeed),
    server: o.options.serverUrl,
    userName: o.options.userName ?? '',
    idleSeconds: String(Math.round(o.options.idleMs / 1000)),
    context: o.context ?? '',
  };
  const lockOf = (s: Setting): string | null => {
    // opencode.json's idleSeconds wins over the variable and the file (options.ts).
    if (s.id === 'idleSeconds' && o.projectOptions?.idleSeconds !== undefined && o.projectOptions?.idleSeconds !== null) return 'opencode.json';
    return envLock(s, o.env);
  };
  return {
    ...(o.sessionID ? { sessionID: o.sessionID } : {}),
    host: o.host,
    path: o.path,
    rows: settingsFor('opencode').map((s) => ({ id: s.id, value: live[s.id] ?? '', lock: s.editable ? lockOf(s) : null })),
  };
}

/**
 * The server part's half of `/podium config`: hand the TUI part the rows, and answer '' (the window says the rest), or, with no TUI
 * part attached or the event not delivered, say where the settings are.
 */
export async function openConfigWindow(d: { attached: boolean; emit: ((e: ConfigEvent) => Promise<void>) | undefined; path: string | null; event: () => ConfigEvent }): Promise<string> {
  if (!d.attached || !d.emit) return noWindowText('opencode', d.path);
  try {
    await d.emit(d.event());
    return '';
  } catch {
    return noWindowText('opencode', d.path);
  }
}

/** The dialogs the TUI part draws with (OpenCode's `ctx.ui.dialog` and `ctx.ui.toast`). */
export interface DialogUi {
  select: <V>(o: { title: string; placeholder?: string; current?: V; options: readonly { title: string; value: V; description?: string; category?: string; disabled?: boolean }[] }) => Promise<V | undefined>;
  prompt: (o: { title: string; description?: string; placeholder?: string; value?: string }) => Promise<string | undefined>;
  alert: (o: { title: string; message: string }) => Promise<void>;
  toast: (o: { message: string; variant: 'success' | 'error' | 'info' }) => void;
}

/** The file the TUI part writes: read it (null when it is not there) and write it whole. */
export interface SettingsIO {
  read: (path: string) => string | null;
  write: (path: string, text: string) => void;
}

/** Where the TUI part runs: its host and the `config.env` its home holds. */
export interface Here {
  host: string;
  path: string | null;
  /** How many columns the terminal has, for the short labels; null when unknown. */
  columns: number | null;
}

/** The file the reporter reads is this one, on this machine. Anything else writes nothing. */
export const sameFile = (e: ConfigEvent, here: Here): boolean => !!e.path && e.path === here.path && e.host === here.host;

/** Writes `key=value` into the file, through the allow-list. The message for the person; ok false when nothing was written. */
export function saveSetting(io: SettingsIO, path: string, key: string, value: string): { ok: boolean; message: string } {
  let text: string | null;
  try {
    text = io.read(path);
  } catch {
    return { ok: false, message: `Could not read ${path}, so nothing was changed.` };
  }
  const next = writeSettingsLine(text, key, value);
  if (next === null) return { ok: false, message: `${key} cannot be set to that here.` };
  try {
    io.write(path, next);
  } catch {
    return { ok: false, message: `Could not write ${path}.` };
  }
  return { ok: true, message: `Saved ${key} in ${path}. ${NEXT_START_NOTE}` };
}

/** The new value for a row, from its own dialog; undefined when the person closed it. */
async function askValue(ui: DialogUi, s: Setting, value: string): Promise<string | undefined> {
  if (s.kind === 'choice') return ui.select<string>({ title: s.label, current: value, options: (s.choices ?? []).map((c) => ({ title: c, value: c })) });
  if (s.kind === 'switch') return ui.select<string>({ title: s.label, current: value, options: [{ title: 'off', value: 'false' }, { title: 'on', value: 'true' }] });
  return ui.prompt({ title: s.label, description: `${hintOf(s, 'opencode')}. ${NEXT_START_NOTE}`, value });
}

/**
 * The window: a menu of the rows, then a dialog for the one picked, until the person closes the menu. A change is written only for
 * the row they picked, to the value they gave, and only when the file is the reporter's own; a locked or shown-only row explains itself.
 */
export async function runConfigWindow(ui: DialogUi, e: ConfigEvent, here: Here, io: SettingsIO): Promise<void> {
  const narrow = isNarrow(here.columns);
  const rows = new Map(e.rows.map((r) => [r.id, { ...r }]));
  const writable = sameFile(e, here);
  for (;;) {
    const options = [...rows.values()].flatMap((r) => {
      const s = settingById(r.id);
      if (!s) return [];
      const group = SETTING_GROUPS.find((g) => g.id === s.group)!;
      return [{ title: rowLine(s, r.value, narrow, r.lock), value: r.id, category: narrow ? group.short : group.title, ...(narrow ? {} : { description: hintOf(s, 'opencode') }) }];
    });
    const pick = await ui.select<string>({ title: WINDOW_TITLE, placeholder: `Enter changes a setting. Esc closes. ${NEXT_START_NOTE}`, options });
    if (pick === undefined) return;
    const r = rows.get(pick);
    const s = settingById(pick);
    if (!r || !s) continue;
    if (!s.editable) {
      await ui.alert({ title: labelOf(s, narrow), message: `${r.value || 'not set'}\n${hintOf(s, 'opencode')}` });
      continue;
    }
    if (r.lock) {
      await ui.alert({ title: labelOf(s, narrow), message: `Set by ${r.lock}. ${LOCKED_NOTE}` });
      continue;
    }
    if (!writable) {
      await ui.alert({ title: WINDOW_TITLE, message: `The reporter reads ${e.path ?? 'a file this terminal cannot see'} on ${e.host}. Change it there.` });
      continue;
    }
    const next = await askValue(ui, s, r.value);
    if (next === undefined || next === r.value) continue;
    const checked = checkValue(s, next);
    if (!checked.ok) {
      ui.toast({ message: checked.reason, variant: 'error' });
      continue;
    }
    // `writable` held, so `here.path` is the reporter's file; write to the TUI's own path, never one an event named.
    const saved = saveSetting(io, here.path!, s.env!, checked.value);
    if (saved.ok) r.value = checked.value;
    ui.toast({ message: saved.message, variant: saved.ok ? 'success' : 'error' });
  }
}

/** The part of the TUI's `ctx.ui` the window uses. */
export interface ConfigUi {
  dialog: Pick<DialogUi, 'select' | 'prompt' | 'alert'>;
  toast: { show: (o: { message: string; variant: 'success' | 'error' | 'info' }) => void };
  router: { current: () => { type: string; sessionID?: string } };
}

/** The TUIs that have the window open now: one window at a time in each. */
const showing = new WeakSet<object>();

/**
 * The TUI part's half: the window opens in the terminal whose session ran the command (every attached TUI hears the event), one at
 * a time, and a dialog that fails closes it quietly.
 */
export async function showConfig(ui: ConfigUi, e: ConfigEvent, here: Here, io: SettingsIO): Promise<void> {
  const route = ui.router.current();
  if (e.sessionID && !(route.type === 'session' && route.sessionID === e.sessionID)) return;
  if (showing.has(ui)) return;
  showing.add(ui);
  try {
    await runConfigWindow(
      { select: (o) => ui.dialog.select(o), prompt: (o) => ui.dialog.prompt(o), alert: (o) => ui.dialog.alert(o), toast: (o) => ui.toast.show(o) },
      e,
      here,
      io,
    );
  } catch {
    // The terminal closed the dialog under it: nothing was half written, as a write is one call after the person's pick.
  } finally {
    showing.delete(ui);
  }
}

/** The real file: written whole to a new file beside it (0600, in a 0700 folder) and moved into place, so the token is never left in a half-written file. */
export const fileIO: SettingsIO = {
  read: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return null;
      throw err;
    }
  },
  write: (given, text) => {
    mkdirSync(dirname(given), { recursive: true, mode: 0o700 });
    // A config.env that is a symlink (a dotfiles repo) is written through, not replaced by a plain file.
    let path = given;
    try {
      path = realpathSync(given);
    } catch {
      // Not there yet: the first write creates it.
    }
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, path);
      chmodSync(path, 0o600);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  },
};
