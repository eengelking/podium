// The kanban board (#346): every session's plan steps by state, read-only. A card opens its orchestrator's page.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { BOARD_COLUMNS, buildBoard, CARDS_PER_PAGE, EMPTY_COLUMN, groupBySession, orderCards, planFigures, type BoardCard, type BoardColumn, type PlanFigures } from "../board";
import { filterByPeople, meKey, peopleActive } from "../people";
import { readJson, writeJson } from "../storage";
import { GOTCHAS_URL, type Kpis, type SessionView } from "../types";
import { cssVar, FAMILY_COLOR } from "./Chips";
import { PageNav } from "./PageNav";

const PREFS_KEY = "podium.board";
/** Whether the KPI rows are collapsed (#538): its own key, apart from the header's flags in podium.collapsed.board and the fleet page's. */
const KPIS_COLLAPSED_KEY = "podium.collapsed.board.kpis";
interface BoardPrefs {
  /** Cards grouped under a lane per orchestrator, instead of mixed in each column. */
  group: boolean;
  /** Only the signed-in person's sessions. */
  me: boolean;
  /** Plans: only the sessions with cards in the columns. All: those too, plus the strip of sessions with nothing to show in a column (#426). */
  view: "plans" | "all";
}

function loadPrefs(): BoardPrefs {
  const v = readJson<Partial<BoardPrefs> | null>(PREFS_KEY, null);
  return { group: v?.group === true, me: v?.me === true, view: v?.view === "plans" ? "plans" : "all" };
}

const FLASH_MS = 2700;
const MOVE_MS = 220;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const stepsWord = (n: number) => `${n} ${n === 1 ? "step" : "steps"}`;

function Card({ card, showOrchestrator, flash, fresh, onOpen }: { card: BoardCard; showOrchestrator: boolean; flash: boolean; fresh: boolean; onOpen: (id: string) => void }) {
  const { session: s, step } = card;
  const open = (e: MouseEvent) => {
    // Let a modified click (a new tab) through; a plain one opens the orchestrator in this tab.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onOpen(s.id);
  };
  // A card of its own already says what it needs as its title; a step moved to Review says it here.
  const whyLine = card.why ? (card.waiting ? card.why.detail : card.why.detail ? `${card.why.lead}: ${card.why.detail}` : card.why.lead) : null;
  const cls = ["kb-card", flash && "flash", fresh && "fresh"].filter(Boolean).join(" ");
  // The live wording replaces the step's text while it is in progress; showing both said the same thing twice.
  const work = !card.waiting && step.state === "active" && step.activeText ? step.activeText : step.text;
  return (
    <a className={cls} href="#/" data-key={card.key} aria-label={`${step.text}, ${card.waiting ? "waiting" : step.state}, ${s.name}`} onClick={open}>
      {showOrchestrator && (
        <div className="kb-title" style={cssVar(FAMILY_COLOR[s.modelFamily])}>
          <i aria-hidden="true" />
          <b>{s.name}</b>
        </div>
      )}
      <div className="kb-text">{work}</div>
      {whyLine && <div className="kb-wait">{whyLine}</div>}
      {step.ownerLabel && <div className="kb-own">{step.ownerLabel}</div>}
    </a>
  );
}

/** A note behind an (i): closed until the person clicks it, so the page does not carry the explanation as text. */
function InfoNote({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  // Escape closes the note wherever focus is (the button or the link inside the note), not only on the button.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <>
      <button type="button" className="kb-info" aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 16 16" aria-hidden="true" className="i">
          <circle cx="8" cy="8" r="6.2" />
          <path d="M8 7.2v3.6M8 5.1v.1" />
        </svg>
      </button>
      <div id={id} role="note" className="kb-note" hidden={!open}>
        {children}
      </div>
    </>
  );
}

/** Orchestrators and subagents live, running and waiting, the plans, and the cards (#450). The orchestrator and subagent figures are the ones the server derives for the Fleet page (Kpis), so the two pages cannot disagree; the plan and card figures come from the sessions the page receives. The filters and the Plans | All switch never change any of them. */
export function RunningCounts({ id, hidden, kpis, filtered, plans }: { id?: string; hidden?: boolean; kpis: Kpis | null; filtered: boolean; plans: PlanFigures }) {
  const tiles: { label: string; value: number | undefined; cap: string }[] = [
    { label: "Orchestrators live", value: kpis?.live, cap: "forks excluded" },
    { label: "Orchestrators running", value: kpis?.running, cap: "" },
    { label: "Orchestrators waiting", value: kpis?.waiting, cap: "" },
    { label: "Orchestrators with plans", value: plans.orchestrators, cap: kpis ? `of ${kpis.live} live` : "" },
    { label: "Subagents live", value: kpis?.agentsTotal, cap: "forks included" },
    { label: "Subagents running", value: kpis?.agentsRunning, cap: "" },
    { label: "Subagents waiting", value: kpis?.agentsWaiting, cap: "queued" },
    { label: "Total cards", value: plans.steps, cap: `${plans.done} done` },
  ];
  return (
    <div className="kpis" id={id} hidden={hidden} role="group" aria-label="Orchestrators and subagents, plans and cards, whole fleet">
      {tiles.map((t) => (
        <div className="kpi" key={t.label}>
          <div className="k">{t.label}</div>
          <div className="v mono">{t.value ?? "–"}</div>
          <div className="kpi-cap">{filtered ? "whole fleet" : t.cap}</div>
        </div>
      ))}
    </div>
  );
}

/** The control that hides the KPI rows and brings them back (#538): a pill on the block's bottom edge when open, the whole bar when collapsed. Built on .tbar-tab's look. */
function KpiTab(props: { collapsed: boolean; controls: string; onToggle: () => void }) {
  const name = props.collapsed ? "Show KPI rows" : "Hide KPI rows";
  return (
    <button type="button" className="kpi-tab" aria-expanded={!props.collapsed} aria-controls={props.controls} aria-label={name} data-tip={name} onClick={props.onToggle}>
      <svg viewBox="0 0 10 10" aria-hidden="true">
        <path d={props.collapsed ? "M1.5 3.5 5 7l3.5-3.5" : "M1.5 6.5 5 3l3.5 3.5"} />
      </svg>
    </button>
  );
}

/** What the page says when no card is on it, in each mode (#426). */
export function blankText(sessions: number, plansOnly: boolean): string {
  if (!sessions) return "No sessions are active.";
  return plansOnly ? `None of the ${sessions} active sessions has open steps. Switch to All to list them.` : `None of the ${sessions} active sessions has a task list yet. They are listed below.`;
}

export function Board(props: {
  /** The sessions the fleet page shows. */
  sessions: SessionView[];
  /** The fleet's figures from the server, or null before the first update. */
  kpis: Kpis | null;
  /** True when the fleet page already hides sessions (a people filter, detached sessions), so the counts cover more than the cards. */
  narrowed?: boolean;
  /** Who is signed in, or null: the My orchestrators | Everyone switch is offered only to a signed-in person. */
  me: string | null;
  onOpen: (sessionId: string) => void;
}) {
  const [prefs, setPrefs] = useState(loadPrefs);
  const [kpisShut, setKpisShut] = useState(() => readJson<unknown>(KPIS_COLLAPSED_KEY, false) === true);
  const kpisId = useId();
  const toggleKpis = () => {
    setKpisShut(!kpisShut);
    writeJson(KPIS_COLLAPSED_KEY, !kpisShut);
  };
  const [group, setGroup] = useState<string | null>(null);
  const [pages, setPages] = useState<Partial<Record<BoardColumn, number>>>({});
  const setPref = (p: Partial<BoardPrefs>) =>
    setPrefs((cur) => {
      const next = { ...cur, ...p };
      writeJson(PREFS_KEY, next);
      return next;
    });

  const groups = useMemo(() => (peopleActive(props.sessions) ? [...new Set(props.sessions.map((s) => s.ownerGroup).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b)) : []), [props.sessions]);
  const meOn = prefs.me && !!props.me;
  const visible = useMemo(() => {
    let list = props.sessions;
    if (meOn) list = filterByPeople(list, { person: meKey(props.sessions, props.me), group: null });
    if (group && groups.includes(group)) list = list.filter((s) => s.ownerGroup === group);
    return list;
  }, [props.sessions, props.me, meOn, group, groups]);
  const plansOnly = prefs.view === "plans";
  const board = useMemo(() => buildBoard(visible, plansOnly), [visible, plansOnly]);
  // The plan tiles are whole-fleet: when Me or a group narrows the cards, they are counted over every session the page received.
  const fleetPlans = useMemo(() => planFigures(visible === props.sessions ? board : buildBoard(props.sessions)), [visible, props.sessions, board]);

  // What moved since the last update, for the flash, the order and the announcement.
  const prev = useRef<Map<string, { column: BoardColumn; text: string }> | null>(null);
  const [changedAt, setChangedAt] = useState<Map<string, number>>(() => new Map());
  const [flash, setFlash] = useState<{ moved: Set<string>; fresh: Set<string> }>({ moved: new Set(), fresh: new Set() });
  const [note, setNote] = useState("");
  const flashTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    const cur = new Map<string, { column: BoardColumn; text: string }>();
    for (const col of BOARD_COLUMNS) for (const c of board.columns[col.key]) cur.set(c.key, { column: col.key, text: c.step.text });
    const before = prev.current;
    prev.current = cur;
    if (!before) return;
    const moved = [...cur].filter(([k, v]) => before.has(k) && before.get(k)!.column !== v.column);
    const added = [...cur].filter(([k]) => !before.has(k));
    if (!moved.length && !added.length) return;
    const now = Date.now();
    setChangedAt((m) => {
      const next = new Map(m);
      for (const [k] of [...moved, ...added]) next.set(k, now);
      return next;
    });
    setFlash({ moved: new Set(moved.map(([k]) => k)), fresh: new Set(added.map(([k]) => k)) });
    const label = (c: BoardColumn) => BOARD_COLUMNS.find((x) => x.key === c)!.label;
    const first = moved[0] ? `${moved[0][1].text} moved to ${label(moved[0][1].column)}` : `New step: ${added[0][1].text}`;
    const more = moved.length + added.length - 1;
    setNote(more > 0 ? `${first}, and ${more} more ${more === 1 ? "change" : "changes"}` : first);
    // The timer outlives this run: a later update with nothing moved must not cancel it and leave the flash on.
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash({ moved: new Set(), fresh: new Set() }), FLASH_MS);
  }, [board]);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  // A card that changes column slides from where it was (FLIP). Positions are in the board's own coordinates, so scrolling is not a move.
  const area = useRef<HTMLDivElement>(null);
  const rects = useRef<Map<string, { x: number; y: number }>>(new Map());
  const signature = useRef("");
  useLayoutEffect(() => {
    const root = area.current;
    if (!root) return;
    const box = root.getBoundingClientRect();
    const next = new Map<string, { x: number; y: number }>();
    root.querySelectorAll<HTMLElement>("[data-key]").forEach((el) => {
      const r = el.getBoundingClientRect();
      const col = el.closest<HTMLElement>(".kb-col-b");
      next.set(el.dataset.key!, { x: r.left - box.left + root.scrollLeft, y: r.top - box.top + (col?.scrollTop ?? 0) });
    });
    const sig = [...next.keys()].join("|");
    if (sig !== signature.current && rects.current.size && !reducedMotion()) {
      root.querySelectorAll<HTMLElement>("[data-key]").forEach((el) => {
        const was = rects.current.get(el.dataset.key!);
        const now = next.get(el.dataset.key!)!;
        if (!was || typeof el.animate !== "function") return;
        const dx = was.x - now.x;
        const dy = was.y - now.y;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: MOVE_MS, easing: "cubic-bezier(.2,.7,.2,1)" });
      });
    }
    signature.current = sig;
    rects.current = next;
  });

  const total = BOARD_COLUMNS.reduce((n, c) => n + board.columns[c.key].length, 0);
  const showStrip = !plansOnly && board.withoutSteps.length > 0;
  const [tab, setTab] = useState<BoardColumn>("active");
  // The strip is pinned over the board (#359), so a focused card scrolls into view clear of it: cards read the strip's height from --kb-strip-h.
  const root = useRef<HTMLElement>(null);
  const strip = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = strip.current;
    const host = root.current;
    if (!host) return;
    if (!el || typeof ResizeObserver !== "function") {
      host.style.removeProperty("--kb-strip-h");
      return;
    }
    const set = () => host.style.setProperty("--kb-strip-h", `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showStrip]);

  return (
    <section className="kb" aria-label="Board" ref={root}>
      <div className="kb-head">
        <h2>Board</h2>
        <span className="kb-seg" role="group" aria-label="Sessions shown">
          <button type="button" aria-pressed={plansOnly} onClick={() => setPref({ view: "plans" })}>
            Plans
          </button>
          <button type="button" aria-pressed={!plansOnly} onClick={() => setPref({ view: "all" })}>
            All
          </button>
        </span>
        <span className="spacer" />
        <span className="kb-seg" role="group" aria-label="Layout">
          <button type="button" aria-pressed={!prefs.group} onClick={() => setPref({ group: false })}>
            Mixed
          </button>
          <button type="button" aria-pressed={prefs.group} onClick={() => setPref({ group: true })}>
            By orchestrator
          </button>
        </span>
        {groups.length > 0 && (
          <select className="kb-sel" aria-label="Group" value={group ?? ""} onChange={(e) => setGroup(e.target.value || null)}>
            <option value="">All groups</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        )}
        {props.me && (
          <span className="kb-seg" role="group" aria-label="Whose sessions">
            <button type="button" aria-pressed={meOn} onClick={() => setPref({ me: true })}>
              My orchestrators
            </button>
            <button type="button" aria-pressed={!meOn} onClick={() => setPref({ me: false })}>
              Everyone
            </button>
          </span>
        )}
      </div>
      <div className={`kpi-block${kpisShut ? " shut" : ""}`}>
        <RunningCounts hidden={kpisShut} id={kpisId} kpis={props.kpis} filtered={meOn || group !== null || !!props.narrowed} plans={fleetPlans} />
        <KpiTab collapsed={kpisShut} controls={kpisId} onToggle={toggleKpis} />
      </div>
      <div className="vh" role="status" aria-label="Board updates">
        {note}
      </div>
      {total > 0 ? (
        <>
          <div className="kb-tabs" role="tablist" aria-label="Board columns">
            {BOARD_COLUMNS.map((c) => (
              <button key={c.key} type="button" role="tab" aria-selected={tab === c.key} onClick={() => setTab(c.key)}>
                {c.label}
                <span className="mono">{board.columns[c.key].length}</span>
              </button>
            ))}
          </div>
          <div className="kb-board" ref={area}>
            {BOARD_COLUMNS.map(({ key, label, hint }) => {
              const ordered = orderCards(board.columns[key], changedAt);
              // A lane holds one orchestrator's cards together, so the order is by session (first to appear leads) before the page is cut.
              const cards = prefs.group ? groupBySession(ordered) : ordered;
              const count = Math.max(1, Math.ceil(cards.length / CARDS_PER_PAGE));
              const at = Math.min(pages[key] ?? 0, count - 1);
              const from = at * CARDS_PER_PAGE;
              const slice = cards.slice(from, from + CARDS_PER_PAGE);
              let last = "";
              return (
                <section key={key} className={`kb-col kb-${key}${tab === key ? " on" : ""}`} aria-label={`${label}, ${stepsWord(cards.length)}`}>
                  <div className="kb-col-h">
                    <h3>{label}</h3>
                    <span className="kb-n mono">{cards.length}</span>
                    {hint && <span className="kb-hint">{hint}</span>}
                  </div>
                  <div className="kb-col-b">
                    {slice.length === 0 && <div className="kb-empty">{EMPTY_COLUMN[key]}</div>}
                    {slice.map((c) => {
                      const lane = prefs.group && c.session.id !== last ? <div className="kb-lane" key={`lane:${c.key}`} style={cssVar(FAMILY_COLOR[c.session.modelFamily])}>
                          <i aria-hidden="true" />
                          <b>{c.session.name}</b>
                        </div> : null;
                      last = c.session.id;
                      return (
                        <div key={c.key} className="kb-slot">
                          {lane}
                          <Card card={c} showOrchestrator={!prefs.group} flash={flash.moved.has(c.key)} fresh={flash.fresh.has(c.key)} onOpen={props.onOpen} />
                        </div>
                      );
                    })}
                  </div>
                  {cards.length > 0 && (
                    <PageNav label={`${label} pages`} at={at} pages={count} from={from} shown={slice.length} total={cards.length} perPage={CARDS_PER_PAGE} onPage={(n) => setPages((p) => ({ ...p, [key]: n }))} />
                  )}
                </section>
              );
            })}
          </div>
        </>
      ) : (
        <div className="kb-blank">
          <b>No plans on the board</b>
          <p>{blankText(visible.length, plansOnly)}</p>
        </div>
      )}
      {showStrip && (
        <section className="kb-none" aria-label="Sessions with no open steps" ref={strip}>
          <div className="kb-none-h">
            <b>
              {board.withoutSteps.length} {board.withoutSteps.length === 1 ? "session has" : "sessions have"} no open steps
            </b>
            <InfoNote label="How to get steps here">
              Podium builds the board from each session's task list. Start Claude Code with <code>CLAUDE_CODE_ENABLE_TODO_TOOLS=1</code> or add it to the <code>env</code> block of <code>~/.claude/settings.json</code>, then ask Claude to track the work as a task list.{" "}
              <a href={GOTCHAS_URL} target="_blank" rel="noreferrer">
                A session shows no plan
              </a>
            </InfoNote>
          </div>
          <div className="kb-none-list">
            <ul>
              {board.withoutSteps.map((s) => (
                <li key={s.id}>
                  <a
                    href="#/"
                    onClick={(e) => {
                      e.preventDefault();
                      props.onOpen(s.id);
                    }}
                    style={cssVar(FAMILY_COLOR[s.modelFamily])}
                  >
                    <i aria-hidden="true" />
                    {s.name}
                    <span className="kb-why">{s.plan?.steps.length ? "all done" : "no plan"}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </section>
  );
}
