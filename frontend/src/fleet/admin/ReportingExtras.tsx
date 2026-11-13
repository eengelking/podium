// Admin > Reporting sections #724 adds to pages that already exist (mockup/podium-admin-reporting-compat.html): the projects and branches each person
// worked in (Usage), the skills sessions used (Tools) and the platform and version each reporter runs on (People and groups). Each section has its own CSV and
// JSON in its title line, for every harness. Names of people, projects, branches, skills and platforms come from reporters and are drawn as text nodes.
import { useState } from "react";
import { Pager } from "./Pager";
import { Panel, PageHeader, Section } from "./Page";
import { HarnessSelect, ReportExport, ReportFilters } from "./ReportParts";
import { resultsHeading } from "./ReportPages";
import { formatCell, harnessName, type ReportColumn, type ReportReply, type ReportRow, type ReportsClient } from "./reportsApi";
import { DataSection, useSection } from "./TimePages";
import { Waiting } from "./ToolsPage";
import { ReportBody } from "./ReportParts";
import { useReport, type ReportConfig, type ReportState } from "./useReport";

const COUNT: ReportColumn = { key: "n", label: "", unit: "count" };
const count = (v: unknown): string => formatCell(COUNT, v);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A table's rows a page at a time, 25 to start, as the server's pager would; the whole answer is already here. */
function usePaged(rows: ReportRow[]) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const last = Math.max(1, Math.ceil(rows.length / size));
  const at = Math.min(page, last);
  return { shown: rows.slice((at - 1) * size, at * size), page: at, size, setPage, setSize: (n: number) => { setSize(n); setPage(1); } };
}

// ---- Usage: projects and branches per person ------------------------------------------------------

function PlacesBody({ reply }: { reply: ReportReply }) {
  const p = usePaged(reply.rows);
  const total = reply.total ?? {};
  return (
    <>
      <div className="tw2">
        <table className="ptab" aria-label="Projects and branches per person">
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Group</th>
              <th scope="col" className="n">
                Projects
              </th>
              <th scope="col" className="n">
                Branches
              </th>
              <th scope="col">Most used project</th>
            </tr>
          </thead>
          <tbody>
            {p.shown.map((x) => (
              <tr key={text(x.person)}>
                <td className="who">{text(x.person) === "-" ? "No owner" : text(x.person)}</td>
                <td className={text(x.group) === "-" ? "muted" : undefined}>{text(x.group) === "-" ? "None" : text(x.group)}</td>
                <td className="n mono">{count(x.projects)}</td>
                <td className="n mono">{count(x.branches)}</td>
                <td className={`mono${typeof x.topProject === "string" ? "" : " muted"}`}>{typeof x.topProject === "string" ? x.topProject : "–"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Everyone in the filter</th>
              <td />
              <td className="n mono">{count(total.projects)}</td>
              <td className="n mono">{count(total.branches)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="note-line">A branch counts once per person and project, on any day in the period. The last row counts each project and branch once, not the sum of the rows. A person who worked in no git project shows a dash.</div>
      <Pager id="places" page={p.page} pageSize={p.size} total={reply.rows.length} onPage={p.setPage} onSize={p.setSize} />
    </>
  );
}

export function PlacesSection({ client, r, onLocked }: { client: ReportsClient; r: ReportState; onLocked: () => void }) {
  const s = useSection(client, r, { report: "workload", breakdown: "places", group: true, blocked: null }, onLocked);
  return (
    <DataSection
      id="rep-workload-pl"
      title="Projects and branches per person"
      help={`How many projects and git branches each person worked in, ${r.range.from} to ${r.range.to}. Names that are already on the wall; no paths.`}
      noun="projects and branches per person "
      s={s}
    >
      <Waiting reply={s.reply} error={s.error} problem={r.problem} empty="No sessions in this period.">
        {(rep) => <PlacesBody reply={rep} />}
      </Waiting>
    </DataSection>
  );
}

// ---- Tools: skills ---------------------------------------------------------------------------------

interface SkillEntry {
  skill: string;
  perHarness: Map<string, number>;
  sessions: number;
  people: number;
}

/** The skills of the reply: sessions per harness beside the total, and the people who used the skill on any harness. */
export function skillEntries(reply: ReportReply): SkillEntry[] {
  const people = new Map((reply.bySkill ?? []).map((b) => [text(b.skill), num(b.people)] as const));
  const by = new Map<string, SkillEntry>();
  for (const x of reply.rows) {
    const skill = text(x.skill);
    const e = by.get(skill) ?? { skill, perHarness: new Map<string, number>(), sessions: 0, people: people.get(skill) ?? 0 };
    e.perHarness.set(text(x.harness), (e.perHarness.get(text(x.harness)) ?? 0) + num(x.sessions));
    e.sessions += num(x.sessions);
    by.set(skill, e);
  }
  return [...by.values()].sort((a, b) => b.sessions - a.sessions || byCode(a.skill, b.skill));
}

function SkillsBody({ reply }: { reply: ReportReply }) {
  const entries = skillEntries(reply);
  const harnesses = [...new Set(reply.rows.map((x) => text(x.harness)))].sort(byCode);
  const p = usePaged(entries as unknown as ReportRow[]);
  return (
    <>
      <div className="tw2">
        <table className="ptab" aria-label="Skills">
          <thead>
            <tr>
              <th scope="col">Skill</th>
              {harnesses.map((h) => (
                <th key={h} scope="col" className="n">
                  {harnessName(h)}
                </th>
              ))}
              <th scope="col" className="n">
                Total
              </th>
              <th scope="col" className="n">
                People
              </th>
            </tr>
          </thead>
          <tbody>
            {(p.shown as unknown as SkillEntry[]).map((e) => (
              <tr key={e.skill}>
                <td className="who mono">{e.skill}</td>
                {harnesses.map((h) => (
                  <td key={h} className="n mono">
                    {count(e.perHarness.get(h) ?? 0)}
                  </td>
                ))}
                <td className="n mono">{count(e.sessions)}</td>
                <td className="n mono">{count(e.people)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="note-line">
        A figure is the sessions that used the skill, and People is how many different people ran them. Only the skill's name is kept, never what it was given. Podium's reporters see skills, not other slash commands such as /clear, so those are not listed.
      </div>
      <Pager id="skills" page={p.page} pageSize={p.size} total={entries.length} onPage={p.setPage} onSize={p.setSize} />
    </>
  );
}

export function SkillsSection({ client, r, onLocked }: { client: ReportsClient; r: ReportState; onLocked: () => void }) {
  const s = useSection(client, r, { report: "tools", breakdown: "skills", blocked: null }, onLocked);
  return (
    <DataSection id="rep-tools-sk" title="Skills" help={`How often each skill was used, by how many people, ${r.range.from} to ${r.range.to}.`} noun="skills " s={s}>
      <Waiting reply={s.reply} error={s.error} problem={r.problem} empty="No session used a skill in this period.">
        {(rep) => <SkillsBody reply={rep} />}
      </Waiting>
    </DataSection>
  );
}

// ---- People and groups: platform and reporter version ----------------------------------------------

function PlatformBody({ reply }: { reply: ReportReply }) {
  const p = usePaged(reply.rows);
  const total = reply.total ?? {};
  return (
    <>
      <div className="tw2">
        <table className="ptab" aria-label="Reporters by platform and version">
          <thead>
            <tr>
              <th scope="col">Harness</th>
              <th scope="col">Platform</th>
              <th scope="col">Reporter version</th>
              <th scope="col" className="n">
                Reporters
              </th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {p.shown.map((x) => (
              <tr key={`${text(x.harness)}-${text(x.platform)}-${text(x.version)}`}>
                <td className="who">{harnessName(text(x.harness))}</td>
                <td className={text(x.platform) === "Not reported" ? "muted" : undefined}>{text(x.platform)}</td>
                <td className="mono">{text(x.version)}</td>
                <td className="n mono">{count(x.reporters)}</td>
                <td>{text(x.status)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Reporters</th>
              <td />
              <td />
              <td className="n mono">{count(total.reporters)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="note-line">Reporters heard from in the last 30 days. The platform is the operating system's name the reporter sends, without its version, host name, user name or path. A reporter that sent none shows Not reported.</div>
      <Pager id="platform" page={p.page} pageSize={p.size} total={reply.rows.length} onPage={p.setPage} onSize={p.setSize} />
    </>
  );
}

export function PlatformSection({ client, r, onLocked }: { client: ReportsClient; r: ReportState; onLocked: () => void }) {
  const [harness, setHarness] = useState("");
  const s = useSection(client, r, { report: "harness", breakdown: "platform", harness, blocked: null }, onLocked);
  return (
    <DataSection id="rep-people-pf" title="Platform and reporter version" help="What each reporter runs on today." noun="platforms " s={s}>
      <div className="tool">
        <HarnessSelect value={harness} ids={s.reply?.harnesses ?? []} onChange={setHarness} />
      </div>
      <Waiting reply={s.reply} error={s.error} problem={r.problem} empty="No reporter was heard from in the last 30 days.">
        {(rep) => <PlatformBody reply={rep} />}
      </Waiting>
    </DataSection>
  );
}

/** People and groups: the report it had, then the platform each reporter runs on. */
export function PeoplePage({ cfg, client, onLocked }: { cfg: ReportConfig; client: ReportsClient; onLocked: () => void }) {
  const r = useReport(client, cfg, onLocked);
  const head = resultsHeading(r);
  return (
    <>
      <PageHeader title={cfg.title} lead={cfg.lead} actions={<ReportExport r={r} />} />
      <Section id={`rep-${cfg.report}-f`} title="Period and filters">
        <Panel>
          <ReportFilters client={client} r={r} />
        </Panel>
      </Section>
      <Section id={`rep-${cfg.report}-r`} title={head.title} help={head.help}>
        <Panel>
          <ReportBody r={r} />
        </Panel>
      </Section>
      {!r.problem && <PlatformSection client={client} r={r} onLocked={onLocked} />}
    </>
  );
}
