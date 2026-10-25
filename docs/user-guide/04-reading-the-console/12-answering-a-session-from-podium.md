---
title: "Answering a session from Podium"
description: "Answer a waiting session from the console when answering is turned on."
group: "Getting started"
order: 12
---

# Answering a session from Podium

When a session stops to ask you something, its amber band gets a **Respond** button at the right end, on the card and on
the orchestrator page. It opens the Activity modal with the question, the plan or the tool's request under the feed, and
a message box at the bottom. The terminal keeps working the whole time, and whichever answers first wins.
`mockup/podium-respond.html` shows every case.

## Turn it on

It is off until all of these are on:

- The server's **Respond from Podium** switch (Admin > Settings > Feature flags).
- The server's **Agent activity feed** switch next to it.
- On the session's machine, the mod's **Respond from Podium** option (`respond`) together with **Send an agent's recent
  activity** (`activityFeed`). Set the option in Claude Code with `/plugin configure podium-reporter@eengelking-marketplace`.

It also needs podium-reporter 0.14.0 or later and a server started with a token. The `respond` option has four levels:

| Level | What can be answered |
|---|---|
| `off` | Nothing. This is the default |
| `questions` | Answers to questions, and new messages while idle |
| `questions-and-plans` | The above, plus approving or rejecting a plan |
| `everything` | The above, plus allowing or denying a tool (allow once only), and `/clear`, `/compact` |

## Sign in

To answer, sign in with your name and token, the same ones as the mod's `userName` and `token` options. An Admin can use
the name **Admin** with the admin secret. Sign in from the modal or from **Sign in** at the far right of the top bar.

Only the session's owner, or an Admin, can respond. On anyone else's card **Respond** is dimmed with their name. A
sign-in ends after 12 hours without use, on **Sign out**, when the server restarts, and when your token changes.

## What you can send

- **A question.** Pick an option on each tab (or **Type something**), check **Review**, then **Submit answers**. Writing in
  the message box instead replaces the answer, like "Chat about this" in the terminal.
- **A plan.** Choose **Yes, and use auto mode**, **Yes, auto-accept edits**, **Yes, manually approve edits**, or **No,
  keep planning** with what to change. If Claude Code doesn't take an approval, the modal says so and you approve it in
  the terminal. On a computer where an organization manages Claude Code, only **No, keep planning** is offered.
- **A tool's request.** **Allow once**, or **Deny** with an optional reason. "Always allow" stays in the terminal. A
  command too long to show in full can only be allowed in the terminal, but Podium still lets you deny it.
- **A message.** While the session is idle it starts the next turn. Sent while it runs, it waits until the session is
  idle. Type `/` for the two commands Podium can send: `/clear` (it asks first) and `/compact`, each on its own with
  nothing after it. Anything else runs only in the terminal.

## What happens next

An answer counts once the session confirms it, usually within 2 seconds. Until then the modal says **Sending**.

- If the terminal answered first, if someone else answered first, or if the question closed in the session, the modal
  says so and nothing is sent.
- If the session has stopped checking in, your answer waits and goes out when it reports again, unless the terminal
  answered by then. **Discard my answer** takes it back.
- In the terminal, podium-reporter writes "also open in Podium. Answer here or there." while a question is open, and
  names who answered from Podium and when.
- A tool request answered in the terminal still looks open in Podium until the command finishes, since Claude Code says
  nothing sooner.

<!-- nav:start -->
---

Previous: [Activity](11-activity.md) · Up: [Reading the console](README.md) · Next: [Session recording](13-session-recording.md)
<!-- nav:end -->
