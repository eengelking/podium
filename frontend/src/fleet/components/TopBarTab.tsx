/** The icon tab at the middle of the top bar's bottom edge: a chevron up hides the bar, and the same tab hangs from the top edge, chevron down, to show it again. */
export function TopBarTab(props: { collapsed: boolean; onToggle: () => void }) {
  const name = props.collapsed ? "Show top bar" : "Hide top bar";
  return (
    <button type="button" className="tbar-tab" aria-expanded={!props.collapsed} aria-controls="podium-top" aria-label={name} data-tip={name} onClick={props.onToggle}>
      <svg viewBox="0 0 10 10" aria-hidden="true">
        <path d={props.collapsed ? "M1.5 3.5 5 7l3.5-3.5" : "M1.5 6.5 5 3l3.5 3.5"} />
      </svg>
    </button>
  );
}
