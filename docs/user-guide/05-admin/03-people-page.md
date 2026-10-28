---
title: "People page"
description: "Create a person, copy their token and rotate or revoke it."
group: "Getting started"
order: 3
---

# People page

Under **Create user**, type a name and choose Create user.

- Podium shows the token once, above the page (it stays there when you switch pages), with the settings to paste into
  that person's reporter: `userName`, `token` and `serverUrl`. Copy them before you choose "I have saved it", because
  Podium keeps only a hash and cannot show the token again. With TLS on, the same box also gives the person's reporter
  config, one file named `reporter-config-<name>-<epoch>.pem`: choose **Download reporter config**, save it in
  `~/.podium/` on the machine where Claude Code runs, and start a new Claude Code session. A session that is already
  running does not pick it up, and podium-reporter needs Node.js on the machine's PATH. A person who uses more than one
  Podium server names each file with a context (`/podium context add`; see [REPORTER.md](../../REPORTER.md#contexts-more-than-one-podium-server)). Podium keeps only the
  certificate, so the file is shown once.
- The list has a **Reporter certificate** cell and a **Console token** cell, each with its own badge. Hover a badge (or
  tab to it) for the note: the certificate's date and what happens next, or the token's `pdm_` key id. The Group select
  is under the name, and "created" is under Last report. With TLS off the certificate cell says so. The certificate badge
  reads *valid*, *renewal due* (30 days or fewer left; the reporter renews it itself), *lapses soon* (10 days or fewer
  and not renewed, so reissue the config in time), *expired* (the reporter is refused and cannot renew: reissue the
  config), *revoked* or *none*.
- Each row has one **Actions** menu, grouped Console token, Reporter certificate and Person. Arrow keys, Home and End
  move in it and Escape closes it; an action that does not apply is greyed out.
- **Rotate token** gives a person a new token and stops the old one, and shows it once. Their reporter keeps working.
- **Revoke token** refuses their console sign-in from the next request, and with TLS on their certificate too, so a
  person who is cut off cannot go on with the other credential. A revoked person's row offers **Issue new token**, which
  brings back the console sign-in only: with TLS on, their reporter stays refused until you choose **Reissue config**.
- **Revoke certificate** stops the reporter that uses the certificate and leaves the console sign-in; their token still works until it is revoked. **Revoke token** or **Revoke all** cuts the person off.
  **Reissue config** makes a new certificate and key, stops the old certificate, and shows the new file once. Each asks
  first, in a row under the person that says what will happen.
- **Download certificate** gives the public certificate and the CA, never a key, so it cannot replace the file.
- **Delete** removes a person, and a dialog asks first. Their reporter is refused at once, they leave their group, and
  an Administrator's open Admin session locks. Their past sessions, spend and Admin log entries keep their name, and the
  name can be used again later. To delete several people, tick their rows (the box in the header ticks the page), then
  choose **Delete N…** in the bar above the list. Ticks are for the page you are on. Podium refuses, and deletes no
  one, if the choice includes you or would leave Administrators with no active member.
- The search finds a person by name, group or machine.
- A person in the Administrators group has their name in orange.

A report is accepted when its token belongs to the person whose name it also sends. The server decides who a report is
from by the token, so a valid token with someone else's name is refused. A person cannot see or rotate their own token. Only an Admin can, from this page.

<!-- nav:start -->
---

Previous: [Getting around](02-getting-around.md) · Up: [Admin](README.md) · Next: [Groups](04-groups.md)
<!-- nav:end -->
