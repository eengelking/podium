import type { Phase } from "../store";

/** The connection pill both top bars show: "N reporters live", or why that number isn't known yet. */
export function ConnectionPill({ phase, reporters }: { phase: Phase; reporters: number }) {
  if (phase === "disconnected") {
    return (
      <span className="pill bad" role="status" data-testid="connection-pill" data-state="disconnected">
        <span className="dot bad" aria-hidden="true" />
        disconnected, retrying
      </span>
    );
  }
  if (phase === "loading") {
    return (
      <span className="pill" role="status" data-testid="connection-pill" data-state="loading">
        <span className="dot" aria-hidden="true" />
        connecting…
      </span>
    );
  }
  return (
    <span className="pill" role="status" data-testid="connection-pill" data-state="live">
      <span className="dot running" aria-hidden="true" />
      {reporters} reporter{reporters === 1 ? "" : "s"} live
    </span>
  );
}
