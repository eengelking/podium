// What is wrong with the reporter's secure connection, said so a person can act on it (#584, #650, #948). The words are shared
// by every reporter: the same error code reads the same in the Claude status line and in OpenCode. No `node:` import.

/** What is wrong, said so a person can act on it: a short word for the status line and a sentence for `/podium`. */
export interface Problem {
  code: string;
  status: string;
  text: string;
}

/** Clocks closer than this are not the reason a certificate looks expired or not yet valid. */
export const CLOCK_SKEW_MS = 5 * 60_000;

/** The two clocks a certificate date is judged by: this machine's now, and the server's when a reply has told us (epoch ms). */
export interface ClockView {
  now: number;
  serverNow?: number;
}

const stamp = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * A server certificate that looks expired or not yet valid says the clock may be wrong when the server's time is unknown
 * (the handshake failed before any reply) or differs from this machine's by more than CLOCK_SKEW_MS (#650). It never says
 * the clock is wrong for certain: the certificate could be expired. Null when the clock is not in question.
 */
function clockProblem(code: string, clock: ClockView | undefined): Problem | null {
  if (!clock || (code !== 'CERT_HAS_EXPIRED' && code !== 'CERT_NOT_YET_VALID')) return null;
  const look = code === 'CERT_HAS_EXPIRED' ? 'expired' : 'not yet valid';
  if (clock.serverNow === undefined) {
    return { code, status: 'check the clock', text: `The server's certificate looks ${look} from here. This machine's clock says it is ${stamp(clock.now)}; if that is not right, a wrong clock is the likely cause. Check the system date and time. If it is right, tell whoever runs the Podium server.` };
  }
  if (Math.abs(clock.serverNow - clock.now) <= CLOCK_SKEW_MS) return null;
  return { code, status: 'check the clock', text: `The server's certificate looks ${look} from here. This machine's clock says it is ${stamp(clock.now)}, and the server's says ${stamp(clock.serverNow)}. Clocks that far apart can make a good certificate look wrong. Check the system date and time. If this machine's is right, the server's clock may be the wrong one: tell whoever runs the Podium server.` };
}

/** What a helper or client error code means to the person. Null for a network failure, which is an outage the reporter retries as today. */
export function problemFor(code: string, host: string, clock?: ClockView, expiredOn?: string): Problem | null {
  const skewed = clockProblem(code, clock);
  if (skewed) return skewed;
  switch (code) {
    case 'CLIENT_CERT_REJECTED':
      return { code, status: 'certificate refused', text: 'The server did not accept your certificate: it was revoked, has expired, or the server was reset. Ask an Admin to reissue your reporter config.' };
    case 'CERT_EXPIRED':
      return { code, status: 'certificate expired', text: `Your Podium certificate expired${expiredOn ? ` on ${expiredOn}` : ''}. Ask an Admin to generate a new reporter config.` };
    case 'CERT_RENEWAL_REFUSED':
      return { code, status: 'certificate refused', text: 'The server would not renew your certificate: it was revoked, or is not one this server issued. Ask an Admin to reissue your reporter config.' };
    case 'CLOSED_AFTER_HANDSHAKE':
      return { code, status: 'server closed connection', text: 'The server closed the connection right after the handshake. Either it restarted, or it did not accept your certificate (revoked or expired). If this goes on, ask an Admin to reissue your reporter config.' };
    case 'CERT_HAS_EXPIRED':
      return { code, status: 'server certificate expired', text: "The server's own certificate has expired. Tell whoever runs the Podium server." };
    case 'ALTNAME':
      return { code, status: 'wrong server name', text: `The server's certificate is not for ${host}. The address in the reporter config file does not match the server.` };
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return { code, status: 'server not trusted', text: 'The server’s certificate is not signed by the CA in your reporter config file. Ask an Admin for a new file.' };
    default:
      return code.startsWith('CERT_') ? { code, status: 'server certificate refused', text: `The server's certificate was refused (${code}).` } : null;
  }
}

const STATUS_REASON_MAX = 60;

/** `config unreadable`, with the reason after it (cut to fit a status line) so the status says what is wrong with the file (#672). */
function configStatus(reason: string | undefined): string {
  const short = reason && reason.length > STATUS_REASON_MAX ? `${reason.slice(0, STATUS_REASON_MAX - 1)}…` : reason;
  return short ? `config unreadable: ${short}` : 'config unreadable';
}

/**
 * What a startup failure that is about the config file means to the person: the code the TLS client or the helper gave, the reason it
 * gave (if any), and the file's path. Null for any other code, which each reporter words for its own connection process.
 */
export function configProblemFor(code: string, why: string | undefined, path: string): Problem | null {
  if (code === 'CONFIG_PERMISSIONS') return { code, status: 'config too open', text: `The reporter config file ${path} can be read by other people, and it holds your private key. Run: chmod 600 ${path}` };
  if (code === 'CONFIG_INVALID' || code === 'CONFIG_MISSING') return { code, status: configStatus(why), text: `The reporter config file ${path} cannot be used: ${why ?? code}.` };
  return null;
}
