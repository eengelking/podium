// The Reporter certificate cell on Admin > People (#587, T9): the badge a person's certificate gets and what its note says.
import type { PersonRow } from "./adminApi";
import { dateOf, leftText, renewWithinDays, stageOf, type CertStage } from "./certFormat";

export interface CertCell {
  /** Shape, word and color come from the stage; `off` is the grey of a credential that is not in use. */
  stage: CertStage | "off";
  text: string;
  /** The note a Tip shows: the date and what happens next. */
  note: string;
  /** Whether the certificate still counts: it has not been revoked and has not expired. */
  live: boolean;
  /** Whether the person has a certificate at all that can be downloaded: one that is not revoked. */
  downloadable: boolean;
}

/** The certificate cell for a person, or null when TLS is off and the column has nothing to say. */
export function certCell(p: PersonRow, tls: boolean, now: number): CertCell | null {
  if (!tls) return null;
  const c = p.certificate;
  if (!c) return { stage: "off", text: "none", note: "No certificate yet. Reissue config makes one.", live: false, downloadable: false };
  if (c.revoked) return { stage: "off", text: "revoked", note: "Revoked. The reporter is refused.", live: false, downloadable: false };
  const date = dateOf(c.notAfter);
  // An expired certificate is not renewed (#665): the reporter cannot reach the reporter port with it, so an Admin reissues the config.
  const stage = stageOf(c.notAfter, now, renewWithinDays(c.notBefore, c.notAfter));
  if (stage === "expired") return { stage, text: "expired", note: `Expired ${date}. The reporter is refused and cannot renew. Reissue the config.`, live: false, downloadable: true };
  if (stage === "ok") return { stage: "ok", text: "valid", note: `Expires ${date}, ${leftText(c.notAfter, now)}.`, live: true, downloadable: true };
  // Ten days or fewer and still not renewed: the reporter has not connected in weeks, so the Admin should reissue in time.
  if (stage === "serious" || stage === "critical") return { stage, text: "lapses soon", note: `Expires ${date}, ${leftText(c.notAfter, now)}, and the reporter has not renewed it. Reissue the config before then.`, live: true, downloadable: true };
  return { stage: "soon", text: "renewal due", note: `Expires ${date}, ${leftText(c.notAfter, now)}. The reporter renews it itself the next time it connects.`, live: true, downloadable: true };
}
