// Orchestrator messaging on Admin > Reporters > a reporter (#347, #416, SPEC 8.1, mockup/podium-my-reporters.html, "Admin, on
// Admin > Reporters"). The Admin never overrides an owner: a change here is a proposal the owner accepts on My reporters or
// in a session, and only Pause all links applies at once. It draws the owner's reporters with the same Grid | Board as My
// reporters. Nothing of it shows while the peer-messaging flag is off.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AdminError, type AdminApi } from "./adminApi";
import { failText, useList } from "./useList";
import { LayoutSwitch, PausedTag, RightsBoard, RightsGrid, SystemTag, useRightsLayout } from "../components/PeerRights";
import { LEVEL_LABEL, LEVELS, pairKey, rightsModel, type PeerLevel, type PeerReporter, type PeerRequestView, type PeerRight } from "../peers";
import { ADMIN } from "../people";

export const PEER_FLAG = "peer-messaging";

/** A reporter as the Admin's read lists it: no state or live orchestrators, which this page does not draw. */
export type PeerRef = Pick<PeerReporter, "key" | "machine" | "owner" | "adminSecret" | "os" | "peers" | "version">;
interface Effective {
  from: string;
  to: string;
  level: PeerLevel;
  paused: boolean;
}

/**
 * The reporter, and every pair between its owner's reporters, in one read: GET /api/admin/reporters/:key/peers
 * (SPEC 7.1).
 */
export interface AdminPeers {
  reporter: PeerRef;
  peers: PeerRef[];
  rights: PeerRight[];
  effective: Effective[];
  requests: PeerRequestView[];
  /** The owner's Trust my own reporters. */
  trust: boolean;
}

/** Whether a reporter can take part at all, as the server decides it: a person's token, and not the admin secret. */
export const eligible = (r: Pick<PeerRef, "adminSecret" | "owner">): boolean => !r.adminSecret && r.owner !== null && r.owner.toLowerCase() !== ADMIN.toLowerCase();

export const loadAdminPeers = (api: AdminApi, key: string): Promise<AdminPeers> => api<AdminPeers>("GET", `/reporters/${encodeURIComponent(key)}/peers`);

/** Asks again while the page is visible, as the rest of the reporter's detail does. */
function useEvery(ms: number, run: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => document.visibilityState !== "hidden" && run(), ms);
    return () => clearInterval(id);
  }, [ms, run, enabled]);
}

export function WarnIcon() {
  return (
    <svg className="wicon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.2L14.4 13H1.6L8 2.2z" />
      <path d="M8 6.6v3" />
      <path d="M8 11.4v.1" />
    </svg>
  );
}

function Blank({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="kb-blank">
      <b>{title}</b>
      <p className="hint">{children}</p>
    </div>
  );
}

/** Why this reporter offers no choices, or null when it can take part. */
function cannot(r: PeerRef): ReactNode {
  if (r.adminSecret) {
    return (
      <Blank title="The admin secret cannot take part">
        {r.machine} reports with the admin secret, so its sessions belong to no one, and messaging only joins one person's own reporters. Once it reports with a person's token, its rights can be proposed here.
      </Blank>
    );
  }
  if (!eligible(r)) return <Blank title="This reporter belongs to no one">Messaging only joins one person's own reporters, so there is nothing to set here.</Blank>;
  if (r.peers === null) {
    return (
      <Blank title={`${r.machine}'s reporter can't message`}>
        It is too old to message. Update podium-reporter on that machine: in Claude Code there, run <span className="mono">/plugin</span>, pick podium-reporter on the Installed tab and choose Update now.
      </Blank>
    );
  }
  if (r.peers === false) {
    return (
      <Blank title={`Messaging is off on ${r.machine}`}>
        Only that machine can turn it on: in Claude Code there, run <span className="mono">/plugin configure podium-reporter</span> and set <span className="mono">peers</span> to on. Until then there is nothing to set here.
      </Blank>
    );
  }
  return null;
}

/** The Messaging row of the reporter's details: On, or why not, and Paused while every link is. */
function MessagingState({ r, paused }: { r: PeerRef; paused: boolean }) {
  if (r.peers === true && eligible(r)) {
    return (
      <>
        <span className="badge ok">
          <span className="dot running" aria-hidden="true" />
          On
        </span>
        {paused && (
          <>
            {" "}
            <PausedTag />
          </>
        )}
      </>
    );
  }
  let why = "Off on the machine";
  if (!eligible(r)) why = "Cannot take part";
  else if (r.peers === null) why = "Reporter can't message: update it";
  return (
    <span className="badge off">
      <span className="dot" aria-hidden="true" />
      {why}
    </span>
  );
}

export interface ReporterMessaging {
  /** Pause all links or Resume all links, for the detail's header; null when it offers no choices. */
  pause: ReactNode;
  /** The System and Messaging rows of the reporter's details. */
  rows: [string, ReactNode][];
  /** The Messaging section, below the details. */
  section: ReactNode;
}

const NONE: ReporterMessaging = { pause: null, rows: [], section: null };

/** Everything the reporter's detail shows of messaging. With the flag off, nothing. */
export function useReporterMessaging(api: AdminApi, reporterKey: string, onLocked: () => void, every = 10_000): ReporterMessaging {
  const settings = useList<{ features?: { id: string; on: boolean }[] }>(api, "/settings", onLocked);
  const on = settings.data?.features?.some((f) => f.id === PEER_FLAG && f.on) ?? false;
  const [data, setData] = useState<AdminPeers | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState(false);
  // A proposal sent and not yet in a read, so its select keeps the new level meanwhile.
  const [sent, setSent] = useState<Record<string, PeerLevel>>({});
  const [layout, setLayout] = useRightsLayout();
  const [boardOf, setBoardOf] = useState<string | null>(reporterKey);
  const lock = useRef(onLocked);
  lock.current = onLocked;

  // Only the newest read started may land, so an interval read taken before a proposal or a pause cannot undo it.
  const gen = useRef(0);
  const reload = useCallback(async () => {
    const at = ++gen.current;
    try {
      const d = await loadAdminPeers(api, reporterKey);
      if (gen.current !== at) return;
      setData(d);
      setLoadErr(null);
    } catch (e) {
      if (gen.current !== at) return;
      if (e instanceof AdminError && e.status === 401) lock.current();
      else setLoadErr(failText(e));
    }
  }, [api, reporterKey]);
  useEffect(() => {
    if (on) void reload();
  }, [on, reload]);
  const tick = useCallback(() => void reload(), [reload]);
  useEvery(every, tick, on);

  if (!on) return NONE;
  if (!data) {
    const body = loadErr ? (
      <div className="errbox" role="alert">
        Could not load this reporter's messaging ({loadErr}). It tries again by itself every few seconds.
      </div>
    ) : (
      <div className="hint">Loading…</div>
    );
    return { pause: null, rows: [], section: <MessagingShell help={null}>{body}</MessagingShell> };
  }

  const ref = data.reporter;
  const owner = ref.owner ?? "the owner";
  const mine = data.effective.filter((e) => e.from === ref.key || e.to === ref.key);
  const allPaused = mine.length > 0 && mine.every((e) => e.paused);
  const why = cannot(ref);
  const machine = (key: string) => data.peers.find((p) => p.key === key)?.machine ?? key;

  const act = async (run: () => Promise<unknown>, failWords: string) => {
    setBusy(true);
    try {
      await run();
      setErr(null);
      await reload();
      return true;
    } catch (e) {
      if (e instanceof AdminError && e.status === 401) lock.current();
      else setErr(`${failWords}: ${failText(e)}. Nothing changed. Try again.`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const pauseAll = async () => {
    const paused = !allPaused;
    const ok = await act(() => api("PUT", `/reporters/${encodeURIComponent(ref.key)}/peers/pause`, { paused }), paused ? "Could not pause the links" : "Could not resume the links");
    if (ok) setSaid(paused ? `Every link on ${ref.machine} is paused.` : `Links on ${ref.machine} resumed.`);
  };

  const model = rightsModel({
    reporters: data.peers.map((p) => ({ ...p, live: [] }) as unknown as PeerReporter),
    rights: data.rights,
    defaults: { trust: data.trust, onRequest: "ask", newSend: "ask", limits: {} },
    requests: data.requests,
  });
  const shown = (a: string, b: string): PeerLevel => sent[pairKey(a, b)] ?? model.proposed(a, b) ?? model.level(a, b);
  // An Admin can only propose more than a pair has: No access, and any level below today's, would take a right away,
  // which is the owner's choice. The server takes any proposal but No access, so the page holds the line.
  const below = (a: string, b: string): readonly PeerLevel[] => LEVELS.filter((l) => l === "none" || LEVELS.indexOf(l) < LEVELS.indexOf(model.level(a, b)));

  const propose = async (a: string, b: string, level: PeerLevel) => {
    if (below(a, b).includes(level) || level === shown(a, b)) return;
    const k = pairKey(a, b);
    setSent((s) => ({ ...s, [k]: level }));
    // The proposal goes through the sending reporter's page: the server takes one that involves the reporter it names.
    const ok = await act(() => api("POST", `/reporters/${encodeURIComponent(a)}/peers/propose`, { from: a, to: b, level }), "Could not send the proposal");
    setSent((s) => {
      const next = { ...s };
      delete next[k];
      return next;
    });
    if (ok) setSaid(`Proposed to ${owner}: ${machine(a)} to ${machine(b)}, ${LEVEL_LABEL[level]}.`);
  };

  const pause = why ? null : (
    // Not disabled while it saves, which would drop the focus: a second press waits for the first instead.
    <button type="button" className="btn sm" aria-busy={busy || undefined} onClick={() => !busy && void pauseAll()}>
      {allPaused ? "Resume all links" : "Pause all links"}
    </button>
  );
  const rows: [string, ReactNode][] = [
    ["System", <SystemTag key="os" os={ref.os} />],
    ["Messaging", <MessagingState key="m" r={ref} paused={allPaused} />],
  ];

  const view = { model, waitingFor: owner, shown, onSet: (a: string, b: string, l: PeerLevel) => void propose(a, b, l), showLive: false, disabledLevels: below };
  const section = (
    <MessagingShell help={eligible(ref) ? `What ${owner}'s reporters may do with each other. Only one person's own reporters can be linked.` : null} switcher={why ? null : <LayoutSwitch layout={layout} onLayout={setLayout} />}>
      {err && (
        <div className="errbox" role="alert">
          {err}
        </div>
      )}
      <div className="vh" role="status" aria-live="polite">
        {said}
      </div>
      {why ?? (
        <div className="panel">
          <div className="warnbar" role="status">
            <WarnIcon />
            <div className="tx">
              <b>A change you make here is sent to {owner} to accept.</b> It shows as Proposed until {owner} answers, in Podium or in a session on the machine. Pause all links takes effect at once and needs no answer.
            </div>
          </div>
          {data.trust && (
            <div className="warnbar" role="status">
              <WarnIcon />
              <div className="tx">
                <b>Trust my own reporters is on for {owner}.</b> Every reporter below can send to every other one, so these choices are locked until {owner} turns it off on My reporters.
              </div>
            </div>
          )}
          {layout === "grid" ? <RightsGrid {...view} /> : <RightsBoard {...view} of={boardOf} onOf={setBoardOf} />}
          <div className="pm-note">
            <p className="hint">
              {layout === "grid"
                ? "Read a row as: this reporter's orchestrators can do this to the column's. Can see lists their orchestrators with project, system and status. Can send includes Can see."
                : "Drag a card to another column, or use its Move to list. The line at the bottom of a card is what that reporter can do back."}
            </p>
            <p className="hint">You can propose more than a pair has. Taking a right away, or lowering one, is {owner}'s choice.</p>
          </div>
        </div>
      )}
    </MessagingShell>
  );
  return { pause, rows, section };
}

/** The section's heading, its help, and the Grid | Board switch beside them. */
function MessagingShell({ help, switcher, children }: { help: string | null; switcher?: ReactNode; children: ReactNode }) {
  return (
    <section className="asec" aria-labelledby="rep-msg-h">
      <div className="asec-h">
        <div>
          <h2 id="rep-msg-h">Messaging</h2>
          {help && <p className="hint">{help}</p>}
        </div>
        {switcher}
      </div>
      {children}
    </section>
  );
}
