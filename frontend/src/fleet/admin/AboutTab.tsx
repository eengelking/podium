// Admin > Server > About (#862, mockup/podium-admin-about.html): what the server and its reporters are running. Read-only. The server
// supplies what it holds (its version, runtime, database and the reporters' versions); the console adds the versions of React and
// TypeScript it was built with. Copy details puts all of it on the clipboard as plain text.
import type { AdminApi } from "./adminApi";
import { fmtBytes } from "./activityFormat";
import { aboutText, CONSOLE_BUILD, RUNTIME_LABEL, rangeText, reporterLabel, startedText, upText, type AboutView } from "./aboutText";
import { IconCheck, IconCopy } from "../components/Icons";
import { useCopy } from "../components/SessionId";
import { PageHeader, Panel, Section } from "./Page";
import { Version } from "./ReportersTab";
import { useList } from "./useList";

/** The page is read once it opens and every half minute after, since reporters come and go. */
export const ABOUT_REFRESH_MS = 30_000;

function Facts({ label, rows }: { label: string; rows: [string, string][] }) {
  return (
    <Panel>
      <div className="tw2" tabIndex={0} aria-label={label} /* NOSONAR S6845: a focusable scroll region, by design */>
        <table className="ptab">
          <thead>
            <tr>
              <th>Item</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td className="mono">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function CopyDetails({ about }: { about: AboutView | null }) {
  const { state, copy } = useCopy(about ? aboutText(about) : "");
  return (
    <button type="button" className="btn" disabled={!about} onClick={copy}>
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy details"}</span>
      {state === "copied" ? <IconCheck /> : <IconCopy />}
    </button>
  );
}

export function AboutTab({ api, onLocked }: { api: AdminApi; onLocked: () => void }) {
  const { data: about, error } = useList<AboutView>(api, "/about", onLocked, ABOUT_REFRESH_MS);
  return (
    <>
      <PageHeader title="About" lead="What software this server and its reporters are running." actions={<CopyDetails about={about} />} />
      {error && (
        <div className="err" role="alert">
          {about === null ? `Could not load this page (${error}). Reload it to try again.` : `Could not refresh this page (${error}). It shows what was last read.`}
        </div>
      )}
      {about === null && !error && <div className="empty">Loading…</div>}
      {about && (
        <>
          <Section id="about-server-h" title="Podium server" help="Read from the running server. Nothing is collected from a machine for this page.">
            <Facts
              label="Podium server"
              rows={[
                ["Version", about.server.version],
                ...(about.server.build ? ([["Build", about.server.build]] as [string, string][]) : []),
                ["Running as", RUNTIME_LABEL[about.server.runtime]],
                ["Started", `${startedText(about.server.startedAt)} · up ${upText(about.serverTime - about.server.startedAt)}`],
                ["System", about.server.system],
              ]}
            />
          </Section>
          <Section id="about-stack-h" title="Built with" help="The runtimes and libraries this server and the console are made of.">
            <Facts
              label="Runtime and libraries"
              rows={[
                ["Node.js", `v${about.stack.node}`],
                ["Express", about.stack.express],
                ["React", CONSOLE_BUILD.react],
                ["TypeScript", CONSOLE_BUILD.typescript],
              ]}
            />
          </Section>
          <Section id="about-db-h" title="Database" help="The storage adapter in use and the database behind it.">
            <Facts
              label="Database"
              rows={[
                ["Adapter", about.database.engine],
                ["Engine version", about.database.version],
                ["Schema version", String(about.database.schemaVersion)],
                ...(about.database.sizeBytes === null ? [] : ([["Size", fmtBytes(about.database.sizeBytes)]] as [string, string][])),
              ]}
            />
          </Section>
          <Section id="about-rep-h" title="Reporters" help="The version each connected machine runs. A flagged version is outside the range this server reads.">
            {about.reporters.length === 0 ? (
              <div className="kb-blank">
                <b>No reporter is connected</b>
                <p className="hint">Install podium-reporter on a machine and its version shows here. Admin &gt; Reporters lists every reporter this server has heard from.</p>
              </div>
            ) : (
              <Panel>
                <div className="tw2" tabIndex={0} aria-label="Reporter versions" /* NOSONAR S6845: a focusable scroll region, by design */>
                  <table className="ptab">
                    <thead>
                      <tr>
                        <th>Reporter</th>
                        <th>Version</th>
                        <th>This server reads</th>
                        <th className="n">Machines</th>
                      </tr>
                    </thead>
                    <tbody>
                      {about.reporters.map((r) => (
                        <tr key={`${r.reporterName}/${r.version}`}>
                          <td>{reporterLabel(r.reporterName)}</td>
                          <td>
                            <Version r={r} />
                          </td>
                          <td className="mono">{rangeText(r.support)}</td>
                          <td className="n mono">{r.machines}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            )}
          </Section>
        </>
      )}
    </>
  );
}
