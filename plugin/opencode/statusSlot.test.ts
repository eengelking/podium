import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mountBanner, mountStatus, type SlotHost, type StatusParts } from './statusSlot.ts';

function fakes() {
  let value = '';
  const claims: { append: string; render: () => unknown }[] = [];
  let disposed = 0;
  const parts: StatusParts = {
    solid: { createSignal: <T>(v: T) => { value = v as string; return [() => value as unknown as T, (n: T) => { value = n as string; }]; } },
    jsx: { jsx: (type, props) => ({ type, get text() { return props.children; } }) },
  };
  const host: SlotHost = { slot: (c) => { claims.push(c); return () => void disposed++; } };
  return { parts, host, claims, disposed: () => disposed };
}

describe('the status line in the prompt footer (#987)', () => {
  it('claims prompt.footer.status once, renders a text that follows what is set, and gives the slot back', async () => {
    const f = fakes();
    const line = await mountStatus(f.host, async () => f.parts);
    expect(line).not.toBeNull();
    expect(f.claims.map((c) => c.append)).toEqual(['prompt.footer.status']);
    const el = f.claims[0]!.render() as { type: string; text: string };
    expect(el).toMatchObject({ type: 'text', text: '' });
    line!.set('podium ● online');
    expect(el.text).toBe('podium ● online');
    line!.dispose();
    expect(f.disposed()).toBe(1);
  });
  it('is null when the parts do not load or the host refuses the claim, and never throws', async () => {
    const f = fakes();
    expect(await mountStatus(f.host, async () => { throw new Error('no solid-js'); })).toBeNull();
    expect(await mountStatus({ slot: () => { throw new Error('no slot'); } }, async () => f.parts)).toBeNull();
  });
  it('claims session.composer.top for the Admin board, which shows the lines it is given and gives the slot back (#1051)', async () => {
    const f = fakes();
    const board = await mountBanner(f.host, async () => f.parts);
    expect(board).not.toBeNull();
    expect(f.claims.map((c) => (c as unknown as { append: string }).append)).toEqual(['session.composer.top']);
    const el = f.claims[0]!.render() as { type: string; text: string };
    board!.set('Podium: A (an Admin) is reading your Podium group.');
    expect(el.text).toBe('Podium: A (an Admin) is reading your Podium group.');
    board!.dispose();
    expect(f.disposed()).toBe(1);
    expect(await mountBanner({ slot: () => { throw new Error('no slot'); } }, async () => f.parts)).toBeNull();
  });
  it('names the host modules with literal specifiers in tui.ts: the host cannot resolve a name held in a variable (found in a live run)', () => {
    const tui = readFileSync(new URL('./tui.ts', import.meta.url), 'utf8');
    expect(tui).toContain("import('solid-js')");
    expect(tui).toContain("import('@opentui/solid/jsx-runtime')");
    expect(tui).not.toMatch(/import\((?!['"])/);
  });
});
