---
title: "Components"
description: "Which files own each part of Podium, which issue introduced it and how it works, one page per part."
group: "Project internals"
entries: "list"
order: 2
---

# Components

Most subsections name the files that own them and the issue that introduced them. Mockups are under `mockup/`.

## Pages

<!-- entries:start -->
- [Reporters, identity and Admin](01-reporters-identity-and-admin.md): How reporter tokens, people and the Admin area work, and which server files own them.
- [Admin page patterns](02-admin-page-patterns.md): The shared layout and controls the Admin pages are built from, and where they live.
- [Tooltips](03-tooltips.md): How a note on a word or badge is built with the Tip component.
- [Fleet card](04-fleet-card.md): How the session card on the fleet wall is built: its chips, session id and files.
- [Orchestrator page](05-orchestrator-page.md): How the orchestrator page is laid out and which file builds it.
- [Known reporters](06-known-reporters.md): How the server tracks the reporters it has seen, and the Admin tab that lists them.
- [Prompt and answer modal](07-prompt-and-answer-modal.md): How the whole prompt and answer are kept out of growing places and shown in a modal.
- [Activity feed](08-activity-feed.md): How the activity feed is built on the server and in the UI, and how the Admin can keep it durably.
- [Activity history](09-activity-history.md): How the durable activity history is stored in its own database file, set by the Admin and purged.
- [Session recording](10-session-recording.md): How a session is recorded by the mod, stored on the server with its limits and replayed in the UI.
- [Responding](11-responding.md): How Podium answers a session that waits on its person, and the server, mod and UI files that do it.
- [File diff](12-file-diff.md): How a changed file's diff is captured by the mod, redacted, stored and shown in a modal.
- [Orchestrator messaging](13-orchestrator-messaging.md): How orchestrators send messages to each other through Podium, with rights, settings and routes.
- [Built-in TLS (#577)](14-built-in-tls.md): How the server serves HTTPS itself, the structure its sub-issues agreed on and what is still blocked on the engine.
- [People view](15-people-view.md): How the People view and the Admin spend tab are built from the fleet's data.
- [Logging](16-logging.md): How the server's logging works, where it lives and what it keeps.
- [Shared contract](17-shared-contract.md): Where the Report types live on the server and in the mod, and how a test keeps them identical.
- [Other server parts](18-other-server-parts.md): The smaller server parts that have no page of their own, such as model prices.
<!-- entries:end -->

<!-- nav:start -->
---

Previous: [How Podium fits together](../01-how-podium-fits-together.md) · Up: [Architecture](../README.md) · Next: [Spec questions](../03-spec-questions.md)
<!-- nav:end -->
