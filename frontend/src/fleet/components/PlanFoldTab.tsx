/** The control that folds the Plan / Files column away and brings it back (#604): a pill on the column's edge when open, on the rail when folded. Built on .tbar-tab's look, turned 90 degrees. */
export function PlanFoldTab(props: { folded: boolean; controls: string; onToggle: () => void }) {
  const name = props.folded ? "Show plan and files" : "Hide plan and files";
  return (
    <button type="button" className="fold-tab" aria-expanded={!props.folded} aria-controls={props.controls} aria-label={name} data-tip={name} onClick={props.onToggle}>
      <svg viewBox="0 0 10 10" aria-hidden="true">
        <path d={props.folded ? "M3.5 1.5 7 5 3.5 8.5" : "M6.5 1.5 3 5l3.5 3.5"} />
      </svg>
    </button>
  );
}
