import { useEffect } from "react";
import { RespondProvider, useRespond } from "../useRespond";
import { useFleet, type UseFleetOptions } from "../useFleet";
import { useMyPeers } from "../useMyPeers";
import { peersApi as livePeersApi, type PeersApi, type RespondApi } from "../respondApi";
import { ADMIN } from "../people";
import { reportersLive } from "../store";
import { TopBar } from "./TopBar";

/**
 * The shared top bar for a page that has no wall of its own (History #452, Admin #468). It owns the fleet stream, so the
 * stream's ticks redraw only the bar and not the page below, and gives the bar what it reads: the live reporter count, the
 * connection, who is signed in, and the Traffic and My reporters links while orchestrator messaging is on. There is no Hide
 * top bar or wall button here: the page has no wall, and the bar is one line.
 */
export function StreamTopBar({ page, base, fleetOptions, respondApi, peersApi, onSignInChange }: { page: string; base?: string; fleetOptions?: UseFleetOptions; respondApi?: RespondApi; peersApi?: PeersApi; onSignInChange?: (signedIn: boolean) => void }) {
  const fleet = useFleet({ ...(base ? { base } : {}), ...fleetOptions });
  const flagsOn = fleet.features.respond === true && fleet.features["activity-feed"] !== false;
  return (
    <RespondProvider flagsOn={flagsOn} diffOn={fleet.features["file-diff"] === true} historyOn={fleet.features["activity-history"] === true} recordingOn={fleet.features["session-recording"] === true} peersOn={fleet.features["peer-messaging"] === true} api={respondApi}>
      <Bar page={page} fleet={fleet} peersApi={peersApi} onSignInChange={onSignInChange} />
    </RespondProvider>
  );
}

function Bar({ page, fleet, peersApi = livePeersApi, onSignInChange }: { page: string; fleet: ReturnType<typeof useFleet>; peersApi?: PeersApi; onSignInChange?: (signedIn: boolean) => void }) {
  const signedIn = useRespond()?.me;
  const me = signedIn?.signedIn && signedIn.name && signedIn.name.toLowerCase() !== ADMIN.toLowerCase() ? signedIn.name : null;
  // A page that shows more to a signed-in person (History's kept recordings) reads again when the sign-in changes.
  const isIn = signedIn?.signedIn === true;
  useEffect(() => {
    onSignInChange?.(isIn);
  }, [isIn, onSignInChange]);
  const peersOn = fleet.features["peer-messaging"] === true;
  const peers = useMyPeers(peersApi, peersOn && me !== null, false);
  return (
    <TopBar
      page={page}
      phase={fleet.phase}
      reporters={reportersLive(fleet.sessions, fleet.leaving)}
      myReporters={peersOn && me !== null ? { count: peers.data ? peers.data.requests.length : null, current: false } : undefined}
      traffic={peersOn ? { current: false } : undefined}
    />
  );
}
