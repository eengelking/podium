---
title: "Certificates"
description: "View the built-in certificate authority and serving certificate when TLS is on."
group: "Getting started"
order: 9
---

# Certificates

With built-in TLS on (`podiumctl start --tls`), this page shows Podium's own certificate authority (CA) and the
serving certificate it signs. Reporters connect on their own port, which accepts only a valid reporter certificate; the
console stays on plain HTTP, so a browser needs nothing from this page. With TLS off it says so and has nothing else.

- **Status.** The CA and the serving certificate, each with its expiry date, how the certificate renews and a status
  that is a shape, a word and a color. A band at the top is blue at 30 days or fewer, orange at 10 and red at 5, and red
  again once the first of them has expired. If the last renewal failed, its reason shows in red under the table. The CA's
  fingerprint has a copy control, to compare with the CA in a reporter config. "localhost and 3 more" opens the list of names the
  running serving certificate carries.
- **Renewal and lifetimes.** The serving certificate's lifetime (30 to 825 days) and how many days before it expires it
  renews (7 to 90), and a person's certificate lifetime (30 to 365). A certificate that has expired is not renewed, so there is no grace. A number
  saves when you leave the field; a value the server refuses stays in the box with the reason under it. Each change is
  written to the Admin log. The last switch turns the header countdown on or off.
- **Reporters over HTTP.** One switch, **Allow reporters to connect over HTTP**. While it is on, a reporter that has
  only its name and token (no reporter config) still reports over plain HTTP, and a warning line says that is not
  encrypted. It is on for a server that already had reporters when TLS was first turned on, and off for a fresh one.
  Turning it on takes effect at once. Turning it off asks first and names how many reporters are connected over HTTP
  now, since they are refused at once; a reporter with a reporter config keeps working on the reporter port, and so
  does the console, so an Admin can always sign in. Each change is written to the Admin log.
- **Rotate by hand.** **Renew now** issues a new serving certificate from the same CA and keeps the old one as a backup.
  **Rotate CA…** asks first, then makes a new CA that reporters pick up when they renew, while the old one keeps working through an overlap (120 days). A blue band counts the reporters still on the old CA, and **Retire old CA…** ends the overlap when none are left. **Rotate CA and end the overlap now** is for a CA key that may have leaked: every reporter then needs a reissued config, and open connections are closed.
- **Previous certificates.** The last three serving certificates Podium replaced, kept in `/data/tls/previous`.

**The header pill.** Whichever of the CA and the serving certificate expires first shows as a pill after the
connection: blue with a clock at 30 days or fewer, orange with a triangle at 10, red with a triangle at 5, and "Certificate
expired" with a ring and a cross. It links to this page, has no close button, and never tracks a person's certificate.
The switch hides only the countdown: a failed renewal and an expired certificate always show.

<!-- nav:start -->
---

Previous: [Security](08-security.md) · Up: [Admin](README.md) · Next: [Data](10-data.md)
<!-- nav:end -->
