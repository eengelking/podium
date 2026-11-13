// `/podium config` in OpenCode (#1001): the rows the server part hands over, the dialogs, and the write to ~/.podium/config.env.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configEvent, fileIO, openConfigWindow, runConfigWindow, saveSetting, sameFile, showConfig, type ConfigEvent, type ConfigUi, type DialogUi, type SettingsIO } from './configWindow.ts';
import { optionsOf } from './options.ts';
import { trustedSettings } from '../core/settings.ts';

const dirs: string[] = [];
const scratchHome = () => { const d = mkdtempSync(join(tmpdir(), 'podium-1001-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const PATH = '/home/dana/.podium/config.env';
const event = (over: Partial<ConfigEvent> = {}): ConfigEvent => ({
  host: 'box',
  path: PATH,
  rows: [
    { id: 'respond', value: 'off', lock: null },
    { id: 'peers', value: 'false', lock: null },
    { id: 'activityFeed', value: 'true', lock: 'PODIUM_ACTIVITY_FEED' },
    { id: 'server', value: 'http://s', lock: null },
    { id: 'userName', value: '', lock: null },
    { id: 'idleSeconds', value: '60', lock: null },
    { id: 'context', value: '', lock: null },
  ],
  ...over,
});
const here = { host: 'box', path: PATH, columns: 100 };

/** A file in memory, and every write made to it. */
const memIO = (text: string | null = null): SettingsIO & { text: string | null; writes: number } => {
  const io = {
    text,
    writes: 0,
    read: () => io.text,
    write: (_: string, t: string) => { io.text = t; io.writes++; },
  };
  return io;
};

/** Dialogs that answer from a script: each select, prompt and alert takes the next answer, and every call is kept. */
const scripted = (answers: (string | undefined)[]) => {
  const calls: { kind: string; o: any }[] = [];
  const toasts: { message: string; variant: string }[] = [];
  const next = () => answers.shift();
  const ui: DialogUi = {
    select: async (o) => (calls.push({ kind: 'select', o }), next() as never),
    prompt: async (o) => (calls.push({ kind: 'prompt', o }), next()),
    alert: async (o) => { calls.push({ kind: 'alert', o }); },
    toast: (o) => { toasts.push(o); },
  };
  return { ui, calls, toasts };
};

describe('the rows the server part hands over (#1001)', () => {
  it('are the live settings, with what decides a row the window cannot change', () => {
    const env = { PODIUM_PEERS: 'true' };
    const options = optionsOf({}, null, env, 'PODIUM_RESPOND=everything\nPODIUM_PEERS=false\nPODIUM_SERVER=http://f\nPODIUM_USER=Dana\nPODIUM_TOKEN=secret');
    const e = configEvent({ options, env, projectOptions: {}, context: 'work', host: 'box', path: PATH, sessionID: 's1' });
    expect(e).toMatchObject({ sessionID: 's1', host: 'box', path: PATH });
    const by = Object.fromEntries(e.rows.map((r) => [r.id, r]));
    expect(by.respond).toEqual({ id: 'respond', value: 'everything', lock: null });
    // The environment won over the file, so the window shows the live value and says what sets it.
    expect(by.peers).toEqual({ id: 'peers', value: 'true', lock: 'PODIUM_PEERS' });
    expect(by.server).toEqual({ id: 'server', value: 'http://f', lock: null });
    expect(by.userName!.value).toBe('Dana');
    expect(by.idleSeconds!.value).toBe('60');
    expect(by.context!.value).toBe('work');
    expect(JSON.stringify(e)).not.toContain('secret');
  });
  it('an idleSeconds in opencode.json decides the idle time; no session or context leaves them out', () => {
    const options = optionsOf({ idleSeconds: 30 }, null, {}, null);
    const e = configEvent({ options, env: {}, projectOptions: { idleSeconds: 30 }, context: null, host: 'box', path: null });
    expect(e.sessionID).toBeUndefined();
    const by = Object.fromEntries(e.rows.map((r) => [r.id, r]));
    expect(by.idleSeconds).toEqual({ id: 'idleSeconds', value: '30', lock: 'opencode.json' });
    expect(by.context!.value).toBe('');
    expect(by.userName!.value).toBe('');
  });
});

describe('the server part opens the window', () => {
  it('with a TUI attached, hands it the rows and says nothing more', async () => {
    const sent: ConfigEvent[] = [];
    expect(await openConfigWindow({ attached: true, emit: async (e) => { sent.push(e); }, path: PATH, event: () => event() })).toBe('');
    expect(sent).toHaveLength(1);
  });
  it('with no TUI, or an event that is not delivered, says where the settings are', async () => {
    expect(await openConfigWindow({ attached: false, emit: async () => undefined, path: PATH, event: () => event() })).toContain(`Your settings are in ${PATH}.`);
    expect(await openConfigWindow({ attached: true, emit: undefined, path: PATH, event: () => event() })).toContain('needs the terminal UI');
    expect(await openConfigWindow({ attached: true, emit: async () => { throw new Error('gone'); }, path: null, event: () => event() })).toContain('~/.podium/config.env');
  });
});

describe('the window', () => {
  it('draws the menu with groups, values and locks, and closes on Esc', async () => {
    const s = scripted([undefined]);
    await runConfigWindow(s.ui, event(), here, memIO());
    const menu = s.calls[0]!.o;
    expect(menu.title).toBe('Podium settings');
    expect(menu.placeholder).toContain('next start');
    expect(menu.options.map((o: any) => o.title)).toEqual([
      'Respond from Podium: off',
      'Message my other orchestrators: off',
      'Share the activity feed: on ▲ set by PODIUM_ACTIVITY_FEED',
      'Server: http://s',
      'Your name: not set',
      'Idle seconds: 60',
      'Podium context: not set',
    ]);
    expect(menu.options[0].category).toBe('Consent (your choice)');
    expect(menu.options[0].description).toBe('off, questions, questions-and-plans, everything');
  });
  it('takes the short labels at a narrow width', async () => {
    const s = scripted([undefined]);
    await runConfigWindow(s.ui, event(), { ...here, columns: 50 }, memIO());
    const menu = s.calls[0]!.o;
    expect(menu.options[0]).toMatchObject({ title: 'Respond: off', category: 'Consent (yours)' });
    expect(menu.options[0].description).toBeUndefined();
  });
  it('a pick and a value write that one key, and the menu shows the new value', async () => {
    const io = memIO('PODIUM_TOKEN=secret\n');
    const s = scripted(['respond', 'everything', 'peers', 'true', undefined]);
    await runConfigWindow(s.ui, event(), here, io);
    expect(io.text).toBe('PODIUM_TOKEN=secret\nPODIUM_RESPOND=everything\nPODIUM_PEERS=true\n');
    expect(s.toasts.map((t) => t.variant)).toEqual(['success', 'success']);
    expect(s.toasts[0]!.message).toContain('next start');
    const last = s.calls.filter((c) => c.kind === 'select' && c.o.title === 'Podium settings').at(-1)!.o;
    expect(last.options[0].title).toBe('Respond from Podium: everything');
    expect(last.options[1].title).toBe('Message my other orchestrators: on');
    // The value dialog starts on the current value.
    expect(s.calls[1]!.o).toMatchObject({ title: 'Respond from Podium', current: 'off' });
  });
  it('a number comes from a prompt and is checked before anything is written', async () => {
    const io = memIO();
    const s = scripted(['idleSeconds', '3', 'idleSeconds', ' 90 ', undefined]);
    await runConfigWindow(s.ui, event(), here, io);
    expect(s.toasts[0]).toMatchObject({ variant: 'error', message: 'Idle seconds is a whole number of at least 5.' });
    expect(io.text).toBe('PODIUM_IDLE_SECONDS=90\n');
    expect(s.calls[1]!.o.description).toContain('at least 5');
  });
  it('closing a value dialog, or giving the same value, writes nothing', async () => {
    const io = memIO();
    const s = scripted(['respond', undefined, 'respond', 'off', undefined]);
    await runConfigWindow(s.ui, event(), here, io);
    expect(io.writes).toBe(0);
  });
  it('a locked row and a shown-only row explain themselves and write nothing', async () => {
    const io = memIO();
    const s = scripted(['activityFeed', 'server', 'context', 'nope', undefined]);
    await runConfigWindow(s.ui, event(), here, io);
    const alerts = s.calls.filter((c) => c.kind === 'alert').map((c) => c.o.message);
    expect(alerts[0]).toBe('Set by PODIUM_ACTIVITY_FEED. Change it where it is set. This window cannot.');
    expect(alerts[1]).toContain('PODIUM_SERVER and PODIUM_USER');
    expect(alerts[2]).toContain('/podium context use');
    expect(io.writes).toBe(0);
  });
  it('a terminal on another machine, or with another home, writes nothing', async () => {
    const io = memIO();
    const s = scripted(['respond', undefined]);
    await runConfigWindow(s.ui, event({ host: 'elsewhere' }), here, io);
    expect(s.calls.find((c) => c.kind === 'alert')!.o.message).toBe(`The reporter reads ${PATH} on elsewhere. Change it there.`);
    expect(io.writes).toBe(0);
    expect(sameFile(event({ path: null }), { ...here, path: null })).toBe(false);
    expect(sameFile(event(), { ...here, path: '/other/.podium/config.env' })).toBe(false);
    expect(sameFile(event(), here)).toBe(true);
    const s2 = scripted(['respond', undefined]);
    await runConfigWindow(s2.ui, event({ path: null }), here, io);
    expect(s2.calls.find((c) => c.kind === 'alert')!.o.message).toContain('a file this terminal cannot see');
  });
  it('a failed read or write says so and changes nothing', () => {
    const broken = { read: () => { throw new Error('EACCES'); }, write: () => undefined };
    expect(saveSetting(broken, PATH, 'PODIUM_PEERS', 'true')).toEqual({ ok: false, message: `Could not read ${PATH}, so nothing was changed.` });
    const readonly = { read: () => null, write: () => { throw new Error('EROFS'); } };
    expect(saveSetting(readonly, PATH, 'PODIUM_PEERS', 'true')).toEqual({ ok: false, message: `Could not write ${PATH}.` });
    expect(saveSetting(memIO(), PATH, 'PODIUM_TOKEN', 'x')).toEqual({ ok: false, message: 'PODIUM_TOKEN cannot be set to that here.' });
  });
});

describe('showConfig in the TUI part', () => {
  const tui = (route: { type: string; sessionID?: string }, answers: (string | undefined)[]) => {
    const s = scripted(answers);
    const ui: ConfigUi = { dialog: { select: s.ui.select, prompt: s.ui.prompt, alert: s.ui.alert }, toast: { show: s.ui.toast }, router: { current: () => route } };
    return { ui, s };
  };
  it('opens only in the terminal whose session ran the command', async () => {
    const other = tui({ type: 'session', sessionID: 'other' }, [undefined]);
    await showConfig(other.ui, event({ sessionID: 's1' }), here, memIO());
    expect(other.s.calls).toHaveLength(0);
    const home = tui({ type: 'home' }, [undefined]);
    await showConfig(home.ui, event({ sessionID: 's1' }), here, memIO());
    expect(home.s.calls).toHaveLength(0);
    const mine = tui({ type: 'session', sessionID: 's1' }, [undefined]);
    await showConfig(mine.ui, event({ sessionID: 's1' }), here, memIO());
    expect(mine.s.calls).toHaveLength(1);
    const any = tui({ type: 'home' }, [undefined]);
    await showConfig(any.ui, event(), here, memIO());
    expect(any.s.calls).toHaveLength(1);
  });
  it('one window at a time, and a dialog that fails closes it quietly', async () => {
    let release: (v: string | undefined) => void = () => undefined;
    let menus = 0;
    const ui: ConfigUi = {
      dialog: { select: () => { menus++; return new Promise((r) => { release = r as never; }); }, prompt: async () => undefined, alert: async () => undefined },
      toast: { show: () => undefined },
      router: { current: () => ({ type: 'home' }) },
    };
    const first = showConfig(ui, event(), here, memIO());
    await showConfig(ui, event(), here, memIO());
    expect(menus).toBe(1);
    release(undefined);
    await first;
    // Closed, so the next command opens it again.
    const again = showConfig(ui, event(), here, memIO());
    expect(menus).toBe(2);
    release(undefined);
    await again;
    const failing: ConfigUi = { ...ui, dialog: { ...ui.dialog, select: async () => { throw new Error('closed'); } } };
    await expect(showConfig(failing, event(), here, memIO())).resolves.toBeUndefined();
  });
});

describe('the real file', () => {
  it('is written whole, 0600 in a 0700 folder, and read back as the reporter reads it', () => {
    const home = scratchHome();
    const path = join(home, '.podium', 'config.env');
    expect(fileIO.read(path)).toBeNull();
    expect(saveSetting(fileIO, path, 'PODIUM_RESPOND', 'questions').ok).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.podium')).mode & 0o777).toBe(0o700);
    expect(trustedSettings({}, readFileSync(path, 'utf8')).respondLevel).toBe('questions');
    // No scratch file is left beside it.
    expect(readdirSync(join(home, '.podium'))).toEqual(['config.env']);
  });
  it('keeps the token and the other lines, and fixes a file others could read', () => {
    const home = scratchHome();
    mkdirSync(join(home, '.podium'));
    const path = join(home, '.podium', 'config.env');
    writeFileSync(path, 'PODIUM_TOKEN=secret\nPODIUM_PEERS=true\n', { mode: 0o644 });
    expect(saveSetting(fileIO, path, 'PODIUM_PEERS', 'false').ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('PODIUM_TOKEN=secret\nPODIUM_PEERS=false\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it('a file that cannot be read for another reason is an error, and a failed write leaves no scratch file', () => {
    const home = scratchHome();
    expect(() => fileIO.read(home)).toThrow();
    // config.env is a folder here, so the finished file cannot be moved into place.
    mkdirSync(join(home, '.podium', 'config.env'), { recursive: true });
    expect(() => fileIO.write(join(home, '.podium', 'config.env'), 'PODIUM_PEERS=true\n')).toThrow();
    expect(readdirSync(join(home, '.podium'))).toEqual(['config.env']);
  });
});
