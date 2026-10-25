---
title: "Session recording"
description: "Turn on session recording and know which three switches must all be on."
group: "Getting started"
order: 13
---

# Session recording

Podium can record one session whole and let you replay it, to see what happened and why. It is off by default and needs
three yes answers: the Admin's **Session recording** switch, your choice of the session, and the `sessionRecording`
option on the machine the session runs on. [REPLAY.md](../../REPLAY.md) explains all of it.

To record and replay:

1. Open the orchestrator's page. If the Admin has turned the feature on and you own the session (or are an Admin), the
   last cell of the facts panel reads **Record**.
2. Press it, tick the orchestrator and the agents you want, and press **Start recording**. If the machine's owner has not
   allowed recording, the dialog says so and nothing is recorded.
3. A red band on the card and a layer on the page say that it is being recorded, by whom, and when it is deleted. They
   have no X and cannot be hidden, for anyone, while the session is recorded. The owner's terminal says it too.
4. **Stop recording** ends it and keeps what was recorded. **Open replay** plays it back, oldest first: filter by agent,
   drag the slider, **Jump to next failure**, and **Show older** for a long run. **Delete recording** removes it. Each of
   these asks first.
5. A session that has ended is reached from History, whose row says "recording kept until `<time>`", or from Admin >
   Settings > Recordings.

What to know:

- Only the session's owner and an Admin can stop, delete or replay it. Everyone sees that it is recorded and never what
  is in it.
- It keeps whole prompts, file contents, command output and tool results. Anything that looks like a secret is replaced
  with `[redacted]` on the machine, but that is not a guarantee, so do not record a session you would not want an Admin
  to read.
- It is kept for 6 hours unless the Admin sets longer (7 days at most), and it stops by itself at 512 MB for one session
  or when all recordings reach 4 GB.
- The model's thinking text is not available. The replay marks where it thought and says the text is not there.
- An answer or approval sent from Podium shows in the replay as a row with who sent it. A question you answered in the
  terminal, or a permission prompt you answered there, leaves no row of its own; the tool's result still shows what ran.

<!-- nav:start -->
---

Previous: [Answering a session from Podium](12-answering-a-session-from-podium.md) · Up: [Reading the console](README.md) · Next: [My reporters](14-my-reporters.md)
<!-- nav:end -->
