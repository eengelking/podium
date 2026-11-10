// The header's count of features that stopped after a harness update (#724): what GET /api/admin/notice answers an unlocked Admin, and the hook that asks for it.
// The route says nothing to a locked page, and asking never counts as Admin activity, so it does not hold off the idle lock.
import { useEffect, useState } from "react";

/** Where the pill leads. Admin follows `#/admin/<page>` for pages a link elsewhere in the console can open. */
export const HARNESS_UPDATES_HASH = "#/admin/harness";
/** How often the header asks again. The count is built from daily rollups, so a few minutes is plenty. */
export const STOPPED_POLL_MS = 5 * 60_000;

/** The number of features to show, or 0 for nothing: locked, none stopped, or no answer. */
export function stoppedOf(body: unknown): number {
  const b = body as { unlocked?: unknown; stopped?: unknown } | null;
  return b?.unlocked === true && typeof b.stopped === "number" && Number.isFinite(b.stopped) && b.stopped > 0 ? Math.floor(b.stopped) : 0;
}

/** Reads the count once, then every few minutes while the page is visible. A failed read keeps what was known. */
export function useStoppedFeatures(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const read = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const r = await fetch("/api/admin/notice", { cache: "no-store", credentials: "same-origin" });
        if (live && r.ok) setN(stoppedOf(await r.json()));
      } catch {
        // No answer: the header shows nothing new.
      }
    };
    void read();
    const id = setInterval(() => void read(), STOPPED_POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);
  return n;
}
