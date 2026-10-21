import { EdgeTab } from "./EdgeTab";

/** The control that folds the Plan / Files column away and brings it back (#604): a pill on the column's edge when open, on the rail when folded. */
export function PlanFoldTab(props: { folded: boolean; controls: string; onToggle: () => void }) {
  return <EdgeTab place="fold" name={props.folded ? "Show plan and files" : "Hide plan and files"} points={props.folded ? "right" : "left"} controls={props.controls} expanded={!props.folded} onToggle={props.onToggle} />;
}
