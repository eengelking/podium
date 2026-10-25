---
title: "5.11 Testing a mod (Verified in the reference)"
description: "How to run and write tests for a mod."
group: "Reference"
section: "5.11"
order: 11
---

# 5.11 Testing a mod (Verified in the reference)

`claude plugin test <folder>` runs `*.test.ts`. Import `test`, `expect`, `mock` from `'claude-code/testing'`. A test holds the engine's `$` and an `on` whose hooks sit beneath the plugin. Hooks beneath stand in for the engine, so what they answer is what the plugin receives. `test(name, { options }, body)` supplies `userConfig` values. `mock.session(on)` reads appended rows back. A UI test mounts a component per surface; the reporter has no UI components, so it needs none. Read the testing types (`grep -n "claude-code/testing"` in the types file) for the exact API, and write a test that raises each hooked event and asserts what the reporter posted through a mocked `http.fetch`.

---

<!-- nav:start -->
---

Previous: [5.10 Alternatives and extras the implementer may use](05-10-alternatives-and-extras.md) · Up: [5. The Claude Code mod API: everything the reporter needs](README.md)
<!-- nav:end -->
