import { describe, it, expect } from 'vitest';
import { openSqliteStorage } from '../storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import type { Report } from './protocol.js';
import { fixtureReport } from './testing.js';

// Issue #805: the card shows a Comp pill when Claude Code compacted the session on its own. The count is the session's stored automatic compact events (SPEC 5.3).
const NOW = 1_791_648_000_000;

async function setup() {
  const fleet = new Fleet(openSqliteStorage(':memory:'), { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' }, () => NOW);
  await fleet.init();
  const r: Report = fixtureReport();
  r.sentAt = NOW;
  r.session.startedAt = NOW - 60_000;
  return { fleet, r };
}

const compact = (r: Report, n: number, data: Record<string, unknown> | null, agentId: string | null = null) =>
  ({ id: `${r.session.id}:compact:${n}`, t: NOW - 10_000 + n, kind: 'compact', agentId, text: 'auto-compacted at 22% on the orchestrator', data }) as Report['events'][number];

describe('compactions on the session view (#805)', () => {
  it('is 0 for a session with no compaction event', async () => {
    const { fleet, r } = await setup();
    await fleet.ingest(r);
    expect((await fleet.view(r.session.id))!.compactions).toBe(0);
  });

  it('counts the automatic compact events of every loop, and not a manual one', async () => {
    const { fleet, r } = await setup();
    r.events.push(compact(r, 1, { trigger: 'auto', percent: 22 }), compact(r, 2, { trigger: 'auto', percent: 25 }, 'a1'), compact(r, 3, { tokensBefore: 1 }));
    await fleet.ingest(r);
    expect((await fleet.view(r.session.id))!.compactions).toBe(2);
  });

  it('does not count a blowout as a compaction', async () => {
    const { fleet, r } = await setup();
    await fleet.ingest(r);
    expect((await fleet.view(r.session.id))!.blowouts.total).toBeGreaterThan(0);
    expect((await fleet.view(r.session.id))!.compactions).toBe(0);
  });
});
