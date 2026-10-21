/** Where a collapse control sits: the top bar's edge, the Kanban KPI rows', the Plan / Files column's, or a side pane's. Each place has its own class and the same look. */
export type EdgePlace = "top" | "kpi" | "fold" | "left" | "right";

// Chevrons in the 10 x 10 box the pill draws them in.
const CHEVRON = {
  up: "M1.5 6.5 5 3l3.5 3.5",
  down: "M1.5 3.5 5 7l3.5-3.5",
  left: "M6.5 1.5 3 5l3.5 3.5",
  right: "M3.5 1.5 7 5 3.5 8.5",
} as const;

/** The one collapse control (#626): a pill on the edge of what it hides, with a styled tip on hover and keyboard focus. The top bar, the KPI rows, the Plan / Files column and both panes use it. */
export function EdgeTab(props: {
  place: EdgePlace;
  /** The accessible name, which says what a click does: "Hide top bar". */
  name: string;
  /** The tip, when it says more than the name does (a shortcut). */
  tip?: string;
  /** The way the chevron points. */
  points: keyof typeof CHEVRON;
  /** The id of what it shows and hides. */
  controls: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`edge-tab edge-tab-${props.place}${props.expanded ? "" : " edge-tab-shut"}`}
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      aria-label={props.name}
      data-tip={props.tip ?? props.name}
      onClick={props.onToggle}
    >
      <svg viewBox="0 0 10 10" aria-hidden="true">
        <path d={CHEVRON[props.points]} />
      </svg>
    </button>
  );
}

/** A side pane's tab (#33). The chevron points the way the pane will move: toward its edge to close, away from it to open. */
export function PaneEdgeTab(props: { side: "left" | "right"; collapsed: boolean; onToggle: () => void }) {
  const { side, collapsed } = props;
  const name = `${collapsed ? "Expand" : "Collapse"} the ${side} pane`;
  const shortcut = side === "left" ? "[" : "]";
  return (
    <EdgeTab
      place={side}
      name={name}
      tip={`${name} (${shortcut})`}
      points={(side === "left") !== collapsed ? "left" : "right"}
      controls={side === "left" ? "podium-rail-body" : "podium-side-body"}
      expanded={!collapsed}
      onToggle={props.onToggle}
    />
  );
}
