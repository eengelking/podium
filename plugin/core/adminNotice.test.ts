import { describe, test, expect } from 'claude-code/testing';
import { AdminNoticeSeen, adminNoticeLine, adminNoticeToast } from './adminNotice.ts';
import { isAdminNotice, Transport } from './transport.ts';
import type { AdminNotice, Report } from './protocol.ts';

const n = (id: string, text = 'Root (an Admin) is reading your Podium group.'): AdminNotice => ({ id, at: 1, text });

describe('the callout an Admin\'s reading shows the person (#1034)', () => {
  test('accepts only a notice with an id and a text', () => {
    expect(isAdminNotice(n('a'))).toBe(true);
    for (const bad of [null, 'x', {}, { id: '', at: 1, text: 'x' }, { id: 'a', at: 1 }, { id: 'a', at: 1, text: 5 }, { id: 'a', text: 'x' }]) expect(isAdminNotice(bad)).toBe(false);
  });

  test('shows each id once, and a list again shows only what is new', () => {
    const seen = new AdminNoticeSeen();
    expect(seen.fresh([n('a'), n('b')]).map((x) => x.id)).toEqual(['a', 'b']);
    expect(seen.fresh([n('a'), n('b'), n('c')]).map((x) => x.id)).toEqual(['c']);
    expect(seen.fresh([n('a')])).toEqual([]);
  });

  test('forgets the oldest ids past its limit, so it stays small', () => {
    const seen = new AdminNoticeSeen(3);
    seen.fresh([n('a'), n('b'), n('c'), n('d')]);
    expect(seen.fresh([n('a')]).map((x) => x.id)).toEqual(['a']);
  });

  test('words the toast and the line on one line, from Podium, with nothing else added', () => {
    const t = n('a', 'Root (an Admin) is reading\nyour Podium group.   ');
    expect(adminNoticeToast(t)).toBe('Podium: Root (an Admin) is reading your Podium group.');
    expect(adminNoticeLine(t)).toBe('Root (an Admin) is reading your Podium group.');
    expect(adminNoticeToast(n('a', 'x'.repeat(2000))).length).toBeLessThan(400);
  });
});

describe('the transport carries the callouts of a reply', () => {
  async function reply(extra: object): Promise<Transport> {
    const t = new Transport(async () => ({ status: 200, ok: true, text: JSON.stringify({ ok: true, ackedEvents: 0, ...extra }) }), { serverUrl: 'http://h:1', token: '', heartbeatMs: 5000, version: '0.11.0' });
    await t.send(() => ({ v: 1, events: [] }) as unknown as Report, 0);
    return t;
  }
  test('keeps the well-formed ones, with the messaging option off too, and none from an older server', async () => {
    const t = await reply({ adminNotices: [n('a'), { bad: 1 }, n('b')] });
    expect(t.peers).toBe(false);
    expect(t.adminNotices.map((x) => x.id)).toEqual(['a', 'b']);
    expect((await reply({})).adminNotices).toEqual([]);
    expect((await reply({ adminNotices: 'x' })).adminNotices).toEqual([]);
  });
});
