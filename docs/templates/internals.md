---
title: "Name of the topic"
description: "One sentence, under 160 characters, that says what a contributor learns from this page."
group: Project internals
---

# Name of the topic

This page records <what: how it was built, why a choice was made, what is known to go wrong>. It is for
<who: a contributor, a maintainer>, who wants to <understand or change what>. What the product must do is in
[SPEC.md](SPEC.md); this page does not restate it.

Contents:

- [The shape of it](#the-shape-of-it)
- [How it works](#how-it-works)
- [What is still open](#what-is-still-open)

## The shape of it

Start with the answer: the structure, the decision, the symptom. Then the reasons.

## How it works

Cite the source file for a claim about code, as `path/to/file.ts`, and the spec section for intended behavior,
as `SPEC 6.8`. A reader should be able to check the claim in one step.

Entries in a log page (decisions, gotchas) keep their fixed parts, in order:

- **You see**, **Why**, **Do** for a gotcha.
- Context, Decision, Why, Alternatives, Cost for a decision.

## What is still open

Say what is not done or not known. Do not leave it out to make the page read as finished.
