---
title: "13.6 The reviewer"
description: "A hand-run review that flags problem memories and proposes changes. An Admin reviews shared memories, a person their own, and a person approves each change."
group: "Reference"
section: "13.6"
order: 6
---

# 13.6 The reviewer

A shared memory is text one agent wrote that another agent may act on. Some will be wrong, stale, a duplicate, or an attempt
to steer another agent. The reviewer looks for those and flags them. It never removes one.

## 13.6 What it is

Podium never starts or stops an agent (section 1). So the reviewer is not a service in Podium. It is an agent definition and two
tools that ship with `podium-reporter`, run in a person's own harness on that person's model and tokens, and the console says so.

**At first it is a manual process an administrator controls,** for the shared memories. Later, Podium is expected to create
orchestration agents of its own for this work, which is out of scope here ([section 11](../11-out-of-scope-and-deferred.md)). A
person may also run a review over their own memories.

A run needs the Admin flag **Brain** on, the runner's reporter Brain switch at `readwrite`, and a run started in the console.

## 13.6 What a run may read

| Run started by | May read |
|---|---|
| An Admin who is also a person | The `everyone` scope only, including flagged memories. **Never a person's `person` memories** |
| A person | Their own memories for the projects they tick in the run's start dialog, when they turned on **Reviewer**, and the `everyone` scope when they have **Read shared memories** on |

**No run reads another person's memories.** A review runs in the starter's own session, so what it reads is in that session's
transcript, recording and answers, where no notice to an owner could follow it.

## 13.6 What it may do

- `podium_brain_review_queue` lists the memories a run may look at, oldest unreviewed first, with the reason each was queued: new,
  downvoted, flagged, possible duplicate, superseded by something heavier, or not checked for a long time ([13.2](13-02-the-memory.md)).
- `podium_brain_review_propose` records a **proposal** against one memory: `flag` (a reason and a note), `edit` (the new text),
  `merge` (this memory into another, as a `supersedes` edge) or `delete` (a reason).

A proposal changes nothing. It is a row in a **review log** with the run, the reviewer's agent id, who started the run, the
memory, the version the proposal is against, the change, the reason and the time.

## 13.6 A run belongs to one session

The console asks which of the starter's live sessions will do the run, shows what it may read and an estimate of its size, and
asks for confirmation. The server **binds the run to that one session id** and refuses every review call from any other session.
Until a run is started the review tools answer `403`. A run ends when the reviewer says so, when the starter ends it, after 200
proposals or 2 hours, or when its session ends. A run reads at most 500 memories. Turning **Reviewer** or the Brain switch off
ends the run at the next call.

## 13.6 How a proposal becomes a change

1. The reviewer adds proposals to the log.
2. The approver reads the log. Each proposal shows the memory, the change as a diff, and the reason.
3. The approver approves or rejects each one. **Nothing is written until it is approved.** An approval makes a new version that
   names the review run as the author and the approver, or trashes the memory for a `delete`.
4. A proposal against a version that has changed since is **stale**. It can only be rejected or re-proposed.
5. The text a change replaced, like any trashed memory, is kept for **30 days** and the owner can restore it ([13.2](13-02-the-memory.md)).
   After that the old text is gone, and a record names the change, the approver and the time, never the text.

**Who approves.**

| The memory | `edit` and `merge` | `flag` and `delete` |
|---|---|---|
| A `person` memory | The owner | The owner |
| An `everyone` memory | The owner, and the result then needs approval like any edit to a shared memory ([13.3](13-03-who-can-read-and-write.md)) | The owner or an Admin |

An Admin never edits, so an `edit` is never theirs to make. A memory whose owner is gone can only be flagged or deleted.

## 13.6 Limits

- A review log keeps proposals and their outcome for the retention period ([13.9](13-09-storage-limits-and-retention.md)). The
  proposed text lives only as long as the proposal is open or the change can still be undone.
- A run never reads a conversation, a prompt or a session. It sees the memories and the vote reasons it is allowed to.
- Every proposal's text is shown as text, never run, rendered as HTML or followed.

## Related

- [13.3 Who can read and write](13-03-who-can-read-and-write.md)
- [13.7 The reporter's tools](13-07-the-reporters-tools.md)

<!-- nav:start -->
---

Previous: [13.5 Sync with local memory files](13-05-sync-with-local-memory-files.md) · Up: [13. The brain](README.md) · Next: [13.7 The reporter's tools](13-07-the-reporters-tools.md)
<!-- nav:end -->
