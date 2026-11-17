import type { ReactNode } from "react";

/** The two tabs of the Activity modal (#897): the feed is Output, and the shells and monitors a loop started are Background. */
export type ActivityTab = "output" | "background";

export function ActivityTabs(props: { tab: ActivityTab; onTab: (t: ActivityTab) => void; count: number | null; idPrefix: string }) {
  const tab = (t: ActivityTab, label: string, extra?: ReactNode) => (
    <button
      type="button"
      role="tab"
      id={`${props.idPrefix}-tab-${t}`}
      aria-selected={props.tab === t}
      aria-controls={`${props.idPrefix}-panel`}
      tabIndex={props.tab === t ? 0 : -1}
      onClick={() => props.onTab(t)}
      onKeyDown={(e) => {
        // Arrow keys move between the two tabs, as a tab list does.
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          props.onTab(t === "output" ? "background" : "output");
        }
      }}
    >
      {label}
      {extra}
    </button>
  );
  return (
    <div className="tabs" role="tablist" aria-label="Activity">
      {tab("output", "Output")}
      {tab("background", "Background", props.count !== null && props.count > 0 ? <span className="ct">{props.count}</span> : null)}
    </div>
  );
}
