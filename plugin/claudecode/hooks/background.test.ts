import { describe, test, expect } from 'claude-code/testing'
import { tasksDirOf } from './background.ts'

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
