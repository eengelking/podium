// The names dialog (#586, mockup decision 18): the names on the running serving certificate, in the app's small modal.
import { IconCheck, IconCopy } from "../components/Icons";
import { Modal } from "../components/Modal";
import { useCopy } from "../components/SessionId";
import { namesList, type CertsView } from "./certFormat";

/** localhost and 127.0.0.1 are on every certificate; the rest come from PODIUM_ALLOWED_HOSTS and the bind address. */
const ALWAYS = new Set(["localhost", "127.0.0.1"]);

function Group({ id, title, env, rows }: { id: string; title: string; env?: string; rows: ReturnType<typeof namesList> }) {
  return (
    <section className="nset" aria-labelledby={id}>
      <h3 id={id}>
        {title} {env && <span className="env">{env}</span>}
      </h3>
      <ul>
        {rows.map((r) => (
          <li key={r.name}>
            <bdi className="nm">{r.name}</bdi>
            <span className="kd">{r.kind}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function NamesModal({ view, onClose }: { view: CertsView; onClose: () => void }) {
  const all = namesList(view.certificateNames);
  const always = all.filter((r) => ALWAYS.has(r.name));
  const added = all.filter((r) => !ALWAYS.has(r.name));
  const { state, copy } = useCopy(all.map((r) => r.name).join("\n"));
  const sorted = (rows: { name: string }[]) => rows.map((r) => r.name).sort((a, b) => a.localeCompare(b)).join(" ");
  const differs = sorted(namesList(view.names)) !== sorted(all);
  return (
    <Modal titleId="names-t" title={`${all.length} names on the serving certificate`} sub="A client that connects by any other name refuses it." className="sm" onClose={onClose}>
      <div className="sbody">
        {always.length > 0 && <Group id="ns-a" title="Always included" rows={always} />}
        {added.length > 0 && <Group id="ns-b" title="Allowed hosts and bind address" env="PODIUM_ALLOWED_HOSTS" rows={added} />}
        <p className="note">To change the list, edit <span className="mono">PODIUM_ALLOWED_HOSTS</span> or the bind address, then choose Renew now. Podium issues a certificate with the new names.</p>
        {differs && <p className="note">The next renewal will use a different list than this certificate carries: {namesList(view.names).length} names. Choose Renew now to apply it.</p>}
      </div>
      <div className="sfoot">
        <button type="button" className="sid" aria-label="Copy the names" onClick={copy}>
          <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy names"}</span>
          {state === "copied" ? <IconCheck /> : <IconCopy />}
        </button>
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
