import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { RespondError } from "../respondApi";
import { replayLine, fmtWhen, leaveReplay, sizeWords } from "../recording";
import { buildItems, COLLAPSE_AT, firstLine, nextFailure, tailLines, type ReplayItem } from "../replayItems";
import type { RecordingGrant, RecordingLoopInfo, RecordingPage, RecordingRow, SessionView } from "../types";
import { nameKey } from "../respond";
import { useRespond } from "../useRespond";
import { feedTime, ICON_REASONING, ICON_TEXT, ICON_TOOL, ICON_YOU, Redacted } from "./ActivityFeed";
import { Blank } from "./Blank";
import { IconBack, IconX } from "./Icons";
import { ConfirmBox, recordingFail } from "./RecordingLayer";

const LABEL: Record<ReplayItem["kind"], string> = { prompt: "Prompt", text: "Text", thinking: "Reasoning", tool: "Tool call", result: "Tool result", decision: "Sent from Podium", mark: "Note" };
const ICON: Record<ReplayItem["kind"], ReactNode> = { prompt: ICON_YOU, text: ICON_TEXT, thinking: ICON_REASONING, tool: ICON_TOOL, result: ICON_TOOL, decision: ICON_YOU, mark: ICON_TEXT };
const CLASS: Record<ReplayItem["kind"], string> = { prompt: "you", text: "txt", thinking: "txt", tool: "tool", result: "tool", decision: "you", mark: "txt" };

/** The longest a loop's name gets in the filter before it is cut; the whole name is the option's title. */
const NAME_CUT = 28;

type Load =
  | { state: "loading" }
  | { state: "error"; status: number | null; message: string; owner: string | null; unavailable?: true }
  | { state: "ok"; rows: RecordingRow[]; olderBefore: number | null; total: number; grant: RecordingGrant; owner: string | null };

/** A text that may be long: short ones as they are, long ones cut with the whole text one click away. Text only, never HTML. */
function Long({ text, label }: { text: string; label: string }) {
  if (text.length <= COLLAPSE_AT) return <Redacted text={text} />;
  return (
    <>
      <Redacted text={`${text.slice(0, COLLAPSE_AT)}…`} />
      <details className="res">
        <summary>
          {label} ({text.length.toLocaleString("en-US")} characters)
        </summary>
        <pre className="code">{text}</pre>
      </details>
    </>
  );
}

/** A tool call's result under it, collapsed to a few lines until opened. */
function Result({ row }: { row: RecordingRow }) {
  return (
    <details className="res">
      <summary>Result{row.failed ? " (failed)" : ""}</summary>
      <pre className="code">{row.text || "No output."}</pre>
    </details>
  );
}

/** The failure box for a call whose result failed: the call and the tail of its output, in the same box a failed agent uses. */
function Failed({ call, result }: { call: string; result: RecordingRow }) {
  return (
    <div className="failbox">
      <div className="fh2">
        <IconX />
        {result.name ? `${result.name} failed` : "tool call failed"}
      </div>
      <div className="fb">
        <div>
          <span className="lab">Failing call{result.name ? ` · ${result.name}` : ""}</span>
          <pre className="code">{call || "not recorded"}</pre>
        </div>
        {result.text && (
          <div>
            <span className="lab">Output</span>
            <pre className="code">{tailLines(result.text)}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ item, i, startedAt, who, cur, me }: { item: ReplayItem; i: number; startedAt: number; who: string; cur: boolean; me: string | null }) {
  const { row } = item;
  const text = row.text;
  let body: ReactNode;
  if (item.kind === "tool") {
    const { line, more } = firstLine(text);
    body = (
      <>
        <span className="name">{row.name ?? "Tool"}</span>{" "}
        <span className="arg">
          <Redacted text={line} />
          {more ? "…" : ""}
        </span>
        {more && (
          <details className="res">
            <summary>Whole input ({text.length.toLocaleString("en-US")} characters)</summary>
            <pre className="code">{text}</pre>
          </details>
        )}
        {item.result && <Result row={item.result} />}
        {item.failed && item.result && <Failed call={line} result={item.result} />}
      </>
    );
  } else if (item.kind === "result") {
    body = (
      <>
        <span className="name">{row.name ?? "Tool"}</span> <span className="arg">result of a call on an older page</span>
        <Result row={row} />
      </>
    );
  } else if (item.kind === "decision") {
    body = (
      <>
        <span className="name">{item.label}</span>
        {text && (
          <>
            {" "}
            <span className="arg">
              <Redacted text={text} />
            </span>
          </>
        )}
        {item.failed && (
          <div className="failbox">
            <div className="fh2">
              <IconX />
              {item.label}
            </div>
            {text && (
              <div className="fb">
                <pre className="code">{text}</pre>
              </div>
            )}
          </div>
        )}
      </>
    );
  } else if (item.kind === "thinking") {
    body = <span className="hint">Thinking: text is not available</span>;
  } else if (item.kind === "mark") {
    body = <span>{item.mark}</span>;
  } else {
    body = <Long text={text} label="Whole text" />;
  }
  // What was sent from Podium is attributed as the Activity feed does: "You, from Podium" for the signed-in viewer.
  const sender = item.by === undefined ? null : item.by ? (me && nameKey(item.by) === nameKey(me) ? "You" : item.by) : "Someone";
  const speaker = sender ? `${sender}, from Podium` : item.podium ? "Podium" : who;
  return (
    <li className={`${CLASS[item.kind]}${item.kind === "mark" ? " mark" : ""}${cur ? " cur" : ""}`} data-i={i} aria-current={cur ? "true" : undefined}>
      <span className="at" title={new Date(row.at).toLocaleTimeString()}>
        {feedTime(row.at, startedAt)}
      </span>
      <span className="k" role="img" aria-label={LABEL[item.kind]} title={LABEL[item.kind]}>
        {ICON[item.kind]}
      </span>
      <span className="body">
        <span className="who" title={speaker}>
          {speaker}:
        </span>
        {body}
      </span>
    </li>
  );
}

const cut = (s: string) => (s.length > NAME_CUT ? `${s.slice(0, NAME_CUT - 1)}…` : s);

/**
 * A recording's replay (#353, mockup/podium-recording.html), at `#/?open=<id>&replay`: the Activity feed's rows, oldest first, the
 * loop's name before each, a collapsed result under each tool call. A loop filter, a position slider and Jump to next failure move
 * through it. The newest 200 rows load, and Show older pages back. Read-only: nothing here runs anything or reaches the session.
 */
export function ReplayPage({ id, session, now }: { id: string; session: SessionView | null; now: number }) {
  const respond = useRespond();
  const api = respond?.api;
  const uid = useId();
  const [filter, setFilter] = useState("");
  const [tries, setTries] = useState(0);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [loops, setLoops] = useState<RecordingLoopInfo[]>([]);
  const [cur, setCur] = useState(0);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderErr, setOlderErr] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  const [fetchedName, setFetchedName] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  // Counts the loads of page one: an older page that comes back after the loop filter changed belongs to rows no longer shown.
  const epoch = useRef(0);

  // The name of a session the fleet no longer holds (one that ended) comes from its stored page.
  useEffect(() => {
    if (session) return;
    let live = true;
    try {
      void fetch(`/api/fleet/sessions/${encodeURIComponent(id)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { name?: unknown } | null) => {
          if (live && b && typeof b.name === "string") setFetchedName(b.name);
        })
        .catch(() => undefined);
    } catch {
      // No way to ask: the short id stands in for the name.
    }
    return () => {
      live = false;
    };
  }, [id, session]);
  const name = session?.name ?? fetchedName ?? id.slice(0, 8);

  const fetchPage = api?.recordingPage;
  useEffect(() => {
    let live = true;
    epoch.current++;
    setLoad({ state: "loading" });
    setCur(0);
    if (!fetchPage) {
      setLoad({ state: "error", status: null, message: "the recording cannot be read from here", owner: null, unavailable: true });
      return;
    }
    fetchPage(id, { loop: filter || null })
      .then((p: RecordingPage) => {
        if (!live) return;
        setLoops(p.loops);
        setLoad({ state: "ok", rows: p.entries, olderBefore: p.olderBefore, total: p.total, grant: p.grant, owner: p.owner });
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof RespondError) setLoad({ state: "error", status: e.status, message: e.message, owner: typeof e.body.owner === "string" ? e.body.owner : null });
        else setLoad({ state: "error", status: null, message: "could not reach the server", owner: null });
      });
    return () => {
      live = false;
    };
  }, [fetchPage, id, filter, tries]);

  // A viewer who was asked to sign in, and then does, gets the recording without reloading. Opening it is written to the Admin log, so
  // it is asked for again only after that refusal, never because the sign-in state arrived.
  const signedIn = respond?.me?.signedIn === true;
  const refused = load.state === "error" && load.status === 401;
  const was = useRef(signedIn);
  useEffect(() => {
    if (signedIn && !was.current && refused) setTries((n) => n + 1);
    was.current = signedIn;
  }, [signedIn, refused]);

  const rows = load.state === "ok" ? load.rows : null;
  const items = useMemo(() => buildItems(rows ?? []), [rows]);
  const names = useMemo(() => new Map(loops.map((l) => [l.loop, l.name])), [loops]);
  const goTo = useCallback((i: number) => {
    setCur(i);
    list.current?.querySelector<HTMLElement>(`li[data-i="${i}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, []);

  const older = async () => {
    if (load.state !== "ok" || load.olderBefore === null || !fetchPage) return;
    setOlderBusy(true);
    setOlderErr(null);
    const mine = epoch.current;
    try {
      const p = await fetchPage(id, { before: load.olderBefore, loop: filter || null });
      if (epoch.current !== mine) return;
      const before = buildItems(load.rows).length;
      setLoad({ ...load, rows: [...p.entries, ...load.rows], olderBefore: p.olderBefore, total: p.total });
      // Rows added above push the one the slider is on down by as many places as they add.
      const added = buildItems([...p.entries, ...load.rows]).length - before;
      setCur((c) => c + added);
    } catch (e) {
      setOlderErr(recordingFail(e, "load older rows"));
    } finally {
      setOlderBusy(false);
    }
  };
  const remove = async () => {
    if (!api?.recordingDelete) return;
    setBusy(true);
    setDelErr(null);
    try {
      await api.recordingDelete(id);
      leaveReplay(id, session !== null);
    } catch (e) {
      setDelErr(recordingFail(e, "delete the recording"));
      setAsking(false);
    } finally {
      setBusy(false);
    }
  };

  const back = (
    <button type="button" className="back" onClick={() => leaveReplay(id, session !== null)}>
      <IconBack />
      Back to {name}
    </button>
  );

  if (load.state === "error" && (load.status === 401 || load.status === 403 || load.status === 404)) {
    const refusal =
      load.status === 401 ? (
        <Blank title="Sign in to open this recording">Use Sign in in the top bar, with your name and token. Only the session&apos;s owner, or an Admin, can open the recording.</Blank>
      ) : load.status === 403 ? (
        <Blank title="This session was recorded">Only {load.owner && load.owner !== "Admin" ? load.owner : "its owner"} or an Admin can open the recording.</Blank>
      ) : (
        <Blank title="There is no recording to open">It was deleted, it has expired, or this session was never recorded.</Blank>
      );
    return (
      <div className="replay">
        {back}
        {refusal}
      </div>
    );
  }

  const ok = load.state === "ok" ? load : null;
  const startedAt = ok?.grant.startedAt ?? ok?.rows[0]?.at ?? 0;
  const needsHours = items.some((it) => it.row.at - startedAt >= 3_600_000);
  const header = (
    <div className="osum">
      <div className="fh">
        <div className="id">
          <h1>{name}</h1>
          <div className="goal">Replay of a recording</div>
          {ok && <div className="sub">{replayLine(ok.grant, session ? session.status === "done" : true, now)}</div>}
          <p>
            The model&apos;s thinking text is not available. Claude Code gives Podium the thinking without its text on the models tested, so a place where the model thought is marked and shows nothing. An empty place does not mean it did not think.
          </p>
        </div>
      </div>
    </div>
  );

  let main: ReactNode;
  if (load.state === "loading") {
    main = (
      <div className="loading" role="status">
        Loading…
      </div>
    );
  } else if (load.state === "error") {
    main = (
      <>
        <div className="errbox" role="alert">
          {load.unavailable ? "This page cannot open recordings. Reload it, and sign in from the top bar if you are not signed in." : `Could not load the recording${load.status ? `: HTTP ${load.status}` : `: ${load.message}`}. Try again.`}
        </div>
        {!load.unavailable && (
          <div className="formacts">
            <button type="button" className="btn pri" onClick={() => setTries((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
      </>
    );
  } else if (load.rows.length === 0 && filter === "") {
    main = <Blank title="Nothing has been recorded yet">Recording started{load.grant.startedAt !== null ? ` at ${fmtWhen(load.grant.startedAt, now, false)}` : ""} and no loop has done anything since. Reload to look again.</Blank>;
  } else {
    const shown = load.rows.length;
    const pos = items.length ? `Row ${Math.min(cur, items.length - 1) + 1} of ${items.length}` : "No rows";
    main = (
      <>
        {asking && (
          <ConfirmBox title="Delete this recording?" doLabel="Delete recording" busy={busy} onDo={() => void remove()} onCancel={() => setAsking(false)}>
            The whole recording, {sizeWords(load.grant.bytes)}, is removed for good, and you go back to the orchestrator page. The session, History and the live feed are not touched. This is written to the Admin log.
          </ConfirmBox>
        )}
        {delErr && (
          <div className="errbox" role="alert">
            {delErr}
          </div>
        )}
        <section className="sec" aria-label="Recorded activity">
          <div className="sh">
            <h2>Recorded activity</h2>
            <span className="src">Oldest first. Read-only: a replay never runs anything or sends anything to the session.</span>
          </div>
          <div className="tools">
            <span className="live">
              <label className="sub" htmlFor={`${uid}-loop`}>
                Loop
              </label>
              <select id={`${uid}-loop`} value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="">All loops</option>
                {loops.map((l) => (
                  <option key={l.loop} value={l.loop} title={l.name}>
                    {cut(l.name)}
                  </option>
                ))}
              </select>
            </span>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                const k = nextFailure(items, cur);
                if (k >= 0) goTo(k);
              }}
              disabled={!items.some((it) => it.failed)}
              title={items.some((it) => it.failed) ? undefined : load.olderBefore !== null ? "No call failed in the rows loaded. Show older rows to look further." : "No call failed."}
            >
              Jump to next failure
            </button>
          </div>
          <div className="scrub">
            <label className="hint" htmlFor={`${uid}-pos`}>
              Position
            </label>
            <input id={`${uid}-pos`} type="range" min={0} max={Math.max(0, items.length - 1)} value={Math.min(cur, items.length - 1)} aria-valuetext={pos} onChange={(e) => goTo(Number(e.target.value))} />
            <span className="hint mono" role="status">
              {pos}
            </span>
          </div>
          <ol className={needsHours ? "feed hours" : "feed"} ref={list} aria-label="Recorded activity, oldest first" tabIndex={0}>
            {items.length === 0 && <li className="empty">No rows for this loop.</li>}
            {items.map((it, i) => (
              <Row key={it.key} item={it} i={i} startedAt={startedAt} who={names.get(it.row.loop) ?? it.row.loop} cur={i === cur} me={respond?.me?.signedIn ? respond.me.name : null} />
            ))}
          </ol>
          <div className="feedfoot stat older">
            <span className="count" role="status">
              {load.olderBefore !== null ? `Showing the newest ${shown} of ${load.total}` : `Showing all ${load.total}`}
            </span>
            {load.olderBefore !== null && (
              <button type="button" className="btn sm" disabled={olderBusy} onClick={() => void older()}>
                Show older
              </button>
            )}
          </div>
          {olderErr && (
            <div className="feedfoot" role="alert">
              <span>{olderErr}</span>
            </div>
          )}
          <div className="feedfoot">
            <span>
              {load.grant.keptUntil !== null ? `Kept until ${fmtWhen(load.grant.keptUntil, now)}, then deleted.` : "Kept until it expires, then deleted."} Only the owner and an Admin can open it.
            </span>
            <button type="button" className="btn sm bad" onClick={() => setAsking(true)}>
              Delete recording
            </button>
          </div>
        </section>
      </>
    );
  }
  return (
    <div className="replay">
      {back}
      {header}
      {main}
    </div>
  );
}
