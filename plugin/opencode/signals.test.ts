// What OpenCode sent the reporter (#724): the events that ran and the fields the reporter reads from them, counted as the Claude Code reporter counts its hooks.
import { describe, expect, it } from 'vitest';
import { buildReport } from './report.ts';
import { apply, newStore, type BusEvent } from './state.ts';
import { VERSION } from './version.ts';

let n = 0;
const ev = (type: string, data: Record<string, unknown>, created: number): BusEvent => ({ id: `e${++n}`, created, type, data, location: { directory: '/work/project' } });
const META = { now: 9000, version: VERSION, engineVersion: null, hostSurface: null };
const ROOT = 'ses_root';

function signalsOf(...events: BusEvent[]): Record<string, number> | undefined {
  const s = newStore();
  for (const e of [ev('session.created', { sessionID: ROOT, slug: 'x', title: 't' }, 1), ...events]) apply(s, e, e.created ?? 0);
  return buildReport(s.roots.get(ROOT)!, [], META).signals;
}

describe('signals', () => {
  it('count each event that ran and each listed field it carried', () => {
    const sig = signalsOf(ev('session.step.started', { sessionID: ROOT, agent: 'build', model: 'm' }, 2), ev('session.step.started', { sessionID: ROOT, agent: 'build' }, 3));
    expect(sig).toMatchObject({ 'hook:session.created': 1, 'field:session.created.slug': 1, 'field:session.created.title': 1, 'hook:session.step.started': 2, 'field:session.step.started.agent': 2, 'field:session.step.started.model': 1 });
  });

  it('show a field that went missing: the event still counts and the field does not', () => {
    const sig = signalsOf(ev('session.tool.called', { sessionID: ROOT, id: 'c1', name: 'read' }, 2));
    expect(sig!['hook:session.tool.called']).toBe(1);
    expect(sig!['field:session.tool.called.name']).toBe(1);
    expect(sig!['field:session.tool.called.input']).toBeUndefined();
  });

  it('never carry a value, only names and counts', () => {
    const sig = signalsOf(ev('session.text.ended', { sessionID: ROOT, text: 'the secret answer' }, 2));
    expect(JSON.stringify(sig)).not.toContain('secret');
    expect(sig!['field:session.text.ended.text']).toBe(1);
  });
});
