// The state one Reporting page keeps (#484): the period and filters (remembered in this browser), the report they ask for,
// and the export of exactly that reply. A page shows it with the parts in ReportParts.tsx.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminError, query } from "./adminApi";
import {
  periodRange,
  rangeProblem,
  readReportPrefs,
  reportErrorText,
  saveFile,
  writeReportPrefs,
  type ReportId,
  type ReportPrefs,
  type ReportReply,
  type ReportsClient,
} from "./reportsApi";

export type FilterId = "person" | "group" | "model";
export interface ReportConfig {
  report: ReportId;
  title: string;
  lead: string;
  /** Whether the report is cut into days, weeks or months. The Admin activity and People and groups reports are not. */
  hasBy: boolean;
  filters: FilterId[];
  /** A `breakdown` the page can ask for: [value, label]. The first is the default and is not sent when it is `none`. */
  breakdowns?: [string, string][];
  /** The Admin activity report is filtered by the kind of entry. */
  kinds?: boolean;
  /** The column the chart draws, summed per period. */
  chart?: { key: string; unit: string };
  /** Totals shown above the chart, from the reply's `total`. */
  summary: { key: string; caption: string }[];
  /** The section's one-line help. */
  help: string;
}

export interface ReportState {
  cfg: ReportConfig;
  prefs: ReportPrefs;
  setPrefs: (p: Partial<ReportPrefs>) => void;
  range: { from: string; to: string };
  problem: string | null;
  path: string | null;
  reply: ReportReply | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  page: number;
  setPage: (n: number) => void;
  /** CSV and JSON download the same query and reply the table shows. */
  exportAs: (format: "csv" | "json") => Promise<void>;
  exportError: string | null;
  /** Names seen for the filters and the kind choice. */
  kinds: string[];
}

export function useReport(client: ReportsClient, cfg: ReportConfig, onLocked: () => void): ReportState {
  const [prefs, setPrefsState] = useState<ReportPrefs>(() => readReportPrefs(cfg.report, cfg.breakdowns?.[0]?.[0] ?? ""));
  const [page, setPage] = useState(1);
  const [reply, setReply] = useState<ReportReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [exportError, setExportError] = useState<string | null>(null);
  const [kinds, setKinds] = useState<string[]>([]);
  const lock = useRef(onLocked);
  lock.current = onLocked;
  const kindRef = useRef(prefs.kind);
  kindRef.current = prefs.kind;

  const setPrefs = useCallback((p: Partial<ReportPrefs>) => {
    setPrefsState((prev) => {
      const next = { ...prev, ...p };
      // Choosing Custom starts from the dates the last choice covered, so the fields are never blank.
      if (p.period === "custom" && !(prev.from && prev.to)) Object.assign(next, periodRange(prev.period, { from: prev.from, to: prev.to }));
      writeReportPrefs(cfg.report, next);
      return next;
    });
    // A new choice starts at page 1; a new page size does too.
    setPage(1);
  }, [cfg.report]);

  const range = useMemo(() => periodRange(prefs.period, { from: prefs.from, to: prefs.to }), [prefs.period, prefs.from, prefs.to]);
  const problem = rangeProblem(range.from, range.to);

  const path = useMemo(() => {
    if (problem) return null;
    const bd = cfg.breakdowns && prefs.breakdown && prefs.breakdown !== "none" ? prefs.breakdown : undefined;
    return `/reports/${cfg.report}${query({
      from: range.from,
      to: range.to,
      by: cfg.hasBy ? prefs.by : undefined,
      breakdown: bd,
      person: cfg.filters.includes("person") ? prefs.person : undefined,
      group: cfg.filters.includes("group") ? prefs.group : undefined,
      model: cfg.filters.includes("model") ? prefs.model : undefined,
      kind: cfg.kinds ? prefs.kind : undefined,
    })}`;
  }, [problem, cfg, prefs, range.from, range.to]);

  useEffect(() => {
    if (path === null) {
      setReply(null);
      setError(null);
      return;
    }
    let live = true;
    setError(null);
    setReply(null);
    client.get<ReportReply>(path).then(
      (r) => {
        if (!live) return;
        setReply(r);
        // The kinds to choose from are the ones an unfiltered reply holds.
        if (cfg.kinds && !kindRef.current) setKinds([...new Set(r.rows.map((x) => String(x.kind)))].sort());
      },
      (e: unknown) => {
        if (!live) return;
        if (e instanceof AdminError && e.status === 401) lock.current();
        else {
          setReply(null);
          setError(reportErrorText(e));
        }
      },
    );
    return () => {
      live = false;
    };
  }, [client, path, tick, cfg.kinds]);

  const exportAs = useCallback(
    async (format: "csv" | "json") => {
      setExportError(null);
      if (path === null || (format === "json" && !reply)) return;
      const name = `podium-${cfg.report}-${range.from}-${range.to}.${format}`;
      try {
        if (format === "json") saveFile(name, "application/json", JSON.stringify(reply, null, 2));
        else saveFile(name, "text/csv", await client.text(`${path}${path.includes("?") ? "&" : "?"}format=csv`));
      } catch (e) {
        if (e instanceof AdminError && e.status === 401) lock.current();
        else setExportError("Could not download the file. Try again.");
      }
    },
    [client, path, reply, cfg.report, range.from, range.to],
  );

  return { cfg, prefs, setPrefs, range, problem, path, reply, loading: path !== null && !reply && !error, error, reload: () => setTick((n) => n + 1), page, setPage, exportAs, exportError, kinds };
}
