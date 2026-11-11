import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FleetApp } from "./fleet/FleetApp";
import { AdminView } from "./fleet/admin/AdminView";
import { HistoryView } from "./fleet/HistoryView";
import { redirectFor, routeFor } from "./route";

function Root() {
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
  if (route === "history") return <HistoryView />;
  if (route === "admin") return <AdminView />;
  // The board, My reporters, My usage, Chat and Traffic are pages of the fleet console, so they are the same element with a flag: opening a
  // card keeps the selection it made, and the top bar's "N waiting" and My reporters read the same data.
  return <FleetApp board={route === "board"} myReporters={route === "my-reporters"} myUsage={route === "my-usage"} traffic={route === "traffic"} chat={route === "chat"} />;
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
