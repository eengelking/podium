import { useLayoutEffect, useRef, useState } from "react";
import { planProgress, sessionCounts } from "../logic";
import type { SessionView } from "../types";
import { backgroundOf, BlowBadge, ModelChip, PlanBar, sessionDot, stateKind } from "./Chips";
import { backgroundStatus } from "../waiting";
import { COPYRIGHT, LICENSE_URL, NOTICES_URL } from "../types";
import { PaneTab } from "./PaneTab";
import { Monogram, YouTag } from "./People";
import { ADMIN, isFlat, type GroupBy, type Unit } from "../people";
import { PageNav } from "./PageNav";
import { pageOf, paginateRail, type RailBlock, type RailPage, type RailSlice } from "../railPages";

/** The people view in the left list: the same grouping as the wall, and a band header that narrows the wall to it. */
export interface RailPeople {
  groupBy: GroupBy;
  units: Unit[];
  /** The band key the wall is narrowed to, if any. */
  picked: string | null;
  onPick: (u: Unit) => void;
  /** The sessions the people filter lets through. */
  visible: ReadonlySet<string>;
}

export interface Split {
  running: number;
  waiting: number;
  stale: number;
}

export function splitText(s: Split): string {
  return `${s.running} running · ${s.waiting} waiting · ${s.stale} stale`;
}

// What the list is measured with when the browser has not laid a row out yet (#242).
const ROW_H = 62;
const BAND_H = 38;
/** The pager's row and the line that points at a selection on another page, reserved whether or not that line shows, so showing it never moves a page break. */
const PAGER_H = 40;
const NOTE_H = 22;

interface Measure {
  room: number;
  rowH: number;
  bandH: number;
}

/** The height the panel leaves for rows, and what a row and a band header take; null while the panel has no height (hidden, or no layout). */
function measure(nav: HTMLElement): Measure | null {
  const height = nav.clientHeight;
  if (!height) return null;
  const used = [".rail-head", ".ritem.all", ".rail-foot"].reduce((n, sel) => n + (nav.querySelector<HTMLElement>(sel)?.offsetHeight ?? 0), 0);
  // The tallest row and header on show, not the first (rows are one height today, so this is a guard): a row with a Remove button or a wrapped line is taller, and a page
  // sized by a short one would overflow. In the stacked layout the rail's height follows its content, and sizing by the
  // tallest keeps the list from ever looking too long for itself there.
  const tallest = (sel: string) => Math.max(0, ...[...nav.querySelectorAll<HTMLElement>(sel)].map((e) => e.offsetHeight));
  const band = tallest(".rgh");
  return {
    room: height - used,
    rowH: tallest(".ritem-slot") || ROW_H,
    // the band's own 1px rule below its last row
    bandH: band ? band + 1 : BAND_H,
  };
}

export function Rail(props: {
  sessions: SessionView[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  split: Split;
  entering: (id: string) => boolean;
  leaving: Record<string, number>;
  liveCount: number;
  onRemove?: (id: string) => void;
  /** The running server's version; null until the first snapshot. */
  version?: string | null;
  collapsed?: boolean;
  onToggle?: () => void;
  people?: RailPeople;
}) {
  const pv = props.people;
  const item = (s: SessionView, showOwner: boolean) => {
    const p = planProgress(s.plan);
    const c = sessionCounts(s);
    const cls = `ritem${props.entering(s.id) ? " enter" : ""}${props.leaving[s.id] ? " leave" : ""}${s.blowouts.level === 2 ? " risk" : ""}`;
    const removable = s.status === "stale" && !!props.onRemove;
    const owner = s.owner ?? "Unassigned";
    const kind = stateKind(s);
    return (
      <div key={s.id} className={`ritem-slot${removable ? " has-remove" : ""}`}>
        <button type="button" className={cls} aria-current={props.selected === s.id} onClick={() => props.onSelect(s.id)} disabled={!!props.leaving[s.id]}>
          <div className="l1">
            <i className={sessionDot(s, kind)} aria-hidden="true" />
            <span className="nm">{s.name}</span>
            <span className="vh">{backgroundOf(s) ? backgroundStatus(s.background!) : kind === "deleg" ? "delegating" : s.status}</span>
            {showOwner && (
              <span title={owner}>
                <Monogram name={owner} kind={s.owner === null ? "unassigned" : s.owner === ADMIN ? "admin" : "person"} size="sm" />
                <span className="vh">, {owner}</span>
              </span>
            )}
            <BlowBadge n={s.blowouts.total} level={s.blowouts.level} />
            <ModelChip family={s.modelFamily} model={s.model} />
          </div>
          <div className="l2">
            {p ? (
              <>
                <PlanBar pct={p.pct} />
                <span className="mono">
                  {p.done}/{p.total}
                </span>
              </>
            ) : (
              <>
                <span style={{ color: "var(--muted)" }}>no plan reported</span>
                <span style={{ flex: 1 }} />
              </>
            )}
            <span className="mono" title="running / total agents">
              {c.running}/{c.all}
            </span>
          </div>
        </button>
        {removable && (
          <button type="button" className="rx" onClick={() => props.onRemove?.(s.id)} disabled={!!props.leaving[s.id]} title="Remove from the fleet now" aria-label={`Remove ${s.name} from the fleet`}>
            &times;
          </button>
        )}
      </div>
    );
  };
  const visible = props.sessions.filter((s) => !pv || pv.visible.has(s.id));
  const banded = !!pv && !isFlat(pv.groupBy);
  // The rows in list order, by band when the people view groups them.
  const bandUnits: Unit[] = [];
  const blocks: RailBlock[] = [];
  if (banded) {
    const unitOf = new Map<string, string>();
    for (const u of pv.units) for (const s of u.sessions) unitOf.set(s.id, u.key);
    for (const u of pv.units) {
      const rows = visible.filter((s) => unitOf.get(s.id) === u.key).map((s) => s.id);
      if (rows.length) {
        bandUnits.push(u);
        blocks.push({ key: u.key, rows });
      }
    }
  } else {
    blocks.push({ key: null, rows: visible.map((s) => s.id) });
  }
  const nav = useRef<HTMLElement>(null);
  const [size, setSize] = useState<Measure | null>(null);
  const [page, setPage] = useState(0);
  const [said, setSaid] = useState("");
  const firstRow = useRef<string | null>(null);
  const total = blocks.reduce((n, b) => n + b.rows.length, 0);
  const need = size ? blocks.reduce((n, b) => n + b.rows.length * size.rowH + (b.key === null ? 0 : size.bandH), 0) : 0;
  // Page only when every row would not fit; the pager (and the line below it) take their room out of the rows'.
  const fit = size ? (need > size.room ? size.room - PAGER_H - NOTE_H : Infinity) : Infinity;
  const pages: RailPage[] = paginateRail(blocks, { rowH: size?.rowH ?? ROW_H, bandH: size?.bandH ?? BAND_H, room: fit });
  const at = Math.min(page, pages.length - 1);
  const shown = pages[at]?.slices ?? [];
  const range = (n: number) => ({ from: pages.slice(0, n).reduce((sum, p) => sum + p.rows, 0), shown: pages[n]?.rows ?? 0 });
  const selPage = props.selected ? pageOf(blocks, pages, props.selected) : -1;
  // After every render: re-measure, and remember the first row on show so a resize keeps the reader near it.
  useLayoutEffect(() => {
    const m = nav.current ? measure(nav.current) : null;
    setSize((prev) => (prev?.room === m?.room && prev?.rowH === m?.rowH && prev?.bandH === m?.bandH ? prev : m));
    // A page past the end (the list shrank) is dropped, so growing again does not jump back to it.
    if (page > at) setPage(at);
  });
  const sig = size ? `${size.room}|${size.rowH}|${size.bandH}` : "";
  useLayoutEffect(() => {
    const p = firstRow.current ? pageOf(blocks, pages, firstRow.current) : -1;
    if (p >= 0) setPage(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  useLayoutEffect(() => {
    const s = shown[0];
    firstRow.current = s ? blocks[s.block]!.rows[s.start]! : null;
  });
  const go = (n: number) => {
    setPage(n);
    const r = range(n);
    setSaid(`Page ${n + 1} of ${pages.length}, showing ${r.from + 1} to ${r.from + r.shown} of ${total} orchestrators`);
  };
  const byId = new Map(props.sessions.map((s) => [s.id, s]));
  const row = (id: string, showOwner: boolean) => item(byId.get(id)!, showOwner);
  const r = range(at);
  return (
    <nav ref={nav} className={`rail${props.collapsed ? " collapsed" : ""}`} aria-label="Orchestrators">
      {props.onToggle && <PaneTab side="left" collapsed={!!props.collapsed} controls="podium-rail-body" onToggle={props.onToggle} shortcut="[" />}
      <div id="podium-rail-body" hidden={props.collapsed}>
      <div className="rail-head">
        <h2>Orchestrators</h2>
        <span className="mono" style={{ color: "var(--muted)" }}>
          {props.liveCount}
        </span>
      </div>
      <button type="button" className="ritem all" aria-current={props.selected === null} onClick={() => props.onSelect(null)}>
        <div className="l1">
          <span className="nm">All orchestrators</span>
        </div>
        <div className="l2">
          <span>{splitText(props.split)}</span>
        </div>
      </button>
      {banded ? <RailBands units={bandUnits} blocks={blocks} slices={shown} people={pv} row={row} /> : shown.flatMap((sl) => blocks[sl.block]!.rows.slice(sl.start, sl.end).map((id) => row(id, !!pv)))}
      {pages.length > 1 && (
        <div className="rail-pager">
          <PageNav label="Orchestrators pages" compact at={at} pages={pages.length} from={r.from} shown={r.shown} total={total} perPage={r.shown} onPage={go}>
            {selPage >= 0 && selPage !== at && (
              <div className="sel-note">
                Selected: {byId.get(props.selected!)?.name} is on{" "}
                <button type="button" onClick={() => go(selPage)}>
                  page {selPage + 1}
                </button>
              </div>
            )}
          </PageNav>
        </div>
      )}
      <div className="vh" role="status">
        {said}
      </div>
      <footer className="rail-foot">
        <span>
          <a href={NOTICES_URL} target="_blank" rel="noreferrer">
            Theme credits
          </a>
          {" · "}
          <a href={LICENSE_URL} target="_blank" rel="noreferrer">
            License
          </a>
        </span>
        <span>
          {props.version && props.version !== "unknown" ? `Podium v${props.version} · ` : ""}
          {COPYRIGHT}
        </span>
      </footer>
      </div>
    </nav>
  );
}

/** The bands on the current page: each slice is a band, or the rest of one that began on an earlier page. A band's counts are the whole band's. */
function RailBands({ units, blocks, slices, people, row }: { units: Unit[]; blocks: RailBlock[]; slices: RailSlice[]; people: RailPeople; row: (id: string, showOwner: boolean) => JSX.Element }) {
  return (
    <>
      {slices.map((sl) => {
        const u = units[sl.block]!;
        const attn = u.waiting + u.stale;
        const groupish = u.kind === "group" || u.kind === "nogroup";
        return (
          <div className="rgroup" key={`${u.key}:${sl.start}`}>
            <button type="button" className="rgh" aria-pressed={people.picked === u.key} onClick={() => people.onPick(u)} title={people.picked === u.key ? "Show everyone" : `Show only ${u.name}`}>
              <Monogram name={u.name} kind={u.kind} />
              <span className="nm">
                {u.name}
                {u.mine && (
                  <>
                    {" "}
                    <YouTag kind={u.kind} />
                  </>
                )}
                {sl.cont && <span className="cont"> continued</span>}
              </span>
              {attn > 0 && (
                <span className="attn" title={`${u.waiting} waiting, ${u.stale} stale`}>
                  <i className="dot waiting" aria-hidden="true" />
                  {attn}
                  <span className="vh"> need attention</span>
                </span>
              )}
              <span className="cnt mono">
                {u.sessions.length}
                <span className="vh"> orchestrators</span>
              </span>
            </button>
            {blocks[sl.block]!.rows.slice(sl.start, sl.end).map((id) => row(id, groupish))}
          </div>
        );
      })}
    </>
  );
}
