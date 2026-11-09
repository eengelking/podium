import { describe, expect, it } from 'vitest';
import { argsOf, runPodium, type CommandDeps } from './command.ts';

const deps = (): CommandDeps & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    answer: async (a, id) => (calls.push(`answer ${a} ${id}`), 'answered'),
    name: async (n) => (calls.push(`name ${n}`), 'named'),
    context: async (a) => (calls.push(`context${a}`), 'context said'),
    status: () => (calls.push('status'), 'status text'),
    config: async () => (calls.push('config'), ''),
  };
};

describe('/podium config in OpenCode (#1001)', () => {
  it('opens the settings window for the word alone, and anything after it is the status', async () => {
    const d = deps();
    expect(await runPodium(' config', d)).toBe('');
    expect(await runPodium(' config now', d)).toBe('status text');
    expect(d.calls).toEqual(['config', 'status']);
  });
});

describe('/podium words in OpenCode (#987)', () => {
  it('strips the command word, with or without the slash', () => {
    expect(argsOf('/podium name x')).toBe(' name x');
    expect(argsOf('podium')).toBe('');
    expect(argsOf(undefined)).toBe('');
  });
  it('routes allow, decline and deliver, name, context, and anything else to the status', async () => {
    const d = deps();
    expect(await runPodium(' allow abcd', d)).toBe('answered');
    expect(await runPodium(' name  Silverbolt ', d)).toBe('named');
    expect(await runPodium(' context use work', d)).toBe('context said');
    expect(await runPodium('', d)).toBe('status text');
    expect(await runPodium(' name', d)).toBe('status text');
    expect(d.calls).toEqual(['answer allow abcd', 'name Silverbolt', 'context use work', 'status', 'status']);
  });
});
