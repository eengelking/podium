import type { ReactNode } from "react";
import type { Phase } from "../store";
import { BrandLink } from "./BrandLink";
import { ConnectionPill } from "./ConnectionPill";
import { TopBarSignIn, type MyReportersLink } from "./SignIn";
import { TopBarTab } from "./TopBarTab";
import { useRespond } from "../useRespond";

export function TopBar(props: {
  page: string;
  phase: Phase;
  reporters: number;
  outdated?: number;
  newer?: number;
  collapsed?: boolean;
  onCollapse?: () => void;
  wall?: ReactNode;
  onFleet?: () => void;
  /** The My reporters link (#415), while orchestrator messaging is on and a person is signed in. */
  myReporters?: MyReportersLink;
  /** The Traffic link (#417), while orchestrator messaging is on; `current` on the Traffic page. */
  traffic?: { current: boolean };
}) {
  const { phase, reporters } = props;
  // Admin is offered only to a signed-in Administrator (#215). The server checks it again; hiding the button is not the gate.
  const admin = useRespond()?.me?.admin === true;
  return (
    <header className="top" id="podium-top" hidden={props.collapsed}>
      <BrandLink />
      <span className="pill">{props.page}</span>
      {/* Do not add anything to the right of the connection pill below. Its text changes width with the
          reporter count, so everything after it would shift. Leave that space empty for now. */}
      <ConnectionPill phase={phase} reporters={reporters} />
      {!!props.outdated && (
        <span className="pill warn" role="status" title="Update the podium-reporter mod from eengelking-marketplace">
          <span className="dot warn" aria-hidden="true" />
          {props.outdated} reporter{props.outdated === 1 ? "" : "s"} need{props.outdated === 1 ? "s" : ""} an update
        </span>
      )}
      {!!props.newer && (
        <span className="pill warn" role="status" title="Upgrade the Podium server">
          <span className="dot warn" aria-hidden="true" />
          {props.newer} reporter{props.newer === 1 ? "" : "s"} newer than the server
        </span>
      )}
      <span className="spacer" />
      {/* Fleet goes back to the wall (#346), clearing an open orchestrator too; it is a link so it still works in a new tab. The wall's own pill names it, so it is left off there. */}
      {props.page !== "Fleet" && (
        <a
          className="btn"
          href="#/"
          onClick={(e) => {
            if (!props.onFleet || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            props.onFleet();
          }}
        >
          Fleet
        </a>
      )}
      {/* The Board page's own pill names it, so the button is left off there. */}
      {props.page !== "Board" && (
        <a className="btn" href="#/board">
          Board
        </a>
      )}
      <a className="btn" href="#/history">
        History
      </a>
      {/* Traffic (#417) shows only while orchestrator messaging is on. Its map and counts are open to every reader. */}
      {props.traffic && (
        <a className="btn" href="#/traffic" aria-current={props.traffic.current ? "page" : undefined}>
          Traffic
        </a>
      )}
      {props.wall}
      {admin && (
        <a className="btn" href="#/admin" title="People, groups, reporters, settings, model prices, spend and the Admin log">
          Admin
        </a>
      )}
      {/* Sign in to respond (#206) stays at the far end, after a divider, so nothing before it moves on signing in or out. */}
      <TopBarSignIn myReporters={props.myReporters} />
      {/* Out of the flex row (absolute, at 50% of the bar), so nothing above can collide with it or move it as the pills' text changes (#91, #402). */}
      {props.onCollapse && <TopBarTab collapsed={false} onToggle={props.onCollapse} />}
    </header>
  );
}
