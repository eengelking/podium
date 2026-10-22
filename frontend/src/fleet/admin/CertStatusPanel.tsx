// Admin > Server > Certificates, the Status section (#586): the alert band, the CA and serving rows, the CA fingerprint and
// the names dialog. The markup is the accepted mockup's (mockup/podium-tls-certificates.html).
import { useState, type ReactNode } from "react";
import { IconCertCross, IconCheck, IconClock, IconCopy, IconWarn } from "../components/Icons";
import { useCopy } from "../components/SessionId";
import { CertBadge } from "./CertIcons";
import { NamesModal } from "./NamesModal";
import { dateOf, leftText, namesList, stageOf, yearsOf, type CertsView } from "./certFormat";
import { dayWord, daysUntil, plural } from "../tlsStatus";
import { Panel, Section } from "./Page";

const DAY = 86_400_000;

interface Band {
  role?: "status";
  cls: string;
  icon: ReactNode;
  title: string;
  detail: string;
}

/** The alert at the top of the panel: blue, orange or red by the stage of whichever certificate expires first. */
function bandOf(v: CertsView, now: number): Band | null {
  const ca = v.ca ? Date.parse(v.ca.notAfter) : Number.POSITIVE_INFINITY;
  const sv = Date.parse(v.serving.notAfter);
  const caFirst = ca < sv;
  const cert = caFirst && v.ca ? v.ca : v.serving;
  const stage = stageOf(cert.notAfter, now);
  if (v.rotation && stage === "ok") {
    const { onOldCa } = v.rotation.reporters;
    return { role: "status", cls: "deleg", icon: <IconClock />, title: "Certificate authority rotation is in progress.", detail: `${plural(onOldCa, "reporter")} still ${onOldCa === 1 ? "uses" : "use"} the old CA. Podium accepts it, and presents a chain the old CA verifies, until ${dateOf(v.rotation.cross.notAfter)} or until you retire it. A reporter that does not connect before then, and before its own ${v.reporter.graceDays}-day grace ends, is refused, and its person needs a reissued reporter config. Retire it when none are left.` };
  }
  if (stage === "ok") return null;
  const what = caFirst ? "The certificate authority" : "The serving certificate";
  const days = daysUntil(cert.notAfter, now);
  if (stage === "expired") {
    return {
      cls: "crit hot",
      icon: <IconCertCross />,
      title: `${what} expired on ${dateOf(cert.notAfter)}.`,
      detail: caFirst ? "Reporters can no longer verify this server, and browsers show a warning. Rotate the CA, then give each person a new reporter config." : "Reporters and browsers are refused until it is renewed.",
    };
  }
  const detail = caFirst ? "The CA is rotated by hand. Reporters stop trusting this server when it expires." : v.lastFailure ? "Podium renews it automatically, but the last renewal did not work." : "Podium renews it automatically.";
  return { cls: stage === "critical" ? "crit hot" : stage === "serious" ? "stale" : "deleg", icon: stage === "soon" ? <IconClock /> : <IconWarn />, title: `${what} expires ${dayWord(days)}.`, detail };
}

function failureText(f: NonNullable<CertsView["lastFailure"]>): string {
  const manual = f.trigger === "manual";
  return `The last ${manual ? "" : "automatic "}renewal failed on ${dateOf(f.at)}: ${f.reason}. ${manual ? "" : "Podium tries again every day. "}Fix the cause, then choose Renew now.`;
}

const RECOVERY = ["Choose Rotate CA… below.", "Reissue each person's reporter config on Admin > People (Reissue config).", "Each person saves the new reporter config in ~/.podium/ and starts a new Claude Code session."];

function Fingerprint({ value }: { value: string }) {
  const { state, copy } = useCopy(value);
  return (
    <button type="button" className="sid" aria-label="Copy the CA fingerprint" onClick={copy}>
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : `SHA-256 ${value}`}</span>
      {state === "copied" ? <IconCheck /> : <IconCopy />}
    </button>
  );
}

export function CertStatusPanel({ view, now, base, onRetire }: { view: CertsView; now: number; base: string; onRetire: () => Promise<void> }) {
  const [names, setNames] = useState(false);
  const [asking, setAsking] = useState(false);
  const rot = view.rotation ?? null;
  const { ca, serving } = view;
  const band = bandOf(view, now);
  const caExpired = !!ca && stageOf(ca.notAfter, now) === "expired";
  const list = namesList(view.certificateNames);
  const first = list[0]?.name ?? "";
  const renewOn = new Date(Date.parse(serving.notAfter) - view.settings.renewBeforeDays * DAY);
  return (
    <Section id="c-s" title="Status" help="The header shows a pill when the CA or the serving certificate is close to expiring, or a renewal has failed.">
      <Panel>
        {band && (
          <div className={`band ${band.cls}`} role={band.role ?? "alert"}>
            <span className="bi">{band.icon}</span>
            <span className="bt">
              <span className="bl">{band.title}</span>
              <span className="bd">{band.detail}</span>
            </span>
          </div>
        )}
        <div className="tw2">
          <table className="ptab" aria-label="Certificate status">
            <thead>
              <tr>
                <th scope="col">Certificate</th>
                <th scope="col">Expires</th>
                <th scope="col">Renewal</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {ca && (
                <tr>
                  <td className="who">
                    Certificate authority
                    <span className="hint">Podium CA, valid {plural(yearsOf(ca), "year")}</span>
                  </td>
                  <td className="nw">
                    <span className="mono">{dateOf(ca.notAfter)}</span>
                    <span className="hint">{leftText(ca.notAfter, now)}</span>
                  </td>
                  <td>By hand</td>
                  <td>
                    <CertBadge notAfter={ca.notAfter} now={now} />
                  </td>
                </tr>
              )}
              {rot && (
                <tr>
                  <td className="who">
                    Previous certificate authority
                    <span className="hint">Retiring, chain verified by it until {dateOf(rot.cross.notAfter)}</span>
                  </td>
                  <td className="nw">
                    <span className="mono">{dateOf(rot.previousCa.notAfter)}</span>
                    <span className="hint">kept for the overlap</span>
                  </td>
                  <td>
                    <button type="button" className="btn sm" aria-expanded={asking} onClick={() => setAsking(true)}>
                      Retire old CA…
                    </button>
                  </td>
                  <td>
                    {rot.reporters.onOldCa > 0 ? (
                      <span className="badge soon">
                        <IconClock />
                        {rot.reporters.onOldCa} of {rot.reporters.total} reporters still use it
                      </span>
                    ) : (
                      <span className="badge ok">
                        <span className="dot running" aria-hidden="true" />
                        no reporter uses it
                      </span>
                    )}
                  </td>
                </tr>
              )}
              <tr>
                <td className="who">
                  Serving certificate
                  <span className="hint">
                    {list.length > 1 ? (
                      <button type="button" className="klink" aria-haspopup="dialog" onClick={() => setNames(true)}>
                        <bdi>{first}</bdi> and {list.length - 1} more
                      </button>
                    ) : (
                      <bdi>{first}</bdi>
                    )}
                  </span>
                </td>
                <td className="nw">
                  <span className="mono">{dateOf(serving.notAfter)}</span>
                  <span className="hint">{leftText(serving.notAfter, now)}</span>
                </td>
                <td>
                  {caExpired ? (
                    "After the CA is rotated"
                  ) : view.lastFailure ? (
                    <span className="badge bad">
                      <IconWarn />
                      last renewal failed
                    </span>
                  ) : renewOn.getTime() > now ? (
                    `Renews itself ${dateOf(renewOn.toISOString())}`
                  ) : (
                    "Renews at the next check"
                  )}
                </td>
                <td>{caExpired ? <CertBadge notAfter={serving.notAfter} now={now} stage="expired" text="not trusted: the CA expired" /> : <CertBadge notAfter={serving.notAfter} now={now} />}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {rot && asking && (
          <div className="callout" role="alert" onKeyDown={(e) => e.key === "Escape" && setAsking(false)}>
            <IconWarn className="wicon" />
            <h3>Retire the old CA?</h3>
            <p>
              {rot.reporters.onOldCa > 0
                ? `The ${plural(rot.reporters.onOldCa, "reporter")} still on the old CA ${rot.reporters.onOldCa === 1 ? "is" : "are"} refused at once, and open connections are closed. Their people need a new reporter config from Admin > People. The ${rot.reporters.total - rot.reporters.onOldCa} that already renewed ${rot.reporters.total - rot.reporters.onOldCa === 1 ? "is" : "are"} not affected.`
                : "No reporter still uses the old CA. Open connections that came in on it are closed."}
            </p>
            <p className="formacts">
              <button
                type="button"
                className="btn dng"
                autoFocus
                onClick={() => {
                  setAsking(false);
                  void onRetire();
                }}
              >
                Retire old CA
              </button>
              <button type="button" className="btn" onClick={() => setAsking(false)}>
                Cancel
              </button>
            </p>
          </div>
        )}
        {view.lastFailure && (
          <div className="err" role="alert">
            {failureText(view.lastFailure)}
          </div>
        )}
        {caExpired && (
          <div className="note-line">
            <b>To restore access</b>
            <ol>
              {RECOVERY.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ol>
          </div>
        )}
        {ca && (
          <div className="note-line">
            <b>CA fingerprint</b> A browser trusts the CA only when a person installs it. Compare this with the fingerprint the browser shows before trusting it. The CA has no name constraints, so download it only for a browser you choose to trust it in: that browser then trusts anything the CA key signs, for every site.
            <span className="row2">
              <Fingerprint value={ca.fingerprintSha256} />
              <a className="btn sm" href={`${base}/certificates/ca.pem`} download="podium-ca.pem">
                Download CA (ca.pem)
              </a>
            </span>
          </div>
        )}
        <div className="note-line">
          Keys and certificates are stored in <span className="mono">/data/tls</span> (keys mode 0600). Keep that folder on a volume or host folder that survives a rebuild: without the CA key, every reporter config must be reissued.
        </div>
        {names && <NamesModal view={view} onClose={() => setNames(false)} />}
      </Panel>
    </Section>
  );
}
