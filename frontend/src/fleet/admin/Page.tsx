// The pieces every Admin page is built from (#143): a header, then sections, each a title and help line above a panel.
import type { ReactNode } from "react";
import { RailFoot } from "../components/Rail";

/** `actions` sit at the right of the header, such as a report's Export buttons (#484). */
export function PageHeader({ title, lead, actions }: { title: string; lead: string; actions?: ReactNode }) {
  return (
    <div className="page-h">
      <div>
        <h1>{title}</h1>
        <p className="lead">{lead}</p>
      </div>
      {actions}
    </div>
  );
}

/** A labelled group of buttons where exactly one is pressed (the toolbar's "Group by", "Show as", "By"). */
export function Choice<T extends string | number>(props: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="f">
      <span className="lab" aria-hidden="true">
        {props.label}
      </span>
      <span className="seg" role="group" aria-label={props.label}>
        {props.options.map(([k, name]) => (
          <button type="button" key={k} aria-pressed={props.value === k} onClick={() => props.onChange(k)}>
            {name}
          </button>
        ))}
      </span>
    </div>
  );
}

/** `id` names the heading so the section is a labelled region. */
export function Section({ id, title, help, children }: { id: string; title: string; help?: ReactNode; children: ReactNode }) {
  return (
    <section className="asec" aria-labelledby={id}>
      <div className="asec-h">
        <div>
          <h2 id={id}>{title}</h2>
          {help && <p className="hint">{help}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

export function Panel({ children }: { children: ReactNode }) {
  return <div className="panel">{children}</div>;
}

/**
 * One on/off setting: its name and what it does on the left, the switch and its state on the right. The switch is named by
 * the setting's name plus its state ("Terminal On"). `on` is undefined while the setting is loading.
 */
export function SwitchRow(props: { id: string; name: string; tag?: string; description: ReactNode; on: boolean | undefined; onFlip: () => void }) {
  const { id, on } = props;
  return (
    <div className="srow">
      <div className="setname">
        <b id={`${id}-n`}>{props.name}</b>
        {props.tag && <span className="fid">{props.tag}</span>}
        <p className="hint ink2">{props.description}</p>
      </div>
      <div className="sw">
        <button type="button" role="switch" aria-checked={on ?? false} aria-labelledby={`${id}-n ${id}-s`} disabled={on === undefined} onClick={props.onFlip} />
        <span id={`${id}-s`}>{on === undefined ? "Loading…" : on ? "On" : "Off"}</span>
      </div>
    </div>
  );
}

/** The same footer as the fleet page's rail: the links, the Dev row, the version and the copyright. */
export function AdminFoot({ version, build, className = "" }: { version: string | null; build: string | null; className?: string }) {
  return <RailFoot version={version} build={build} className={className} />;
}
