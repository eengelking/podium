// Admin > Reporting > Spend (#484, #482, #483): three sections in order. Spend today (with the breakdown a row opens),
// the Projection, and Spend over time, which is the shared report with the page's Export. Figures are estimated from tokens.
import type { UseFleetOptions } from "../useFleet";
import { PageHeader, Panel, Section } from "./Page";
import { ReportBody, ReportExport, ReportFilters } from "./ReportParts";
import { SPEND_CONFIG, resultsHeading } from "./ReportPages";
import type { ReportsClient } from "./reportsApi";
import { SpendProjection } from "./SpendProjection";
import { SpendTab } from "./SpendTab";
import { useReport } from "./useReport";

export function SpendPage(props: { client: ReportsClient; fleetOptions?: UseFleetOptions; onCount: (n: number) => void; onLocked: () => void }) {
  const { client, onLocked } = props;
  const r = useReport(client, SPEND_CONFIG, onLocked);
  const head = resultsHeading(r);
  return (
    <>
      <PageHeader title={SPEND_CONFIG.title} lead={SPEND_CONFIG.lead} actions={<ReportExport r={r} noun="spend over time " />} />
      <SpendTab fleetOptions={props.fleetOptions} onCount={props.onCount} client={client} onLocked={onLocked} />
      <SpendProjection client={client} onLocked={onLocked} />
      <Section id="rep-spend-r" title="Spend over time" help={head.help}>
        <Panel>
          <ReportFilters client={client} r={r} />
          <ReportBody r={r} />
        </Panel>
      </Section>
    </>
  );
}
