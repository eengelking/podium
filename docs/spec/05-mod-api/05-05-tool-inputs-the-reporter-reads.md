---
title: "5.5 Tool inputs the reporter reads (Verified)"
description: "The input shapes of the tools whose calls the reporter reads."
group: "Reference"
section: "5.5"
order: 5
---

# 5.5 Tool inputs the reporter reads (Verified)

```ts
Agent:      { description: string; prompt: string; subagent_type?: string;
              model?: 'sonnet'|'opus'|'haiku'|'fable'; effort?: 'low'|'medium'|'high'|'xhigh'|'max';
              name?: string; isolation?: 'worktree'|'remote' }
              // effort and model are IGNORED for subagent_type "fork": a fork inherits both.
Skill:      { skill: string; args?: string }
TaskCreate: { subject: string; description: string; activeForm?: string; metadata?: {} }
            // result: { task: { id: string; subject: string } }
TaskUpdate: { taskId: string; subject?; description?; activeForm?;
              status?: 'pending'|'in_progress'|'completed'|'deleted';
              addBlocks?: string[]; addBlockedBy?: string[]; owner?: string; metadata?: {} }
            // result: { success, taskId, updatedFields, error?, statusChange?: { from, to } }
TaskList:   {}   // result: { tasks: [{ id, subject, status, owner?, blockedBy }] }
TaskGet:    { taskId }  // result: { task: { id, subject, description, status, blocks, blockedBy } | null }
TodoWrite:  { todos: [{ content, status: 'pending'|'in_progress'|'completed', activeForm }] }
            // result: { oldTodos, newTodos }
```

For a fork the model sets `subagent_type: "fork"`; in `agent.spawn` that arrives as `fork: true`.

<!-- nav:start -->
---

Previous: [5.4 Engine calls the reporter uses (Verified)](05-04-engine-calls-the-reporter-uses.md) · Up: [5. The Claude Code mod API: everything the reporter needs](README.md) · Next: [5.6 What the engine does and does not tell you](05-06-what-the-engine-does-and-does-not-tell-you.md)
<!-- nav:end -->
