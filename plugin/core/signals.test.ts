// #724: counting the hooks that ran and the fields their events carried.
import { describe, test, expect } from 'claude-code/testing';
import { bumpSignals, MAX_SIGNAL_NAMES, reportSignals } from './signals.ts';

describe('bumpSignals', () => {
  test('counts the hook and each listed field the event carried with a value', () => {
    const s = {};
    bumpSignals(s, 'tool.call', { tool: 'Bash', tool_use_id: 'a', agentId: null }, ['tool', 'tool_use_id', 'agentId', 'duration']);
    bumpSignals(s, 'tool.call', { tool: 'Read' }, ['tool', 'tool_use_id', 'agentId', 'duration']);
    expect(s).toEqual({ 'hook:tool.call': 2, 'field:tool.call.tool': 2, 'field:tool.call.tool_use_id': 1 });
  });

  test('a field the reporter does not list is never counted, and a hook with no event still counts', () => {
    const s = {};
    bumpSignals(s, 'session.start', undefined);
    bumpSignals(s, 'turn.start', { text: 'secret', extra: 1 }, ['text']);
    expect(Object.keys(s).sort()).toEqual(['field:turn.start.text', 'hook:session.start', 'hook:turn.start']);
    // the value of a field is never kept
    expect(JSON.stringify(s)).not.toContain('secret');
  });

  test('stops adding new names at the cap but keeps counting the ones it has', () => {
    const s = {};
    for (let i = 0; i < MAX_SIGNAL_NAMES + 10; i++) bumpSignals(s, `h${i}`, {});
    expect(Object.keys(s)).toHaveLength(MAX_SIGNAL_NAMES);
    bumpSignals(s, 'h0', {});
    expect((s as Record<string, number>)['hook:h0']).toBe(2);
  });
});

describe('reportSignals', () => {
  test('clips names and adds the ones that clip alike', () => {
    expect(reportSignals({ 'hook:abcdef': 1, 'hook:abcxyz': 2 }, (n) => n.slice(0, 8))).toEqual({ 'hook:abc': 3 });
  });
});
