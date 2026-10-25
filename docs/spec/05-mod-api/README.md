---
title: "5. The Claude Code mod API: everything the reporter needs"
description: "The reference for the Claude Code mod API the reporter uses: what is verified, what is assumed, and where to look."
group: "Reference"
entries: "list"
section: "5"
sidebar_label: "5. The mod API"
order: 5
---

# 5. The Claude Code mod API: everything the reporter needs

This section is the working reference. Two labels mark how far to trust a statement:

- **Verified**: read from the engine's type declarations on the build this spec was written against (engine
  2.1.296).
- **Assumption**: the implementer must check it against the types file or with `claude plugin validate` before
  relying on it. Any wrong assumption must be recorded in `docs/architecture/` under "Mod API findings".

## Pages

<!-- entries:start -->
- [5.1 Where the truth is](05-01-where-the-truth-is.md): Where to find the engine's types, guide and examples, and how far to trust each statement in section 5.
- [5.2 Shape of a mod (Verified)](05-02-shape-of-a-mod.md): The files a mod is made of: plugin manifest, hooks list and the register module.
- [5.3 Events the reporter hooks](05-03-events-the-reporter-hooks.md): Every event the reporter hooks, what it reads from each, and what it does, including responding and recording.
- [5.4 Engine calls the reporter uses (Verified)](05-04-engine-calls-the-reporter-uses.md): The engine calls the reporter makes, what each returns, and what the reporter uses it for.
- [5.5 Tool inputs the reporter reads (Verified)](05-05-tool-inputs-the-reporter-reads.md): The input shapes of the tools whose calls the reporter reads.
- [5.6 What the engine does and does not tell you](05-06-what-the-engine-does-and-does-not-tell-you.md): What data the engine gives the reporter, what it leaves out, and how tokens are counted.
- [5.7 Git queries](05-07-git-queries.md): The git commands the reporter runs, how often, and how it builds the changed-files list.
- [5.8 Session identity, /clear, restarts](05-08-session-identity-clear-restarts.md): How the reporter keeps one session identity across /clear, resume and restarts.
- [5.9 Mod configuration (userConfig)](05-09-mod-configuration-userconfig.md): The mod's options, how identity is set, and the reporter config file used with TLS.
- [5.10 Alternatives and extras the implementer may use](05-10-alternatives-and-extras.md): Other ways to feed Podium (settings hooks, environment variables, telemetry) that the implementer may use.
- [5.11 Testing a mod (Verified in the reference)](05-11-testing-a-mod.md): How to run and write tests for a mod.
<!-- entries:end -->

<!-- nav:start -->
---

Previous: [4. Architecture](../04-architecture.md) · Up: [Specification](../README.md) · Next: [6. The reporter protocol](../06-reporter-protocol/README.md)
<!-- nav:end -->
