// What a reporter's report costs the store when an Admin is reading (#1062): `noticesFor` runs on every report of every session, so the readings on record are
// read once per short window, not once per report, and a thread with no conversation is looked up once per window, not once per report.
import { describe, expect, it } from 'vitest';
import { AdminReads } from './chatAdminReads.js';
import type { ChatCore } from './chatCore.js';
import type { AdminReadRow, ChatAdminReadsApi } from '../storage/types.js';
import { NOTICE_TTL_MS } from './chatAdminNotices.js';

const T0 = 1_791_648_000_000;
const SESSIONS = 50;
const READINGS = 20;
const REPORT_EVERY_MS = 5_000;

/** An AdminReads over a fake core whose store counts its reads. `conversations` of the `dm:` threads that exist; the rest are deleted conversations. */
function setup(conversations: number) {
  const clock = { now: T0 };
  const counts = { recent: 0, resolve: 0 };
  const rows: (AdminReadRow & { thread: string })[] = [];
  const store = {
    recent: async (since: number) => {
      counts.recent++;
      return rows.filter((r) => r.lastSeenAt > since);
    },
    touch: async (thread: string, admin: string) => {
      const record = { admin, startedAt: clock.now, lastSeenAt: clock.now, kind: 'read' as const };
      rows.push({ thread, ...record } as AdminReadRow & { thread: string });
      return { started: true, record, previousSeenAt: null };
    },
    mark: async () => undefined,
    forget: async () => 0,
    purge: async () => 0,
    threads: async () => [],
  } as unknown as ChatAdminReadsApi;
  const owners = Array.from({ length: SESSIONS }, (_, i) => `person${i}`);
  const core = {
    store: { adminReads: store },
    host: {
      now: () => clock.now,
      peers: { messages: { live: (id: string) => ({ owner: `person${Number(id.slice(1))}` }) } },
      sessionOf: async () => null,
      liveIds: () => [],
    },
    notices: { for: () => [], push: () => undefined },
    onEvent: () => undefined,
    signal: () => undefined,
  } as unknown as ChatCore;
  const reads = new AdminReads(core);
  reads.resolve = async (thread) => {
    counts.resolve++;
    const n = Number(thread.slice('dm:'.length).split('|')[0]!.slice(1));
    return n < conversations ? { scope: 'dm', thread, owners: [`person${n % SESSIONS}`], phrase: 'is reading your Podium conversation' } : null;
  };
  return { reads, clock, counts, owners };
}

/** A minute of reports: every session reports every 5 seconds. */
async function minute(reads: AdminReads, clock: { now: number }): Promise<void> {
  for (let t = 0; t < 60_000; t += REPORT_EVERY_MS) {
    for (let s = 0; s < SESSIONS; s++) await reads.noticesFor(`s${s}`);
    clock.now += REPORT_EVERY_MS;
  }
}

async function readings(reads: AdminReads, deleted: number): Promise<void> {
  const admin = { actor: 'Boss', name: 'Boss', admin: true } as never;
  for (let i = 0; i < READINGS; i++) {
    // the last `deleted` readings are of conversations that are gone
    const n = i < READINGS - deleted ? i : 1000 + i;
    await reads.note(admin, { scope: 'dm', thread: `dm:s${n}|s${n + 1}`, owners: [`person${i % SESSIONS}`], phrase: 'is reading your Podium conversation' });
  }
}

describe('what a report costs the store while Admins read (#1062)', () => {
  it('reads the recent readings a bounded number of times in a minute of reports, not once per report', async () => {
    const { reads, clock, counts } = setup(READINGS);
    await readings(reads, 0);
    counts.recent = 0;
    await minute(reads, clock);
    // 600 reports; one read per 2 seconds of them at most
    expect(counts.recent).toBeLessThanOrEqual(30);
  });

  it('looks a deleted conversation up once for the window, however many reports there are, and not more for a fleet with more conversations', async () => {
    const small = setup(READINGS);
    await readings(small.reads, 10);
    // the cache a note leaves is what a restart does not have: drop it, so each thread is resolved from the store
    (small.reads as unknown as { known: Map<string, unknown> }).known.clear();
    small.counts.resolve = 0;
    await minute(small.reads, small.clock);
    const few = small.counts.resolve;

    const big = setup(10_000);
    await readings(big.reads, 10);
    (big.reads as unknown as { known: Map<string, unknown> }).known.clear();
    big.counts.resolve = 0;
    await minute(big.reads, big.clock);

    expect(few).toBeLessThanOrEqual(READINGS); // each thread once
    expect(big.counts.resolve).toBe(few);
  });

  it('prunes what it remembers once its window has passed', async () => {
    const { reads, clock } = setup(READINGS);
    await readings(reads, 5);
    const known = (reads as unknown as { known: Map<string, unknown> }).known;
    expect(known.size).toBe(READINGS);
    clock.now += NOTICE_TTL_MS + 10_000;
    await reads.noticesFor('s1');
    expect(known.size).toBe(0);
  });

  it('still tells a session that starts after a reading began, and drops the cache when a reading is noted', async () => {
    const { reads, clock } = setup(READINGS);
    await reads.noticesFor('s3'); // caches an empty list
    await readings(reads, 0);
    clock.now += 1_000;
    const told = await reads.noticesFor('s3');
    expect(told.map((n) => n.text)).toEqual(['Boss (an Admin) is reading your Podium conversation.']);
  });
});
