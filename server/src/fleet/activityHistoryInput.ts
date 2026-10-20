// Reading the Activity history's request inputs (#432): the Stored activity filter from a query string or a body, the delete
// body, and a settings object that is checked without being saved. Each returns an error sentence for a bad value, so a
// route answers 400 and never 500.
import { activityHistoryFieldError } from './activityHistorySettings.js';
import type { ActivityHistorySettings, StoredDeleteBody, StoredFilter } from './activityHistoryTypes.js';

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** The most session ids one delete takes, and the longest id (the session id limit in the report protocol). */
export const STORED_DELETE_MAX_IDS = 200;
export const STORED_ID_MAX = 200;
const TEXT_MAX = 200;
const LOOPS = ['all', 'main', 'agents'] as const;
const FILTER_KEYS = ['q', 'loop', 'project', 'owner', 'olderThanDays', 'from', 'to', 'source'] as const;

export const EMPTY_FILTER_ERROR = 'Pick a filter, or delete everything.';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function text(name: string, v: unknown): Parsed<string> {
  if (typeof v !== 'string' || v.length > TEXT_MAX) return { ok: false, error: `${name} must be text of at most ${TEXT_MAX} characters` };
  return { ok: true, value: v };
}

/** A query value (a string) or a body value (a number) that is a finite number from `min` up. */
function amount(name: string, v: unknown, min: number): Parsed<number> {
  const n = typeof v === 'string' ? (v.trim() === '' ? Number.NaN : Number(v)) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min) return { ok: false, error: `${name} must be a number of ${min} or more` };
  return { ok: true, value: n };
}

/** Reads a filter from the raw fields of a query string or a body. Empty strings count as absent, so a form can send them. */
export function parseFilter(raw: Record<string, unknown>, strict = false): Parsed<StoredFilter> {
  if (strict) {
    const extra = Object.keys(raw).find((k) => !(FILTER_KEYS as readonly string[]).includes(k));
    if (extra) return { ok: false, error: `unknown filter field: ${extra}` };
  }
  const out: StoredFilter = {};
  const given = (k: string) => raw[k] !== undefined && raw[k] !== '';
  for (const k of ['q', 'project', 'owner'] as const) {
    if (!given(k)) continue;
    const t = text(k, raw[k]);
    if (!t.ok) return t;
    out[k] = t.value;
  }
  if (given('loop')) {
    if (!(LOOPS as readonly unknown[]).includes(raw.loop)) return { ok: false, error: `loop must be one of ${LOOPS.join(', ')}` };
    out.loop = raw.loop as StoredFilter['loop'];
  }
  if (given('source')) {
    if (raw.source !== 'activity') return { ok: false, error: 'source must be activity' };
    out.source = 'activity';
  }
  for (const k of ['olderThanDays', 'from', 'to'] as const) {
    if (!given(k)) continue;
    const n = amount(k, raw[k], 0);
    if (!n.ok) return n;
    out[k] = n.value;
  }
  return { ok: true, value: out };
}

/** Whether a filter would match everything: nothing in it narrows the stored sessions. */
export function filterIsEmpty(f: StoredFilter): boolean {
  return !f.q?.trim() && (f.loop === undefined || f.loop === 'all') && !f.project && !f.owner && f.olderThanDays === undefined && f.from === undefined && f.to === undefined;
}

/** `page` (1 or more) and `pageSize` (1 to 200) from a query string. */
export function parsePaging(query: Record<string, unknown>): Parsed<{ page: number; pageSize: number }> {
  const whole = (name: string, v: unknown, min: number, max: number, dflt: number): Parsed<number> => {
    if (v === undefined || v === '') return { ok: true, value: dflt };
    const n = amount(name, v, min);
    if (!n.ok || !Number.isInteger(n.value) || n.value > max) return { ok: false, error: `${name} must be a whole number from ${min} to ${max}` };
    return n;
  };
  const page = whole('page', query.page, 1, 1_000_000, 1);
  if (!page.ok) return page;
  const pageSize = whole('pageSize', query.pageSize, 1, 200, 25);
  if (!pageSize.ok) return pageSize;
  return { ok: true, value: { page: page.value, pageSize: pageSize.value } };
}

/** The body of `POST /stored-activity/delete`: ticked ids, a filter that is not empty, or everything. */
export function parseDeleteBody(body: unknown): Parsed<StoredDeleteBody> {
  const shape = 'give ids (a list of session ids), match (a filter) or all (true)';
  if (!isObject(body)) return { ok: false, error: shape };
  const keys = Object.keys(body).filter((k) => body[k] !== undefined);
  if (keys.length !== 1) return { ok: false, error: shape };
  if (keys[0] === 'all') return body.all === true ? { ok: true, value: { all: true } } : { ok: false, error: 'all must be true' };
  if (keys[0] === 'ids') {
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > STORED_DELETE_MAX_IDS || ids.some((i) => typeof i !== 'string' || i.length < 1 || i.length > STORED_ID_MAX)) {
      return { ok: false, error: `ids must be 1 to ${STORED_DELETE_MAX_IDS} session ids` };
    }
    return { ok: true, value: { ids: ids as string[] } };
  }
  if (keys[0] === 'match') {
    if (!isObject(body.match)) return { ok: false, error: 'match must be a filter' };
    const f = parseFilter(body.match, true);
    if (!f.ok) return f;
    if (filterIsEmpty(f.value)) return { ok: false, error: EMPTY_FILTER_ERROR };
    return { ok: true, value: { match: f.value } };
  }
  return { ok: false, error: shape };
}

/** A complete settings object, checked field by field with the store's own rules and saved nowhere. */
export function parseSettings(raw: unknown, authOn: boolean): Parsed<ActivityHistorySettings> {
  if (!isObject(raw)) return { ok: false, error: 'settings must give policy, n, unit and capGb' };
  const fields = ['policy', 'n', 'unit', 'capGb'] as const;
  const extra = Object.keys(raw).find((k) => !(fields as readonly string[]).includes(k));
  if (extra) return { ok: false, error: `unknown setting: ${extra}` };
  for (const f of fields) {
    if (!(f in raw)) return { ok: false, error: 'settings must give policy, n, unit and capGb' };
    const err = activityHistoryFieldError(f, raw[f]);
    if (err) return { ok: false, error: err };
  }
  if (raw.policy !== 'default' && !authOn) return { ok: false, error: 'Keeping activity needs the server to run with a sign-in token (PODIUM_TOKEN), so only the owner and an Admin can read it' };
  return { ok: true, value: { policy: raw.policy, n: raw.n, unit: raw.unit, capGb: raw.capGb } as ActivityHistorySettings };
}

/** `before` and `limit` of the read route. `before` is a sequence number; `limit` is clamped by the caller. */
export function parseRead(query: Record<string, unknown>): Parsed<{ before: number | null; limit: number | undefined }> {
  const whole = (name: string, v: unknown): Parsed<number | null> => {
    if (v === undefined || v === '') return { ok: true, value: null };
    const n = amount(name, v, 0);
    if (!n.ok || !Number.isSafeInteger(n.value)) return { ok: false, error: `${name} must be a whole number` };
    return n;
  };
  const before = whole('before', query.before);
  if (!before.ok) return before;
  const limit = whole('limit', query.limit);
  if (!limit.ok) return limit;
  return { ok: true, value: { before: before.value, limit: limit.value ?? undefined } };
}
