import { lazy, Suspense, useEffect, useState } from "react";
import { FleetApp } from "./fleet/FleetApp";
import { LazyBoundary } from "./LazyBoundary";
import { redirectFor, routeFor } from "./route";

// Admin and History are separate scripts, fetched the first time a viewer opens them (#754): most viewers only use the wall, and the two hold
// about twenty Admin tabs the wall never needs. A page that is fetched once stays loaded until the tab is closed.
const AdminView = lazy(() => import("./fleet/admin/AdminView").then((m) => ({ default: m.AdminView })));
const HistoryView = lazy(() => import("./fleet/HistoryView").then((m) => ({ default: m.HistoryView })));

export function Root() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const route = routeFor(hash);
  // Traffic was replaced by Chat (#1034): its address goes there, and Pause link and Remove link are on each Direct Message.
  useEffect(() => {
    const to = redirectFor(hash);
    if (to) window.location.replace(to);
  }, [hash]);
  // Loading is a short word in the muted color (the standards' empty, loading and error states).
  const loading = (
    <div className="podium">
      <div className="hint" role="status">
        Loading…
      </div>
    </div>
  );
  if (route === "history") return <LazyBoundary><Suspense fallback={loading}><HistoryView /></Suspense></LazyBoundary>;
  if (route === "admin") return <LazyBoundary><Suspense fallback={loading}><AdminView /></Suspense></LazyBoundary>;
  // The board, My reporters, My usage, Chat and Traffic are pages of the fleet console, so they are the same element with a flag: opening a
  // card keeps the selection it made, and the top bar's "N waiting" and My reporters read the same data.
  return <FleetApp board={route === "board"} myReporters={route === "my-reporters"} myUsage={route === "my-usage"} traffic={route === "traffic"} chat={route === "chat"} />;
}
