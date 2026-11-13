// A table whose headings sort must not move its columns when one is clicked (#1144). Two things moved them: the arrow, which took room only
// on the sorted heading, and an automatic layout, which sizes each column to the rows on the page, and a sort changes which rows those are.
import { useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

/** The arrow of a sorted heading. Its slot is always there and always the same width, so it appearing, going or moving to another heading moves nothing. */
export function SortArrow({ dir }: { dir: 1 | -1 | 0 }) {
  return (
    <span className="sarrow" aria-hidden="true">
      {dir === 1 ? "↑" : dir === -1 ? "↓" : ""}
    </span>
  );
}

/**
 * Holds a table's columns where they were when the first heading was clicked, for as long as `scope` stays the same. A new `scope` (a new
 * reply, another filter) is different content, so the columns are sized to it again. Put `head` on the heading row, call `hold()` in the
 * heading's click, spread `tableStyle` on the table and draw `cols` as its first child. The heading row has one `th` for each column of the
 * table and none with a `colSpan`, because each `col` takes the width of the heading at its place.
 */
export function useHeldColumns(scope: unknown): { head: RefObject<HTMLTableRowElement | null>; hold: () => void; tableStyle: CSSProperties | undefined; cols: ReactNode } {
  const [held, setHeld] = useState<{ scope: unknown; widths: number[] } | null>(null);
  const head = useRef<HTMLTableRowElement>(null);
  const widths = held && held.scope === scope ? held.widths : null;
  const hold = () => {
    if (!widths && head.current) setHeld({ scope, widths: [...head.current.children].map((th) => th.getBoundingClientRect().width) });
  };
  if (!widths) return { head, hold, tableStyle: undefined, cols: null };
  return {
    head,
    hold,
    // Fixed layout keeps each column to its width; the minimum keeps a narrow screen scrolling sideways, as it did, instead of squeezing.
    tableStyle: { tableLayout: "fixed", minWidth: widths.reduce((a, b) => a + b, 0) },
    cols: (
      <colgroup>
        {widths.map((w, i) => (
          <col key={i} style={{ width: w }} />
        ))}
      </colgroup>
    ),
  };
}
