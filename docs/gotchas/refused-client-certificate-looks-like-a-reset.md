---
title: "A refused client certificate shows as \"socket hang up\", not a TLS alert"
description: "Under TLS 1.3 the reporter port refuses a bad client certificate after the handshake, so it reads as a reset; check the certificate, not the network."
group: "Project internals"
area: "Reporters and machines"
date: "2026-10-27"
status: "open"
order: 14
---

# A refused client certificate shows as "socket hang up", not a TLS alert

**You see:** The server log has `podium: a TLS handshake failed: ECONNRESET: socket hang up` for a reporter whose
certificate was forged, signed by another CA, revoked or expired. The reporter's status line says `server closed
connection`, and a command-line client such as `curl` exits with 56 ("connection reset") and no certificate message. A
client that sends no certificate at all is different: the log says `ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE: peer did
not return a certificate`.

**Why:** TLS 1.3 lets the client finish its side of the handshake before the server has checked the client
certificate. The server then drops the connection, which the client sees as a reset after the handshake and not as an
alert. Node reports it as `ECONNRESET` on the server too, so the log line has no reason beyond the reset. The reporter's
helper (`helper.mjs`) tells it from a network outage by the handshake having completed first, and calls it
`CLOSED_AFTER_HANDSHAKE`. Repeats from one source fold into one line in the text log.

**Do:**

1. Treat a reset after a completed handshake as a refused certificate before you suspect the network.
2. Ask an Admin to check the person on Admin > People: the certificate may be revoked or expired. Reissue the config
   if it is.
3. If the Admin rotated the CA with no overlap, every reporter needs a new config.

<!-- nav:start -->
---

Previous: [podiumctl start fails with "port N ... is already in use"](podiumctl-start-port-already-in-use.md) · Up: [Gotchas](README.md) · Next: [I changed a setting and nothing happened](changed-a-setting-and-nothing-happened.md)
<!-- nav:end -->
