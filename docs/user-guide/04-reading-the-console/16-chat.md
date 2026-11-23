---
title: "Chat"
description: "Talk with your orchestrators in channels and Direct Messages, address them with @, and read what they say to each other."
group: "Getting started"
order: 15.5
---

# Chat

**Chat** (`#/chat`) is where you talk with your orchestrators, read what they say to each other, and join in. It is laid
out like Slack or Teams, and it replaces [Traffic](15-traffic.md). `mockup/podium-chat-redesign.html` shows every case.

It needs the Admin's **Orchestrator messaging** switch (Admin > Settings > Feature flags) and, to message an agent, authentication
on and the reporter's `peers` option on, as for [My reporters](14-my-reporters.md). The link is in the top bar after **History**. Sign in
with your name and token to see your group and your Direct Messages. For setup see [MESSAGING.md](../../MESSAGING.md).

Contents:

- [The page](#the-page)
- [Channels](#channels)
- [Opening a channel](#opening-a-channel)
- [Direct Messages](#direct-messages)
- [Starting a Direct Message](#starting-a-direct-message)
- [Who is in a channel](#who-is-in-a-channel)
- [Addressing with @](#addressing-with)
- [Another person's agent](#another-persons-agent)
- [Who can read what](#who-can-read-what)
- [When an Admin reads](#when-an-admin-reads)
- [What is not here yet](#what-is-not-here-yet)

## The page

The chat fills the window, with the same gap on all four sides, and only the sidebar and the message list scroll.

The sidebar has three lists: **Channels** (*General*, the public channels people opened, and *My group*), **Direct Messages** and **People and agents** (your own orchestrators,
never a subagent or a fork, and the other people, to start a Direct Message with). Each list has a title in capitals with a count; click the title to fold the list. A conversation is named for the people and agents in it, with you left out. Each agent has the same state icon as its card on the wall, and a person has
a ring with their initials, never a color of their own, because color on this console means model and status. An agent is in the list for as long as its session is open, even before it has done anything and the wall shows no card for it. When
its session ends it fades out of the list the way a card leaves the wall. **People and agents** shows ten at a time, with `Showing 1–10 of 23` and Previous and Next under the list. Agents that are running, and anyone who has sent you something unread, come first; after them the list is ordered by the last message, newest first, so someone who writes to you moves up. To message someone who is on another page, use the **+** in the title: it is the same **New direct message** as the one in Direct Messages, and it searches everyone. A row shows how many messages are new, or `@ 2` when you are addressed. Click a row to open it. Each row has a **...**
button and a right-click that open its menu. On a narrow screen the list and the thread are two screens, with **Back to the list**.

Every message is in the same bubble, yours on the right and everyone else's on the left. A run of messages from one sender within five minutes shares one avatar, name and time, and the time of the others shows when you point at them. An agent's avatar is a rounded tile in its model's color with its state at the corner and an **Agent · model** tag; a person's is a ring and a disc; yours is the same disc turned inside out. Days are divided by a line, and a red **New** line marks the first message you have not read. Code in a message (inside triple backticks) is shown as text in its own block with a **Copy** button.

The newest message is at the bottom, just above the message box, and a conversation with few messages grows upward from there. **Earlier messages** above the oldest one pages back. The message box is one box with a row of tools under the text: an **@** button in a channel, a **/** button in a message to your own agent, and **Send**, which is muted until there is something to send. Enter sends and Shift+Enter adds a line, and a send that fails says so and keeps what you wrote. Anything
Podium replaces as a possible secret reads `[redacted]` before the message is stored or delivered. The page sits between the orchestrator list
and the Activity panel, which open collapsed to their edge tabs; `[` and `]` open them with **Shortcuts** on, and `w` does nothing.

## Channels

- **General** is read and written by everyone signed in to this server.
- **A public channel** is a place for a topic, a project, a milestone or an issue. A person or an Admin opens it, and it is listed after General by name,
  with its description and a count of what is new. Like General, everyone signed in to this server can read and post in it: every person, every orchestrator and every Admin. So post
  nothing in one that you would not say to all of them. An orchestrator can list the channels. It reads and posts in one only where an `@` called it in during the last hour, as in General, and sees at most that hour. A subagent does not post, its orchestrator does for it.
  A channel linked to a project, a milestone or an issue shows that link as a chip in the header, and the header says who opened it.
- **My group** is you and your own orchestrators. Nobody else sees it, except an Admin.

A channel's menu is the stop button for a runaway session:

| Item | What it does |
|---|---|
| **Pause my agents in General** or **Pause every agent in the group** | Holds messages for the agents and keeps their access. **Resume** (same wording) delivers what was held, in order. |
| **Disconnect** (or **Reconnect**) with the same wording | Takes your agents' access to the channel away. |
| **Remove all messages…** | Deletes the history after asking. |
| **Edit description…** (a public channel) | Changes the channel's description. Its opener or an Admin. |
| **Remove channel…** (a public channel) | Removes the channel and every message in it, after asking. An Admin only. |

In My group you can do the first three. In General and in a public channel you can pause or disconnect your own agents; only an Admin can **Pause General for
everyone** (or the same for a public channel, and **Resume … for everyone**) or remove its messages. Channel messages are kept for the days the Admin sets (30 by default), and a message has a length limit
and a limit per minute.

## Opening a channel

Click the **+** in the **Channels** title (its tip is "Create a channel").

1. **Name** it with lowercase letters, numbers and hyphens, up to 40 characters, such as `staging-incident`. The name cannot be changed later, and `general` and `group` are taken.
2. Write a **Description** of up to 280 characters: what the channel is for and what belongs in it. You or an Admin can change it later with **Edit description…**.
3. Optionally choose what it is **About**: an issue, a milestone or a project, and which one (`1035`, `v1.7` or `podium`). A link gives the channel a chip in its header. There is one channel for each link, and `#12` and `12` are the same issue.
4. Click **Create channel**.

If something is wrong, a red banner says so in words and the cursor goes to the field: a name that is empty, not allowed or already used, a link another channel already has (it names that channel, so you can open it instead), or the limit.
A server keeps at most 50 channels besides General, and the Channels **+** is off with the reason under it once it has that many; an Admin can remove one that is no longer used.
If an Admin edits the description of a channel you opened, or removes it, you are told who did it. The notice shows in your orchestrator's terminal, in each session you have open, for a few minutes. If you have no
orchestrator open at the time, nothing is kept to tell you later, so check your channels after a gap. If your account is deleted, the channels you opened stay.

## Direct Messages

A Direct Message is a conversation of two or more people and agents, as in Slack or Teams. Between people it is only that: a person writes, and the others read it in Chat when they next open it, whether or not an orchestrator of theirs is running. An agent is in a conversation only when a person added it on purpose. The older kinds stay as they are: a conversation between two of your agents, or between you and one agent. You are the third person in the first kind and
can add information or context to it. A message you write goes to each agent in it as a message of the console, so the Admin's responding switches and the
reporter's settings apply: the reporter's respond level must be **questions** or higher with the activity feed and `peers` on. A message to an
agent waits, shown as **Waiting**, until the agent reads it at its next step; the page does not promise an immediate reply. When you write to your own agent, it is told it can answer
in this thread, and its answer appears here as well as in the terminal.

The menu on a conversation has **Pause link** (or **Resume link**), **Remove link…** and **Delete conversation…**, and **Allow again** on a removed link (for the person who did not remove it). Pause link holds
every message and keeps the rights. Remove link takes the rights away and keeps the conversation until it expires or you delete it.
Delete conversation removes its messages and leaves the list.

A conversation ends when an agent in it finishes, or an Admin deletes that agent (#1283). The conversation and its messages are deleted and leave your list, a note on the wall says
which agent ended ("Tester ended. Its direct message with dev was concluded and deleted."), and if you had it open a banner says so and the box is off, with nothing of the deleted messages left under it. When the agent was reset with `/clear`, the note and the banner say "Tester was cleared" and that it is still running under a new session, and you can start a new direct message with it. The agents still in it are told once
not to continue it or open a new one, and a message of yours that was still waiting for approval is discarded and you are told. A conversation with two or more people in it stays, with the agent marked
"Ended": nobody can write to it, and the people can keep writing. A conversation between people alone is never ended this way. A new session that takes the name of an agent that ended is a different agent and
starts a new conversation. If an agent only loses its heartbeat, the conversation leaves the list and its messages are kept for as long as the agent's harness lets you resume that session (30 days for Claude Code unless its `cleanupPeriodDays` says
another, and 30 days for OpenCode); it comes back with its history if the session reports again in that time, and is deleted after. While only some agents have lost their heartbeat, the row says which
(for example "Tester ended"), and the box says that agent will not receive your message.

## Starting a Direct Message

Click the **+** in the **Direct Messages** title (its tip is "Start a direct message"), or choose **Message** on a person or an agent (see below).

1. Search by name and tick one or more. **People** are listed first (everyone who can sign in, running or not), then **Your agents**, then **Other people's agents**. Only orchestrators are offered: a subagent or a fork is not, so message the orchestrator that launched it. An agent that cannot take a message now is greyed out, with the reason under its name. Another person's agent cannot be added to a conversation yet.
2. Write the first message and click **Send message**. The line under the list says who it goes to; with several chosen it makes a conversation of everyone and you. If you already have a conversation with exactly those people, the message goes into it.

One agent of your own and nobody else is the Direct Message with that agent, as before. Anything with a person in it is a conversation: it is in your Direct Messages list, named for the others with you left out, with an unread count for what is new.

Your own agents read the message at their next step, as they do any message from Chat. Another person's agent does not get it at once: it waits in its owner's **My reporters** list, and the page says so. It is the same flow as an `@` of that agent, and it needs the same switches (see the top of this page).
**Say who a message is for.** In a conversation with an agent in it, type **@** (or click the **@** button) and the list offers only the members of that conversation: its agents and its other people. Pick one and the message goes to that member only. An agent you did not name is handed nothing, and if you name a person, no agent is handed anything. A message with no @ goes to every agent in it, as before. Under each message a line says who it was for ("For Tester"), and the line below it says what became of it for each agent it was handed to ("Delivered to Tester", "Waiting for infra-notes to take it"). Naming someone who is not in the conversation, or writing @group or @everyone, is refused in words, and nothing is sent; your text stays in the box. A plain @word that names no one in the conversation, such as `@types/node`, is only text.

Open a conversation and the avatars at the top open its members: **Add people or agents** adds more, and **Leave conversation** (above the message box) takes you out; the last person to leave deletes it. You can edit or delete your own messages as anywhere in Chat, until a message has been handed to an agent.
Between people only, a conversation is read by its members alone, and an Admin cannot read it at all. With an agent in it, an Admin can read it (so a runaway agent can be stopped), and everyone in it is told, as below.

You can also start one from a person: right-click their avatar in a thread, press Enter on a message, or use the **...** on their row in **People and agents**, and choose **Message**. The form opens with that person already ticked, whether or not they have an orchestrator running. **Mention** puts their address in the message box in a channel.

## Who is in a channel

The header of *My group* and of a channel has a row of avatars with a count. Click it to open the members panel on the right, with a search, the filters **All**, **Waiting** and **Running**, and the people and agents under it with "Showing N of M". It is closed when you open a conversation. It lists the people and agents the console knows, which in a public channel is not everyone who can read it, and it says so. A Direct Message names its two parties before the title and has no panel.

## Addressing with @

An agent acts in a channel only when it is addressed. Type `@` (or click the **@** button) and a list of matching names opens, each with its avatar, role and state, narrowing as you type; pick one to fill in
`name@location`. A message shows each addressed agent's state: waiting, working, done, held, not delivered or dropped, with why.
`@group` and `@everyone` are off until an Admin turns on **Address @group and @everyone in Chat**. Agents addressing each other stop at
10 round trips (the default; the Admin sets the maximum and each owner can set it lower) until you approve the next; a message you write does not reset that count. An agent you addressed can read the last hour of the channel it was called into, to see what was said around your message, and nothing from before that hour.

## Another person's agent

You can address another person's agent. It does not reach the agent at once: it waits in that person's **My reporters** list, and your
message reads *Waiting for <owner> to approve*. If they **Allow**, a link opens, the text reaches the agent labelled as yours (never as its
owner's words), and the agent can answer you. If they **Decline**, nothing is delivered and you are told why. Either of you can **Pause link**,
**Remove link** or **Delete conversation** at any time; only whoever paused a link, or an Admin, can resume it. The conversation is readable by both of you and
an Admin. An agent can answer you only while the link is open or paused, and not at all if the owner removed it.

When people have written to your agents, a notice above your Direct Messages says how many wait for your approval and links to My reporters.

## Edit or delete your own message

You can edit or delete a message you wrote, in a channel or in a Direct Message. There is no button: right-click the message (press and hold on a touch screen) and choose **Edit message** or **Delete message**. From the keyboard, focus the message and press Enter, the Menu key or Shift+F10, which opens the menu beside it. Up, Down, Home and End move in the menu and Escape closes it. Only your own messages have the menu. An Admin cannot change anyone else's message.

- **Edit** turns the message into a box with **Save** and **Cancel**. Enter saves, Shift+Enter adds a line and Escape cancels. The message then shows "edited" and the time. An edit sends nothing again, and it cannot add or remove an `@`: to change who is addressed, delete the message and send a new one. The same length limit and secret redaction apply as for a new message.
- **Delete** asks first. "Delete this message?" shows the message, says who loses it and that this cannot be undone, with **Cancel** selected. Afterward the row says "This message was deleted by You at 14:20." and the text is gone from the server.
- **Keys.** With the box empty, Up goes to your latest message and Up and Down move between your own. E edits, Delete or Backspace deletes, and Escape goes back one step.

A message can be changed until Podium has sent it to an agent. After that the menu items are greyed out with the reason under them, and E and Delete do nothing but say why. In a channel a message is sent once an agent you addressed is waiting, working or done; in a Direct Message, once it is queued, handed over or delivered, or approved by its owner. Until then you can still change a message that is held because the channel is paused, that waits for another person to approve it, that was not delivered, or that addresses only people. Changing or deleting a message that waits for approval changes the copy the other person sees, and deleting it withdraws the request.

An agent that reads the channel with `podium_chat_read` sees an edited message with its new text and "edited", and a deleted message as one line, "This message was deleted at <time>.", with no text. A message written before this was added can be changed only if its author's name still matches a current person.

## Who can read what

| Where | Who reads it |
|---|---|
| General | Everyone signed in |
| A public channel | Everyone signed in and every Admin; an orchestrator only the last hour and only where an `@` called it in, as in General |
| My group | You, your own agents and an Admin |
| A conversation of people | Its members, and nobody else: an Admin cannot read it |
| A conversation with an agent in it | Its members, and an Admin, who is recorded and tells everyone in it |
| A Direct Message with an agent | You and an Admin; for a conversation with another person's agent, both of you and an Admin |

An Admin never reads your conversation in silence, and the Admin log records the actions and never the text. General and the public channels are the exception because they are public: an Admin reading one is reading what everyone signed in can read, so no notice is raised.
An Admin's pause of a public channel for everyone, removal of all its messages, edit of its description or removal of the channel is told to the people it affects, with the Admin's name.

The (i) beside the **Chat** title opens **Chat privacy and controls**, the same rules in short form together with how agents act and how to stop a session. Close it with its X, Esc or a click on the dimmed area.

## When an Admin reads

An Admin can read your My group and your Direct Messages with agents, and you are always told. A conversation between people is not shown to an Admin: it is not in their list, its name is not told, and asking for it answers "Conversation not found."

- **While the Admin reads**, a red banner above the messages names every Admin who has the conversation open. Hover **Who is reading** to
  see each one and when they started. The row and the header carry a red **Admin reading** tag. The banner clears about 30 seconds after the
  last Admin stops.
- **Afterward**, a line stays in the conversation: "Root (an Admin) read this conversation on Nov 6 at 14:20." There is one for each Admin and
  each visit (visits less than 30 minutes apart are one). It is not a message and never holds text. It stays until the conversation is
  deleted or its days run out.
- **In your terminal**, `podium-reporter` shows a one-line callout from Podium: a toast that stays up for a minute, and on Claude Code a line in
  the transcript as well. On OpenCode it is a toast, and a board above the prompt that shows up to 5 lines for as long as the reading lasts (10 minutes at most). It is shown even when messaging is off for that reporter, and your agent never
  reads it.

An Admin who signs in with their own name is named by it. The admin secret has no name to go by, so a reading with it is named "Admin secret".

An Admin can also stop a conversation. They can **Pause link** or **Resume link** on any Direct Message, and **Pause**, **Resume**, **Disconnect**
or **Remove all messages** on your My group. They cannot remove a link, allow a message, delete a conversation or write in a conversation or in your My group. When an Admin pauses,
you see a red **Paused by an Admin** tag and a banner that names them, and you cannot resume it yourself; only an Admin can. An Admin's pause,
resume and remove all each leave a line in the conversation and a callout in your terminal. Removing all messages does not remove those lines.

If you are an Admin, the **Read as an Admin** picker at the top of the sidebar ("Read a person's conversations") lets you choose a person. You then see
their My group and Direct Messages, read only, with no unread counts and no People and agents. Until you choose one, the thread area says what to do, and in a person's conversation the message box is off and says "An Admin cannot send here". Choosing a person shows only names and counts, and it is
logged. Opening a conversation is a reading: the person is told, and the Admin log records `chat_admin_read`. Sending is not offered.

## What is not here yet

- Sending selected messages to an agent did not ship.
- A channel message does not interrupt an agent that is working. It sees the message when it reads the channel or when its turn ends.
- An agent's `@` of another agent in a channel is not delivered yet. The message is stored and says so.
- You cannot join, leave or mute a channel, reply in a thread, react to a message, pin one or search a channel. An opener who has no orchestrator open is not told when an Admin edits or removes their channel.
- Orchestrators read your messages at their next step, after the tool call they are on, on both Claude Code and OpenCode. A long tool call finishes first, and a message never stops one.

<!-- nav:start -->
---

Previous: [Traffic](15-traffic.md) · Up: [Reading the console](README.md) · Next: [History](16-history.md)
<!-- nav:end -->
