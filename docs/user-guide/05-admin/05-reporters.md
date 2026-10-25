---
title: "Reporters"
description: "Check which machines have reported to the server and filter them by state."
group: "Getting started"
order: 5
---

# Reporters

Every machine that has reported to this server, one row each. Rows are kept after the machine's sessions are deleted, so
you can check that a reporter is connected and see which ones ever were. The list updates by itself every 10 seconds.

The strip on top counts reporters by state and filters the list:

| State | Meaning |
|---|---|
| **Reporting** | Heard from in the last 2 minutes |
| **Idle** | Heard from up to an hour ago |
| **Silent** | Heard from longer ago. It means only that nothing has arrived: Podium cannot tell a reporter that is turned off from one that cannot reach it (hover or focus the state for this) |
| **Not since restart** | Last heard before the server started. After a restart, most rows read this until they report again. Hover or focus it to read why |

Each row shows the machine, the person, the token it uses, the reporter version (with a warning when it is older or newer
than this Podium supports), the last report and the number of sessions.

Select a row for its details: version and compatibility, machine id, source address, the token's key id (never the
token), then two panels. **Recent sessions** is paged like the other Admin lists, so you can reach every session the
server still holds for it. **Reports the server turned away** lists refused reports.

A reporter with no user name (the `userName` option) sends no machine id. Its row shows its newest project, or its
address, with "no name set" beside it, and it is matched by its sessions, so a container that comes back on a new address
stays one row. Hover or focus a state, or "no name set", for what it means for that row.

**Admin secret warning.** A reporter that reports with the admin secret instead of a token made for one person is always
flagged:

- an amber **Admin secret** badge in the Token column,
- a band above the list that counts them (**Show only these** filters to them),
- a warning at the top of its details with the steps to fix it: make a person in People, then enter their token and name
  in the reporter's options.

**Removing and ignoring.**

- **Remove from list** (in a reporter's details, with a tooltip that says the same) takes a reporter off the list. It
  comes back if it reports again, and its sessions are not touched.
- To clear out many at once, tick the boxes (the box in the header ticks the page, and **Select all N that match**
  reaches past it), then **Remove N…**. With a state chosen, **Remove all `<state>`** beside the search does the same.
- To keep a reporter off the list for good, choose **Ignore…** in its details. It sits beside **Remove from list**, and
  the … in its name means it asks what to ignore before doing anything. Its reports are then turned away, so its sessions stop
  appearing on the fleet.
- The **Ignore rules** section after the table shows every rule (a key, an address or a version, with `*` for "anything",
  as in `10.88.*` or `*-sim`). **Remove rule** undoes one.

**Messaging.** While **Orchestrator messaging** is on, a reporter's details add its **System** and **Messaging** (On,
Paused, Off on the machine, Reporter can't message: update it, or Cannot take part), and a **Messaging** section below
shows the owner's reporters with the same **Grid | Board** as [My reporters](../04-reading-the-console/14-my-reporters.md). How rights, proposals and
pauses fit together is in [MESSAGING.md](../../MESSAGING.md#rights-and-approval).

- An Admin never decides for the owner. A change you make there is sent to the owner as a proposal, shows as
  Proposed, waiting for them, and applies only once they accept it, on My reporters or in a session on the machine. You
  can only propose more than a pair has; lowering a right or taking it away is the owner's choice.
- **Pause all links** in the details' header pauses every link of that reporter at once, with no answer needed, and
  **Resume all links** undoes it.
- While the owner has **Trust my own reporters** on, the choices are locked and a band says so.
- A reporter on the admin secret, with no owner, with messaging off on its machine, or too old to message says why
  and offers no choices.

A source address and a machine name are personal data, so only Admin shows them.

If one machine shows several rows, or a changed login does not reach a running session, see
[Reporters and machines](../../gotchas/README.md#reporters-and-machines).

<!-- nav:start -->
---

Previous: [Groups](04-groups.md) · Up: [Admin](README.md) · Next: [Settings](06-settings.md)
<!-- nav:end -->
