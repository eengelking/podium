import { describe, test, expect } from 'claude-code/testing'
import { MAIN_LOOP } from '../../core/protocol.ts'
import { bgFile, bgItems, bgStarted, readBackground, setWatchedBackground, tasksDirOf } from './background.ts'
import { newSession, type SessionState } from './state.ts'

describe('the tasks folder beside a hook’s scratchpad folder (#897)', () => {
  test('is the tasks folder beside it, with or without separators at the end', () => {
    for (const tail of ['', '/', '///', '/\\/', '\\\\']) expect(tasksDirOf(`/tmp/s/scratch${tail}`)).toBe('/tmp/s/tasks')
  })

  test('keeps the separator kind of the last one in the path', () => {
    expect(tasksDirOf('C:\\s\\scratch\\')).toBe('C:\\s\\tasks')
    expect(tasksDirOf('C:\\s\\scratch\\\\\\')).toBe('C:\\s\\tasks')
    expect(tasksDirOf('/a\\b/')).toBe('/a\\tasks')
  })

  test('is null for no path, an empty one, one that is only separators, and one with no parent', () => {
    for (const v of [undefined, null, 5, '', '/', '///', '\\/\\', 'scratch', '/scratch', '/scratch//']) expect(tasksDirOf(v)).toBeNull()
  })
})

// #1242: an orchestrator's Background list holds what it and every agent under it started; an agent's holds its own and its descendants'.
describe('whose background items a loop lists (#1242)', () => {
  const agent = (id: string, parentId: string | null) => ({ id, parentId }) as unknown as SessionState['agents'][string]
  // The orchestrator O; subagents A and B under it; K a child of A. Each loop runs one shell.
  function tree(): SessionState {
    let s = newSession({ id: 's1', cwd: '/p', startedAt: 1 })
    s = { ...s, agents: { A: agent('A', null), B: agent('B', null), K: agent('K', 'A') }, order: ['A', 'B', 'K'] }
    const start = (id: string, agentId: string | null) => (s = bgStarted(s, { id, kind: 'shell', command: `run ${id}`, agentId, now: 10 }))
    start('o1', null)
    start('a1', 'A')
    start('b1', 'B')
    start('k1', 'K')
    return s
  }
  const ids = (s: SessionState, loop: string) => bgItems(s, loop, false).map((i) => i.id).sort()

  test('the orchestrator lists its own and every descendant’s, nested ones included', () => {
    expect(ids(tree(), MAIN_LOOP)).toEqual(['a1', 'b1', 'k1', 'o1'])
  })

  test('an agent lists its own and its descendants’, never its parent’s or a sibling’s', () => {
    expect(ids(tree(), 'A')).toEqual(['a1', 'k1'])
    expect(ids(tree(), 'B')).toEqual(['b1'])
    expect(ids(tree(), 'K')).toEqual(['k1'])
  })

  test('an item a descendant started names its owner; an item the loop started itself does not', () => {
    const items = bgItems(tree(), MAIN_LOOP, false)
    expect(items.find((i) => i.id === 'o1')).not.toHaveProperty('ownerId')
    expect(items.find((i) => i.id === 'k1')).toMatchObject({ ownerId: 'K' })
    expect(bgItems(tree(), 'A', false).find((i) => i.id === 'a1')).not.toHaveProperty('ownerId')
  })

  test('an item whose agent has finished stays listed while it runs', () => {
    const s = tree()
    const done = { ...s, agents: { ...s.agents, A: { ...s.agents.A!, status: 'done' } } } as SessionState
    expect(ids(done, MAIN_LOOP)).toContain('a1')
  })

  test('output is read for a task when its owner or any loop above it is watched', async () => {
    const s = { ...tree(), tasksDir: '/t', watched: [MAIN_LOOP], watchedBackground: [MAIN_LOOP] }
    const seen: string[] = []
    const fs = { stat: async (f: string) => { seen.push(f); throw new Error('missing') }, read: async () => { throw new Error('missing') } }
    await readBackground(fs, s, true, 100)
    // a child-owned task (k1, under A, under the orchestrator) is looked at because the orchestrator is watched
    expect(seen.some((f) => f.includes('k1.output'))).toBe(true)
  })

  test('a task’s output is kept while any loop above its owner stays on the watch list, and dropped when none does', () => {
    const base = tree()
    let s = { ...base, watchedBackground: [MAIN_LOOP] }
    s = bgFile(s, 'k1', { output: 'built', settled: true })
    // another loop's tab opens: the orchestrator is still watched, so its list keeps the child's output
    s = setWatchedBackground(s, [MAIN_LOOP, 'B'])
    expect(s.bg.find((t) => t.id === 'k1')!.output).toBe('built')
    // the orchestrator's tab closes too: nothing above k1 is watched any more
    s = setWatchedBackground(s, ['B'])
    expect(s.bg.find((t) => t.id === 'k1')!.output).toBeNull()
  })
})
