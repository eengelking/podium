# Introduction

Podium is a live fleet console for Claude Code. Every session on one machine shows up in one browser tab.

For each session it shows the model, effort and plan, the agents it launched, what they cost, how full their context windows are, why anything failed, and which git branch it works in. It is for someone who runs several Claude Code sessions or agents at once and wants to see what they are doing and costing without watching each terminal.

## What Podium does

- Shows each session within about two seconds of its first prompt, and removes it when it ends, with no refresh.
- Estimates cost from token counts and a price table. The table starts as Anthropic's list prices and you can change any price in Admin > Model prices. It is never a bill.
- Groups the wall by person when a whole team reports to one server.

## What Podium does not do

Podium watches. The one thing it can send is an answer to a session that waits on its person (a question, a plan, a tool's permission prompt, a message, `/clear` or `/compact`), and only once the server's Admin and the session's owner have both turned that on. It never types into a terminal and never changes a session's permission rules.

## How it fits together

Podium has two parts, and you run both yourself:

- The **server** stores what sessions report and serves the console you open in a browser. See [Running the server](SERVER.md).
- The **reporter mod**, `podium-reporter`, runs inside Claude Code and sends the data. See [Reporter](REPORTER.md).

## Where to go

| If you want to | Read |
|---|---|
| Set Podium up and read the dashboard | [User guide](USER_GUIDE.md) |
| Run the server for yourself or a team | [Running the server](SERVER.md) |
| Install and configure the mod | [Reporter](REPORTER.md) |
| Let your own orchestrators message each other | [Messaging](MESSAGING.md) |
| Record a session and play it back | [Session recording and replay](REPLAY.md) |
| Show Podium to other people | [Demo](DEMO.md) |
| Look up what Podium must do | [Specification](SPEC.md) |
| Learn how it was built, and why | [Architecture](ARCHITECTURE.md) and [Decisions](DECISIONS.md) |
| Find the fix for a sharp edge | [Gotchas](GOTCHAS.md) |
| Join the community | [Community](COMMUNITY.md) |
