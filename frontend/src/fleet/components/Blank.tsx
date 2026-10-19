import type { ReactNode } from "react";

/** The empty-state block: a dashed box with a title and a hint. Why a page has nothing to show, or no choices to offer. */
export function Blank({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="kb-blank">
      <b>{title}</b>
      <p className="hint">{children}</p>
    </div>
  );
}
