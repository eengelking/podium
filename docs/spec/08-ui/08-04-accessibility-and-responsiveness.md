---
title: "8.4 Accessibility and responsiveness"
description: "The accessibility and narrow-width rules every control must meet."
group: "Reference"
section: "8.4"
order: 4
---

# 8.4 Accessibility and responsiveness

Every interactive element is a real `button`, `a` or `input`, with a visible focus ring. Resize handles are `role="separator"` with `aria-orientation`, `aria-valuenow`, labels and arrow-key support. The pane tabs and the top bar toggle report `aria-expanded` and `aria-controls`. Charts have `role="img"` with an `aria-label`; the same numbers are in text elsewhere. No horizontal scroll of the page at 400 px; the agent tree scrolls inside its own container. The page title follows the route, and on Admin it names the open section. The rules for each control are on `docs/standards/accessibility.html`.

---

<!-- nav:start -->
---

Previous: [8.3 Visual tokens](08-03-visual-tokens.md) · Up: [8. The UI](README.md) · Next: [8.5 History](08-05-history.md)
<!-- nav:end -->
