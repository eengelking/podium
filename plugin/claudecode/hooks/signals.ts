// The hooks the engine runs for this reporter and the fields of each event that the reporter reads (#724), so Admin > Reporting > Harness updates can say which of
// them stopped after a Claude Code update. A field is listed because `register.ts` reads it, not because the event happens to have it. Pure: no `$` here.
export const CLAUDE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'turn.start': ['agentId', 'text'],
  'turn.step': ['agentId', 'effort', 'model'],
  'turn.complete': ['agentId', 'answer', 'reason'],
  'session.compact': ['agentId', 'trigger'],
  'session.measure': ['context', 'cost', 'rateLimits'],
  'agent.spawn': ['description', 'fork', 'isTeammate', 'model', 'name', 'parentAgentId', 'prompt', 'subagentType', 'tool_use_id'],
  'tool.call': ['agentId', 'tool', 'tool_use_id'],
  'tool.check': ['input', 'tool', 'tool_use_id'],
  'skill.prompt': ['skill'],
  'classic.PermissionRequest': ['agent_id', 'tool_input', 'tool_name'],
  'classic.Notification': ['message', 'notification_type'],
  'classic.SessionStart': ['cwd'],
  'classic.UserPromptSubmit': ['cwd'],
  'classic.Stop': ['background_tasks', 'session_crons'],
  'command.run': ['args'],
};
