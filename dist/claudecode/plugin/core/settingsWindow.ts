// The settings window `/podium config` opens (#1001): one description of its rows, read by every harness, so the groups, the words,
// the allowed values and which key is which are the same in each. Pure: no engine, no file system; each harness draws the rows with
// what its own interface has and writes a change where it reads its settings.
//
// A consent option is the person's own choice (core/settings.ts). Nothing here reads a project's files: a value is changed only from
// the person's own press in the window, and `writeSettingsLine` changes only the keys on the allow-list, to a value `checkValue` took.

import { CONSENT_VARS } from './settings.ts';

export type Harness = 'claudecode' | 'opencode';
export type SettingGroup = 'consent' | 'connection' | 'timing' | 'context';
/** `choice` picks one of `choices`, `switch` is on or off, `number` is a whole number of at least `min`, `info` is shown and never changed here. */
export type SettingKind = 'choice' | 'switch' | 'number' | 'info';

export interface Setting {
  id: string;
  group: SettingGroup;
  /** The label drawn at a normal width. */
  label: string;
  /** The label drawn at a narrow width (`isNarrow`). */
  short: string;
  kind: SettingKind;
  choices?: readonly string[];
  /** The lowest number a `number` takes; the reporter reads a lower one as this. */
  min?: number;
  /** The Claude Code option (the `userConfig` field) that holds it; null where Claude Code has none. */
  option: string | null;
  /** The `PODIUM_*` variable that holds it for OpenCode (environment first, then `~/.podium/config.env`); null where OpenCode reads none. */
  env: string | null;
  /** Whether the window may change it. Connection and context rows are shown only. */
  editable: boolean;
}

/** The groups in the order every harness draws them, with the heading for each width. */
export const SETTING_GROUPS: readonly { id: SettingGroup; title: string; short: string }[] = [
  { id: 'consent', title: 'Consent (your choice)', short: 'Consent (yours)' },
  { id: 'connection', title: 'Connection', short: 'Connection' },
  { id: 'timing', title: 'Timing', short: 'Timing' },
  { id: 'context', title: 'Context', short: 'Context' },
];

export const RESPOND_CHOICES = ['off', 'questions', 'questions-and-plans', 'everything'] as const;

/** Every row the window can show. A harness shows a row that it has a home for (`settingsFor`). The token is not here, and never will be. */
export const SETTINGS: readonly Setting[] = [
  { id: 'respond', group: 'consent', label: 'Respond from Podium', short: 'Respond', kind: 'choice', choices: RESPOND_CHOICES, option: 'respond', env: CONSENT_VARS.respond, editable: true },
  { id: 'peers', group: 'consent', label: 'Message my other orchestrators', short: 'Peers', kind: 'switch', option: 'peers', env: CONSENT_VARS.peers, editable: true },
  { id: 'activityFeed', group: 'consent', label: 'Share the activity feed', short: 'Activity feed', kind: 'switch', option: 'activityFeed', env: CONSENT_VARS.activityFeed, editable: true },
  { id: 'server', group: 'connection', label: 'Server', short: 'Server', kind: 'info', option: 'serverUrl', env: 'PODIUM_SERVER', editable: false },
  { id: 'userName', group: 'connection', label: 'Your name', short: 'Name', kind: 'info', option: 'userName', env: 'PODIUM_USER', editable: false },
  { id: 'flushIntervalMs', group: 'timing', label: 'Report interval (ms)', short: 'Interval (ms)', kind: 'number', min: 200, option: 'flushIntervalMs', env: null, editable: true },
  { id: 'heartbeatMs', group: 'timing', label: 'Heartbeat (ms)', short: 'Heartbeat (ms)', kind: 'number', min: 1000, option: 'heartbeatMs', env: null, editable: true },
  { id: 'idleSeconds', group: 'timing', label: 'Idle seconds', short: 'Idle (s)', kind: 'number', min: 5, option: null, env: 'PODIUM_IDLE_SECONDS', editable: true },
  { id: 'context', group: 'context', label: 'Podium context', short: 'Context', kind: 'info', option: null, env: null, editable: false },
];

/** The rows a harness shows, in the window's order: those it has a home for, and the context row, which every harness has. */
export function settingsFor(harness: Harness): Setting[] {
  const ordered = SETTING_GROUPS.flatMap((g) => SETTINGS.filter((s) => s.group === g.id));
  return ordered.filter((s) => s.id === 'context' || (harness === 'claudecode' ? s.option !== null : s.env !== null));
}

/** The `PODIUM_*` keys the OpenCode window may write to `~/.podium/config.env`. The server, the user name and the token are not among them. */
export const WRITABLE_KEYS: ReadonlySet<string> = new Set(SETTINGS.filter((s) => s.editable && s.env).map((s) => s.env!));

/** The Claude Code options the window may change through the engine's settings. */
export const WRITABLE_OPTIONS: ReadonlySet<string> = new Set(SETTINGS.filter((s) => s.editable && s.option).map((s) => s.option!));

/** Below this many columns a harness draws the short labels. */
export const NARROW_COLUMNS = 60;
export const isNarrow = (columns: number | null | undefined): boolean => typeof columns === 'number' && columns > 0 && columns < NARROW_COLUMNS;

export const WINDOW_TITLE = 'Podium settings';
/** Every setting is read when the reporter starts (#1001): a change is not promised before then. */
export const NEXT_START = 'next start';
export const NEXT_START_NOTE = 'Changes take effect at the next start.';
export const LOCKED_NOTE = 'Change it where it is set. This window cannot.';
export const CONTEXT_HINT = 'Switch it with /podium context use <name>.';
export const CLAUDE_CONFIGURE = '/plugin configure podium-reporter';
export const CLAUDE_CONNECTION_HINT = `Token and server: ${CLAUDE_CONFIGURE}`;
export const OPENCODE_CONNECTION_HINT = 'Server and name: PODIUM_SERVER and PODIUM_USER in ~/.podium/config.env';

/** What `/podium config` says where no window can be drawn. */
export function noWindowText(harness: Harness, path: string | null): string {
  if (harness === 'claudecode') return `No settings window in this mode.\nRun ${CLAUDE_CONFIGURE}.`;
  return [
    'The settings window needs the terminal UI.',
    `Your settings are in ${path ?? '~/.podium/config.env'}.`,
    'Edit it, or set the PODIUM_* variables.',
    'They are read at the next start.',
  ].join('\n');
}

/** Whether `/podium <args>` is `/podium config`. */
export const isConfigArgs = (args: string | null | undefined): boolean => (args ?? '').trim().toLowerCase() === 'config';

/** The label for a width. */
export const labelOf = (s: Setting, narrow: boolean): string => (narrow ? s.short : s.label);

/** How a value reads: a switch is `on` or `off`, an empty value `not set`. */
export function shownValue(s: Setting, value: string): string {
  if (s.kind === 'switch') return value === 'true' ? 'on' : 'off';
  return value === '' ? 'not set' : value;
}

/** What says who decides a row the window cannot change: `set by PODIUM_RESPOND`, `set by managed settings`. */
export const lockedBy = (source: string): string => `set by ${source}`;

/**
 * The variable that decides a row in this environment, or null. A variable that is set, even to nothing, wins over the file
 * (core/settings.ts), so the window shows the live value and does not offer a change the reporter would not read.
 */
export function envLock(s: Setting, env: Readonly<Record<string, string | undefined>>): string | null {
  return s.env && typeof env[s.env] === 'string' ? s.env : null;
}

/** One menu line, as OpenCode draws it: `Respond from Podium: everything`, with `▲ set by …` when something else decides it. */
export function rowLine(s: Setting, value: string, narrow: boolean, lock: string | null): string {
  const line = `${labelOf(s, narrow)}: ${shownValue(s, value)}`;
  return lock ? `${line} ▲ ${lockedBy(lock)}` : line;
}

/** What a row says under its value: its allowed values, its lowest number, or where it is changed. */
export function hintOf(s: Setting, harness: Harness): string {
  if (s.kind === 'choice') return (s.choices ?? []).join(', ');
  if (s.kind === 'switch') return 'on or off';
  if (s.kind === 'number') return `at least ${s.min}`;
  if (s.id === 'context') return CONTEXT_HINT;
  return harness === 'claudecode' ? CLAUDE_CONNECTION_HINT : OPENCODE_CONNECTION_HINT;
}

export type Checked = { ok: true; value: string } | { ok: false; reason: string };

/**
 * A value the person gave a row, checked: one of its choices, `true` or `false` for a switch, a whole number of at least its lowest
 * for a number. A row the window does not change, and any value with a line break or another control character, is refused.
 */
export function checkValue(s: Setting, raw: string): Checked {
  if ([...raw].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return { ok: false, reason: 'A value cannot hold a line break or a control character.' };
  if (!s.editable) return { ok: false, reason: `${s.label} cannot be changed here.` };
  const v = raw.trim();
  if (s.kind === 'choice') return (s.choices ?? []).includes(v) ? { ok: true, value: v } : { ok: false, reason: `${s.label} is one of: ${(s.choices ?? []).join(', ')}.` };
  if (s.kind === 'switch') return v === 'true' || v === 'false' ? { ok: true, value: v } : { ok: false, reason: `${s.label} is on or off.` };
  const n = Number(v);
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n < (s.min ?? 0)) return { ok: false, reason: `${s.label} is a whole number of at least ${s.min}.` };
  return { ok: true, value: String(n) };
}

/** The row a `PODIUM_*` key or a Claude Code option names, or undefined. */
export const settingByEnv = (key: string): Setting | undefined => SETTINGS.find((s) => s.env === key);
export const settingById = (id: string): Setting | undefined => SETTINGS.find((s) => s.id === id);

/**
 * `config.env`'s text with `key` set to `value`: every earlier line for the key (with or without `export`) is taken out and one
 * `KEY=value` line is added at the end, so the file's later-line-wins reading gives the new value. Every other line, the token's
 * included, is kept as it was. Null for a key not on the allow-list or a value `checkValue` refuses: nothing is written then.
 */
export function writeSettingsLine(text: string | null, key: string, value: string): string | null {
  const s = settingByEnv(key);
  if (!s || !WRITABLE_KEYS.has(key)) return null;
  const checked = checkValue(s, value);
  if (!checked.ok) return null;
  const isKey = (line: string): boolean => {
    const t = line.trim().replace(/^export\s+/, '');
    return t.startsWith(`${key}=`) || t.startsWith(`${key} =`);
  };
  const kept = (text ?? '').split(/\r?\n/).filter((line) => !isKey(line));
  while (kept.length && kept[kept.length - 1]!.trim() === '') kept.pop();
  kept.push(`${key}=${checked.value}`);
  return `${kept.join('\n')}\n`;
}
