// The statement counter the contract cases read (#1309).
import { describe, expect, it } from 'vitest';
import { countCalls, counted, statementCount } from './statementCount.js';

describe('countCalls and counted', () => {
  it('counts each call of a patched method, still runs it as before, and counted gives the statements of what it ran', async () => {
    const target = { run: function (this: { n: number }, by: number) { this.n += by; return this.n; }, other: () => 'x', n: 1 };
    countCalls(target, ['run']);
    const before = statementCount.n;
    const { value, statements } = await counted(async () => [target.run(2), target.run(3), target.other()]);
    expect(value).toEqual([3, 6, 'x']);
    expect(statements).toBe(2);
    expect(statementCount.n - before).toBe(2);
    expect((await counted(async () => 'nothing')).statements).toBe(0);
  });

  it('throws for a method the target does not have, so a renamed driver call fails at load', () => {
    expect(() => countCalls({ run: () => 1 }, ['run', 'runAll'])).toThrow('no method "runAll"');
  });
});
