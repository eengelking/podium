// What a reporter's report costs the store when an Admin is reading (#1062): `noticesFor` runs on every report of every session, so the readings on record are
// read once per short window, not once per report, and a thread with no conversation is looked up once per window, not once per report.
import { describe, expect, it } from 'vitest';
import { AdminReads, NO_SUBJECT_MS } from './chatAdminReads.js';
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
  const counts = { recent: 0, resolve: 0, unseen: 0 };
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
    unseenFor: async () => { counts.unseen++; return []; },
    mark: async () => undefined,
    forget: async () => 0,
    seen: async () => 0,
    purge: async () => 0,
    threads: async () => [],
  } as unknown as ChatAdminReadsApi;
  const owners = Array.from({ length: SESSIONS }, (_, i) => `person${i}`);
  const core = {
    store: { adminReads: store },
    host: {
      now: () => clock.now,
      peers: { messages: { live: (id: string) => ({ owner: `person${Number(id.slice(1))}`, ownerId: Number(id.slice(1)) % SESSIONS }) } },
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
    return n < conversations ? { scope: 'dm', thread, owners: [`person${n % SESSIONS}`], people: [n % SESSIONS], phrase: 'is reading your Podium conversation' } : null;
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
    const n = i < READINGS - deleted ? i : 100_000 + i;
    await reads.note(admin, { scope: 'dm', thread: `dm:s${n}|s${n + 1}`, owners: [`person${i % SESSIONS}`], people: [i % SESSIONS], phrase: 'is reading your Podium conversation' });
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

    // each deleted thread once per 10 seconds of its window, the others once: bounded by the threads, never by the reports or the conversations
    expect(few).toBeLessThanOrEqual(READINGS + 10 * 6);
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

  it('does not keep a read of the store that a note began during, so the reading just noted is told', async () => {
    const { reads, clock, counts } = setup(READINGS);
    const core = (reads as unknown as { core: { store: { adminReads: { recent: (s: number) => Promise<unknown[]> } } } }).core;
    const real = core.store.adminReads.recent;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    core.store.adminReads.recent = async (since) => {
      const rows = await real(since); // the rows as they were before the note
      await gate;
      return rows;
    };
    const first = reads.noticesFor('s3'); // starts the read, which is held
    await Promise.resolve();
    core.store.adminReads.recent = real;
    await readings(reads, 0); // an Admin reads while it is held
    release();
    await first;
    clock.now += 100;
    expect((await reads.noticesFor('s3')).map((n) => n.text)).toEqual(['Boss (an Admin) is reading your Podium conversation.']);
    expect(counts.recent).toBeGreaterThan(1);
  });

  it('looks a thread with no subject up again after a short time, so a conversation that appears later is still told', async () => {
    const { reads, clock, counts } = setup(READINGS);
    await readings(reads, 1);
    (reads as unknown as { known: Map<string, unknown> }).known.clear();
    await reads.noticesFor('s1');
    const once = counts.resolve;
    await reads.noticesFor('s2');
    expect(counts.resolve).toBe(once); // remembered
    clock.now += NO_SUBJECT_MS + 1;
    await reads.noticesFor('s2');
    expect(counts.resolve).toBeGreaterThan(once);
  });
});

describe('what a report costs the store for an Admin\'s stop owed to the person (#1328)', () => {
  it('reads each person\'s owed stops once, however many reports there are, and again after a write or a look', async () => {
    const { reads, clock, counts } = setup(READINGS);
    await minute(reads, clock);
    // 600 reports of 50 people: one read each, not one per report.
    expect(counts.unseen).toBe(SESSIONS);
    await reads.seen('act:1', 1);
    await reads.noticesFor('s1');
    expect(counts.unseen).toBe(SESSIONS + 1);
  });
});
