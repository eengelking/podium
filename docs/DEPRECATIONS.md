---
title: "Deprecations"
description: "Which features are deprecated, the release that announced each one, and the release that removes it."
group: Reference
---

# Deprecations

This page lists every feature Podium has marked for removal, the release that announced it, the release that removes it and what to use
instead. It is for someone who runs Podium or `podium-reporter` and wants to know what will stop working before an upgrade. It does not
describe the replacements in full; each entry links to the page that does.

Contents:

- [The policy](#the-policy)
- [Deprecated now](#deprecated-now)
- [Removed](#removed)

## The policy

A feature marked for deprecation is removed within three minor releases. The release that announces the deprecation counts as the
first of the three, so a feature announced in 1.5 is removed in 1.8.

| Term | Meaning |
|---|---|
| Announced | The first release whose `CHANGELOG.md` has a `Deprecated` entry for the feature. The feature still works as before. |
| Removed | The release in which the feature is gone. It has a `Removed` entry in `CHANGELOG.md`. |

While a feature is deprecated:

- It keeps working and keeps its tests. A deprecation changes no behavior by itself.
- The replacement is available from the release that announces the deprecation, so there is always a release where both work.

A removal is never earlier than the release listed here. It can be later; the entry then changes and says why.

`node scripts/check-deprecations.mjs` (also in `npm test`) reads the "Deprecated now" table and the version in `package.json`. It
fails when a row's Announced or Removed is not `MAJOR.MINOR`, when Removed is not after Announced or is more than three minor releases
later, and when the version has reached the Removed release. So `development` fails its tests when the release-prep bump reaches a
removal that has not been done: remove the feature, then move its row to "Removed". Keep each row to the four columns and write both
versions as `1.5`, not `v1.5`.

This page and the `Deprecated` and `Removed` sections of `CHANGELOG.md` must agree. The changelog says what changed in a release, and
this page is the one place that shows everything still on its way out.

## Deprecated now

| Feature | Announced | Removed | Use instead |
|---|---|---|---|
| [Reporter tokens over plain HTTP](#reporter-tokens-over-plain-http) | 1.5 | 1.8 | A reporter config and the reporter port, over [built-in TLS](SERVER.md#built-in-tls) |
| [The Traffic page](#the-traffic-page) | 1.6 | 1.9 | [Chat](user-guide/04-reading-the-console/16-chat.md), where the same conversations are Direct Messages |

### Reporter tokens over plain HTTP

A reporter that proves who it is with a token sent over the plain HTTP port is deprecated. The token travels in a header that anyone on
the network path can read, so it is the weakest way a reporter can connect ([DECISIONS 20](decisions/README.md) records the
trade-off, and [SPEC 7.7](spec/07-server/07-07-hardening.md) lists the warnings).

- **Announced in 1.5, removed in 1.8.** From 1.8 the HTTP port refuses reporter traffic, and the Admin setting **Allow reporters to
  connect over HTTP** is gone.
- **What keeps working:** the console and Admin on the HTTP port, and a reporter on the server's own loopback address.
- **What to do:** turn on built-in TLS, give each person a reporter config in Admin > People, and turn off **Allow reporters to connect
  over HTTP** once every reporter has its config. The steps are under "Decide about plain HTTP" in [SERVER.md](SERVER.md#built-in-tls).
  The reporter side is "Over TLS" in [REPORTER.md](REPORTER.md#over-tls).

### The Traffic page

The **Traffic** page (`#/traffic`), the map and table of which orchestrators message which, is deprecated. Chat replaces it: the same
conversations are its Direct Messages, with the same Pause link and Remove link, and a person can read back, page to older
messages and add to one.

- **Announced in 1.6, removed in 1.9.** From 1.9 the page and `GET /api/fleet/peers/traffic` are gone.
- **What keeps working:** the page, its read and its tests. The top bar's Traffic link is now Chat, and `#/traffic` opens Chat. The
  page shows a note that says so.
- **What to do:** open **Chat** from the top bar. The map and the per-range counts have no Chat equivalent; read the conversations
  there. Anything that calls `GET /api/fleet/peers/traffic` should move to the routes in
  [SPEC 7.1](spec/07-server/07-01-endpoints.md#routes-for-chat-1034) before 1.9.

## Removed

Nothing has been removed under this policy yet. A removed feature moves here from "Deprecated now", with the release that removed it.

## Related

- [Changelog](../CHANGELOG.md), where each release lists what it deprecated and removed.
- [Server](SERVER.md), for built-in TLS and the reporter config.
