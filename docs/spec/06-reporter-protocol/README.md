---
title: "6. The reporter protocol"
description: "The data that crosses the wire between the reporter and the server: the report, its rules and version compatibility."
group: "Reference"
entries: "list"
section: "6"
order: 6
---

# 6. The reporter protocol

## Pages

<!-- entries:start -->
- [6.1 Endpoint](06-01-endpoint.md): The report endpoint: request headers and body, and each response the server can send.
- [6.2 The Report](06-02-the-report.md): The shape of a Report: every field, its type and when it is null.
- [6.3 Plan building rules](06-03-plan-building-rules.md): How the reporter builds a session's plan from task tool calls.
- [6.4 Failure and excerpt rules](06-04-failure-and-excerpt-rules.md): How failures are classified, how text is redacted, and what the opt-in full text, activity, recording and diff options send.
- [6.5 Models, windows, prices](06-05-models-windows-prices.md): How a model is named, its context window sized and its price applied.
- [6.6 Session display name](06-06-session-display-name.md): How a session's display name is chosen, in priority order.
- [6.7 Reporting cadence](06-07-reporting-cadence.md): When the reporter sends: on change, on heartbeat, and how often it polls git.
- [6.8 Version compatibility](06-08-version-compatibility.md): How the mod and server versions may drift, the supported range, and how each side tells the person.
<!-- entries:end -->

<!-- nav:start -->
---

Previous: [5. The Claude Code mod API: everything the reporter needs](../05-mod-api/README.md) · Up: [Specification](../README.md) · Next: [7. The server](../07-server/README.md)
<!-- nav:end -->
