import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readMachine, readSettingsFile, sharedMachineId } from './machine.ts';

const dirs: string[] = [];
const home = () => { const d = mkdtempSync(join(tmpdir(), 'podium-856-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('the shared machine id (#856)', () => {
  it('makes one, keeps it in ~/.podium/machine-id with mode 0600, and returns the same id next time', () => {
    const h = home();
    const id = sharedMachineId(h, undefined);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(readFileSync(join(h, '.podium/machine-id'), 'utf8').trim()).toBe(id);
    expect(statSync(join(h, '.podium/machine-id')).mode & 0o777).toBe(0o600);
    expect(sharedMachineId(h, undefined)).toBe(id);
  });

  it('takes over the id a Claude install already made, so that install keeps its row', () => {
    const h = home();
    mkdirSync(join(h, '.claude'));
    writeFileSync(join(h, '.claude/podium-machine-id'), 'abcdef012345\n');
    expect(sharedMachineId(h, undefined)).toBe('abcdef012345');
    expect(readFileSync(join(h, '.podium/machine-id'), 'utf8').trim()).toBe('abcdef012345');
  });

  it('prefers the shared file over a Claude id, and follows CLAUDE_CONFIG_DIR', () => {
    const h = home();
    mkdirSync(join(h, '.podium'));
    writeFileSync(join(h, '.podium/machine-id'), 'aaaaaaaaaaaa\n');
    expect(sharedMachineId(h, undefined)).toBe('aaaaaaaaaaaa');
    const h2 = home();
    const cfg = join(h2, 'cfg');
    mkdirSync(cfg);
    writeFileSync(join(cfg, 'podium-machine-id'), 'bbbbbbbbbbbb\n');
    expect(sharedMachineId(h2, cfg)).toBe('bbbbbbbbbbbb');
  });

  it('reports no machine without a user name', async () => {
    const h = home();
    expect(await readMachine(null, h)).toBeNull();
    expect(await readMachine('  ', h)).toBeNull();
    expect(await readMachine('Dana', h, undefined)).toMatchObject({ id: sharedMachineId(h, undefined) });
  });

  it('names the machine as the Claude Code reporter does: the pin it already made, shared on first read (#967)', async () => {
    const h = home();
    mkdirSync(join(h, '.claude'));
    writeFileSync(join(h, '.claude/podium-machine-name'), 'Studio-M2\n');
    expect(await readMachine('Dana', h, undefined)).toMatchObject({ name: 'Studio-M2' });
    expect(readFileSync(join(h, '.podium/machine-name'), 'utf8').trim()).toBe('Studio-M2');
  });
});

describe('the settings file (#856)', () => {
  it('reads config.env and says when its permissions are too open', () => {
    const h = home();
    expect(readSettingsFile(h)).toEqual({ text: null, open: false });
    mkdirSync(join(h, '.podium'));
    const f = join(h, '.podium/config.env');
    writeFileSync(f, 'PODIUM_TOKEN=t\n');
    chmodSync(f, 0o600);
    expect(readSettingsFile(h)).toEqual({ text: 'PODIUM_TOKEN=t\n', open: false });
    chmodSync(f, 0o644);
    expect(readSettingsFile(h).open).toBe(true);
    expect(readSettingsFile('rel')).toEqual({ text: null, open: false });
  });
});
