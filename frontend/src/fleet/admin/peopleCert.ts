// The Reporter certificate cell on Admin > People (#587, T9): the badge a person's certificate gets and what its note says.
import type { PersonRow } from "./adminApi";
import { dateOf, leftText, stageOf, type CertStage } from "./certFormat";
import { plural } from "../tlsStatus";

const DAY_MS = 86_400_000;

export interface CertCell {
  /** Shape, word and color come from the stage; `off` is the grey of a credential that is not in use. */
  stage: CertStage | "off";
  text: string;
  /** The note a Tip shows: the date and what happens next. */
  note: string;
  /** Whether the certificate still counts: it has not been revoked and has not lapsed past the grace. */
  live: boolean;
  /** Whether the person has a certificate at all that can be downloaded: one that is not revoked. */
  downloadable: boolean;
}

/** The certificate cell for a person, or null when TLS is off and the column has nothing to say. */
export function certCell(p: PersonRow, tls: boolean, graceDays: number, now: number): CertCell | null {
  if (!tls) return null;
  const c = p.certificate;
  if (!c) return { stage: "off", text: "none", note: "No certificate yet. Reissue config makes one.", live: false, downloadable: false };
  if (c.revoked) return { stage: "off", text: "revoked", note: "Revoked. The reporter is refused.", live: false, downloadable: false };
  const date = dateOf(c.notAfter);
  if (Date.parse(c.notAfter) < now) {
    const graceLeft = Math.ceil((Date.parse(c.notAfter) + graceDays * DAY_MS - now) / DAY_MS);
    if (graceLeft > 0) return { stage: "serious", text: "expired, in grace", note: `Expired ${date}. The reporter can still renew it for ${plural(graceLeft, "more day")}.`, live: true, downloadable: true };
    return { stage: "expired", text: "expired", note: `Expired ${date}, past the ${graceDays}-day grace. Reissue the config.`, live: false, downloadable: true };
  }
  if (stageOf(c.notAfter, now) === "ok") return { stage: "ok", text: "valid", note: `Expires ${date}, ${leftText(c.notAfter, now)}.`, live: true, downloadable: true };
  return { stage: "soon", text: "renewal due", note: `Expires ${date}, ${leftText(c.notAfter, now)}. The reporter renews it itself the next time it connects.`, live: true, downloadable: true };
}
