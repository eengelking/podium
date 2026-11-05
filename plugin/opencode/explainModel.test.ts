import { describe, expect, it, vi } from 'vitest';
import { explainWith, pickExplainModel } from './explainModel.ts';

const m = (providerID: string, id: string, over: Record<string, unknown> = {}) => ({ providerID, id, type: 'chat', enabled: true, status: 'active', cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }], ...over });

describe('picking the model that explains a failure (#986)', () => {
  it('takes the cheapest enabled chat model whose id names a small tier, with its variant left unset', () => {
    const list = { data: [m('anthropic', 'claude-opus-5-5'), m('anthropic', 'claude-haiku-5-5', { cost: [{ input: 1, output: 5, cache: { read: 0, write: 0 } }] }), m('openai', 'gpt-5-mini', { cost: [{ input: 0.25, output: 2, cache: { read: 0, write: 0 } }] })] };
    expect(pickExplainModel(list)).toEqual({ providerID: 'openai', id: 'gpt-5-mini' });
  });

  it('skips a model that is disabled, deprecated, not a chat model or has no cost, and one whose id merely contains a small word inside another word', () => {
    const list = { data: [m('a', 'x-mini', { enabled: false }), m('a', 'y-mini', { status: 'deprecated' }), m('a', 'z-mini', { type: 'image' }), m('a', 'big-minimal'), m('a', 'w-nano', { cost: [] }), m('a', 'q-flash', { cost: [{ input: 3, output: 3, cache: { read: 0, write: 0 } }] })] };
    expect(pickExplainModel(list)).toEqual({ providerID: 'a', id: 'q-flash' });
  });

  it('treats a tiered cost by its first entry, a missing type as chat, and breaks a tie by id', () => {
    const list = { data: [m('a', 'b-lite', { type: undefined }), m('a', 'a-lite', { type: undefined })] };
    expect(pickExplainModel(list)).toEqual({ providerID: 'a', id: 'a-lite' });
  });

  it('returns null when the list is missing, malformed or holds no small model', () => {
    expect(pickExplainModel(null)).toBeNull();
    expect(pickExplainModel({ data: 'x' })).toBeNull();
    expect(pickExplainModel({ data: [null, m('a', 'opus')] })).toBeNull();
  });
});

describe('asking it (#986)', () => {
  const list = { data: [m('openai', 'gpt-5-mini')] };

  it('asks the chosen model and names it after the answer', async () => {
    const text = vi.fn(async (_i: { prompt: string; model?: { id: string; providerID: string } }) => ({ text: 'Install the dependency.' }));
    expect(await explainWith(text, async () => list, 'why')).toBe('Install the dependency. (explained by openai/gpt-5-mini)');
    expect(text).toHaveBeenCalledWith({ prompt: 'why', model: { providerID: 'openai', id: 'gpt-5-mini' } });
  });

  it('keeps the model name when the answer is long', async () => {
    const out = await explainWith(async () => ({ text: 'x'.repeat(900) }), async () => list, 'p');
    expect(out!.length).toBeLessThanOrEqual(400);
    expect(out!.endsWith('(explained by openai/gpt-5-mini)')).toBe(true);
  });

  it('uses the default model, and says so, when no small model is listed or the list cannot be read', async () => {
    const text = vi.fn(async (_i: { prompt: string; model?: unknown }) => ({ text: 'ok' }));
    expect(await explainWith(text, async () => ({ data: [] }), 'p')).toBe('ok (explained by OpenCode\'s default model)');
    expect(text).toHaveBeenLastCalledWith({ prompt: 'p' });
    expect(await explainWith(text, async () => { throw new Error('down'); }, 'p')).toBe('ok (explained by OpenCode\'s default model)');
    expect(await explainWith(text, () => { throw new Error('no model API'); }, 'p')).toBe('ok (explained by OpenCode\'s default model)');
  });

  it('does not fall back to the default model when the chosen one fails', async () => {
    const text = vi.fn(async () => { throw new Error('no credentials'); });
    await expect(explainWith(text, async () => list, 'p')).rejects.toThrow('no credentials');
    expect(text).toHaveBeenCalledTimes(1);
  });

  it('returns null for an answer that is not text', async () => {
    expect(await explainWith(async () => ({}) as { text: string }, async () => list, 'p')).toBeNull();
  });

  it('returns null for an empty answer', async () => {
    expect(await explainWith(async () => ({ text: '  ' }), async () => list, 'p')).toBeNull();
  });
});
