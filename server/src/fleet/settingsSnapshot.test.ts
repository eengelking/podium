import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import type { StateBody } from './protocol.js';
import { RESPOND } from '../storage/features.js';

const fleets: Fleet[] = [];
afterEach(async () => {
  for (const f of fleets.splice(0)) {
    f.close();
    await f.flush();
    await f.storage.close();
  }
});

async function start(): Promise<Fleet> {
  const fleet = new Fleet(openSqliteStorage(':memory:'), { ...DEFAULT_CONFIG, home: '/', dbPath: ':memory:' }, () => 1_000_000);
  fleets.push(fleet);
  await fleet.init();
  return fleet;
}

/** The snapshots and wall messages a client was sent, in order. */
function client(chunks: string[]) {
  return {
    write: (c: string) => void chunks.push(c),
  };
}

const bodies = (chunks: string[], event: string): unknown[] =>
  chunks
    .join('')
    .split('\n\n')
    .filter((b) => b.includes(`event: ${event}\n`))
    .map((b) => JSON.parse(/data: (.*)/.exec(b)![1]!));

describe('the Admin settings in a snapshot (#313)', () => {
  it('reads the stored settings in the first snapshot and in state', async () => {
    const fleet = await start();
    await fleet.features.setFeature(RESPOND, true);
    await fleet.wall.setShowBackgroundSessions(true);
    const state = await fleet.state();
    expect(state.features[RESPOND]).toBe(true);
    expect(state.wall.showBackgroundSessions).toBe(true);
    const chunks: string[] = [];
    await fleet.attach(client(chunks));
    const first = bodies(chunks, 'snapshot')[0] as StateBody;
    expect(first.features[RESPOND]).toBe(true);
    expect(first.wall.showBackgroundSessions).toBe(true);
  });

  it('sends a changed flag to open consoles, and never a snapshot with the old value after the change', async () => {
    const fleet = await start();
    const chunks: string[] = [];
    await fleet.attach(client(chunks));
    // A snapshot that has read the flag but is still on its way out when the Admin turns the flag on.
    const real = fleet.state.bind(fleet);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    let slow = true;
    (fleet as unknown as { state: () => Promise<StateBody> }).state = async () => {
      const s = await real();
      if (slow) {
        slow = false;
        await held;
      }
      return s;
    };
    const first = fleet.activityHistoryChanged();
    await new Promise((r) => setTimeout(r, 20)); // the snapshot has now read the flag as off
    await fleet.features.setFeature(RESPOND, true);
    release();
    await first;
    await fleet.flush();
    const sent = bodies(chunks, 'snapshot') as StateBody[];
    // the attach snapshot, then everything sent after the change
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent[0]!.features[RESPOND]).toBe(false);
    for (const s of sent.slice(1)) expect(s.features[RESPOND]).toBe(true);
  });

  it('makes a snapshot again when a price changes while it is being built', async () => {
    const fleet = await start();
    const chunks: string[] = [];
    await fleet.attach(client(chunks));
    const real = fleet.state.bind(fleet);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    let slow = true;
    (fleet as unknown as { state: () => Promise<StateBody> }).state = async () => {
      const s = await real();
      if (slow) {
        slow = false;
        await held;
      }
      return s;
    };
    const built = fleet.activityHistoryChanged();
    await new Promise((r) => setTimeout(r, 20));
    const std = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 };
    expect(await fleet.prices.set('m', { std })).toBeNull();
    release();
    await built;
    await fleet.flush();
    expect(fleet.prices.pricing().rowOf('m')?.std).toEqual(std);
    expect(bodies(chunks, 'snapshot').length).toBeGreaterThanOrEqual(2);
  });

  it('sends the wall message with the new value, once per stored change', async () => {
    const fleet = await start();
    const chunks: string[] = [];
    await fleet.attach(client(chunks));
    await fleet.wall.setNotice('background-sessions', false);
    await fleet.wall.setNotice('background-sessions', false);
    await fleet.flush();
    const walls = bodies(chunks, 'wall') as Array<{ notices: Record<string, boolean> }>;
    expect(walls).toHaveLength(1);
    expect(walls[0]!.notices['background-sessions']).toBe(false);
  });
});
