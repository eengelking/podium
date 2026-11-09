import { describe, expect, it } from 'vitest';
import { Attachments, tuiId } from './attachment.ts';
import { ATTACH_TTL_MS } from './bridge.ts';

describe('Attachments: which TUI parts are attached (#1029)', () => {
  it('is not attached before any TUI part has said so', () => {
    const a = new Attachments();
    expect(a.lastSeen()).toBe(0);
    expect(a.attached(1000)).toBe(false);
  });

  it('is attached for ATTACH_TTL_MS after the last attach, and not after', () => {
    const a = new Attachments();
    a.attach('tui-1', 1000);
    expect(a.attached(1000 + ATTACH_TTL_MS - 1)).toBe(true);
    expect(a.attached(1000 + ATTACH_TTL_MS)).toBe(false);
  });

  it('says nobody is left when the only TUI part detaches, and is no longer attached at once', () => {
    const a = new Attachments();
    a.attach('tui-1', 1000);
    expect(a.detach('tui-1', 2000)).toBe(true);
    expect(a.attached(2000)).toBe(false);
    expect(a.lastSeen()).toBe(0);
  });

  it('stays attached while another TUI part is, and says nobody is left only after the last one detaches', () => {
    const a = new Attachments();
    a.attach('tui-1', 1000);
    a.attach('tui-2', 1500);
    expect(a.detach('tui-1', 2000)).toBe(false);
    expect(a.attached(2000)).toBe(true);
    expect(a.lastSeen()).toBe(1500);
    expect(a.detach('tui-2', 2500)).toBe(true);
    expect(a.attached(2500)).toBe(false);
  });

  it('does not count a TUI part whose last attach is older than the limit as still there', () => {
    const a = new Attachments();
    a.attach('gone', 1000);
    a.attach('here', 1000 + ATTACH_TTL_MS);
    expect(a.detach('here', 1000 + ATTACH_TTL_MS + 1)).toBe(true);
  });

  it('treats a detach from a TUI part it never saw as the same as none attached', () => {
    const a = new Attachments();
    expect(a.detach('nobody', 1000)).toBe(true);
    a.attach('tui-1', 1000);
    expect(a.detach('nobody', 1100)).toBe(false);
    expect(a.attached(1100)).toBe(true);
  });

  it('keeps an attach with no id (an older TUI part) as one part under a shared name', () => {
    const a = new Attachments();
    a.attach(undefined, 1000);
    expect(a.attached(1000)).toBe(true);
    expect(a.detach(undefined, 2000)).toBe(true);
  });
});

describe('Attachments: a late attach and the memory of who left (#1029)', () => {
  it('does not bring a TUI part back when its attach arrives after its detach', () => {
    const a = new Attachments();
    a.attach('tui-1', 1000);
    expect(a.detach('tui-1', 2000)).toBe(true);
    a.attach('tui-1', 2001);
    expect(a.attached(2001)).toBe(false);
  });

  it('forgets the oldest detached ids past the limit, so the memory stays small', () => {
    const a = new Attachments();
    for (let i = 0; i < 70; i++) a.detach(`gone-${i}`, 1000);
    a.attach('gone-0', 2000);
    expect(a.attached(2000)).toBe(true);
    a.attach('gone-69', 2000);
    a.detach('gone-69', 2001);
    a.attach('gone-69', 2002);
    expect(a.lastSeen()).toBe(2000);
  });

  it('prunes a TUI part that was killed without a detach when another attaches', () => {
    const a = new Attachments();
    a.attach('dead', 1000);
    a.attach('alive', 1000 + ATTACH_TTL_MS);
    expect(a.detach('alive', 1000 + ATTACH_TTL_MS + 1)).toBe(true);
  });
});

describe('tuiId', () => {
  it('reads a non-empty string id and nothing else', () => {
    expect(tuiId({ id: 'a' })).toBe('a');
    expect(tuiId({ id: '' })).toBeUndefined();
    expect(tuiId({ id: 3 })).toBeUndefined();
    expect(tuiId({})).toBeUndefined();
    expect(tuiId(null)).toBeUndefined();
    expect(tuiId(undefined)).toBeUndefined();
  });
});
