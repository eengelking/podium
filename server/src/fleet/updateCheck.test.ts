import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateCheck, isNewer, startUpdateCheck, UPDATE_CHECK_INTERVAL_MS, UPDATE_CHECK_FIRST_MS } from './updateCheck.js';
import type { Logger } from '../logging/logger.js';

afterEach(() => vi.useRealTimers());

function release(over: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ tag_name: 'v0.15.0', html_url: 'https://github.com/eengelking/podium/releases/tag/v0.15.0', prerelease: false, draft: false, ...over }), { status: 200 });
}

function logger() {
  const warns: { event: string; message: string }[] = [];
  const l = { debug() {}, info() {}, warn: (event: string, message: string) => warns.push({ event, message }), error() {}, log() {}, isEnabled: () => true } as Logger;
  return { l, warns };
}

function make(over: { fetch?: typeof fetch; on?: boolean; current?: string } = {}) {
  const changed = vi.fn();
  const { l, warns } = logger();
  const fetchFn = over.fetch ?? vi.fn(async () => release());
  const check = new UpdateCheck({ current: over.current ?? '0.14.3', enabled: () => over.on ?? true, onChange: changed, fetch: fetchFn, logger: l });
  return { check, changed, warns, fetchFn };
}

describe('isNewer', () => {
  it('compares major, minor and patch as numbers', () => {
    expect(isNewer('0.15.0', '0.14.3')).toBe(true);
    expect(isNewer('0.14.4', '0.14.3')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.14.10', '0.14.9')).toBe(true);
  });
  it('is false for the same version and for an older one', () => {
    expect(isNewer('0.14.3', '0.14.3')).toBe(false);
    expect(isNewer('0.14.2', '0.14.3')).toBe(false);
    expect(isNewer('0.9.0', '0.14.0')).toBe(false);
  });
  it('is false when either side is not MAJOR.MINOR.PATCH, so a dev or simulator build never nags', () => {
    expect(isNewer('0.15.0', 'unknown')).toBe(false);
    expect(isNewer('0.15.0', '0.1.0-sim')).toBe(false);
    expect(isNewer('v0.15.0', '0.14.3')).toBe(false);
    expect(isNewer('0.15.0-rc.1', '0.14.3')).toBe(false);
  });
});

describe('UpdateCheck.check', () => {
  it('records a newer release with its tag, and builds the release link itself', async () => {
    const { check, changed, fetchFn } = make();
    await check.check();
    expect(check.latest()).toEqual({ latest: '0.15.0', url: 'https://github.com/eengelking/podium/releases/tag/v0.15.0' });
    expect(changed).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/eengelking/podium/releases/latest');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/podium/i);
  });

  it('ignores the html_url GitHub sends, so a changed response cannot point the UI link elsewhere', async () => {
    const { check } = make({ fetch: vi.fn(async () => release({ html_url: 'https://evil.example/x' })) });
    await check.check();
    expect(check.latest()?.url).toBe('https://github.com/eengelking/podium/releases/tag/v0.15.0');
  });

  it('shows nothing when the latest release is the running version or older', async () => {
    const same = make({ fetch: vi.fn(async () => release({ tag_name: 'v0.14.3' })) });
    await same.check.check();
    expect(same.check.latest()).toBeNull();
    expect(same.changed).not.toHaveBeenCalled();
    const older = make({ fetch: vi.fn(async () => release({ tag_name: 'v0.13.0' })) });
    await older.check.check();
    expect(older.check.latest()).toBeNull();
  });

  it('ignores a pre-release, a draft and a tag that is not vMAJOR.MINOR.PATCH', async () => {
    for (const over of [{ prerelease: true }, { draft: true }, { tag_name: 'v0.15.0-rc.1' }, { tag_name: '0.15.0' }, { tag_name: 'nightly' }]) {
      const { check, changed } = make({ fetch: vi.fn(async () => release(over)) });
      await check.check();
      expect(check.latest()).toBeNull();
      expect(changed).not.toHaveBeenCalled();
    }
  });

  it('ignores a nightly snapshot (#528), marked pre-release or not', async () => {
    for (const prerelease of [true, false]) {
      const { check, changed } = make({ fetch: vi.fn(async () => release({ tag_name: 'nightly-2026-10-20', prerelease })) });
      await check.check();
      expect(check.latest()).toBeNull();
      expect(changed).not.toHaveBeenCalled();
    }
  });

  it('makes no request at all when the Admin turned the check off', async () => {
    const { check, fetchFn, changed } = make({ on: false });
    await check.check();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(check.latest()).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });

  it('only tells the stream when the answer changes', async () => {
    const { check, changed } = make();
    await check.check();
    await check.check();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('fails quietly on a network error, a bad status, bad JSON and a hung request, keeping the last good answer', async () => {
    let n = 0;
    const answers: (() => Promise<Response>)[] = [
      async () => release(),
      async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com');
      },
      async () => new Response('rate limited', { status: 403 }),
      async () => new Response('<html>', { status: 200 }),
      async () => new Response(JSON.stringify(null), { status: 200 }),
      () => new Promise<Response>((_, reject) => setTimeout(() => reject(new DOMException('timed out', 'TimeoutError')), 1)),
    ];
    const { check, warns, changed } = make({ fetch: (async () => answers[n++]()) as typeof fetch });
    await check.check();
    for (let i = 1; i < answers.length; i++) await expect(check.check()).resolves.toBeUndefined();
    expect(check.latest()?.latest).toBe('0.15.0');
    expect(changed).toHaveBeenCalledTimes(1);
    // one short line per failed check, never more
    expect(warns).toHaveLength(answers.length - 1);
    for (const w of warns) {
      expect(w.event).toBe('update.check_failed');
      expect(w.message.length).toBeLessThan(160);
    }
  });

  it('forgets a held answer when the check is off, so the notice follows the switch', async () => {
    let on = true;
    const changed = vi.fn();
    const check = new UpdateCheck({ current: '0.14.3', enabled: () => on, onChange: changed, fetch: vi.fn(async () => release()) as unknown as typeof fetch });
    await check.check();
    expect(check.latest()).not.toBeNull();
    on = false;
    expect(check.latest()).toBeNull();
  });

  it('uses the global fetch when none is given', async () => {
    const stub = vi.fn(async () => release());
    vi.stubGlobal('fetch', stub);
    try {
      const check = new UpdateCheck({ current: '0.14.3', enabled: () => true, onChange: () => {} });
      await check.check();
      expect(stub).toHaveBeenCalledTimes(1);
      expect(check.latest()?.latest).toBe('0.15.0');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('startUpdateCheck', () => {
  it('checks shortly after start and then once a day, and stops when asked', async () => {
    vi.useFakeTimers();
    const check = { check: vi.fn(async () => {}) };
    const stop = startUpdateCheck(check as unknown as UpdateCheck);
    expect(check.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_FIRST_MS);
    expect(check.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(check.check).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(check.check).toHaveBeenCalledTimes(2);
  });

  it('survives a check that throws', async () => {
    vi.useFakeTimers();
    const check = { check: vi.fn(async () => Promise.reject(new Error('boom'))) };
    const stop = startUpdateCheck(check as unknown as UpdateCheck, 1000, 10);
    await vi.advanceTimersByTimeAsync(2100);
    expect(check.check).toHaveBeenCalledTimes(3);
    stop();
  });

  it('runs once a day by default', () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(24 * 3600_000);
  });
});
