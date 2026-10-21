import { IconCertCross, IconClock, IconWarn } from "./Icons";
import { CERTS_HASH, pillOf, useTlsStatus, type PillView } from "../tlsStatus";

const ICON = { clock: IconClock, warn: IconWarn, cross: IconCertCross };

/** The pill for a computed view: a status that is a link to Admin > Server > Certificates, with no X (mockup #573, decision 9). */
export function CertPillView({ view }: { view: PillView }) {
  const Icon = ICON[view.icon];
  return (
    <a className={`pill ${view.tone}`} href={CERTS_HASH} title={view.title}>
      <Icon />
      {view.text}
    </a>
  );
}

/**
 * The header's certificate pill (#586): the CA or the serving certificate, whichever expires first, never a person's
 * certificate. Shows nothing while TLS is off, while the certificates are healthy, and when the Admin has switched the
 * countdown off (a failed renewal and an expired certificate always show).
 */
export function CertPill() {
  const view = pillOf(useTlsStatus());
  return view ? <CertPillView view={view} /> : null;
}
