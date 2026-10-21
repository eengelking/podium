// Admin > Server > Certificates, Reporters over HTTP (#589, T11; mockup/podium-tls-certificates.html, decision 23). One switch,
// a warning line in both states, and a question before it is turned off, since that refuses the reporters still on HTTP.
import { useRef, useState } from "react";
import { IconWarn } from "../components/Icons";
import { plural } from "../tlsStatus";
import { Panel, Section, SwitchRow } from "./Page";
import type { CertsView } from "./certFormat";
import type { SaveSetting } from "./CertSettings";

const KEY = "tls.allowReportersOverHttp";

const ON_WARNING = "Not encrypted. Over HTTP the name, the token and everything the reporter sends are not encrypted in transit. Anyone on the network can read them, and can change them. Use it on a trusted network, or only while people move to reporter configs.";
const OFF_WARNING = "Turning this on makes reporters send their name, their token and everything else without encryption. Anyone on the network can read it, and can change it.";

export function CertHttp({ view, save }: { view: CertsView; save: SaveSetting }) {
  const { allow, overHttp, total } = view.http;
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const toggle = () => root.current?.querySelector<HTMLButtonElement>('[role="switch"]')?.focus();
  const apply = async (value: boolean) => {
    setAsking(false);
    setErr((await save(KEY, value)) ?? "");
    toggle();
  };
  const refused =
    overHttp === 0 ? (
      "No reporter is connected over HTTP now, so none is refused."
    ) : (
      <>
        The {plural(overHttp, "reporter")} connected over HTTP {overHttp === 1 ? "is" : "are"} refused at once, until their person saves a reporter config in <span className="mono">~/.podium/</span> and starts a new Claude Code session.
      </>
    );
  const description = allow
    ? `A reporter uses its name and token, with no certificate. It also keeps a reporter working that has no reporter config yet. ${overHttp} of ${plural(total, "reporter")} ${overHttp === 1 ? "is" : "are"} connected over HTTP now.`
    : "Reporters must use a reporter config over HTTPS. A reporter without one is refused until it has one.";
  return (
    <Section id="c-http" title="Reporters over HTTP" help="A reporter can still connect with its name and token, with no certificate. This is how reporters work today.">
      <Panel>
        <div ref={root}>
          <SwitchRow id="sw-http" name="Allow reporters to connect over HTTP" description={description} on={allow} onFlip={() => (allow ? setAsking(true) : void apply(true))} />
        </div>
        <div className="warnbar" role="note">
          <IconWarn className="wicon" />
          <span className="tx">{allow ? ON_WARNING : OFF_WARNING}</span>
        </div>
        {asking && (
          <div className="callout" role="alert" onKeyDown={(e) => e.key === "Escape" && (setAsking(false), toggle())}>
            <IconWarn className="wicon" />
            <h3>Stop allowing reporters over HTTP?</h3>
            <p>
              {refused} The console on the loopback address keeps working over HTTP, so an Admin can always sign in.
            </p>
            <p className="formacts">
              <button type="button" className="btn dng" autoFocus onClick={() => void apply(false)}>
                Stop allowing HTTP
              </button>
              <button type="button" className="btn" onClick={() => (setAsking(false), toggle())}>
                Cancel
              </button>
            </p>
          </div>
        )}
        {err && (
          <div className="err" role="alert">
            {err}
          </div>
        )}
      </Panel>
    </Section>
  );
}
