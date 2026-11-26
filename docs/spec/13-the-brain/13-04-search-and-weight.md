---
title: "13.4 Search and weight"
description: "Reading in steps from summary to resources, a swappable in-process search index checked against Storage, and adjustable weights with their history."
group: "Reference"
section: "13.4"
order: 4
---

# 13.4 Search and weight

The reasoning is in [DECISIONS 81](../../decisions/81-memory-search-is-an-in-process-index-behind-an-interface-fed-from-storage-and-checked-against-it.md).

## 13.4 An agent reads in steps

A memory is read the way a skill is: a short summary first, and the rest only when the agent asks. The aim is that an agent's
context holds only what it needs, however many memories there are.

1. **Search** returns summaries only. Each result carries the `id`, `name`, `description` (the summary), `type`, `tags`,
   `project`, `scope`, `weight`, `state`, `checked_at`, whether it is `superseded`, and the names and one-line descriptions of its
   resources. It never carries a body or a resource's content.
2. **Open a memory** returns its body and the list of its resources, each with name, description and size. It does not return
   their content.
3. **Open a resource** returns one resource's content. An agent opens only the ones it needs, one at a time.

At any step the agent decides "this is it" or keeps looking. A rejection is a vote ([13.4 Weight](#134-weight)).

## 13.4 The index

Search is served by an **index** in the server process, behind an interface (`MemoryIndex`). The database stays the only
durable store. The index is derived data: it holds nothing the database does not, it is never saved anywhere else, and it
can be rebuilt at any time from `Storage`.

- **It lives outside the adapters,** in `server/src/brain/`. It imports no database driver and reads memories only through
  store methods in `types.ts`, so `neutral.test.ts` holds and one engine serves SQLite, PostgreSQL and MariaDB alike.
- **The search library is swappable, and the first one is MiniSearch.** Only the implementation of `MemoryIndex` that uses it may
  import it, and a test in the style of `storage/neutral.test.ts` fails a file that imports a search library from anywhere else.
  One contract test, `server/src/brain/indexContract.ts`, runs over every implementation. Libraries score differently, so the
  contract asserts behavior and not scores, each property with the fixture it holds on: what matches (prefixes, an empty query,
  required tags with no words); what is filtered; that of two otherwise identical memories of equal weight, the one matching in
  `name` ranks above the one matching in `body`; that of two identical memories the superseded one ranks lower; that weight
  moves a score only within its bounds; that removal removes; that the order is total; and that paging returns every result
  once. Replacing the library means writing one implementation that passes that test.
- **What it holds** for each memory is its `name`, `description`, `tags`, `body`, and the names, descriptions and **content** of
  its resources for matching, and its `owner`, `scope`, `project`, `state`, `type`, `weight` and `weight_at` for filtering and
  ranking. A fact written only inside a resource is found, and the result still carries only the summary.
- **Every write that changes what is matched, filtered or ranked updates it,** in the request that wrote, after the transaction
  commits and before the reply: a new version, a state change (flag, hide, trash, restore, purge), a project change, a vote or a
  use, an edge, a half-life or cap change, and the deletion of a person or a project. So there is no drift by design and an agent
  that saves a memory finds it a second later.
- **An update re-reads the memory by id through `Storage`** and keeps the memory's change counter it applied, so two updates
  that finish out of order cannot leave the older one in place.
- **While it builds or rebuilds, it says so.** At start, and after any rebuild, a search answers `503 indexing` with
  `Retry-After`, the tool tells the agent to wait and try again, and the console shows a banner that the brain is being
  re-indexed. The build's time and size are measured at the limits of [13.9](13-09-storage-limits-and-retention.md).
- **A check is the safety net.** Every 10 minutes and after any error in an update, the index compares each memory's change
  counter, read from the store in batches, with the one it applied. A mismatch is a defect: it re-reads those memories, or
  rebuilds with the banner, and logs the counts, never a memory.
- **It relies on one server per database** (DECISIONS 53). Server and database are one `podiumctl` deployment. More than one
  server process on a database is not supported, and the troubleshooting guide says so.

## 13.4 A search

A search is the query's terms (at most 12), the reader, and optionally a project, a type, a scope and **required tags**. A memory
is returned only if it carries every required tag, so a person or an agent can keep unrelated memories out. `podium_brain_tags`
lists the tags the reader can see, with counts, so an agent chooses real ones instead of guessing. The list and its counts come
from a store method under the access rules, never from the index. Tags are the only categories; `type` is the one fixed one.

1. **Match.** Text is normalized with Unicode NFKC, lowercased, and split into words on anything that is not a letter, a digit or
   a combining mark, which stay inside the word. Words are cut at 40 characters by code point. The first version is English only
   ([13.1](13-01-what-the-brain-is.md)). Each query term also matches stored terms it is a prefix of when it is at least 3
   characters long.
2. **Relevance.** BM25 over the fields, weighted so that `name` and `tags` count most, then `description` and resource names,
   then `body`, and resource content least. The starting weights are `name` 3, `tags` 3, `description` 2, resource names and
   descriptions 2, `body` 1 and resource content 0.5. Resource content can be large, so the index's size is part of the
   measurement of [13.9](13-09-storage-limits-and-retention.md).
3. **Weight.** The relevance is multiplied by `1 + 0.5 * tanh(w / 10)`, where `w` is the memory's weight faded to the time of the
   query, so weight moves a result by at most half either way and never hides one.
4. **Superseded.** A memory with a `supersedes` edge from a memory the reader may read in the same scope ([13.2](13-02-the-memory.md)) has its score
   halved and is marked.
5. **Rejected in this session.** A memory the session rejected is left out of that session's later searches
   ([13.4 Weight](#134-weight)).
6. **Order.** Score, highest first, then most recently changed, then `id`, so the order is total.

**The index never decides access.** It returns ranked candidate ids, narrowed by `owner`, `scope`, `project`, `state` and tags as a
first cut. Each candidate page is then **re-checked through `Storage`** with the real access rules of
[13.3](13-03-who-can-read-and-write.md), in one store call that returns only what the reader may read. A candidate the check refuses is dropped
and never returned, and more are fetched, up to three rounds. A refusal the first cut should have made is counted and logged. A
stale or wrong index can miss a memory but cannot show one the reader may not read.

A page is 10 memories by default and 50 at most, and the result says whether there is another page. The next page is asked
with a cursor that pins the query's time, so fading weights cannot skip or repeat a result between pages. The edges used for
step 4 are checked through `Storage` too, and a hidden memory is filtered out. A search result is never a use. Search terms are
never logged.

## 13.4 Weight

A memory's weight is what its **uses** add, up to a cap, plus what its **votes** add. Both start at 0 and fade with time.

| Event | Default amount | Counts when |
|---|---|---|
| A use | +1 | An agent opens the memory's body with `podium_brain_get`. A search result, a resource read and a person opening it in the console are not uses |
| An upvote | +3 | A person, or an agent for its person, votes up |
| "Not relevant", after opening it | -1 | Once for one person and one memory in one day, like a use |
| "Not relevant", from a search summary | 0 | It only leaves the memory out of that session |
| Wrong, outdated or unsafe | -4 | A person or an agent votes down with that reason. `unsafe` also flags the memory ([13.2](13-02-the-memory.md)) |

**Uses alone add at most 10** (an Admin setting), so a much-used memory ranks higher and can still be voted down. Without the
cap, daily use would raise a memory so far that several "wrong" votes changed nothing. An Admin or the owner can also delete it.

**The amounts and the half-life are Admin settings** with these defaults, so they can be tuned without a code change. **A change
applies from then on.** Weights already stored are not re-scored.

**A history makes re-scoring possible later.** The server keeps every vote event (a random vote id, whether it was cast,
changed or withdrawn, the amount, the reason, the time) and a count per memory per day of uses and of "not relevant". The vote id
pairs a withdrawal with its vote and leads to no person. The history records no voter and no reader. It lives as long as the
memory and is purged with it.

**A use counts once for one person and one memory in one day (UTC),** whatever the number of agents or sessions. **A vote is one
per person and memory:** an agent's vote is its person's vote, recorded with the agent that cast it, so fifty sessions cannot
vote fifty times.

**A rejection stays out of the session that made it,** whether it was made from the summary or after opening the memory, so the
same miss does not come back. An agent may reject from a summary without opening the memory, which is the point of a summary.

**Fading is lazy.** A memory keeps its use part, its vote part and `weight_at`. When an event happens, the store fades both
(`part * 0.5^((now - weight_at) / half-life)`), adds the amount to one of them and sets `weight_at = now`, in the same transaction
as the event. A read computes the faded weight, `min(use part, cap) + vote part`, and the search ranks by that value at the query's time, so nothing runs on a
timer and an untouched memory drifts to 0, ranked lower. Nothing is deleted for a low weight. The half-life is 90 days by default.
When the Admin changes it, one transaction fades every weight to that moment under the old half-life and keeps the new one from
then.

**A vote that is changed or withdrawn takes back what is left of it, not what it was.** Each vote keeps its time and amount. The
store removes the vote's faded remainder and adds the new amount, so voting, waiting and withdrawing cannot drive a memory down.

### Who may vote

- A voter votes only on a memory they may read. An agent votes up, or down as wrong, outdated or unsafe, only after it has opened
  the memory in the same session.
- A person's vote and an agent's vote carry the same amount, and each records which it was. This is revisited if it becomes a problem.
- A vote on a `person` memory is the owner's. Its reason is visible to the owner only.

## 13.4 What the server holds

`memories` holds the use part, the vote part and `weight_at`. A table of votes holds one current row per person and memory (the
person's id is not nullable, because a `NULL` in a unique key lets duplicates through on all three databases), the agent that
cast it, the amount, the reason and the time. A small table holds one row per person, memory, day and kind (use or "not
relevant"), swept after two days. The history holds vote events and daily counts with no person in them. A session's rejections live in memory with the session and are dropped when it ends.

## Related

- [13.9 Storage, limits and retention](13-09-storage-limits-and-retention.md)
- [13.11 Interfaces](13-11-interfaces.md)

<!-- nav:start -->
---

Previous: [13.3 Who can read and write](13-03-who-can-read-and-write.md) · Up: [13. The brain](README.md) · Next: [13.5 Sync with local memory files](13-05-sync-with-local-memory-files.md)
<!-- nav:end -->
