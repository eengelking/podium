---
title: "Admin log"
description: "Read who made each change in Admin, and where it came from."
group: "Getting started"
order: 13
---

# Admin log

Who made each change (a person, or the admin secret), with the address each came from. It records:

- unlocks and failed unlocks,
- new people, rotations and revocations,
- group changes,
- reporters removed,
- changes to the feature flags, the wall settings and model prices,
- changes to the Activity history policy, history the Admin deleted, and each purge that removed something (counts and
  sizes only),
- certificates issued and revoked, and TLS changes (a CA rotated or retired, the serving certificate),
- recordings stopped or deleted, and changes to the recording limits,
- changes to the messaging and Chat limits and to links (pause, resume, remove),
- reporters ignored or forgotten, and people deleted or restored,
- each time an Admin reads a person's content (a conversation, an agent's text or live feed, an activity record), with who and whose and never the text.

It never holds a token or the secret. Entries are kept for 90 days (set `RETAIN_ADMIN_LOG_MS` to change that), and the
newest 100 are kept however old they are. The page says how long entries are kept.

<!-- nav:start -->
---

Previous: [Reporting](12-reporting.md) · Up: [Admin](README.md) · Next: [About](14-about.md)
<!-- nav:end -->
