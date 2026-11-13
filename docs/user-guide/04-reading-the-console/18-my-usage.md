---
title: "My usage"
description: "See your own spend, sessions, failures and tool calls, and nobody else's."
group: "Getting started"
order: 18
---

# My usage

**My usage** (`#/me/usage`) shows what your own sessions cost, how they ended, what failed and which tools they called. It shows only you. Admin
[Reporting](../05-admin/12-reporting.md) holds the same kinds of figures for everyone; this page is the part that is yours. `mockup/podium-my-usage.html` shows every case.

It needs authentication on and the Admin's **My usage page** switch (Admin > Settings > Feature flags), which is off by default. Sign in with your name and token from **Sign in** at the far
right of the top bar. The top bar then has **My usage** beside **My reporters**, on every page except My usage itself. With the switch off there is no button, and `#/me/usage` says the page was not found.
Signed out, the page says how to sign in and shows nothing.

## What it shows

The page opens on the last 30 days. **Period**, **By** (day, week or month) and **Break down by** work as they do in Admin Reporting, and the same period applies to every section.

- **Spend.** What your sessions cost, in a chart and a table, broken down by model, by project or not at all. It is estimated from tokens, not a bill. **Spend by project** follows it.
- **Sessions by outcome.** How your sessions ended, how long they ran and how full their context got.
- **Failures.** What failed, by class. A row opens [History](16-history.md) for your sessions from the last 30 days; older ones have counts only.
- **Tool calls.** Which tools your sessions called, by harness. Only names and counts are kept, never an argument, a path or a command.

**Harness** narrows Tool calls. Spend, sessions and failures cover every harness, because the daily figures they read are not kept per harness, and the page says so.

A table heading is a button: click it to sort the table (the largest first for a number column, a second click reverses it).

Every section has **CSV** and **JSON**, and the top **Print**, for exactly the table you see. They hold your rows only.

## How far back it goes

Spend and Failures keep the same history as Admin Reporting. Sessions and Tool calls are built from your stored sessions, which Podium keeps for about a month, so a period that reaches
further back says "Podium has no history before ..." and shows what there is. An earlier day is not zero; it is not there.

## Only yours

The server decides whose figures these are from your sign-in. The page sends no name, group or id, and the server ignores one if it is sent. No other person's name, session or reporter is in
anything it answers. Another person's figures are not reachable from here, even for an Administrator: an Administrator who opens it sees their own sessions. The server's side is in
[SPEC 7.1](../../spec/07-server/07-01-endpoints.md).
