import { useEffect, useRef, useState, type FormEvent } from "react";
import { AdminError, query, type AdminApi, type GroupChoice, type Paged, type PersonRow } from "./adminApi";
import { Modal } from "../components/Modal";
import { Pager } from "./Pager";
import { Panel, Section } from "./Page";
import { failText, useList } from "./useList";

export interface Created {
  name: string;
  token: string;
}

export function when(t: number | null): string {
  if (t === null) return "never";
  const d = new Date(t);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

type Pending = { id: number; kind: "rotate" | "revoke" } | null;

export function PeopleTab(props: {
  api: AdminApi;
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
  const [rowErr, setRowErr] = useState("");
  const [sel, setSel] = useState<number[]>([]);
  // The people the delete dialog asks about, and why the last attempt was refused (#243).
  const [doomed, setDoomed] = useState<PersonRow[] | null>(null);
  const [delErr, setDelErr] = useState("");
  const opener = useRef<Element | null>(null);
  const list = useList<Paged<PersonRow> & { groups: GroupChoice[] }>(api, `/people${query({ page, pageSize, q })}`, props.onLocked);
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
      const out = await api<{ person: PersonRow; token: string }>("POST", "/people", { name: n });
      setName("");
      props.onCreated({ name: out.person.name, token: out.token });
      list.reload();
    }, setAddErr);
  };

  const confirm = (p: PersonRow, kind: "rotate" | "revoke") => {
    setRowErr("");
    void guard(async () => {
      if (kind === "rotate") {
        const out = await api<{ person: PersonRow; token: string }>("POST", `/people/${p.id}/rotate`);
        props.onCreated({ name: out.person.name, token: out.token });
      } else {
        await api("POST", `/people/${p.id}/revoke`);
      }
      setPending(null);
      list.reload();
    }, setRowErr);
  };

  const setGroup = (p: PersonRow, value: string) => {
    setRowErr("");
    void guard(async () => {
      await api("PUT", `/people/${p.id}/group`, { groupId: value === "" ? null : Number(value) });
      list.reload();
    }, setRowErr);
  };

  const rows = list.data?.rows ?? [];
  const groups = list.data?.groups ?? [];
  const adminIds = new Set(groups.filter((g) => g.builtIn).map((g) => g.id));
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
      <Section id="admin-create-h" title="Create user" help="Adds the person and makes their token. The token is shown once, right after you create it.">
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
      <Section id="admin-people-h" title="Reporting people" help="Revoking a token takes effect on the next report. People in the Administrators group can also open Admin with their token; moving one out of it, or revoking their token, locks their open Admin session.">
        <Panel>
          <div className="tool">
            <div className="f grow inline">
              <label htmlFor="admin-search">Search people</label>
              <input className="field" id="admin-search" type="search" placeholder="Name, group or machine" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
          {sel.length > 0 && (
            <div className="selbar" role="group" aria-label="Selected people">
              <span className="count">{sel.length} selected</span>
              <span className="grow" />
              <button type="button" className="btn sm dng" onClick={() => askDelete(rows.filter((r) => sel.includes(r.id)))}>
                Delete {sel.length}…
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
                      <th>Group</th>
                      <th>Machines seen</th>
                      <th>Token</th>
                      <th>Created</th>
                      <th>Last report</th>
                      <th>Status</th>
                      <th>
                        <span className="vh">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => {
                      const revoked = p.revokedAt !== null;
                      const isAdmin = adminIds.has(p.groupId ?? -1) && !revoked;
                      const pend = pending && pending.id === p.id ? pending : null;
                      return (
                        <tr key={p.id} className={`${revoked ? "revoked" : ""}${sel.includes(p.id) ? " sel" : ""}`.trim()}>
                          <td className="chk">
                            <input type="checkbox" aria-label={`Select ${p.name}`} checked={sel.includes(p.id)} onChange={(e) => setSel((cur) => (e.target.checked ? [...cur, p.id] : cur.filter((i) => i !== p.id)))} />
                          </td>
                          <td>
                            <span className={isAdmin ? "who isadmin" : "who"} title={isAdmin ? "Administrator: can open Admin with their own token" : undefined}>
                              {p.name}
                            </span>
                            {isAdmin && <span className="vh"> (administrator)</span>}
                          </td>
                          <td>
                            <label className="vh" htmlFor={`admin-grp-${p.id}`}>
                              Group for {p.name}
                            </label>
                            <select className="field sm" id={`admin-grp-${p.id}`} value={p.groupId ?? ""} disabled={revoked} onChange={(e) => setGroup(p, e.target.value)}>
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
                            <span className="tail">{p.credential}</span>
                          </td>
                          <td>{when(p.createdAt)}</td>
                          <td>{when(p.lastReportAt)}</td>
                          <td>
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
                          </td>
                          <td>
                            {pend ? (
                              <div className="confirm">
                                <span>{pend.kind === "rotate" ? "Rotate? Their reporter stops until it has the new token." : (adminIds.has(p.groupId ?? -1) ? "Revoke? Their reporter is refused at once and their open Admin session locks." : "Revoke? Their reporter is refused at once.")}</span>
                                <button type="button" className={`btn sm ${pend.kind === "revoke" ? "dng" : ""}`} onClick={() => confirm(p, pend.kind)}>
                                  {pend.kind === "rotate" ? "Rotate token" : "Revoke token"}
                                </button>
                                <button type="button" className="btn sm" onClick={() => setPending(null)}>
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <div className="acts">
                                <button type="button" className="btn sm" onClick={() => setPending({ id: p.id, kind: "rotate" })}>
                                  {revoked ? "Issue new token" : "Rotate"}
                                </button>
                                {!revoked && (
                                  <button type="button" className="btn sm dng" onClick={() => setPending({ id: p.id, kind: "revoke" })}>
                                    Revoke
                                  </button>
                                )}
                                <button type="button" className="btn sm dng" onClick={() => askDelete([p])}>
                                  Delete
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
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
