// Synthetic OpenCode event streams for scripts/opencode-reporter.test.ts (#1025). They are written by hand with the shapes OpenCode 2.2.5
// puts on its bus (the ones #848 recorded), so the replay runs in CI with no OpenCode and no recording in the repository. Ids are short and
// made up, every directory is /work/project and the provider is `mock`.
import type { BusEvent } from '../plugin/opencode/state.ts';

const DIR = { directory: '/work/project' };
const MODEL = { id: 'mock', providerID: 'mock' };
const STEP = { cost: 0.00014, tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } };
const usage = (n: number) => ({ cost: Number((STEP.cost * n).toFixed(5)), tokens: { input: 100 * n, output: 20 * n, reasoning: 0, cache: { read: 0, write: 0 } } });
const START = 1_700_000_000_000;

/** Builds a stream: each `at(ms, type, sessionID, data)` appends one event `ms` after the start. */
class Stream {
  readonly events: BusEvent[] = [];
  private n = 0;
  at(ms: number, type: string, sid: string, data: Record<string, unknown> = {}, withDir = true): this {
    this.events.push({ id: `evt_${++this.n}`, created: START + ms, type, ...(withDir ? { location: DIR } : {}), data: { sessionID: sid, ...data } });
    return this;
  }
  created(ms: number, sid: string, extra: Record<string, unknown> = {}): this {
    return this.at(ms, 'session.created', sid, { location: DIR, subpath: '', slug: 'mock-slug', version: '2.2.5', ...extra });
  }
  /** One user message in, the run started and the message delivered. */
  turn(ms: number, sid: string, text: string, inbox: string): this {
    return this.at(ms, 'session.inbox.enqueued', sid, { inboxID: inbox, item: { type: 'user', payload: { text }, delivery: 'steer' } })
      .at(ms + 1, 'session.execution.started', sid)
      .at(ms + 2, 'session.inbox.delivered', sid, { inboxID: inbox });
  }
  stepStart(ms: number, sid: string, msg: string, agent = 'build'): this {
    return this.at(ms, 'session.step.started', sid, { assistantMessageID: msg, agent, model: MODEL, started: START + ms });
  }
  stepEnd(ms: number, sid: string, msg: string, finish: 'stop' | 'tool-calls', total: number): this {
    return this.at(ms, 'session.step.ended', sid, { assistantMessageID: msg, finish, rawFinish: finish === 'stop' ? 'stop' : 'tool_calls', ...STEP })
      .at(ms + 1, 'session.usage.updated', sid, usage(total), false);
  }
  text(ms: number, sid: string, msg: string, text: string): this {
    return this.at(ms, 'session.text.started', sid, { assistantMessageID: msg, ordinal: 0 })
      .at(ms + 1, 'session.text.delta', sid, { assistantMessageID: msg, ordinal: 0, delta: text })
      .at(ms + 1, 'session.text.ended', sid, { assistantMessageID: msg, ordinal: 0, text })
      .at(ms + 1, 'session.step.streamed', sid, { assistantMessageID: msg });
  }
  toolCalled(ms: number, sid: string, id: string, name: string, input: Record<string, unknown>): this {
    return this.at(ms, 'session.tool.input.started', sid, { id, name })
      .at(ms + 1, 'session.tool.input.ended', sid, { id, text: JSON.stringify(input) })
      .at(ms + 1, 'session.tool.called', sid, { id, input, executed: false })
      .at(ms + 2, 'session.step.streamed', sid);
  }
  /** The model's closing step after a tool: "done after tool", then the run ends. */
  finish(ms: number, sid: string, msg: string): this {
    return this.stepStart(ms, sid, msg).text(ms + 2, sid, msg, 'done after tool').stepEnd(ms + 5, sid, msg, 'stop', 3).at(ms + 7, 'session.execution.succeeded', sid);
  }
}

const ROOT = 'ses_root';
const CHILD = 'ses_child';

function shortSession(): BusEvent[] {
  return new Stream()
    .turn(1, ROOT, 'say hello', 'msg_in1')
    .stepStart(10, ROOT, 'msg_a1')
    .text(12, ROOT, 'msg_a1', 'mock reply to: say hello')
    .stepEnd(15, ROOT, 'msg_a1', 'stop', 1)
    .at(17, 'session.execution.succeeded', ROOT)
    .at(19, 'session.usage.updated', ROOT, usage(2), false)
    .at(19, 'session.renamed', ROOT, { title: 'mock reply to: say hello' }).events;
}

function subagent(): BusEvent[] {
  return new Stream()
    .created(0, ROOT)
    .turn(3, ROOT, 'TRIG_SUBAGENT go', 'msg_in1')
    .stepStart(10, ROOT, 'msg_a1')
    .toolCalled(11, ROOT, 'call_1', 'subagent', { agent: 'general', description: 'child task', prompt: 'child says hi' })
    .at(14, 'session.usage.updated', ROOT, usage(1), false)
    .created(16, CHILD, { parentID: ROOT, title: 'child task', agent: 'general' })
    .at(17, 'session.tool.progress', ROOT, { id: 'call_1', metadata: { sessionID: CHILD, status: 'running' } }, false)
    .turn(17, CHILD, 'You are a subagent spawned by another session.\nchild says hi', 'msg_in2')
    .stepStart(22, CHILD, 'msg_c1', 'general')
    .text(23, CHILD, 'msg_c1', 'mock reply to: child says hi')
    .stepEnd(25, CHILD, 'msg_c1', 'stop', 1)
    .at(26, 'session.execution.succeeded', CHILD)
    .at(27, 'session.tool.success', ROOT, { id: 'call_1', content: [{ type: 'text', text: `<subagent sessionID="${CHILD}" state="completed">\nmock reply\n</subagent>` }], metadata: { sessionID: CHILD } }, false)
    .stepEnd(28, ROOT, 'msg_a1', 'tool-calls', 2)
    .finish(32, ROOT, 'msg_a2').events;
}

function permission(): BusEvent[] {
  const s = new Stream().created(0, ROOT).turn(7, ROOT, 'TRIG_PERMISSION go', 'msg_in1').stepStart(30, ROOT, 'msg_a1')
    .toolCalled(32, ROOT, 'call_1', 'read', { path: '/work/project/secret.env' })
    .at(38, 'session.usage.updated', ROOT, usage(1), false);
  s.events.push({ id: 'evt_p1', created: START + 39, type: 'permission.asked', data: { sessionID: ROOT, id: 'per_1', action: 'read', resources: ['secret.env'], save: ['*'], source: { type: 'tool', messageID: 'msg_a1', id: 'call_1' } } });
  s.events.push({ id: 'evt_p2', created: START + 790, type: 'permission.replied', data: { sessionID: ROOT, requestID: 'per_1', reply: 'once' } });
  return s
    .at(795, 'session.tool.success', ROOT, { id: 'call_1', content: [{ type: 'text', text: 'Read file /work/project/secret.env, lines 1-1\n1: API_KEY=fake' }], metadata: { truncated: false }, executed: false })
    .stepEnd(797, ROOT, 'msg_a1', 'tool-calls', 2)
    .finish(810, ROOT, 'msg_a2').events;
}

function question(): BusEvent[] {
  const questions = [{ question: 'Pick one?', header: 'Pick', options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }];
  const s = new Stream().created(0, ROOT).turn(8, ROOT, 'TRIG_QUESTION go', 'msg_in1').stepStart(30, ROOT, 'msg_a1')
    .toolCalled(32, ROOT, 'call_1', 'question', { questions })
    .at(38, 'session.usage.updated', ROOT, usage(1), false);
  s.events.push({
    id: 'evt_f1', created: START + 40, type: 'form.created', location: DIR,
    data: { form: { id: 'frm_1', sessionID: ROOT, title: 'Questions', metadata: { kind: 'question', tool: { messageID: 'msg_a1', id: 'call_1' } }, fields: [{ key: 'q0', title: 'Pick', description: 'Pick one?', type: 'string', options: [{ value: 'A', label: 'A', description: 'first' }, { value: 'B', label: 'B', description: 'second' }], custom: true }] } },
  });
  s.events.push({ id: 'evt_f2', created: START + 790, type: 'form.replied', data: { sessionID: ROOT, id: 'frm_1', answer: { q0: 'B' } } });
  return s
    .at(791, 'session.tool.success', ROOT, { id: 'call_1', content: [{ type: 'text', text: 'User has answered your questions: "Pick one?"="B".' }], metadata: { answers: [['B']], truncated: false }, executed: false })
    .stepEnd(793, ROOT, 'msg_a1', 'tool-calls', 2)
    .finish(805, ROOT, 'msg_a2').events;
}

function compaction(): BusEvent[] {
  const summary = '## Objective\nx\n## Work State\n### Completed\nx\n## Next Move\nx';
  return new Stream()
    .created(0, ROOT)
    .turn(7, ROOT, 'first turn', 'msg_in1')
    .stepStart(25, ROOT, 'msg_a1').text(27, ROOT, 'msg_a1', 'mock reply to: first turn').stepEnd(30, ROOT, 'msg_a1', 'stop', 1)
    .at(32, 'session.execution.succeeded', ROOT)
    .at(33, 'session.usage.updated', ROOT, usage(2), false)
    .turn(2500, ROOT, 'second turn', 'msg_in2')
    .stepStart(2520, ROOT, 'msg_a2').text(2522, ROOT, 'msg_a2', 'mock reply to: second turn').stepEnd(2525, ROOT, 'msg_a2', 'stop', 3)
    .at(2528, 'session.execution.succeeded', ROOT)
    .at(5000, 'session.inbox.enqueued', ROOT, { inboxID: 'msg_in3', item: { type: 'compaction', payload: {}, delivery: 'steer' } })
    .at(5001, 'session.execution.started', ROOT)
    .at(5002, 'session.inbox.delivered', ROOT, { inboxID: 'msg_in3' })
    .at(5002, 'session.compaction.started', ROOT, { reason: 'manual', inputID: 'msg_in3' })
    .at(5010, 'session.compaction.delta', ROOT, { text: summary }, false)
    .at(5020, 'session.usage.updated', ROOT, usage(4), false)
    .at(5020, 'session.compaction.ended', ROOT, { reason: 'manual', model: MODEL, text: summary, ...STEP })
    .at(5021, 'session.execution.succeeded', ROOT).events;
}

/** The five streams, by name. A call builds fresh objects, so a test may change what it gets. */
export const STREAM_NAMES = ['short-session', 'subagent', 'permission', 'question', 'compaction'] as const;
export type StreamName = (typeof STREAM_NAMES)[number];
const BUILDERS: Record<StreamName, () => BusEvent[]> = { 'short-session': shortSession, subagent, permission, question, compaction };
export const streamOf = (name: StreamName): BusEvent[] => BUILDERS[name]();
