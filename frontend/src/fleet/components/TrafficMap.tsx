// Traffic's map (#417, mockup/podium-traffic.html): inline SVG, as the app's other charts are. A box per machine with
// its system, a node per orchestrator with the app's status shapes, and a line per conversation. A line's state is its
// dash pattern plus an icon and a word on its label with the count; an arrow at one end means only that way can send;
// a thicker line carries more messages, as a second signal only. Each line is a real link that selects its
// conversation, takes keyboard focus and answers Enter. Names are cut with an ellipsis and keep their full text as a title.
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { StateIcon, type StateKind } from "./Chips";
import { cut, lineLabel, noRightToSend, NODE_R, type LinkState, type MapLayout } from "../trafficData";

/** What the map knows of an orchestrator besides the conversations: its status shape and word, from the live fleet. */
export interface NodeState {
  kind: StateKind;
  word: string;
}

const MARKERS = ["active", "waiting", "paused", "sel"] as const;
const markerId = (k: (typeof MARKERS)[number]) => `pm-ah-${k}`;

/** The pause mark and the clock on a waiting or paused line's label, and No access's struck circle where neither can send. */
const LABEL_ICON: Record<Exclude<LinkState, "active"> | "none", ReactNode> = {
  none: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M4.2 11.8l7.6-7.6" />
    </>
  ),
  paused: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.5 5.5v5M9.5 5.5v5" />
    </>
  ),
  waiting: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.6V8l2.4 1.4" />
    </>
  ),
};

export function TrafficMap(props: {
  layout: MapLayout;
  selected: string | null;
  onSelect: (id: string) => void;
  /** The OS each machine reported, by reporter key, when known. */
  osOf: (key: string) => string | null;
  nodeState: (sessionId: string) => NodeState;
}) {
  const { layout, selected } = props;
  const pick = (id: string) => (e: MouseEvent) => {
    e.preventDefault();
    props.onSelect(id);
  };
  const key = (id: string) => (e: KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    props.onSelect(id);
  };
  return (
    <svg className="pm-map" viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label="Map of orchestrators and the messages between them. The Table view has the same links as text.">
      <defs>
        {MARKERS.map((k) => (
          <marker key={k} id={markerId(k)} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path className={`ah ${k}`} d="M0 0L10 5L0 10z" />
          </marker>
        ))}
      </defs>
      {layout.machines.map((m) => {
        const os = props.osOf(m.key);
        return (
          <g key={m.key}>
            <rect className="mbox" x={m.x} y={m.y} width={m.w} height={m.h} rx="10" />
            <text className="mlabel" x={m.x + 14} y={m.y + 22}>
              <title>{m.name}</title>
              {cut(m.name, 30)}
            </text>
            <text className="mos" x={m.x + 14} y={m.y + 38}>
              {os ? cut(os, 36) : "System not reported"}
            </text>
          </g>
        );
      })}
      {layout.edges.map((e) => {
        const l = e.link;
        const sel = selected === e.id;
        const mk = `url(#${markerId(sel ? "sel" : l.state)})`;
        // The path runs from a to b: an arrow at its end points at b, one at its start (reversed) points at a.
        const start = e.ways === "both" || e.ways === "bToA" ? mk : undefined;
        const end = e.ways === "both" || e.ways === "aToB" ? mk : undefined;
        // The stroke keeps the link's state; only the label says no side can send.
        let icon: ReactNode = null;
        if (l.state !== "active") icon = LABEL_ICON[l.state];
        else if (noRightToSend(l)) icon = LABEL_ICON.none;
        return (
          <a
            key={e.id}
            className={`edge ${l.state}${sel ? " sel" : ""}`}
            href="#/traffic"
            data-edge={e.id}
            aria-label={lineLabel(l)}
            aria-current={sel ? "true" : undefined}
            onClick={pick(e.id)}
            onKeyDown={key(e.id)}
          >
            <path className="hit" d={e.d} />
            <path className="ln" d={e.d} strokeWidth={e.width} markerStart={start} markerEnd={end} />
            <g className="pill" transform={`translate(${e.pill.x},${e.pill.y})`}>
              <rect className="ring" x="-3" y="-3" width={e.pill.w + 6} height={e.pill.h + 6} rx="14" />
              <rect className="face" width={e.pill.w} height={e.pill.h} rx="11" />
              {icon && (
                <g className="ic" transform="translate(8,4) scale(0.875)" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  {icon}
                </g>
              )}
              <text x={icon ? 26 : 10} y="15">
                {e.label}
              </text>
            </g>
          </a>
        );
      })}
      {layout.nodes.map((n) => {
        const st = props.nodeState(n.sessionId);
        return (
          <g key={n.sessionId} className={`node ${st.kind}`}>
            <circle className="bg" cx={n.x} cy={n.y} r={NODE_R} />
            {/* An 18 px viewport: the shape's own svg has no size, so it fills it. */}
            <svg x={n.x - 9} y={n.y - 9} width="18" height="18" overflow="visible">
              <StateIcon kind={st.kind} />
            </svg>
            <text className="nm" x={n.x} y={n.y + 40} textAnchor="middle">
              <title>{n.name}</title>
              {cut(n.name, 24)}
            </text>
            <text className="st" x={n.x} y={n.y + 55} textAnchor="middle">
              Orchestrator, {st.word}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** The legend for the line styles, the arrow and the thickness, and the machines that are not drawn. */
export function TrafficLegend({ off }: { off: { machine: string; why: string }[] }) {
  const sw = (dash?: string) => (
    <svg viewBox="0 0 34 10" aria-hidden="true" focusable="false">
      <line x1="2" y1="5" x2="32" y2="5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={dash} />
    </svg>
  );
  return (
    <div className="legend">
      <span>
        <span className="pm-key-ink">{sw()}</span>Active
      </span>
      <span>
        <span className="pm-key-warn">{sw("7 5")}</span>A message waits for approval
      </span>
      <span>
        <span className="pm-key-muted">{sw("1 6")}</span>Paused
      </span>
      <span>An arrow at one end: only that way can send</span>
      <span>A thicker line carries more messages</span>
      {off.map((m) => (
        <span key={m.machine}>
          {m.machine} is not drawn: {m.why}
        </span>
      ))}
    </div>
  );
}
