// Which proxy hops the server believes about a client's address and scheme (#305). Podium trusts none unless the owner
// names them in PODIUM_TRUST_PROXY: the setting goes to Express's `trust proxy`, so `req.ip` and `req.secure` follow
// X-Forwarded-For and X-Forwarded-Proto from a trusted hop only. A hop that does not overwrite X-Forwarded-For lets any
// client choose its source, which defeats the lockouts, so `true` (trust every hop) is refused.
import { isIP } from 'node:net';

const NAMED = new Set(['loopback', 'linklocal', 'uniquelocal']);
const OFF = new Set(['', 'false', 'off', '0']);

const bad = (why: string): Error => new Error(`PODIUM_TRUST_PROXY: ${why}`);

const validEntry = (entry: string): boolean => {
  if (NAMED.has(entry)) return true;
  const [addr, prefix, ...extra] = entry.split('/');
  const family = isIP(addr);
  if (family === 0 || extra.length > 0) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
};

/**
 * Reads PODIUM_TRUST_PROXY into the value Express's `trust proxy` takes: `false` when off, a hop count, or a list of
 * addresses, CIDR ranges and the names `loopback`, `linklocal` and `uniquelocal`. Throws on anything else, so a typo
 * stops the server at start instead of silently trusting nothing, or too much.
 */
export function parseTrustProxy(raw: string | undefined): false | number | string[] {
  const value = (raw ?? '').trim().toLowerCase();
  if (OFF.has(value)) return false;
  if (value === 'true') throw bad('"true" trusts every hop, so any client could choose its source address; name the hops: a count, or addresses');
  if (/^\d+$/.test(value)) return Number(value);
  const entries = value.split(',').map((e) => e.trim());
  const wrong = entries.find((e) => !validEntry(e));
  if (wrong !== undefined) throw bad(`"${wrong || raw}" is not a hop count, an address, a range such as 10.0.0.0/8, or loopback, linklocal or uniquelocal`);
  return entries;
}
