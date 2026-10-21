// Admin > Server > Certificates (#586, T8; mockup/podium-tls-certificates.html, accepted on #573). The status of the CA and the
// serving certificate, the renewal settings, Renew now, rotating the CA with an overlap and retiring the old one (#588, T10),
// and the certificates Podium kept. The HTTP switch of the same mockup belongs to a later issue (T11).
import { useState } from "react";
import { IconWarn } from "../components/Icons";
import { AdminError, type AdminApi } from "./adminApi";
import { CertBadge } from "./CertIcons";
import { CertSettings, type SaveSetting } from "./CertSettings";
import { CertStatusPanel } from "./CertStatusPanel";
import { dateOf, stageOf, type CertsView } from "./certFormat";
import { plural } from "../tlsStatus";
import { Panel, Section } from "./Page";
import { failText, useList } from "./useList";

/** What GET /certificates answers while TLS is off. */
const TLS_OFF = "TLS is off";

export function CertificatesTab({ api, base = "/api/admin", onLocked, now = Date.now }: { api: AdminApi; base?: string; onLocked: () => void; now?: () => number }) {
  const list = useList<CertsView>(api, "/certificates", onLocked);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [renewErr, setRenewErr] = useState("");
  const [asking, setAsking] = useState(false);
  const view = list.data;

  const save: SaveSetting = async (key, value) => {
    try {
      await api("PUT", "/certificates", { [key]: value });
      list.reload();
      return null;
    } catch (e) {
      if (e instanceof AdminError && e.status === 401) {
        onLocked();
        return null;
      }
      return failText(e);
    }
  };
  const renew = async () => {
    setBusy(true);
    setMsg("");
    setRenewErr("");
    try {
      await api("POST", "/certificates/renew");
      setMsg("Renewed. The old certificate is kept as a backup.");
    } catch (e) {
      if (e instanceof AdminError && e.status === 401) onLocked();
      else setRenewErr(failText(e));
    } finally {
      setBusy(false);
      list.reload();
    }
  };

  /** One of the two CA actions; the answer is the page's new data, so it reloads either way. */
  const caAction = async (path: string, body: unknown, done: (r: { refused?: number }) => string) => {
    setBusy(true);
    setMsg("");
    setRenewErr("");
    try {
      const r = (await api("POST", path, body)) as { refused?: number };
      setMsg(done(r));
    } catch (e) {
      if (e instanceof AdminError && e.status === 401) onLocked();
      else setRenewErr(failText(e));
    } finally {
      setBusy(false);
      list.reload();
    }
  };
  const rotate = (endOverlap: boolean) => {
    setAsking(false);
    return caAction("/certificates/rotate-ca", { endOverlap }, () =>
      endOverlap ? "Rotated. Every reporter needs a new reporter config from Admin > People, and open connections were closed." : "Rotated. Reporters pick up the new CA when they renew. Retire the old CA when none are left.",
    );
  };
  const retire = () => caAction("/certificates/retire-ca", undefined, (r) => `Retired the old CA. ${r.refused ? `${plural(r.refused, "reporter")} now need${r.refused === 1 ? "s" : ""} a new reporter config from Admin > People.` : "No reporter was using it."}`);

  if (list.error === TLS_OFF) {
    return (
      <Panel>
        <div className="empty">TLS is off. Start Podium with built-in TLS to manage certificates here.</div>
      </Panel>
    );
  }
  if (!view) {
    return list.error ? (
      <div className="errbox" role="alert">
        Could not load the certificates ({list.error}).
      </div>
    ) : (
      <div className="empty">Loading…</div>
    );
  }
  const t = now();
  const servingExpired = stageOf(view.serving.notAfter, t) === "expired";
  const caExpired = !!view.ca && stageOf(view.ca.notAfter, t) === "expired";
  return (
    <>
      <CertStatusPanel view={view} now={t} base={base} onRetire={retire} />
      <CertSettings view={view} save={save} />
      <Section id="c-h" title="Rotate by hand" help="For a change of host name, or if a private key may have been exposed.">
        <Panel>
          <div className="srow">
            <div className="setname">
              <b>Renew the serving certificate now</b>
              <p className="hint ink2">Issues a new one from the same CA. The old one is kept as a backup. Reporters and browsers need nothing.</p>
            </div>
            <button type="button" className={servingExpired && !caExpired ? "btn pri" : "btn"} disabled={busy} onClick={() => void renew()}>
              Renew now
            </button>
          </div>
          <div className="srow">
            <div className="setname">
              <b>Rotate the certificate authority</b>
              <p className="hint ink2">Creates a new CA. Reporters keep working through an overlap while they pick up the new CA when they renew. You retire the old CA when none are left.</p>
            </div>
            <button type="button" className={caExpired ? "btn pri" : "btn dng"} disabled={busy} aria-expanded={asking} onClick={() => setAsking(true)}>
              Rotate CA…
            </button>
          </div>
          {asking && (
            <div className="callout" role="alert" onKeyDown={(e) => e.key === "Escape" && setAsking(false)}>
              <IconWarn className="wicon" />
              <h3>Rotate the certificate authority?</h3>
              <p>
                Podium creates a new CA and serves a certificate that chains to both, so reporters that still hold the old CA keep working for {view.overlapDays ?? 120} days. Each reporter picks up the new CA when it renews. A reporter that has not renewed by then needs its reporter config reissued from Admin &gt; People.
                {view.rotation && " A rotation is already in progress: retire the old CA first, or end the overlap now."}
              </p>
              <p className="formacts">
                <button type="button" className="btn dng" disabled={!!view.rotation} onClick={() => void rotate(false)}>
                  Rotate CA
                </button>
                <button type="button" className="btn dng" onClick={() => void rotate(true)}>
                  Rotate CA and end the overlap now
                </button>
                <button type="button" className="btn" autoFocus onClick={() => setAsking(false)}>
                  Cancel
                </button>
              </p>
              <p className="hint">End the overlap now if the old CA key was exposed. Every reporter then needs a new reporter config, and open connections are closed.</p>
            </div>
          )}
          {renewErr && (
            <div className="err" role="alert">
              {renewErr}
            </div>
          )}
          {msg && (
            <div className="note-line" role="status">
              {msg}
            </div>
          )}
        </Panel>
      </Section>
      <Section id="c-p" title="Previous certificates" help={<>Kept as a backup in <span className="mono">/data/tls/previous</span>. Podium keeps the last 3.</>}>
        <Panel>
          {view.previous.length === 0 ? (
            <div className="empty">No earlier certificate has been replaced yet.</div>
          ) : (
            <div className="tw2">
              <table className="ptab" aria-label="Previous certificates">
                <thead>
                  <tr>
                    <th scope="col">Certificate</th>
                    <th scope="col">Valid</th>
                    <th scope="col">Serial</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {view.previous.map((c) => (
                    <tr key={c.serial}>
                      <td className="who">Serving certificate</td>
                      <td className="mono nw">
                        {dateOf(c.notBefore)} to {dateOf(c.notAfter)}
                      </td>
                      <td className="tail">{c.serial}</td>
                      <td>
                        <span className="badge off">
                          <span className="dot" aria-hidden="true" />
                          kept
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </Section>
    </>
  );
}
