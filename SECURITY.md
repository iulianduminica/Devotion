# Security Policy

## What Devotion is, in security terms

One user, one device. There are no accounts, no authentication beyond a session
token, and no multi-user model. It runs on your machine and talks to model
servers on your machine.

Two things follow from that, and they matter before you put this anywhere:

The session token is embedded in the HTML shell. Anyone who can load the page can
read it and use it. On loopback that's fine, because the only things that can
load the page are you and the processes on your machine.

The server binds `127.0.0.1` by default. Setting `DEVOTION_HOST=0.0.0.0` puts the
whole workspace on your network with that token as the only gate, and the startup
banner warns you when you do it. Don't put Devotion behind a reverse proxy facing
the internet. It has no defence against that, and it was never built to need one.

## Data

Everything lives in one directory: a SQLite database in WAL mode, plus a media
folder. Nothing is uploaded. The only outbound requests go to AI provider base
URLs you configure, and the defaults are loopback addresses.

No telemetry, no analytics, no update check.

## AI providers and secrets

An API key is never written to the database. A provider stores a reference, a
keychain or environment name, that resolves at request time. Anything key-shaped
arriving in a settings payload is dropped with a warning before the row is
written.

Provider errors are redacted. `Authorization` headers, `api_key`-shaped fields,
`sk-…`-shaped tokens and credentials inside URLs are stripped from every message
that reaches a log line or the screen.

## Reporting a vulnerability

Open a private issue, or contact me directly. Please don't file a public issue
for something exploitable.

I try to answer within a week. This is a personal, non-commercial project, so
some reports will get the answer that they're out of scope for a single-user
local app, with an explanation of why.

## Supported versions

| Version | Supported |
| --- | --- |
| latest tag | yes |
| `main` | best effort |
| anything older | no, it's one binary, upgrade |

## Limitations

No encryption at rest. The workspace is a plain SQLite file, so if the machine
isn't yours, your notes aren't private. Use a full-disk-encrypted disk.

No sharing, no permissions, no per-page access control. Anyone with the URL and
the token sees everything.

No audit log of who did what, because there's only ever one who.

These follow from the scope. One person, one machine, on a disk you own. A
multi-user deployment would need a different app, and I'd say so plainly rather
than pretend this one is close.
