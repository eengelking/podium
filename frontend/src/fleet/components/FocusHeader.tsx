import { currentStep, inferredStep, planComplete } from "../logic";
import type { SessionView } from "../types";
import { harnessOf } from "../harness";
import { GitLine, HarnessBadge, StateIcon, type StateKind } from "./Chips";
import { MiniCharts } from "./MiniCharts";

/** Layer one of the summary surface: who it is, what it is doing, where. The state shape beside the name is the status band's shape. */
export function FocusHeader({ s, kind, now, showHarness }: { s: SessionView; kind: StateKind; now: number; showHarness?: boolean }) {
  const harness = harnessOf(s.harness);
  const step = currentStep(s.plan);
  const next = step ? null : inferredStep(s.plan);
  return (
    <div className="fh">
      <div className="id">
        <h1>
          <span className="sd">
            <StateIcon kind={kind} />
          </span>
          {s.name}
          {showHarness && <HarnessBadge harness={s.harness} />}
        </h1>
        {s.plan ? (
          <div className="goal">
            {s.plan.title ?? "Plan"}
            {step ? <span> · now: {step}</span> : null}
            {next ? (
              <span title="Claude has not marked this in progress yet. Podium shows the first step not started.">
                {" "}· now: {next.text} <em>(inferred)</em>
              </span>
            ) : null}
            {planComplete(s.plan) ? <span> · plan complete</span> : null}
          </div>
        ) : (
          <div className="goal">
            <span>No plan reported. Agents were launched ad hoc.</span>
          </div>
        )}
        <div className="sub mono">
          <span title="Working directory">{s.cwd}</span>
          {s.repoName && (
            <>
              <span className="sep" aria-hidden="true">
                |
              </span>
              <span title="Repository">{s.repoName}</span>
            </>
          )}
        </div>
        <GitLine git={s.git} />
        {!harness.context && <div className="goal">
            <span>{harness.name} does not report context size.</span>
          </div>}
      </div>
      <MiniCharts s={s} now={now} />
    </div>
  );
}
