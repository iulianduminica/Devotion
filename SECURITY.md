# Security Policy

## What Devotion is, in security terms

A single-user, single-device application. There are no accounts, no
authentication beyond a session token, and no multi-user model. It is designed
to run on your own machine and talk to model servers on your own machine.

Two consequences worth stating before anyone deploys it anywhere:

- **The session token is embedded in the HTML shell.** Anyone who can load the
  page can read it and use it. That is fine on loopback, where the only people
  who can load the page are you and the processes on your machine.
- **The server binds `127.0.0.1` by default.** Setting `DEVOTION_HOST=0.0.0.0`
  puts the entire workspace on your network with that token as its only gate.
  The startup banner says so out loud. Do not put Devotion behind a reverse
  proxy facing the internet; it has no defence against that and is not built to
  need one.

## Data

Everything lives in one directory: a SQLite database (WAL mode) plus a media
folder. Nothing is uploaded. The only outbound requests are to AI provider base
URLs you configure, and the defaults are loopback addresses.

There is no telemetry, no analytics, and no update check.

## AI providers and secrets

An API key is **never** written to the database. A provider stores a reference
(a keychain/environment name) that is resolved at request time. Anything
key-shaped arriving in a settings payload is dropped, with a warning, before the
row is written.

Provider errors are redacted: `Authorization` headers, `api_key`-shaped fields,
`sk-…`-shaped tokens and credentials inside URLs are stripped from every
message that reaches a log line or the UI.

## Reporting a vulnerability

Open a private issue, or contact the maintainer directly. Please don't file a
public issue for something exploitable.

A reasonable response window is a week. Disclosures are welcome; the project is
a personal, non-commercial one, and the honest answer to some reports will be
"this is out of scope for a single-user local app" — with an explanation of why.

## Supported versions

| Version | Supported |
| --- | --- |
| latest tag | yes |
| `main` | best effort |
| anything older | no — it's one binary, upgrade |

## Known limitations, stated plainly

- No encryption at rest. The workspace is a plain SQLite file. If your machine
  is not yours, your notes are not private. Use a full-disk-encrypted disk.
- No sharing, no permissions, no per-page access control. Anyone with the URL
  and the token sees everything.
- No audit log of who did what, because there is only ever one who.

These are not oversights. They are the shape of the product: a local-first,
personal tool. A multi-user deployment would need a different application.
