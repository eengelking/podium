import { useEffect, useRef, useState } from "react";
import { DiffPreloader } from "../diffPreload";
import { usePageVisible } from "../usePageVisible";
import type { ChangedFile, FilesReport, SessionView } from "../types";
import { useRespond, type RespondContext } from "../useRespond";
import { FileDiffModal } from "./FileDiffModal";
import { PageNav } from "./PageNav";

/** Files shown per page; the reporter sends at most 200, so there are at most ten pages. */
export const FILES_PER_PAGE = 20;

const LETTER: Record<ChangedFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };
const MINUS = "−";

const SINCE_NOTE: Record<FilesReport["since"], string | null> = {
  start: null,
  upstream: "The commit this session started from is gone (a rebase or amend). Showing changes since the branch's upstream.",
  worktree: "The commit this session started from is gone (a rebase or amend). Showing changes in the working tree only.",
};

const plural = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

function split(path: string): [string, string] {
  const i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
}

/** Five blocks, green for the share of added lines and red for the rest. Decoration only; the counts carry the numbers. */
function ChangeBar({ added, removed }: { added: number; removed: number }) {
  const total = added + removed;
  let green = total ? Math.round((5 * added) / total) : 0;
  if (total && added && !green) green = 1;
  if (total && removed && green === 5) green = 4;
  return (
    <span className="bars" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <i key={i} className={!total ? undefined : i < green ? "g" : "r"} />
      ))}
    </span>
  );
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="cnt">
      <span className="add">+{added}</span>
      <span className="del">
        {MINUS}
        {removed}
      </span>
    </span>
  );
}

/** The fields of a session the diff gate reads. */
export type DiffSession = Pick<SessionView, "id" | "owner" | "fileDiff" | "fileDiffPreload" | "status">;

/** Whether a name is the same person's, as the server compares them: case-insensitively. */
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Whether this viewer may open a file's diff on this session (#319, SPEC 8.1): `open`, a line saying why not, or `none`
 * when the feature is not on for this server (or the session has ended), where the list is as it always was.
 */
export function diffAccess(s: DiffSession | undefined, ctx: RespondContext | null): { kind: "open" } | { kind: "why"; text: string } | { kind: "none" } {
  if (!s || !ctx?.diffOn || !ctx.me?.enabled || (s.status !== "running" && s.status !== "waiting")) return { kind: "none" };
  if (!ctx.me.signedIn) return { kind: "why", text: "Sign in to open diffs." };
  if (s.owner === null) return { kind: "why", text: "This session has no owner, so no one can open its diffs." };
  if (!ctx.me.name || !sameName(ctx.me.name, s.owner)) return { kind: "why", text: `Only ${s.owner} can open diffs.` };
  if (s.fileDiff !== true) return { kind: "why", text: "Turn on the fileDiff option of podium-reporter on this machine to open diffs." };
  return { kind: "open" };
}

/**
 * The loader for this session's diffs (#631): made when the viewer may open diffs and the reporter allows reading ahead,
 * kept in this component's memory only, and thrown away when the page, the session or the access goes. It follows the
 * report (a new file is queued, an edited one reloaded, a file that left dropped) and holds still while the tab is hidden.
 */
function useDiffPreload(session: DiffSession | undefined, files: ChangedFile[] | undefined, on: boolean): DiffPreloader | undefined {
  const ctx = useRespond();
  const fileDiff = ctx?.api.fileDiff;
  const [loader, setLoader] = useState<DiffPreloader>();
  const visible = usePageVisible();
  const id = session?.id;
  const allowed = on && !!fileDiff && !!id && session?.fileDiffPreload === true;
  useEffect(() => {
    if (!allowed || !fileDiff || !id) return;
    const made = new DiffPreloader((path, ahead) => fileDiff(id, path, ahead));
    setLoader(made);
    return () => {
      made.dispose();
      setLoader(undefined);
    };
  }, [allowed, fileDiff, id]);
  useEffect(() => {
    loader?.setPaused(!visible);
  }, [loader, visible]);
  useEffect(() => {
    if (loader && files) loader.sync(files);
  }, [loader, files]);
  return loader;
}

function FileRow({ f, onOpen }: { f: ChangedFile; onOpen?: (f: ChangedFile, from: HTMLElement) => void }) {
  const [dir, name] = split(f.path);
  const binary = f.added === null || f.removed === null;
  const inner = (
    <>
      <span className={`st ${LETTER[f.status]}`} aria-hidden="true" title={f.status}>
        {LETTER[f.status]}
      </span>
      <span className="fn" title={f.path}>
        <b>{name}</b>
        <span className="vh"> ({f.status})</span>
        {(dir || (f.status === "renamed" && f.from)) && (
          <i>
            <bdi>{dir}</bdi>
            {f.status === "renamed" && f.from ? ` \u2190 ${f.from}` : null}
          </i>
        )}
      </span>
      <span className="df">
        {binary ? (
          <span className="cnt">
            <span className="fnone" title="Binary file, no line counts">
              binary
            </span>
          </span>
        ) : (
          <>
            <Counts added={f.added!} removed={f.removed!} />
            <ChangeBar added={f.added!} removed={f.removed!} />
          </>
        )}
      </span>
    </>
  );
  if (!onOpen) return <li className={f.status}>{inner}</li>;
  return (
    <li className={`${f.status} openable`}>
      <button type="button" aria-haspopup="dialog" onClick={(e) => onOpen(f, e.currentTarget)}>
        {/* The name is the words on the row with the action in front, so what a person says to reach it is in the name (axe label-content-name-mismatch, #800). */}
        <span className="vh">Open diff of </span>
        {inner}
      </button>
    </li>
  );
}

/** The Files tab: a summary, the current page of files, and a pager when there is more than one page. */
export function FilesList({ report, hint, session }: { report: FilesReport | null; hint: string | null; session?: DiffSession }) {
  const [page, setPage] = useState(0);
  const ctx = useRespond();
  const [diffOf, setDiffOf] = useState<ChangedFile | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const access = diffAccess(session, ctx);
  const preload = useDiffPreload(session, report?.files, access.kind === "open");
  if (!report || report.files.length === 0) {
    return (
      <>
        <div className="empty">Files will appear here once a file has been updated.</div>
        {hint && <div className="foot-note">{hint}</div>}
      </>
    );
  }
  const pages = Math.ceil(report.files.length / FILES_PER_PAGE);
  const at = Math.min(page, pages - 1);
  const from = at * FILES_PER_PAGE;
  const shown = report.files.slice(from, from + FILES_PER_PAGE);
  const note = SINCE_NOTE[report.since];
  // The modal steps through every file the report holds, in this list's order. If a later report no longer has the open file, it shows that file alone.
  const idx = diffOf ? report.files.findIndex((f) => f.path === diffOf.path) : -1;
  const stepFiles = diffOf && idx < 0 ? [diffOf] : report.files;
  const open = (f: ChangedFile, from: HTMLElement) => {
    opener.current = from;
    setDiffOf(f);
  };
  const close = () => {
    setDiffOf(null);
    opener.current?.focus();
  };
  return (
    <>
      <div className="sumline">
        {plural(report.total)} {"\u00b7"} <Counts added={report.added} removed={report.removed} />
      </div>
      <ul className="files">
        {shown.map((f) => (
          <FileRow key={f.path} f={f} onOpen={access.kind === "open" ? open : undefined} />
        ))}
      </ul>
      {access.kind === "why" && <div className="foot-note" role="note">{access.text}</div>}
      {diffOf && session && <FileDiffModal sessionId={session.id} files={stepFiles} index={Math.max(idx, 0)} since={report.since} preload={preload} onStep={(i) => setDiffOf(stepFiles[i] ?? diffOf)} onClose={close} />}
      <PageNav label="Files pages" at={at} pages={pages} from={from} shown={shown.length} total={report.files.length} perPage={FILES_PER_PAGE} onPage={setPage} />
      {(report.total > report.files.length || note) && (
        <div className="foot-note">
          {report.total > report.files.length && <div>Listing the first {report.files.length} of {report.total} files.</div>}
          {note && <div>{note}</div>}
        </div>
      )}
    </>
  );
}
