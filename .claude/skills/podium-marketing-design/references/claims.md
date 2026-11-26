# Claims a marketing page may make

Each row is something a page is likely to say, the rule behind it, and where it is written. Re-read the source before you rely on a row. Docs move, and a row here that disagrees with its source is wrong, so fix the row.

## Messaging and Chat

| Say this | The rule | Source |
|---|---|---|
| One person's own agents can message each other, across their machines. | Messages go only between orchestrators of the same owner. The server refuses a link or a message that joins two owners. | `docs/MESSAGING.md` ("What it is"), DECISIONS 37 |
| It is off until three things are on. | The Admin's Orchestrator messaging flag, the `peers` option on each machine, and a right the owner gives. | `docs/MESSAGING.md` |
| A person can write to another person's agent in Chat, if its owner approves. | The message is held as a request in the owner's My reporters list. Allow delivers it and opens a link, so later messages go without asking. Decline drops it. Either person can pause or remove the link. At most 5 messages from one person wait at one owner. | DECISIONS 61, `docs/architecture/02-components/13-orchestrator-messaging.md` ("Across owners") |
| The agent then sees the text as that person's, not its owner's. | The reporter frames it by the person who wrote it. | The same page |
| An agent can answer a person who wrote to it. | `podium_send` to `person:<name>`, with a stored message from that person. | The same page ("An agent answers a person") |
| An agent never messages another person's agent directly. | Between people the only path is a person writing in Chat. Do not draw an agent-to-agent line across two owners. | DECISIONS 37 and 61 |
| A message lands at the receiving agent's next step. | It never stops a running tool. An idle agent gets it as a new turn. | `docs/MESSAGING.md` ("What it is") |
| A message cannot answer a prompt or run a command. | It cannot answer a question, a plan or a permission prompt, run `/clear` or `/compact`, or change a mode or a rule. | `docs/MESSAGING.md` ("What a message can never do") |
| Only an agent's main loop sends. | A subagent cannot send, and a message never reaches one. | `docs/MESSAGING.md` |
| An agent reads a channel only when an `@` called it in. | Only the last hour, and only where a stored `@` of that agent called it in. A channel message is never pushed into a running turn. | `docs/architecture/02-components/13-orchestrator-messaging.md` ("The agent's side of the channels"), DECISIONS 69 |
| General and the public channels are public to the console. | Every signed-in person can read them. | DECISIONS 69 |

## What Podium does and never does

| Say this | The rule | Source |
|---|---|---|
| Podium watches. | It shows sessions, and the one thing it sends is an answer to a session that is waiting on a person. | `docs/spec/01-goals-and-non-goals.md`, the atlas ("Watch, don't drive") |
| An answer needs two yeses. | The Admin's Respond from Podium flag and the session owner's `respond` option. | The same |
| It never types into a terminal. | An answer becomes the result of a hook the reporter already holds. | The same |
| It never starts, stops, resumes or kills a session or an agent. | | The same |
| Sessions call out and nothing calls in. | The server never dials a laptop. Instructions ride the reply to a report. | The atlas ("Connections go outward") |
| Cost is an estimate. | From token counts and a price table. Never a bill. | `docs/spec/01-goals-and-non-goals.md` |
| An Admin never reads in silence. | Whenever an Admin sees a person's non-public content, that person is told, in the console and in the reporter. | `.claude/PROJECT.md` ("An Admin Never Reads in Silence") |

## Harnesses

Podium has a reporter for Claude Code and one for OpenCode, over one shared core, and the capabilities differ. OpenCode has no plan approval and no `/clear`. Say what a feature does for every harness only after reading `docs/REPORTER.md`.

## Things that have been wrong before

- Showing one person's agent messaging another person's agent directly.
- Calling Chat "the wall". The wall is the fleet page of cards.
- Writing "Claude Code" where the sentence is true of any harness.
- Naming the switches a feature needs from memory.
