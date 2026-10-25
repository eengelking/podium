---
title: "The choice, stated as what was decided"
description: "One sentence, under 160 characters, that says what was decided and what it costs."
group: Project internals
number: 0
date: 2026-01-01
status: accepted
---

# The choice, stated as what was decided

`status` is one of `accepted`, `superseded` or `proposed`. A superseded entry also has `superseded_by: <number>` in its
frontmatter and a line under the heading that links to the entry that replaced it. `number` never changes once
published, because other pages cite it as "DECISIONS n". Do not rewrite an old entry. Add a new one that says it
reverses the old.

## Context

What forced the choice: the situation, the constraint, the thing that would otherwise be re-argued.

## Decision

What was decided, in one or two sentences.

## Why

The reasons, strongest first.

## Alternatives

What else was considered and why it lost. Leave this part out only when there was nothing else to consider.

## Cost

What the choice gives up or makes harder. Leave this part out only when there is no cost.
