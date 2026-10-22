import { EdgeTab } from "./EdgeTab";

/** The tab at the middle of the top bar's bottom edge: a chevron up hides the bar, and the same tab hangs from the top edge, chevron down, to show it again. */
export function TopBarTab(props: { collapsed: boolean; onToggle: () => void }) {
  return <EdgeTab place="top" name={props.collapsed ? "Show top bar" : "Hide top bar"} points={props.collapsed ? "down" : "up"} controls="podium-top" expanded={!props.collapsed} onToggle={props.onToggle} />;
}
