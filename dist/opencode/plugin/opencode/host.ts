// What answering does inside OpenCode (#858): the calls the server part makes. The OpenCode API arrives as a small `Api` the entry
// file fills in from `ctx`, so everything here is tested with fakes. A question form is answered through the TUI part when one is
// attached, otherwise through OpenCode's local HTTP route with the address and password in `service.json`.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Host } from './answering.ts';
import { ATTACH_TTL_MS, type AnswerEvent } from './bridge.ts';

export interface Api {
  permissionReply(input: { sessionID: string; requestID: string; reply: 'once' | 'reject'; message?: string }): Promise<unknown>;
  prompt(input: { sessionID: string; id: string; text: string }): Promise<unknown>;
  compact(input: { sessionID: string; id: string }): Promise<unknown>;
}

export interface HostDeps {
  api: Api;
  /** Hands an answer to the TUI part. */
  emitAnswer: (e: AnswerEvent) => Promise<void>;
  /** When a TUI part last said it is attached; 0 for never. */
  tuiSeenAt: () => number;
  /** Whether a form is still open, which is how a TUI part's reply is seen to have landed. */
  isOpen: (formId: string) => boolean;
  /** The text of `service.json`, read when it is needed; null when there is none. */
  readService: () => string | null;
  /** Whether `service.json` exists, without reading it. */
  hasService: () => boolean;
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** How long a TUI part is given to take an answer. */
  tuiWaitMs?: number;
}

/** Where OpenCode writes `service.json`: only while it runs as a background service. */
export function servicePath(env: Readonly<Record<string, string | undefined>>, home: string): string {
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'opencode', 'service.json');
}

/** The address and password from `service.json`. Null unless the address is this machine's: the password is never sent anywhere else. */
export function serviceOf(text: string | null): { url: string; password: string } | null {
  if (!text) return null;
  try {
    const s = JSON.parse(text) as { url?: unknown; password?: unknown };
    if (typeof s.url !== 'string' || typeof s.password !== 'string' || !s.password) return null;
    const u = new URL(s.url);
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return null;
    return { url: u.origin, password: s.password };
  } catch {
    return null;
  }
}

const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** How many delivery ids keep their message id, so a retry is the same message. */
const IDS_KEPT = 200;

/**
 * The id OpenCode takes for a message or a compaction. It takes only a string that starts with `msg_` (OpenCode 2.2.5 answers `Expected a
 * string starting with "msg_"` to anything else), and orders messages by id, so the id is OpenCode's own shape: 12 hex digits of the time,
 * then 14 characters. The characters come from the delivery id, and the first id made for a delivery is kept, so the same delivery sent
 * twice is the same message.
 */
export function messageIdFor(deliveryId: string, now: number, kept: Map<string, string>): string {
  const was = kept.get(deliveryId);
  if (was) return was;
  const time = (BigInt(Math.max(0, Math.trunc(now))) * 0x1000n).toString(16).padStart(12, '0').slice(-12);
  const tail = Array.from(createHash('sha256').update(deliveryId).digest().subarray(0, 14), (b) => ID_CHARS[b % ID_CHARS.length]).join('');
  const id = `msg_${time}${tail}`;
  kept.set(deliveryId, id);
  if (kept.size > IDS_KEPT) kept.delete(kept.keys().next().value as string);
  return id;
}

/** Submits text as a prompt through `api` under a message id made from `id`. Used for a peer's message, which does not go through the host. */
export function promptVia(api: Api, now: () => number): (sessionId: string, id: string, text: string) => Promise<void> {
  const kept = new Map<string, string>();
  return async (sessionID, id, text) => void (await api.prompt({ sessionID, id: messageIdFor(id, now(), kept), text }));
}

export function makeHost(d: HostDeps): Host {
  const ids = new Map<string, string>();
  const tui = (): boolean => d.tuiSeenAt() > 0 && d.now() - d.tuiSeenAt() < ATTACH_TTL_MS;
  // `service.json` is looked for at most every 5 seconds: the form channel is asked about on every pass for every ask.
  let serviceAt = -Infinity;
  let service = false;
  const hasService = (): boolean => {
    if (d.now() - serviceAt >= 5000) {
      service = d.hasService();
      serviceAt = d.now();
    }
    return service;
  };
  const waitMs = d.tuiWaitMs ?? 5000;
  return {
    permissionReply: async (sessionID, requestID, reply, message) => void (await d.api.permissionReply({ sessionID, requestID, reply, ...(message === undefined ? {} : { message }) })),
    formChannel: () => (tui() ? 'tui' : hasService() ? 'http' : null),
    async formReply(sessionID, formID, answer) {
      if (tui()) {
        await d.emitAnswer({ sessionID, formID, answer });
        for (let waited = 0; waited < waitMs; waited += 100) {
          if (!d.isOpen(formID)) return;
          await d.sleep(100);
        }
        if (!d.isOpen(formID)) return;
        // The TUI part said it was there but did not answer: the local route may still work.
        if (!hasService()) throw new Error('the TUI part did not answer the form');
      }
      // Read now, not at start: the file is there only while the service runs, and the password changes with it.
      const svc = serviceOf(d.readService());
      if (!svc) throw new Error('no local service to answer through');
      const res = await d.fetch(`${svc.url}/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`opencode:${svc.password}`).toString('base64')}` },
        body: JSON.stringify({ answer }),
      });
      if (!res.ok) throw new Error(`the form reply was refused (${res.status})`);
    },
    prompt: async (sessionID, id, text) => void (await d.api.prompt({ sessionID, id: messageIdFor(id, d.now(), ids), text })),
    compact: async (sessionID, id) => void (await d.api.compact({ sessionID, id: messageIdFor(id, d.now(), ids) })),
  };
}
