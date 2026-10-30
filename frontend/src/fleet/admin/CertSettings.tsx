// Admin > Server > Certificates, Renewal and lifetimes (#586): number rows that save when the field is left and show a
// rejected value in place, and the header countdown switch. A change is written to the Admin log by the server.
import { useEffect, useState } from "react";
import { Panel, Section, SwitchRow } from "./Page";
import type { CertsView } from "./certFormat";

/** Saves one setting by its flat key; resolves to the server's reason when it refuses, or null. */
export type SaveSetting = (key: string, value: number | boolean) => Promise<string | null>;

/** A whole number of days, saved when the box loses focus. A value the server refuses stays in the box with its reason under the row. */
function DaysRow(props: { id: string; name: string; hint: string; value: number; min: number; max: number; settingKey: string; save: SaveSetting }) {
  const { id, value } = props;
  const [text, setText] = useState(String(value));
  const [err, setErr] = useState("");
  useEffect(() => setText(String(value)), [value]);
  const commit = async () => {
    const n = Number(text);
    if (text.trim() === "" || !Number.isInteger(n)) return setErr(`Enter a whole number of days from ${props.min} to ${props.max}.`);
    if (n === value) return setErr("");
    setErr((await props.save(props.settingKey, n)) ?? "");
  };
  return (
    <>
      <div className="srow">
        <div className="setname">
          <b>
            <label htmlFor={id}>{props.name}</label>
          </b>
          <p className="hint ink2">{props.hint}</p>
        </div>
        <span className="row2">
          <input
            className="field mono daysbox"
            id={id}
            type="number"
            min={props.min}
            max={props.max}
            step={1}
            value={text}
            aria-invalid={err ? true : undefined}
            aria-describedby={err ? `${id}-e` : undefined}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => void commit()}
          />
          <span className="hint">days</span>
        </span>
      </div>
      {err && (
        <div className="err" id={`${id}-e`} role="alert">
          {err}
        </div>
      )}
    </>
  );
}

export function CertSettings({ view, save }: { view: CertsView; save: SaveSetting }) {
  const { settings, reporter } = view;
  const [switchErr, setSwitchErr] = useState("");
  return (
    <Section
      id="c-r"
      title="Renewal and lifetimes"
      help="The serving certificate renews itself and keeps the one it replaced as a backup. Reporters renew their own certificates. A change saves when you leave the field or flip the switch, and is written to the Admin log."
    >
      <Panel>
        <DaysRow id="n-sv" name="Serving certificate lifetime" hint="Default 365 days. From 30 to 825." value={settings.lifetimeDays} min={30} max={825} settingKey="tls.serving.lifetimeDays" save={save} />
        <DaysRow id="n-rn" name="Renew when this many days remain" hint="Also the day the header pill would first appear if a renewal does not happen. From 7 to 90." value={settings.renewBeforeDays} min={7} max={90} settingKey="tls.serving.renewBeforeDays" save={save} />
        <DaysRow id="n-rp" name="Reporter certificate lifetime" hint="Default 90 days. A reporter renews its own certificate when 30 days remain, or half its lifetime when that is shorter. One that expires cannot connect, and an Admin generates a new config for its person. From 30 to 365." value={reporter.lifetimeDays} min={30} max={365} settingKey="tls.reporter.lifetimeDays" save={save} />
        <SwitchRow
          id="sw-hdr"
          name="Show the expiry countdown in the header"
          description="Turn this off if you rely on automatic renewal. A failed renewal and an expired certificate are always shown."
          on={settings.headerCountdown}
          onFlip={() => void save("tls.header.countdown", !settings.headerCountdown).then((e) => setSwitchErr(e ?? ""))}
        />
        {switchErr && (
          <div className="err" id="sw-hdr-e" role="alert">
            {switchErr}
          </div>
        )}
      </Panel>
    </Section>
  );
}
