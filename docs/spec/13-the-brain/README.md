---
title: "13. The brain"
description: "Shared, weighted, searchable memories for a person's agents: what they are, who may read them, how they sync with local memory files, and how they are reviewed."
group: "Reference"
entries: "list"
section: "13"
sidebar_label: "13. The brain"
order: 13
---

# 13. The brain

| | |
|---|---|
| Status | Draft 3, revised after an adversarial review and several rounds of the maintainer's answers (2026-11-25). Not built, and no issue tracks it yet. [13.10](13-10-open-questions.md) lists what must be proved before issues are cut |
| Weight class | Staged DAG once it is cut into issues (the schema in every adapter, the sync protocol and the console views touch overlapping files) |
| Reasoning | [DECISIONS 79](../../decisions/79-the-brain-keeps-a-persons-memories-on-the-server-in-two-scopes-and-every-admin-read-of-one-is-told.md) (what the brain is and who may read it), [DECISIONS 80](../../decisions/80-memories-sync-by-version-chain-with-a-three-way-merge-and-a-conflict-is-kept-and-asked.md) (how local memory files sync) and [DECISIONS 81](../../decisions/81-memory-search-is-an-in-process-index-behind-an-interface-fed-from-storage-and-checked-against-it.md) (how search works) |
| Visual reference | None yet. A mockup of "My memories" and "Admin > Memories" is accepted before any console code ([13.8](13-08-the-console.md)) |

A harness writes an agent's memories as files on the machine the agent runs on. They do not follow the person to another
machine or another project, and two agents of one person learn different things. The brain is a place on the Podium server
where a person's memories live once, are found by search, and rank higher the more they help.

An agent reaches the brain only through `podium-reporter`, with tools the reporter registers. A person reaches it in the
console. The server stores it behind the storage adapter like everything else, and it works on SQLite, PostgreSQL and
MariaDB.

How to read this section:

| If you want | Read |
|---|---|
| What the brain is for, and what it must not become | [13.1](13-01-what-the-brain-is.md) |
| The record: fields, versions, tags, projects | [13.2](13-02-the-memory.md) |
| Who may read and write, sharing, and the Admin | [13.3](13-03-who-can-read-and-write.md) |
| How a search ranks, and how weight rises and falls | [13.4](13-04-search-and-weight.md) |
| How local memory files and the brain stay in line | [13.5](13-05-sync-with-local-memory-files.md) |
| The review of problem memories | [13.6](13-06-the-reviewer.md) |
| The tools an agent gets | [13.7](13-07-the-reporters-tools.md) |
| The two console pages | [13.8](13-08-the-console.md) |
| Tables, limits and retention | [13.9](13-09-storage-limits-and-retention.md) |
| What was decided, how unclear points are read, and what is proposed | [13.10](13-10-open-questions.md) |
| Route, event, error and interface names | [13.11](13-11-interfaces.md) |

## Pages

<!-- entries:start -->
- [13.1 What the brain is](13-01-what-the-brain-is.md): The goals of the brain, the consent it needs (all off until a person turns each on), what the switches protect against, and what it must not become.
- [13.2 The memory](13-02-the-memory.md): The memory record: its fields, types, tags, project, versions and states (including the 30-day trash), edges, and how an id binds it to a person.
- [13.3 Who can read and write](13-03-who-can-read-and-write.md): Scopes, projects and grants, promotion, sharing one memory with another person, and what an Admin may read and delete and how the person is told.
- [13.4 Search and weight](13-04-search-and-weight.md): Reading in steps from summary to resources, a swappable in-process search index checked against Storage, and adjustable weights with their history.
- [13.5 Sync with local memory files](13-05-sync-with-local-memory-files.md): How a harness's memory files and the brain stay in line: mirrors, the three-way merge, conflicts, deletes, the guards, and what must be proved first.
- [13.6 The reviewer](13-06-the-reviewer.md): A manual review an administrator starts, that flags problem memories and proposes changes. A person approves each one, and replaced text stays for 30 days.
- [13.7 The reporter's tools](13-07-the-reporters-tools.md): The tools podium-reporter registers for the brain, the switches that gate them, how a result is framed, and what the server decides.
- [13.8 The console](13-08-the-console.md): My memories and My reporters for a person, Admin > Memories for an Admin: what each shows, the notices, the content-free live event, and the mockup.
- [13.9 Storage, limits and retention](13-09-storage-limits-and-retention.md): What the store holds in every adapter, the checks that must exist before any route, the limits and their defaults, and how long each kind of row is kept.
- [13.10 Open questions](13-10-open-questions.md): What the maintainer decided, how the draft reads the unclear points, the proposals not yet decided, and what must be proved before issues are cut.
- [13.11 Interfaces](13-11-interfaces.md): The names the brain's issues share: routes for reporters, people and Admins, the live event, error codes, store and index interfaces.
<!-- entries:end -->

<!-- nav:start -->
---

Previous: [12. Open questions and flagged assumptions](../12-open-questions.md) · Up: [Specification](../README.md)
<!-- nav:end -->
