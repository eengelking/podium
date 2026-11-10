// The events OpenCode sends the reporter and the fields of each that the reporter reads (#724), so Admin > Reporting > Harness updates can say which of them
// stopped after an OpenCode update. A field is listed because `state.ts` reads it, not because the event happens to have it. Pure: no `$` here.
export const OPENCODE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'session.created': ['agent', 'slug', 'title'],
  'session.renamed': ['title'],
  'session.inbox.enqueued': ['item'],
  'session.execution.interrupted': ['error'],
  'session.step.started': ['agent', 'model'],
  'session.step.ended': ['tokens'],
  'session.step.failed': ['error'],
  'session.skill.activated': ['name'],
  'session.usage.updated': ['cost', 'tokens'],
  'session.text.ended': ['text'],
  'session.tool.input.started': ['id', 'name'],
  'session.tool.called': ['id', 'input', 'name'],
  'permission.asked': ['action', 'id', 'resources', 'source'],
  'permission.replied': ['reply', 'requestID'],
  'form.created': ['form'],
  'form.cancelled': ['form', 'id'],
  'session.compaction.failed': ['reason', 'tokens'],
};
