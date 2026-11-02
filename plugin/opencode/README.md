# plugin/opencode

Placeholder for the OpenCode reporter (#855). It will hold only what is specific to OpenCode: its plugin entry,
its event wiring and its engine API use. Everything shared with the Claude Code reporter (the report types,
transport, failures, redaction, plan, machine id) is imported from `../core/`, and this folder never imports
`../claudecode/`. A test (`server/src/plugin.test.ts`) fails if it does.
