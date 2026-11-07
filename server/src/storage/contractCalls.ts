// Records which store methods the storage tests call, on which adapter (#1008). `contractMethods.ts` derives every method the interface offers
// from `types.ts`; the guard in `adapters.test.ts` fails when one is never called on some adapter, so a method added to the interface is not
// left without a case. A storage is wrapped once, where the adapter is opened for the tests, and every call through it is noted by its path.
import type { ContractAdapter } from './contractAdapter.js';
import type { Storage } from './types.js';

/** adapter name -> the method paths called on it (`fleet.upsertSession`, `peers().rights.propose`). */
export const calls = new Map<string, Set<string>>();

function wrap<T extends object>(value: T, prefix: string, seen: Set<string>): T {
  return new Proxy(value, {
    get(target, prop) {
      const v = Reflect.get(target, prop) as unknown;
      if (typeof prop !== 'string') return v;
      if (typeof v === 'function') {
        return (...args: unknown[]) => {
          seen.add(`${prefix}${prop}`);
          const r = (v as (...a: unknown[]) => unknown).apply(target, args);
          return r && typeof r === 'object' && !(r instanceof Promise) && !Array.isArray(r) && !(r instanceof Map) && !(r instanceof Set)
            ? wrap(r, `${prefix}${prop}().`, seen)
            : r;
        };
      }
      if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Map) && !(v instanceof Set)) return wrap(v as object, `${prefix}${prop}.`, seen);
      return v;
    },
  });
}

/** The adapter, with every storage it opens noting its calls under its name. */
export function noting(adapter: ContractAdapter): ContractAdapter {
  const seen = calls.get(adapter.name) ?? new Set<string>();
  calls.set(adapter.name, seen);
  const note = (s: Storage): Storage => wrap(s, '', seen);
  return {
    ...adapter,
    available: () => adapter.available(),
    open: async () => note(await adapter.open()),
    openUpgraded: async (rows, reporters, sessions, messages, rights, adminReads) => note(await adapter.openUpgraded(rows, reporters, sessions, messages, rights, adminReads)),
    schema: () => adapter.schema(),
    dispose: () => adapter.dispose(),
  };
}
