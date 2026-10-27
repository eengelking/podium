import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { AdminError, query, type AdminApi, type ConfigFile, type PeopleList, type PersonRow } from "./adminApi";
import { Modal } from "../components/Modal";
import { Tip } from "../components/Tip";
import { IconWarn } from "../components/Icons";
import { CertBadge } from "./CertIcons";
import { Pager } from "./Pager";
import { Panel, Section } from "./Page";
import { RowMenu, type MenuGroup } from "./RowMenu";
import type { Created } from "./OnceBox";
import { certCell } from "./peopleCert";
import { failText, useList } from "./useList";

export function when(t: number | null): string {
  if (t === null) return "never";
  const d = new Date(t);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** What a row's menu can ask to confirm (mockup #573, People). */
type Ask = "rotate" | "issue" | "revoke-token" | "revoke-cert" | "revoke-all" | "reissue";
type Pending = { id: number; kind: Ask } | null;
const COLS = 7;

/** The words of each confirmation: its heading, what will happen, and the button. A revoke of the token ends the certificate too (SPEC 7.7). */
function wording(kind: Ask, name: string, tls: boolean, admin: boolean, certRevoked: boolean): { title: string; body: string; button: string; danger: boolean } {
  const locks = admin ? " Their open Admin session locks." : "";
  switch (kind) {
    case "rotate":
      return { title: `Rotate ${name}’s token?`, body: "Their console sign-in stops until they have the new token, which is shown once. Their reporter keeps working.", button: "Rotate token", danger: false };
    case "issue":
      return { title: `Issue ${name}’s token?`, body: `A new token replaces the revoked one and is shown once. They can sign in to the console with it.${tls && certRevoked ? " Their reporter stays refused until you choose Reissue config." : ""}`, button: "Issue new token", danger: false };
    case "revoke-token":
      return { title: `Revoke ${name}’s token?`, body: `They can no longer sign in to the console.${tls ? " Their reporter is refused too, because revoking the token revokes the certificate." : " Their reporter is refused at once."}${locks}`, button: "Revoke token", danger: true };
    case "revoke-cert":
      return { title: `Revoke ${name}’s certificate?`, body: "This stops the reporter that uses the certificate. Their token still works until you revoke it, and they can still sign in to the console. Revoke token or Revoke all cuts them off.", button: "Revoke certificate", danger: true };
    case "revoke-all":
      return { title: `Revoke all for ${name}?`, body: `Their reporter and their console sign-in stop at once. Their open sessions stay on the wall until they end.${locks}`, button: "Revoke all", danger: true };
    case "reissue":
      return { title: `Reissue ${name}’s reporter config?`, body: "Their current certificate stops working, and the new reporter config is shown once.", button: "Reissue config", danger: false };
  }
}

/** The Actions menu of one row: an action that does not apply is disabled, not hidden. */
function menuOf(p: PersonRow, tls: boolean, cert: ReturnType<typeof certCell>): MenuGroup[] {
  const tokenRevoked = p.revokedAt !== null;
  const certLive = Boolean(cert?.live);
  return [
    { heading: "Console token", items: tokenRevoked ? [{ label: "Issue new token", act: "issue" }] : [{ label: "Rotate token", act: "rotate" }, { label: "Revoke token", act: "revoke-token", danger: true }] },
    {
      heading: "Reporter certificate",
      items: [
        { label: "Download certificate", act: "download", disabled: !cert?.downloadable },
        { label: "Reissue config…", act: "reissue", disabled: !tls },
        { label: "Revoke certificate", act: "revoke-cert", danger: true, disabled: !certLive },
      ],
    },
    { heading: "Person", items: [{ label: "Revoke all…", act: "revoke-all", danger: true, disabled: !tls || (tokenRevoked && !certLive) }, { label: "Delete…", act: "delete", danger: true }] },
  ];
}

export function PeopleTab(props: {
  api: AdminApi;
  /** Where the Admin API is mounted: the certificate download is a link, not a call through `api`. */
  base: string;
  page: number;
  pageSize: number;
  q: string;
  onPaging: (p: { page?: number; pageSize?: number; q?: string }) => void;
  onCreated: (c: Created) => void;
  onCount: (n: number) => void;
  onLocked: () => void;
}) {
  const { api, page, pageSize, q, onCount, onPaging } = props;
  const [search, setSearch] = useState(q);
  const [name, setName] = useState("");
  const [addErr, setAddErr] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  // The confirmation row takes focus on its button when it opens or moves to another person: moved in code, not with autoFocus, which Sonar flags (S9379).
  useEffect(() => {
    if (pending) confirmBtn.current?.focus();
  }, [pending]);
  /** Closes the confirmation row without acting and puts focus back on that person's Actions menu, the row above it (#672). */
  const closeConfirm = (from: HTMLElement) => {
    const opener = from.closest("tr")?.previousElementSibling?.querySelector<HTMLElement>("summary");
    setPending(null);
    opener?.focus();
  };
  const [rowErr, setRowErr] = useState("");
  // What the last menu choice did that no row shows, such as a download starting (a status line, not an error).
  const [note, setNote] = useState("");
  const [sel, setSel] = useState<number[]>([]);
  // The people the delete dialog asks about, and why the last attempt was refused (#243).
  const [doomed, setDoomed] = useState<PersonRow[] | null>(null);
  const [delErr, setDelErr] = useState("");
  const opener = useRef<Element | null>(null);
  const list = useList<PeopleList>(api, `/people${query({ page, pageSize, q })}`, props.onLocked);
  // A selection is of the rows on this page: it goes when the page, its size or the search changes.
  useEffect(() => setSel([]), [page, pageSize, q]);
  const total = list.data?.total;
  useEffect(() => {
    if (total !== undefined) onCount(total);
  }, [total, onCount]);
  // The search runs a moment after typing stops, from page one.
  useEffect(() => {
    if (search === q) return;
    const t = setTimeout(() => onPaging({ q: search, page: 1 }), 250);
    return () => clearTimeout(t);
  }, [search, q, onPaging]);

  const guard = async (fn: () => Promise<void>, set: (m: string) => void) => {
    try {
      await fn();
    } catch (e) {
      if (e instanceof AdminError && e.status === 401) props.onLocked();
      else set(failText(e));
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setAddErr("Enter a name.");
    setAddErr("");
    void guard(async () => {
      const out = await api<{ person: PersonRow; token: string; config?: ConfigFile; configError?: string }>("POST", "/people", { name: n });
      setName("");
      props.onCreated({ name: out.person.name, kind: "created", token: out.token, config: out.config, configError: out.configError });
      list.reload();
    }, setAddErr);
  };

  const confirm = (p: PersonRow, kind: Ask) => {
    setRowErr("");
    void guard(async () => {
      const base = `/people/${p.id}`;
      if (kind === "rotate" || kind === "issue") {
        const out = await api<{ person: PersonRow; token: string }>("POST", `${base}/rotate`);
        props.onCreated({ name: out.person.name, kind: "rotated", token: out.token });
      } else if (kind === "reissue") {
        const out = await api<{ config: ConfigFile }>("POST", `${base}/certificate/reissue`);
        props.onCreated({ name: p.name, kind: "reissued", config: out.config });
      } else {
        await api("POST", kind === "revoke-token" ? `${base}/revoke` : kind === "revoke-cert" ? `${base}/certificate/revoke` : `${base}/revoke-all`);
      }
      setPending(null);
      list.reload();
    }, setRowErr);
  };

  /** A row's menu choice: Delete opens the dialog, Download starts the public certificate's download, the rest ask first. */
  const choose = (p: PersonRow, act: string) => {
    setRowErr("");
    setNote("");
    if (act === "delete") return askDelete([p]);
    if (act === "download") {
      const a = document.createElement("a");
      a.href = `${props.base}/people/${p.id}/certificate.pem`;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
      return setNote(`Saving the certificate and the CA of ${p.name}. It has no private key.`);
    }
    setPending({ id: p.id, kind: act as Ask });
  };

  const setGroup = (p: PersonRow, value: string) => {
    setRowErr("");
    void guard(async () => {
      await api("PUT", `/people/${p.id}/group`, { groupId: value === "" ? null : Number(value) });
      list.reload();
    }, setRowErr);
  };

  const rows = list.data?.rows ?? [];
  const tls = list.data?.tls ?? false;
  const now = Date.now();
  const groups = list.data?.groups ?? [];
  const adminIds = new Set(groups.filter((g) => g.builtIn).map((g) => g.id));
  const picked = rows.filter((r) => sel.includes(r.id));
  const pageAllSelected = rows.length > 0 && rows.every((r) => sel.includes(r.id));
  const askDelete = (people: PersonRow[]) => {
    opener.current = document.activeElement;
    setDelErr("");
    setDoomed(people);
  };
  const closeDelete = () => {
    setDoomed(null);
    const el = opener.current;
    opener.current = null;
    if (el instanceof HTMLElement && el.isConnected) el.focus();
  };
  const confirmDelete = () => {
    if (!doomed) return;
    setDelErr("");
    void guard(async () => {
      await api("POST", "/people/delete", { ids: doomed.map((p) => p.id) });
      setDoomed(null);
      setSel([]);
      list.reload();
    }, setDelErr);
  };
  const adminAmong = (people: PersonRow[]) => people.some((p) => p.revokedAt === null && adminIds.has(p.groupId ?? -1));
  return (
    <>
      <Section id="admin-create-h" title="Create user" help="Adds the person and makes their token and, with TLS on, their reporter config. Both are shown once, right after you create them.">
        <Panel>
          <form className="tool alone" onSubmit={add} autoComplete="off">
            <div className="f grow">
              <label htmlFor="admin-new-name">Name</label>
              <input className="field" id="admin-new-name" placeholder="Full name, as it should appear" maxLength={48} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <button type="submit" className="btn pri">
              Create user
            </button>
          </form>
          {addErr && (
            <div className="err" role="alert">
              {addErr}
            </div>
          )}
        </Panel>
      </Section>
      <Section id="admin-people-h" title="Reporting people" help="Revoking a token stops the person’s console sign-in on the next request, and with it their certificate. Revoking a certificate stops the reporter that uses it and leaves the console; the token still works until it is revoked. Revoke token or Revoke all cuts the person off. People in the Administrators group can also open Admin with their token; moving one out of it, or revoking their token, locks their open Admin session.">
        <Panel>
          <div className="tool">
            <div className="f grow inline">
              <label htmlFor="admin-search">Search people</label>
              <input className="field" id="admin-search" type="search" placeholder="Name, group or machine" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <span className="hint" role="status">
              {note}
            </span>
          </div>
          {picked.length > 0 && (
            <div className="selbar" role="group" aria-label="Selected people">
              <span className="count">{picked.length} selected</span>
              <span className="grow" />
              <button type="button" className="btn sm dng" onClick={() => askDelete(picked)}>
                Delete {picked.length}…
              </button>
              <button type="button" className="btn sm" onClick={() => setSel([])}>
                Clear
              </button>
            </div>
          )}
          {rowErr && (
            <div className="err" role="alert">
              {rowErr}
            </div>
          )}
          {list.error && (
            <div className="err" role="alert">
              Could not load people ({list.error}).
            </div>
          )}
          {list.data && rows.length === 0 ? (
            <div className="empty">{q ? `No one matches “${q}”. Check the spelling, or search by group or machine.` : "No one has a token yet. Add the first person above."}</div>
          ) : (
            list.data && (
              <div className="tw2 scroll" tabIndex={0} aria-label="People">
                <table className="ptab">
                  <thead>
                    <tr>
                      <th className="chk">
                        <input
                          type="checkbox"
                          aria-label={`Select all ${rows.length} on this page`}
                          checked={pageAllSelected}
                          onChange={(e) => setSel(e.target.checked ? rows.map((r) => r.id) : [])}
                        />
                      </th>
                      <th>Person</th>
                      <th>Machines seen</th>
                      <th>Reporter certificate</th>
                      <th>Console token</th>
                      <th>Last report</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => {
                      const revoked = p.revokedAt !== null;
                      const isAdmin = adminIds.has(p.groupId ?? -1) && !revoked;
                      const pend = pending && pending.id === p.id ? pending : null;
                      const cert = certCell(p, tls, now);
                      // A person with neither credential in use reads as gone, as a revoked person did.
                      const dead = revoked && (!tls || !cert?.live);
                      const w = pend ? wording(pend.kind, p.name, tls, adminIds.has(p.groupId ?? -1), p.certificate?.revoked === true) : null;
                      return (
                        <Fragment key={p.id}>
                          <tr className={`${dead ? "revoked" : ""}${sel.includes(p.id) ? " sel" : ""}`.trim()}>
                            <td className="chk">
                              <input type="checkbox" aria-label={`Select ${p.name}`} checked={sel.includes(p.id)} onChange={(e) => setSel((cur) => (e.target.checked ? [...cur, p.id] : cur.filter((i) => i !== p.id)))} />
                            </td>
                            <td className="pcell">
                              <span className={isAdmin ? "who isadmin" : "who"} title={isAdmin ? "Administrator: can open Admin with their own token" : undefined}>
                                {p.name}
                              </span>
                              {isAdmin && <span className="vh"> (administrator)</span>}
                              <label className="vh" htmlFor={`admin-grp-${p.id}`}>
                                Group for {p.name}
                              </label>
                              <select className="field sm" id={`admin-grp-${p.id}`} value={p.groupId ?? ""} disabled={dead} onChange={(e) => setGroup(p, e.target.value)}>
                                <option value="">No group</option>
                                {groups.map((g) => (
                                  <option key={g.id} value={g.id}>
                                    {g.name}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <span className="mchips">
                                {p.machines.length ? p.machines.map((m) => <span key={m} className="chip mono">{m}</span>) : <span className="hint">none yet</span>}
                              </span>
                            </td>
                            <td>
                              {cert ? (
                                <Tip text={cert.note}>
                                  {cert.stage === "off" ? (
                                    <span className="badge off">{cert.text}</span>
                                  ) : (
                                    <CertBadge notAfter={p.certificate!.notAfter} now={now} stage={cert.stage} text={cert.text} />
                                  )}
                                </Tip>
                              ) : (
                                <span className="hint">TLS is off</span>
                              )}
                            </td>
                            <td>
                              <Tip text={revoked ? `Revoked. Token ${p.credential}.` : `Token ${p.credential}.`}>
                                {revoked ? (
                                  <span className="badge off">
                                    <span className="dot" aria-hidden="true" />
                                    revoked
                                  </span>
                                ) : (
                                  <span className="badge ok">
                                    <span className="dot running" aria-hidden="true" />
                                    active
                                  </span>
                                )}
                              </Tip>
                            </td>
                            <td className="nw">
                              {when(p.lastReportAt)}
                              <span className="hint">created {when(p.createdAt)}</span>
                            </td>
                            <td>
                              <RowMenu label={`Actions for ${p.name}`} groups={menuOf(p, tls, cert)} onChoose={(act) => choose(p, act)} />
                            </td>
                          </tr>
                          {pend && w && (
                            <tr className="confirmrow">
                              <td colSpan={COLS}>
                                <div className="callout" role="alert" onKeyDown={(e) => e.key === "Escape" && closeConfirm(e.currentTarget)}>
                                  <IconWarn className="wicon" />
                                  <h3>{w.title}</h3>
                                  <p>{w.body}</p>
                                  <p className="formacts">
                                    <button ref={confirmBtn} type="button" className={w.danger ? "btn dng" : "btn"} onClick={() => confirm(p, pend.kind)}>
                                      {w.button}
                                    </button>
                                    <button type="button" className="btn" onClick={(e) => closeConfirm(e.currentTarget)}>
                                      Cancel
                                    </button>
                                  </p>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}
          {list.data && list.data.total > 0 && (
            <Pager id="admin-people" page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(n) => props.onPaging({ page: n })} onSize={(n) => props.onPaging({ pageSize: n, page: 1 })} />
          )}
        </Panel>
      </Section>
      {doomed && (
        <Modal titleId="deletePeopleTitle" title={doomed.length === 1 ? `Delete ${doomed[0]!.name}?` : `Delete ${doomed.length} people?`} onClose={closeDelete} className="sm">
          <div className="sbody">
            <p>{doomed.length === 1 ? "Their reporter is refused at once." : "Their reporters are refused at once."} Their past sessions keep their name.</p>
            {doomed.length > 1 && (
              <ul>
                {doomed.map((p) => (
                  <li key={p.id}>{p.name}</li>
                ))}
              </ul>
            )}
            <p className="hint">
              {adminAmong(doomed) && "Their open Admin session locks. "}Their group membership is removed. {doomed.length === 1 ? "The name" : "The names"} can be used again later.
            </p>
            {delErr && (
              <div className="err" role="alert">
                {delErr}
              </div>
            )}
          </div>
          <div className="sfoot">
            <span className="grow" />
            <button type="button" className="btn" onClick={closeDelete}>
              Cancel
            </button>
            <button type="button" className="btn bad" onClick={confirmDelete}>
              {doomed.length === 1 ? "Delete" : `Delete ${doomed.length} people`}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
