// #724: which hook, field or tool a harness version stopped sending, replayed from the counts the rollups keep.
import { describe, it, expect } from 'vitest';
import { compareVersions } from './reports.js';
import { detectStopped, effectOf, STOPPED, type VersionFacts } from './harnessUpdates.js';

const v = (harness: string, version: string, sessions: number, features: Record<string, number>, reporters = 4, tools = 0): VersionFacts => ({
  harness, version, base: { signals: sessions, tools }, features: new Map(Object.entries(features)), reporters,
});
const find = (list: ReturnType<typeof detectStopped>, feature: string) => list.find((s) => s.feature === feature);

describe('detectStopped', () => {
  it('lists a hook that a version stopped sending, against that version, with how many reporters are on it', () => {
    const list = detectStopped([
      v('claude-code', '2.1.305', 41, { 'hook:tool.check': 40, 'hook:tool.call': 41 }, 6),
      v('claude-code', '2.1.319', 31, { 'hook:tool.check': 0, 'hook:tool.call': 31 }, 4),
    ], compareVersions);
    expect(list).toEqual([{ harness: 'claude-code', version: '2.1.319', previous: '2.1.305', feature: 'hook:tool.check', kind: 'hook', before: 98, now: 0, reporters: 4 }]);
  });

  it('lists nothing when a version changed nothing, and nothing for a feature that never mattered', () => {
    const same = [v('claude-code', '2.1.305', 41, { 'hook:tool.check': 40, 'field:turn.step.effort': 3 }), v('claude-code', '2.1.319', 31, { 'hook:tool.check': 30, 'field:turn.step.effort': 0 })];
    expect(detectStopped(same, compareVersions)).toEqual([]);
  });

  it('lists a feature once, against the first version that lost it', () => {
    const list = detectStopped([
      v('claude-code', '2.1.288', 30, { 'field:session.measure.cost': 30 }), v('claude-code', '2.1.305', 30, {}), v('claude-code', '2.1.319', 30, {}),
    ], compareVersions);
    expect(list.map((s) => s.version)).toEqual(['2.1.305']);
  });

  it('compares a version only with the same harness, and compares numbers, not text', () => {
    const list = detectStopped([
      v('opencode', '1.9.0', 30, { 'hook:session.created': 30 }), v('claude-code', '2.1.305', 30, {}), v('opencode', '1.10.0', 30, {}),
    ], compareVersions);
    expect(list.map((s) => `${s.harness} ${s.version} from ${s.previous}`)).toEqual(['opencode 1.10.0 from 1.9.0']);
  });

  it('leaves out a version with too few sessions or reporters, and skips a thin version when it picks the one to compare with', () => {
    const rows = [v('claude-code', '1', 30, { 'hook:a': 30 }), v('claude-code', '2', STOPPED.minSessions - 1, {}), v('claude-code', '3', 30, {}, STOPPED.minReporters - 1)];
    expect(detectStopped(rows, compareVersions)).toEqual([]);
    expect(detectStopped([...rows.slice(0, 2), v('claude-code', '4', 30, {})], compareVersions).map((s) => `${s.version} from ${s.previous}`)).toEqual(['4 from 1']);
  });

  it('measures a tool name against the sessions that have tool counts, not against the sessions that sent signals', () => {
    const a = { ...v('opencode', '1.3.9', 50, {}, 2, 40), features: new Map([['tool:webfetch', 12]]) };
    const b = { ...v('opencode', '1.4.2', 50, {}, 2, 40), features: new Map([['tool:webfetch', 0]]) };
    const list = detectStopped([a, b], compareVersions);
    expect(find(list, 'tool:webfetch')).toMatchObject({ kind: 'tool', before: 30, now: 0 });
  });
});

describe('effectOf', () => {
  it('says what a known hook affects, names the harness for a tool, and says nothing for a name it does not know', () => {
    expect(effectOf('claude-code', 'hook:tool.check')).toBe('Permission prompts are not counted.');
    expect(effectOf('opencode', 'tool:webfetch')).toContain('no webfetch for OpenCode');
    expect(effectOf('claude-code', 'hook:something.new')).toBe('');
  });
});
