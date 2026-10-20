// The release check (#499): once a day the server asks GitHub for the latest Podium release and keeps the answer
// in memory. The wall shows a notice when that release is newer than the running server. SPEC 6.8.
import type { Logger } from '../logging/logger.js';
import type { UpdateNotice } from './protocol.js';

const REPO = 'eengelking/podium';
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const REQUEST_TIMEOUT_MS = 10_000;

/** How often the check runs, and how long after start the first one does (so a restart loop does not hammer GitHub). */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 3600_000;
export const UPDATE_CHECK_FIRST_MS = 30_000;

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** True when `latest` is a later MAJOR.MINOR.PATCH than `current`. A dev, simulator or unknown version never is. */
export function isNewer(latest: string, current: string): boolean {
  const a = VERSION.exec(latest);
  const b = VERSION.exec(current);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(a[i]) - Number(b[i]);
    if (d !== 0) return d > 0;
  }
  return false;
}

export interface UpdateCheckOptions {
  /** The running server's version. */
  current: string;
  /** The Admin's Release check switch. Off, no request is made and no notice is held. */
  enabled: () => boolean;
  /** Called when the answer changes, so open browsers hear it. */
  onChange: () => void;
  /** The global `fetch` unless a test gives one. */
  fetch?: typeof fetch;
  logger?: Logger;
}

export class UpdateCheck {
  private found: UpdateNotice | null = null;

  constructor(private readonly opts: UpdateCheckOptions) {}

  /** The newer release the last good check found, or null (also null while the Release check is off). */
  latest(): UpdateNotice | null {
    return this.opts.enabled() ? this.found : null;
  }

  /**
   * Asks GitHub once. A failed check (offline, rate limited, no answer, an odd reply) changes nothing the UI can see: it keeps the
   * last good answer and writes one short warning for the log. The release link is built from the tag, never taken from the reply.
   */
  async check(): Promise<void> {
    if (!this.opts.enabled()) return;
    try {
      const doFetch = this.opts.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
      const res = await doFetch(LATEST_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'podium-release-check' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { tag_name?: unknown; prerelease?: unknown; draft?: unknown } | null;
      this.accept(body);
    } catch (err) {
      this.opts.logger?.warn('update.check_failed', `podium: release check failed: ${(err as Error).message}`, { reason: (err as Error).message });
    }
  }

  private accept(body: { tag_name?: unknown; prerelease?: unknown; draft?: unknown } | null): void {
    const tag = typeof body?.tag_name === 'string' ? /^v(\d+\.\d+\.\d+)$/.exec(body.tag_name) : null;
    if (!tag || body?.prerelease === true || body?.draft === true) throw new Error('no release it can read');
    const next = isNewer(tag[1], this.opts.current) ? { latest: tag[1], url: `https://github.com/${REPO}/releases/tag/v${tag[1]}` } : null;
    if (next?.latest === this.found?.latest) return;
    this.found = next;
    this.opts.onChange();
  }
}

/** Runs the check shortly after start and then once a day, until the returned function is called. The timers do not keep the process alive. */
export function startUpdateCheck(check: UpdateCheck, intervalMs = UPDATE_CHECK_INTERVAL_MS, firstMs = UPDATE_CHECK_FIRST_MS): () => void {
  const run = () => void check.check().catch(() => {});
  const first = setTimeout(run, firstMs);
  const every = setInterval(run, intervalMs);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
