// Orchestrator messaging rights (#347, #415, mockup/podium-my-reporters.html): the pieces My reporters draws them with,
// built once so the Admin's Messaging section (C5) uses the same ones. A level is an icon and a word, never a hue. The Grid
// shows every pair at once (rows send, columns receive); the Board shows one reporter's peers in four columns, where a card
// moves by dragging or by its Move to list, so dragging is never the only way. The Grid | Board choice is kept in this browser.
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { readJson, writeJson } from "../storage";
import { idPart, LEVEL_LABEL, LEVELS, type PeerLevel, type PeerReporter, type RightsModel, type SystemKind, systemKind } from "../peers";

const svg = { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false } as const;

/** One glyph per level: a struck circle, an eye, an arrow with a clock, an arrow to a bar. */
const LEVEL_ICON: Record<PeerLevel, ReactNode> = {
  none: (
    <svg {...svg}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M4.2 11.8l7.6-7.6" />
    </svg>
  ),
  see: (
    <svg {...svg}>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  ),
  ask: (
    <svg {...svg}>
      <path d="M1.5 8h6M5 5l3 3-3 3" />
      <circle cx="12" cy="8" r="3" />
      <path d="M12 6.6V8l.9.6" />
    </svg>
  ),
  send: (
    <svg {...svg}>
      <path d="M2 8h10M8.5 4.5L12 8l-3.5 3.5" />
      <path d="M14 3v10" />
    </svg>
  ),
};

const SYSTEM_ICON: Record<SystemKind, ReactNode> = {
  mac: (
    <svg {...svg}>
      <rect x="2" y="3" width="12" height="8" rx="1" />
      <path d="M1 13h14" />
    </svg>
  ),
  linux: (
    <svg {...svg}>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M4.5 6l2 2-2 2M8 10h3" />
    </svg>
  ),
  win: (
    <svg {...svg}>
      <path d="M2 3.5l5-.7v4.7H2zM9 2.6l5-.7v5.6H9zM2 8.5h5v4.7l-5-.7zM9 8.5h5v5.6l-5-.7z" />
    </svg>
  ),
};

/** An access level: its icon and its one label. */
export function AccessLevel({ level }: { level: PeerLevel }) {
  return (
    // lv-<level>, not the bare level: `.none` and `.ask` are already other components' classes.
    <span className={`pm-lv lv-${level}`}>
      {LEVEL_ICON[level]}
      <span>{LEVEL_LABEL[level]}</span>
    </span>
  );
}

/** A reporter's system: an icon for its family and the name it reported. */
export function SystemTag({ os }: { os: string | null }) {
  const kind = systemKind(os);
  if (!kind) return <span className="pm-os muted">Not reported</span>;
  return (
    <span className="pm-os">
      {SYSTEM_ICON[kind]}
      <span>{os}</span>
    </span>
  );
}

/** An Admin's proposal that waits for the owner: a clock and the words, in the warning ink. */
export function ProposedTag({ level, waitingFor }: { level: PeerLevel; waitingFor: string }) {
  return (
    <span className="pm-pend">
      <svg {...svg} strokeWidth={1.5}>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 4.6V8l2.4 1.4" />
      </svg>
      <span>
        Proposed: {LEVEL_LABEL[level]}, waiting for {waitingFor}
      </span>
    </span>
  );
}

/** A paused link: a pause mark and the word. */
export function PausedTag() {
  return (
    <span className="pm-state paused">
      <svg {...svg} strokeWidth={1.6}>
        <circle cx="8" cy="8" r="6" />
        <path d="M6.5 5.5v5M9.5 5.5v5" />
      </svg>
      <span>Paused</span>
    </span>
  );
}

function Grip() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="6" cy="4" r="1" />
      <circle cx="10" cy="4" r="1" />
      <circle cx="6" cy="8" r="1" />
      <circle cx="10" cy="8" r="1" />
      <circle cx="6" cy="12" r="1" />
      <circle cx="10" cy="12" r="1" />
    </svg>
  );
}

/** A name cut with an ellipsis that keeps its full text as a title. */
function Name({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className} title={text}>
      {text}
    </span>
  );
}

export interface SegOption<T extends string> {
  id: T;
  label: string;
  title?: string;
}

/** A choice of a few as the app's segmented radios: only the checked one is in the tab order, and the arrow keys move and pick. */
export function Segmented<T extends string>(props: { label?: string; labelledBy?: string; options: readonly SegOption<T>[]; value: T; onChange: (v: T) => void; disabled?: boolean }) {
  const { options, value } = props;
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = (options.findIndex((o) => o.id === value) + step + options.length) % options.length;
    props.onChange(options[i]!.id);
    e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]")[i]?.focus();
  };
  return (
    <div className="modeseg" role="radiogroup" aria-label={props.label} aria-labelledby={props.labelledBy}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={o.id === value} tabIndex={o.id === value ? 0 : -1} title={o.title} disabled={props.disabled} onClick={() => o.id !== value && props.onChange(o.id)} onKeyDown={onKey}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export type RightsLayout = "grid" | "board";
export const VIEW_KEY = "podium.peers.view";

/** The Grid | Board choice, remembered in this browser; Grid when nothing is kept or storage is blocked. */
export function useRightsLayout(): [RightsLayout, (l: RightsLayout) => void] {
  const [layout, setLayout] = useState<RightsLayout>(() => (readJson<unknown>(VIEW_KEY, "grid") === "board" ? "board" : "grid"));
  const set = (l: RightsLayout) => {
    setLayout(l);
    writeJson(VIEW_KEY, l);
  };
  return [layout, set];
}

export function LayoutSwitch({ layout, onLayout }: { layout: RightsLayout; onLayout: (l: RightsLayout) => void }) {
  return (
    <Segmented
      label="View"
      options={[
        { id: "grid", label: "Grid" },
        { id: "board", label: "Board" },
      ]}
      value={layout}
      onChange={onLayout}
    />
  );
}

/** What both views need besides the model: who a proposal waits for, and how a change is made. */
interface ViewProps {
  model: RightsModel;
  /** "you" on My reporters; the owner's name in the Admin's view. */
  waitingFor: string;
  /** The level a select shows for a pair: the current one, or a proposal the Admin is making. Defaults to the current level. */
  shown?: (a: string, b: string) => PeerLevel;
  /** `control` is the id of the select the change came from, so focus can go back to it. */
  onSet: (from: string, to: string, level: PeerLevel, control: string) => void;
  /** Whether a reporter's live orchestrators are counted. The Admin's view has no count to show (#416). Defaults to true. */
  showLive?: boolean;
  /** Levels that cannot be chosen here: an Admin cannot propose No access (#416). None by default. */
  disabledLevels?: readonly PeerLevel[];
}

const levelOptions = (prefix = "", disabled: readonly PeerLevel[] = []) =>
  LEVELS.map((l) => (
    <option key={l} value={l} disabled={disabled.includes(l)}>
      {prefix}
      {LEVEL_LABEL[l]}
    </option>
  ));

export const gridCellId = (a: string, b: string) => `g-${idPart(a)}-${idPart(b)}`;
export const moveId = (key: string) => `mv-${idPart(key)}`;

/** Every pair at once. Each cell is a select named "A to B"; the diagonal is between orchestrators on one machine. */
export function RightsGrid({ model, waitingFor, shown, onSet, showLive = true, disabledLevels }: ViewProps) {
  const reps = model.reporters;
  const cell = (ra: PeerReporter, rb: PeerReporter) => {
    const a = ra.key;
    const b = rb.key;
    const off = model.off(a, b);
    const self = a === b;
    const id = gridCellId(a, b);
    const proposed = model.proposed(a, b);
    return (
      <td key={b} className={`${off ? "off" : ""}${self ? " self" : ""}`.trim() || undefined}>
        {off ? (
          <>
            <AccessLevel level="none" />
            <span className="hint cellnote">{off}</span>
          </>
        ) : (
          <>
            <label className="vh" htmlFor={id}>
              {ra.machine} to {rb.machine}
            </label>
            <select className="field sm" id={id} value={(shown ?? model.level)(a, b)} disabled={model.locked(a, b)} onChange={(e) => onSet(a, b, e.target.value as PeerLevel, id)}>
              {levelOptions("", disabledLevels)}
            </select>
            {self && <span className="hint cellnote">Between orchestrators on this machine</span>}
            {model.paused(a, b) && <PausedTag />}
            {proposed && <ProposedTag level={proposed} waitingFor={waitingFor} />}
          </>
        )}
      </td>
    );
  };
  return (
    // A scrolling region takes focus so the keyboard can scroll it (accessibility.html).
    <div className="pm-gridwrap scroll" tabIndex={0} role="region" aria-label="Rights between reporters. Each row sends to each column." /* NOSONAR S6845: a focusable scroll region, by design */>
      <table className="pm-grid">
        <thead>
          <tr>
            <th scope="col">From, to</th>
            {reps.map((r) => (
              <th key={r.key} scope="col">
                <Name text={r.machine} className="mn" />
                {r.os ?? ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {reps.map((ra) => (
            <tr key={ra.key}>
              <th scope="row">
                <Name text={ra.machine} className="mn" />
                {showLive && <span className="hint">{ra.live.length} live</span>}
              </th>
              {reps.map((rb) => cell(ra, rb))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One reporter's peers in four columns, one per level, each a labelled region with its count. A card moves by dragging it
 * to a column or with its Move to list; after a move from the list, focus stays on that list in the card's new column.
 */
export function RightsBoard({ model, waitingFor, shown, onSet, of, onOf, showLive = true, disabledLevels = [] }: ViewProps & { of: string | null; onOf: (key: string) => void }) {
  const [over, setOver] = useState<PeerLevel | null>(null);
  const dragging = useRef<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const refocus = useRef<string | null>(null);
  // A card that moved column is a new element: put focus back on its Move to list.
  useLayoutEffect(() => {
    if (!refocus.current) return;
    document.getElementById(refocus.current)?.focus();
    refocus.current = null;
  });
  const able = model.reporters.filter((r) => r.peers === true);
  if (!able.length) return <div className="pm-note"><p className="hint">None of your reporters has messaging on yet, so there is nothing to arrange here.</p></div>;
  const me = able.find((r) => r.key === of) ?? able[0]!;
  const level = shown ?? model.level;
  const list = [me, ...model.reporters.filter((r) => r.key !== me.key)];
  const move = (key: string, to: PeerLevel, el: string) => onSet(me.key, key, to, el);

  const card = (r: PeerReporter) => {
    const locked = model.locked(me.key, r.key);
    const self = r.key === me.key;
    const id = moveId(r.key);
    const proposed = model.proposed(me.key, r.key);
    return (
      <div
        key={r.key}
        className={`pm-card${locked ? " locked" : ""}${dragKey === r.key ? " dragging" : ""}`}
        draggable={!locked}
        data-card={r.key}
        onDragStart={(e) => {
          dragging.current = r.key;
          setDragKey(r.key);
          e.dataTransfer?.setData("text/plain", r.key);
        }}
        onDragEnd={() => {
          dragging.current = null;
          setDragKey(null);
        }}
      >
        <div className="ct">
          {self ? (
            <b>
              Within <Name text={r.machine} />
            </b>
          ) : (
            <b title={r.machine}>{r.machine}</b>
          )}
          {!locked && (
            <span className="grip">
              <Grip />
            </span>
          )}
        </div>
        <div className="sub">
          <SystemTag os={r.os} />
          {showLive && <span>{r.live.length} live</span>}
          {messagingOffShort(r) && <span>{messagingOffShort(r)}</span>}
        </div>
        <label className="vh" htmlFor={id}>
          Move {r.machine} to
        </label>
        <select
          className="field sm"
          id={id}
          value={level(me.key, r.key)}
          disabled={locked}
          onChange={(e) => {
            refocus.current = id;
            move(r.key, e.target.value as PeerLevel, id);
          }}
        >
          {levelOptions("Move to: ", disabledLevels)}
        </select>
        {model.paused(me.key, r.key) && <PausedTag />}
        {proposed && <ProposedTag level={proposed} waitingFor={waitingFor} />}
        {!self && (
          <div className="backl">
            {r.machine} to {me.machine}: <AccessLevel level={model.level(r.key, me.key)} />
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="pm-pick">
        <span id="pm-pick-l" className="hint">
          What this reporter's orchestrators can do
        </span>
        <Segmented labelledBy="pm-pick-l" options={able.map((r) => ({ id: r.key, label: r.machine, title: r.machine }))} value={me.key} onChange={onOf} />
      </div>
      <div className="pm-board">
        {LEVELS.map((c) => {
          const cards = list.filter((r) => level(me.key, r.key) === c);
          return (
            <section
              key={c}
              className={`pm-col${over === c ? " over" : ""}`}
              data-col={c}
              aria-label={`${LEVEL_LABEL[c]}, ${cards.length} ${cards.length === 1 ? "reporter" : "reporters"}`}
              onDragOver={(e) => {
                if (!dragging.current) return;
                e.preventDefault();
                setOver(c);
              }}
              onDragLeave={() => setOver((o) => (o === c ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const key = dragging.current ?? e.dataTransfer?.getData("text/plain");
                dragging.current = null;
                setDragKey(null);
                if (key && !model.locked(me.key, key) && level(me.key, key) !== c && !disabledLevels.includes(c)) move(key, c, moveId(key));
              }}
            >
              <h3>
                <AccessLevel level={c} />
                <span className="n mono" aria-hidden="true">
                  {cards.length}
                </span>
              </h3>
              {cards.length ? cards.map(card) : <div className="kb-empty">None here. Drag a reporter here or use its Move to list.</div>}
            </section>
          );
        })}
      </div>
    </>
  );
}

/** A card's short reason a reporter cannot take part. */
function messagingOffShort(r: Pick<PeerReporter, "peers">): string | null {
  if (r.peers === true) return null;
  return r.peers === null ? "Reporter can't message: update it" : "Messaging off on the machine";
}

/**
 * Asked as soon as A can send to B and B cannot send back: a reply is a message too, so it needs its own right. The
 * answer sets B to A, or Not now leaves it.
 */
export function AnswerBack({ a, b, onAnswer }: { a: string; b: string; onAnswer: (level: "ask" | "send" | null) => void }) {
  return (
    <div className="pm-back">
      <div className="confirm" role="group" aria-label={`Can ${b} answer?`}>
        <div className="q">
          <span>
            <b>{a}</b> can now send to <b>{b}</b>. Can <b>{b}</b> answer?
          </span>
          <span className="hint">
            A reply is a message too, so it needs its own right. Without it, {b}'s orchestrators read what arrives and cannot answer.
          </span>
        </div>
        <button type="button" className="btn sm" onClick={() => onAnswer(null)}>
          Not now
        </button>
        <button type="button" className="btn sm" onClick={() => onAnswer("ask")}>
          {LEVEL_LABEL.ask}
        </button>
        <button type="button" className="btn sm" onClick={() => onAnswer("send")}>
          {LEVEL_LABEL.send}
        </button>
      </div>
    </div>
  );
}

/** Text from an orchestrator, drawn as text nodes. The only element inside it is Podium's own `[redacted]` marker. */
export function QuotedText({ text }: { text: string }) {
  const parts = text.split("[redacted]");
  return (
    <div className="pm-quote">
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 && (
            <span className="rd" title="Replaced on the sending machine. The original never left it.">
              [redacted]
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
