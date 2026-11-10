// Features that stopped after a harness update (#724): the part of Admin > Reporting > Harness updates that compares one version of a harness with the one before it.
// Pure: it reads counts that were already rolled up (names and counts only) and decides which hook, event field or tool name a version stopped sending.

/** What makes a feature "stopped". The numbers keep one machine, a rarely used tool or a quiet week from raising a false alarm (#724). */
export const STOPPED = {
  /** The share of the previous version's sessions that sent it, at least. */
  minBeforeShare: 0.25,
  /** The new version's share must be under this fraction of the earlier one. */
  dropTo: 0.1,
  /** Sessions to compare against, on each of the two versions, at least. */
  minSessions: 20,
  /** Reporters on the new version, at least. */
  minReporters: 2,
} as const;

/** One version of one harness over the period: the sessions there were to compare against, how many sent each feature, and the reporters on it. */
export interface VersionFacts {
  harness: string;
  version: string;
  /** Sessions whose reporter sent signals (what `hook:` and `field:` features are measured against), and sessions with tool counts (what `tool:` features are measured against). */
  base: { signals: number; tools: number };
  /** Feature name (`hook:...`, `field:...`, `tool:...`) to the sessions that sent it. */
  features: Map<string, number>;
  reporters: number;
}

export type FeatureKind = 'hook' | 'field' | 'tool';

export interface Stopped {
  harness: string;
  version: string;
  /** The version it was compared with: the nearest earlier one with enough sessions. */
  previous: string;
  feature: string;
  kind: FeatureKind;
  /** The share of sessions on the previous version that sent it, and on this version, as whole percents. */
  before: number;
  now: number;
  reporters: number;
}

const kindOf = (feature: string): FeatureKind | null => (feature.startsWith('hook:') ? 'hook' : feature.startsWith('field:') ? 'field' : feature.startsWith('tool:') ? 'tool' : null);
const baseOf = (v: VersionFacts, kind: FeatureKind): number => (kind === 'tool' ? v.base.tools : v.base.signals);

/**
 * Each version is compared with the nearest earlier version of the same harness that has enough sessions, never with another harness. A feature is listed against the
 * first version that lost it: the version after that compares with one that already lacks it, so it is not listed again. A version that changed nothing lists nothing.
 */
export function detectStopped(versions: readonly VersionFacts[], compare: (a: string, b: string) => number): Stopped[] {
  const out: Stopped[] = [];
  const byHarness = new Map<string, VersionFacts[]>();
  for (const v of versions) byHarness.set(v.harness, [...(byHarness.get(v.harness) ?? []), v]);
  for (const [harness, list] of byHarness) {
    const ordered = [...list].sort((a, b) => compare(a.version, b.version) || (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
    ordered.forEach((v, i) => {
      if (v.reporters < STOPPED.minReporters) return;
      for (const kind of ['hook', 'field', 'tool'] as const) {
        const nowBase = baseOf(v, kind);
        if (nowBase < STOPPED.minSessions) continue;
        let prev: VersionFacts | undefined;
        for (let j = i - 1; j >= 0; j--) {
          if (baseOf(ordered[j]!, kind) >= STOPPED.minSessions) {
            prev = ordered[j];
            break;
          }
        }
        if (!prev) continue;
        const prevBase = baseOf(prev, kind);
        for (const [feature, sent] of prev.features) {
          if (kindOf(feature) !== kind) continue;
          const before = sent / prevBase;
          if (before < STOPPED.minBeforeShare) continue;
          const now = (v.features.get(feature) ?? 0) / nowBase;
          if (now >= before * STOPPED.dropTo) continue;
          out.push({ harness, version: v.version, previous: prev.version, feature, kind, before: Math.round(before * 100), now: Math.round(now * 100), reporters: v.reporters });
        }
      }
    });
  }
  return out.sort((a, b) => (a.harness < b.harness ? -1 : a.harness > b.harness ? 1 : 0) || compare(b.version, a.version) || b.before - a.before || (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0));
}

/** What the Admin sees stop working with a hook or field the reporter relies on. A name that is not here shows nothing: the feature is still listed. */
const EFFECTS: Readonly<Record<string, string>> = {
  'hook:session.measure': 'Context, cost and rate limits stop updating.',
  'field:session.measure.cost': 'Cost shows a dash.',
  'field:session.measure.context': 'Context fullness shows a dash.',
  'field:session.measure.rateLimits': 'Rate limits show a dash.',
  'hook:turn.step': 'Model and effort stop updating.',
  'field:turn.step.model': 'The model is not shown.',
  'field:turn.step.effort': 'Effort shows as not reported.',
  'hook:turn.complete': 'Answers and how a turn ended are not reported.',
  'hook:agent.spawn': 'Agents a session launches are not listed.',
  'hook:tool.call': 'Tool calls, their counts and lengths are not reported.',
  'field:tool.call.tool_use_id': 'A call is not matched to its result, so call length and failures drop out.',
  'hook:tool.check': 'Permission prompts are not counted.',
  'hook:classic.PermissionRequest': 'Answering a permission prompt from Podium stops working.',
  'hook:classic.Notification': 'Waiting for a person is not noticed.',
  'hook:classic.Stop': 'Background work is not reported.',
  'field:classic.Stop.background_tasks': 'Background work is not reported.',
  'hook:session.compact': 'Compactions are not counted.',
  'hook:skill.prompt': 'Skills are not listed.',
  'hook:command.run': 'The /podium command stops working.',
  'hook:session.tool.called': 'Tool calls, their counts and lengths are not reported.',
  'field:session.tool.called.name': 'Tool calls are counted under no name.',
  'hook:permission.asked': 'Permission prompts are not counted.',
  'hook:session.usage.updated': 'Cost and tokens stop updating.',
  'field:session.usage.updated.cost': 'Cost shows a dash.',
  'hook:session.step.started': 'Model and agent stop updating.',
  'hook:session.skill.activated': 'Skills are not listed.',
  'hook:session.compaction.failed': 'Compaction failures are not reported.',
};

const HARNESS_NAMES: Readonly<Record<string, string>> = { 'claude-code': 'Claude Code', opencode: 'OpenCode' };
export const harnessName = (id: string): string => HARNESS_NAMES[id] ?? id;

/** One line on what a stopped feature affects, or an empty string when nothing is known about it. A tool name is not something the reporter relies on, so it says what the report loses. */
export function effectOf(harness: string, feature: string): string {
  if (feature.startsWith('tool:')) return `Calls by tool shows no ${feature.slice(5)} for ${harnessName(harness)}. A person may simply have stopped using it.`;
  return EFFECTS[feature] ?? '';
}
