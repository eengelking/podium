---
title: "8. The UI"
description: "What the browser UI must do and how it is built: requirements, components, tokens and accessibility."
group: "Reference"
entries: "list"
section: "8"
sidebar_label: "8. The UI"
order: 8
---

# 8. The UI

`mockup/podium.html` is the specification. Open it, read all of it (about 1,100 lines), and reproduce its behavior in React. Where the mockup simulates data, the UI consumes `SessionView`. Do not redesign. New UI follows the standards in `docs/standards/` and starts with a mockup that links `tokens.css`. `mockup/podium-wall.html` shows the collapsed panes, the disconnect strip and wall mode added in #33.

## Pages

<!-- entries:start -->
- [8.1 What the UI must do](08-01-what-the-ui-must-do.md): The UI's requirements, one line each, from the page frame through the Admin pages, responding and the orchestrator page.
- [8.2 Components](08-02-components.md): The components to create and how they group.
- [8.3 Visual tokens](08-03-visual-tokens.md): Where color tokens live, the themes, and the rules that keep the UI on them.
- [8.4 Accessibility and responsiveness](08-04-accessibility-and-responsiveness.md): The accessibility and narrow-width rules every control must meet.
- [8.5 History](08-05-history.md): What the History page (#/history) shows and does: day picker, table, paging, opened session, empty and error states, sign-in and narrow layout.
<!-- entries:end -->

<!-- nav:start -->
---

Previous: [7. The server](../07-server/README.md) · Up: [Specification](../README.md) · Next: [9. Phased build plan](../09-phased-build-plan.md)
<!-- nav:end -->
