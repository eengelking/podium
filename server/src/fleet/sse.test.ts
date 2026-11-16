import { describe, it, expect, afterEach, vi } from 'vitest';
import { openSqliteStorage } from '../storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import { formatSse, SseHub } from './sse.js';
import { fixtureReport } from './testing.js';

afterEach(() => {
  vi.useRealTimers();
});

function sink() {
  const chunks: string[] = [];
  return { chunks, write: (c: string) => void chunks.push(c) };
}

function events(chunks: string[]): string[] {
  return chunks.join('').split('\n\n').map((b) => /^event: (\w+)/.exec(b)?.[1]).filter((e): e is string => !!e);
}

describe('SseHub', () => {
  it('formats messages as one data line of JSON', () => {
    expect(formatSse('tick', { a: 'x\ny' })).toBe('event: tick\ndata: {"a":"x\\ny"}\n\n');
  });

  it('sends retry and the first messages on connect, then broadcasts', () => {
    const hub = new SseHub();
    const a = sink();
    hub.add(a, [formatSse('snapshot', { n: 1 })]);
    hub.broadcast('tick', { n: 2 });
    expect(a.chunks[0]).toMatch(/^retry: 2000\n\nevent: snapshot\n/);
    expect(events(a.chunks)).toEqual(['snapshot', 'tick']);
  });

  it('removes a client whose write throws, and keeps serving the others', () => {
    const hub = new SseHub();
    const good = sink();
    let calls = 0;
    hub.add({ write: () => { if (++calls > 1) throw new Error('EPIPE'); } });
    hub.add(good);
    expect(hub.size).toBe(2);
    expect(() => hub.broadcast('tick', {})).not.toThrow();
    expect(hub.size).toBe(1);
    hub.broadcast('tick', {});
    expect(events(good.chunks)).toEqual(['tick', 'tick']);
  });

  it('removes a client on disconnect and supports at least 20 at once', () => {
    const hub = new SseHub();
    const ids = Array.from({ length: 20 }, () => hub.add(sink()));
    expect(ids.every((i) => i !== null)).toBe(true);
    hub.remove(ids[0]!);
    expect(hub.size).toBe(19);
  });

  it('ends a client whose queue passes the limit, logs it once and keeps serving the others (#748)', () => {
    const drops: string[] = [];
    const hub = new SseHub(100, 1000, (reason) => drops.push(reason));
    const healthy = sink();
    let queued = 0;
    let ended = 0;
    hub.add({ write: () => void (queued += 400), queued: () => queued, end: () => void ended++ });
    hub.add({ ...healthy, queued: () => 0 });
    hub.broadcast('tick', {});
    expect(hub.size).toBe(2);
    hub.broadcast('tick', {});
    expect(hub.size).toBe(1);
    expect(ended).toBe(1);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatch(/1200 bytes queued.*limit of 1000/);
    hub.broadcast('tick', {});
    expect(events(healthy.chunks)).toEqual(['tick', 'tick', 'tick']);
    expect(queued).toBe(1200);
  });

  it('does not drop a client whose queue is under the limit, as when a snapshot is in flight (#748)', () => {
    const hub = new SseHub(100, 1000);
    hub.add({ write: () => undefined, queued: () => 999 });
    hub.broadcast('tick', {});
    expect(hub.size).toBe(1);
  });

  it('refuses clients past its limit', () => {
    const hub = new SseHub(2);
    expect(hub.add(sink())).not.toBeNull();
    expect(hub.add(sink())).not.toBeNull();
    expect(hub.add(sink())).toBeNull();
  });

  it('says whether it is full, apart from a client that vanished while being added', () => {
    const hub = new SseHub(1);
    expect(hub.isFull).toBe(false);
    const dead = { write() { throw new Error('closed'); } };
    expect(hub.add(dead)).toBeNull(); // gone, not "too many"
    expect(hub.isFull).toBe(false);
    expect(hub.add(sink())).not.toBeNull();
    expect(hub.isFull).toBe(true);
  });
});

describe('Fleet broadcasts', () => {
  async function fleetWith() {
    let now = 1_791_648_000_000;
    const fleet = new Fleet(openSqliteStorage(':memory:'), { ...DEFAULT_CONFIG, home: '/', dbPath: ':memory:' }, () => now);
    await fleet.init();
    const s = sink();
    fleet.hub.add(s, [await fleet.snapshotMessage()]);
    return { fleet, s, advance: (ms: number) => { now += ms; vi.advanceTimersByTime(ms); } };
  }

  it('snapshot on connect, activity per new event, throttled session, tick', async () => {
    vi.useFakeTimers();
    const { fleet, s, advance } = await fleetWith();
    const r = fixtureReport();
    for (let i = 0; i < 10; i++) {
      await fleet.ingest(r);
      advance(20);
    }
    await fleet.flush();
    // ten ingests in 200 ms: three activity messages (the events are new once), at most one session
    expect(events(s.chunks)).toEqual(['snapshot', 'activity', 'activity', 'activity']);
    advance(300);
    await fleet.flush();
    expect(events(s.chunks).filter((e) => e === 'session')).toHaveLength(1);
    await fleet.tick();
    await fleet.flush();
    expect(events(s.chunks).at(-1)).toBe('tick');
    fleet.close();
  });

  it('a tick with no client connected does not compute the KPIs, and one that follows a connect does (#749)', async () => {
    vi.useFakeTimers();
    const fleet = new Fleet(openSqliteStorage(':memory:'), { ...DEFAULT_CONFIG, home: '/', dbPath: ':memory:' }, () => 1_791_648_000_000);
    await fleet.init();
    await fleet.ingest(fixtureReport());
    const kpis = vi.spyOn(fleet, 'kpis');
    await fleet.tick();
    expect(kpis).not.toHaveBeenCalled();
    const s = sink();
    await fleet.attach(s);
    kpis.mockClear();
    await fleet.tick();
    expect(kpis).toHaveBeenCalledTimes(1);
    expect(events(s.chunks)).toEqual(['snapshot', 'tick']);
    fleet.close();
  });

  it('activity messages arrive oldest first and carry the session name', async () => {
    vi.useFakeTimers();
    const { fleet, s } = await fleetWith();
    await fleet.ingest(fixtureReport());
    await fleet.flush();
    const acts = s.chunks.join('').split('\n\n').filter((b) => b.startsWith('event: activity')).map((b) => JSON.parse(b.split('data: ')[1]!));
    expect(acts.map((a) => a.kind)).toEqual(['spawn', 'fail', 'blow']);
    expect(acts[0].sessionName).toBe('invoice-v2');
    fleet.close();
  });

  it('removed:deleted when a live session is deleted', async () => {
    vi.useFakeTimers();
    const { fleet, s } = await fleetWith();
    const r = fixtureReport();
    await fleet.ingest(r);
    expect(await fleet.deleteSession(r.session.id)).toBe(true);
    await fleet.flush();
    expect(s.chunks.join('')).toContain(`event: removed\ndata: {"sessionId":"${r.session.id}","reason":"deleted"}`);
    fleet.close();
  });
});
