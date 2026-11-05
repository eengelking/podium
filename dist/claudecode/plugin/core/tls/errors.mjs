// How the TLS helper names what went wrong upstream and how long it waits after a refusal (#584, #948). Plain `.mjs` with no imports,
// shared by every reporter that makes the mTLS connection (one copy, #927).

export const DAY_MS = 86_400_000;
/** After a renewal fails for a reason that may pass (the server is down), wait this long before asking again. */
export const RENEW_RETRY_MS = 60_000;

const CLIENT_REJECTED = /^ERR_SSL_.*(ALERT|CERTIFICATE_REQUIRED)/;
const OTHER_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

/** A short name for what went wrong upstream, for the `X-Podium-Helper-Error` header. */
export function classifyError(err) {
  const code = err?.code ?? '';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'ALTNAME';
  if (CLIENT_REJECTED.test(code)) return 'CLIENT_CERT_REJECTED';
  if (/^[A-Z0-9_]+$/.test(code) && (code.startsWith('CERT_') || code.includes('SELF_SIGNED') || code.startsWith('UNABLE_TO_') || OTHER_CODES.has(code))) return code;
  return 'UPSTREAM_ERROR';
}

/** How long to wait after a 429, from its Retry-After header in seconds: never less than the usual retry, never more than a day. */
export function retryDelayMs(header, usual = RENEW_RETRY_MS) {
  const secs = Number(Array.isArray(header) ? header[0] : header);
  return Number.isFinite(secs) && secs > 0 ? Math.min(Math.max(secs * 1000, usual), DAY_MS) : usual;
}
