// The events OpenCode sends the reporter and the fields of each that the reporter reads (#724), so Admin > Reporting > Harness updates can say which of them
// stopped after an OpenCode update. A field is listed because `state.ts` reads it, not because the event happens to have it. Pure: no `$` here.
/** The events `state.ts` handles. Only these are counted, so a session that sees many other event types (a stream of text deltas, say) never fills the 64 names before a handled one shows. */
export const OPENCODE_EVENTS: readonly string[] = [
  'session.created', 'session.renamed', 'session.inbox.enqueued', 'session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted',
  'session.step.started', 'session.step.ended', 'session.step.failed', 'session.skill.activated', 'session.usage.updated', 'session.text.ended', 'session.reasoning.ended',
  'session.tool.input.started', 'session.tool.called', 'session.tool.success', 'session.tool.failed', 'permission.asked', 'permission.replied', 'form.created', 'form.replied',
  'form.cancelled', 'session.compaction.started', 'session.compaction.ended', 'session.compaction.failed', 'session.deleted', 'session.archived', 'session.unarchived',
];

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
