import type { ReactNode } from "react";

/**
 * The footer shared by the Files tab, the Plan tab and the left list: the range shown, then page buttons once there is more than one page.
 * `compact` swaps the button per page for "1 of 3" between Previous and Next, for the narrow left list; `children` sit below the row.
 */
export function PageNav(props: { label: string; at: number; pages: number; from: number; shown: number; total: number; perPage: number; onPage: (page: number) => void; compact?: boolean; children?: ReactNode }) {
  const { label, at, pages, from, shown, total, perPage, onPage, compact, children } = props;
  return (
    <div className="pager">
      <span>
        Showing {from + 1}
        {"–"}
        {from + shown} of {total}
      </span>
      {pages > 1 ? (
        <nav className="pg" aria-label={label}>
          <button type="button" aria-label="Previous page" disabled={at === 0} onClick={() => onPage(at - 1)}>
            {"‹"}
          </button>
          {compact ? (
            <span className="at">
              {at + 1} of {pages}
            </span>
          ) : (
            Array.from({ length: pages }, (_, i) => (
              <button key={i} type="button" aria-current={i === at ? "page" : undefined} onClick={() => onPage(i)}>
                {i + 1}
              </button>
            ))
          )}
          <button type="button" aria-label="Next page" disabled={at === pages - 1} onClick={() => onPage(at + 1)}>
            {"›"}
          </button>
        </nav>
      ) : (
        <span>{perPage} per page</span>
      )}
      {children}
    </div>
  );
}
