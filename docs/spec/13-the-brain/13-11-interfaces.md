---
title: "13.11 Interfaces"
description: "The names the brain's issues share: routes for reporters, people and Admins, the live event, error codes, store and index interfaces."
group: "Reference"
section: "13.11"
order: 11
---

# 13.11 Interfaces

Two people cutting issues from this section must get the same names, so they are fixed here. Request and response shapes are
defined with the types in `plugin/core/protocol.ts` and the server's view types, which the first issue that adds a route
writes. Every route follows the conventions of [7.1](../07-server/07-01-endpoints.md).

## 13.11 Reporter routes

Under `/api/fleet/sessions/:id/brain`, with the person's token, for a live session that has a person behind it. A refusal is
`{ ok: false, error, code }` with `error` in words the model can be shown.

| Route | Tool or use |
|---|---|
| `POST /search` | `podium_brain_search` (a `POST`, so that no query term is in a URL or a log) |
| `GET /tags` | `podium_brain_tags` |
| `GET /memories/:memoryId` | `podium_brain_get` |
| `GET /memories/:memoryId/resources/:resourceId` | `podium_brain_resource` |
| `POST /memories` and `PUT /memories/:memoryId` | `podium_brain_save` |
| `POST /memories/:memoryId/checked` | `podium_brain_checked` |
| `POST /memories/:memoryId/vote` | `podium_brain_vote` |
| `POST /memories/:memoryId/flag` | `podium_brain_flag` |
| `POST /sync/plan` | The first step of a sync ([13.5](13-05-sync-with-local-memory-files.md)), from `podium_brain_sync` and at session start |
| `GET /sync/versions/:versionId` | A base version's content, for a merge |
| `POST /sync/push`, `/sync/conflicts`, `/sync/uploads`, `/sync/confirm` | A push with its base, a conflict's local side, a dry run's or a pause's list, and what was written or deleted |
| `GET /review/queue` and `POST /review/proposals` | the review tools |

## 13.11 Console routes for a person

On responding's browser router, `/api/fleet/respond/brain`, with its sign-in and `X-Podium-Respond: 1` on a change, and
`Cache-Control: no-store`. Each acts on the signed-in person's own data.

| Route | Does |
|---|---|
| `GET /memories`, `GET /memories/:id`, `PUT /memories/:id`, `DELETE /memories/:id` | List, read, edit, trash |
| `POST /memories/:id/restore`, `/checked`, `/pin`, `/vote`, `/promote`, `/share` | The actions of 13.8 |
| `GET /trash` | Recently deleted |
| `GET /memories/:id/versions`, `GET /memories/:id/versions/:versionId` | The history and one version |
| `POST /memories/:id/flag`, `DELETE /memories/:id/flag`, `DELETE /memories/:id/vote`, `POST /memories/:id/seen-merge` | Flag, clear a flag, withdraw a vote, dismiss a merge notice |
| `POST /edges`, `DELETE /edges/:id` | `supersedes` and `related` |
| `POST /memories/:id/promotion`, `DELETE /promotions/:id`, `DELETE /public/:id` | Ask for a promotion, withdraw the request, withdraw a shared memory of one's own |
| `GET /offers`, `GET /offers/sent`, `POST /offers/:id/accept`, `/decline`, `/block`, `DELETE /offers/:id`, `DELETE /blocks/:personId` | The inbox, what was sent, withdrawal and unblocking |
| `GET /conflicts`, `POST /conflicts/:id/resolve`, `POST /duplicates/:id/resolve` | Conflicts and possible duplicates |
| `GET /imports`, `POST /imports/:id/approve`, `POST /pauses/:id/approve` | A dry run, a paused sync and their approval |
| `POST /folders/:id/relink` | A folder that moved |
| `GET /projects`, `POST /projects`, `PUT /projects/:id`, `DELETE /projects/:id?memories=none\|trash` | Projects |
| `DELETE /review/runs/:id` | End a run |
| `GET /access`, `PUT /access/:reporterKey` | The Brain switch, Sync, folders and grants |
| `PUT /settings` | Read shared memories and Reviewer |
| `POST /review/runs`, `GET /review/proposals`, `POST /review/proposals/:id` | A review |

## 13.11 Admin routes

Under `/api/admin/brain`, behind the Admin unlock, with the same-origin `Origin` and `X-Podium-Admin: 1` on a change. Each write
is recorded with `audit()`, and each read of a person's content is in the Admin read registry.

| Route | Does |
|---|---|
| `GET /settings`, `PUT /settings` | The settings of 13.8 |
| `GET /public`, `GET /public/:id`, `DELETE /public/:id`, `POST /public/:id/hide`, `/clear` | The `everyone` memories and flags |
| `POST /purge/:id` | Purge an exposed secret at once, logged and told as that |
| `GET /promotions`, `POST /promotions/:id/approve`, `/reject` | Promotion requests |
| `GET /people` | Counts only |
| `GET /people/:personId/memories`, `GET /people/:personId/memories/:id`, `DELETE /people/:personId/memories/:id` | A told read, a told read, a told delete |
| `GET /people/:personId/projects`, `POST`, `PUT /people/:personId/projects/:id` | Told reads and writes of project names |
| `POST /review/runs`, `GET /review/proposals`, `POST /review/proposals/:id` | A review the Admin starts |

## 13.11 The live event

`brain`, with `{ rev, scope: 'person' | 'everyone' }` and nothing else ([13.8](13-08-the-console.md)).

## 13.11 Codes

The `code` of a refusal, with its status:

| `code` | Status | When |
|---|---|---|
| `brain-off` | 403 | The Admin flag, the machine's option or the console switch is off |
| `project-not-held` | 403 | A save or search names a project the agent does not hold |
| `invalid` | 400 | A field or tag breaks its rule |
| `stale-proposal` | 409 | A proposal against a version that has changed |
| `conflict-open` | 409 | An action that an open conflict blocks |
| `paused` | 409 | A sync waiting for the person's approval |
| `no-person` | 403 | The session has no person behind it |
| `reporter-too-old`, `server-too-old` | 403 | The reporter is outside the three-version window, below it or above it |
| `not-found` | 404 | No such memory, or one the reader may not read |
| `version-mismatch` | 409 | A save or push whose version is not the current one |
| `no-run` | 403 | A review tool with no run for this session |
| `secret-found` | 422 | Any part of a memory matched a secret pattern, named without its text |
| `over-limit` | 422 | A write over a limit, which is named |
| `rate-limited` | 429 | With `Retry-After` |
| `indexing` | 503 | The index is building, with `Retry-After` |

## 13.11 Code interfaces

| Name | Where | Is |
|---|---|---|
| `BrainStore` | `server/src/storage/types.ts` | The store of memories and everything of [13.9](13-09-storage-limits-and-retention.md), reached through `Storage`, with a `contract.ts` case for each method |
| `MemoryIndex` | `server/src/brain/` | The search index of [13.4](13-04-search-and-weight.md), with `indexContract.ts` |
| `MemoryFormat` | `plugin/<harness>/` | A harness's local file format ([13.5](13-05-sync-with-local-memory-files.md)), with the shared merge in `plugin/core/` |

An offer to someone who blocked the sender is accepted by the route and goes nowhere, so the block is not revealed. A sort of the
console's list by weight is answered from the index, which holds the faded weight, so no adapter does time arithmetic in SQL.

Route and type names may change during review. After the first issue that adds one is merged, a change goes through this page.

## Related

- [13.7 The reporter's tools](13-07-the-reporters-tools.md)
- [7.1 Endpoints](../07-server/07-01-endpoints.md)

<!-- nav:start -->
---

Previous: [13.10 Open questions](13-10-open-questions.md) · Up: [13. The brain](README.md)
<!-- nav:end -->
