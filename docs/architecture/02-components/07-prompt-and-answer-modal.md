---
title: "Prompt and answer modal"
description: "How the whole prompt and answer are kept out of growing places and shown in a modal."
group: "Project internals"
order: 7
---

# Prompt and answer modal

Files: `components/ReportDocs.tsx`, `components/Markdown.tsx`, `components/Modal.tsx`. Issues #97 and #118.

- The whole prompt and answer are kept out of the places that grow. The mod sends them (`promptText`,
  `answerText`, mod 0.10.0, `fullPrompts` option) once each, tracked by `promptSent` and `answerSent` on its
  agent state and cleared only by an accepted report (`markTextSent`).
- The server stores them in `agent_texts` (migration 8), a table of its own so `SELECT` on `agents` and the SSE
  state stay small. The view carries only `promptChars` and `answerChars`, and the modal fetches the text when it
  opens.
- `Markdown.tsx` builds React elements and never an HTML string. That keeps SPEC 7.7's rule that reported strings
  reach the page only as text nodes, and it needs no dependency.
- The modal shell is `components/Modal.tsx`, shared with the activity feed's modal. It is portaled to `<body>`
  inside its own `.podium` wrapper (for the theme tokens) and blurs `#root`. A capturing key listener keeps Esc
  and the shell shortcuts from reaching the page behind it.

<!-- nav:start -->
---

Previous: [Known reporters](06-known-reporters.md) · Up: [Components](README.md) · Next: [Activity feed](08-activity-feed.md)
<!-- nav:end -->
