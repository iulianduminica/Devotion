# Devotion

A local-first Notion alternative. Block editor, relational databases, views
(table, board, list, gallery, calendar, timeline, chart, form), multi-column
layout, PDF/HTML/Markdown/CSV export, first-party templates, and pluggable
on-device AI — running entirely on your machine, in one folder.

No subscription, no account, no cloud. The workspace is a SQLite file plus a
media folder; backup is a folder copy.

> Internal identifiers still use the `strata-` prefix (`x-strata-token`,
> `strata-theme`, the `.data/workspace` path). Renaming a live protocol header
> and storage keys would break running installs for no user benefit, so the
> rename is deliberately at the product surface only.

---

## Quick start

```bash
npm ci
npm run seed     # build a demo workspace in .data/workspace
npm run dev      # API on :8790, app on http://127.0.0.1:5175
```

Production shape:

```bash
npm run build
npm start        # one server on :8790 serving the app and /api
# → http://127.0.0.1:8790
```

Requires **Node 24+**. It uses the built-in `node:sqlite`, so there is no
compiler, no native module, no Electron and nothing to build for the database.
Node 24 also runs the server's TypeScript directly, so production needs no
transpiler. On an older Node the server exits with a sentence saying what to
install, rather than `ERR_UNKNOWN_BUILTIN_MODULE`.

**Windows, macOS and Linux.** CI runs the full suite and boots the real server
on all three, on every push. There is no platform-specific code in the runtime
path.

Docker, if you'd rather not install Node:

```bash
docker compose up --build          # loopback on the host: 127.0.0.1:8790
# your notes live in ./data — copy that folder to back up
```

Checks:

```bash
npm run typecheck
npm run test:all   # eight suites, ~2100 assertions
npm run boot:check # starts the real server, hits it over HTTP, shuts it down
```

---

## Why it is built this way

**One node table for everything.** Pages, blocks and database rows are all
nodes in one tree. A database row *is* a page, so it holds nested blocks.
Building "the editor" and "the database" as two systems is what makes clones
feel broken, so they were never two systems here.

**Fractional indexing for block order.** A block's position is a
lexicographically-ordered string, so drag-reorder writes exactly one row.
Repeated same-gap inserts lengthen keys (inherent to the scheme), so a parent's
children are rebalanced when a key crosses 24 characters — scoped to one
parent, never a whole document.

**One write path, one append-only log.** Every mutation goes through
`server/ops.ts` and appends to `op_log`. Undo, redo, page version history,
trash/restore, backup, and future multi-device sync all derive from that log.
A user edit is a `tx`, so undo is paragraph-granular, not per keystroke.

**Typed property columns.** Each property value is spread across
`text_v / num_v / date_v / bool_v / json_v`, so multi-rule filter, sort and
aggregation compile to plain SQL against indexes — not JSON scraping at read
time.

**FTS5 by triggers, not by hand.** The search index is maintained by SQL
triggers on the node table, so it cannot drift from the content. Diacritics are
folded (`Iași` is found by `iasi`).

**No `eval` in the formula engine.** Formula source is untrusted user text, so
it is a hand-written lexer, recursive-descent parser, and tree-walking
evaluator. Depth is capped, non-finite results throw, and the test suite scans
the source to prove there is no `eval`, `new Function`, `import()` or
`require()`.

**AI is an adapter, and optional.** Ollama, LM Studio, any OpenAI-compatible
endpoint, and Strata. With no provider configured, AI features are hidden —
not broken. Workspace Q&A falls back to keyword search and says so, rather
than failing, when no embedding provider is present.

---

## Features

**Editor** — paragraph, H1–H3, bulleted, numbered, to-do, toggle, quote,
divider, callout, code (syntax highlighted), LaTeX, image, file, audio,
bookmark, page links, **2–5 column layout with draggable dividers**, and a
**table-of-contents block** that outlines the page (including headings nested
inside columns). Drag handle, slash menu, block conversion, nesting. Page icons,
covers, font switching, full-width, light/dark/system.

**Wiki** — nested pages, breadcrumbs, deep links, backlinks ("Linked mentions",
resolved to the owning page in both directions).

**Databases** — Title, Text, Number (plain/currency/percent/progress), Date
(with ranges), Checkbox, Select, Multi-Select, Status, URL, Email, Phone,
Files, Relation (bidirectional, self), Formula, Rollup, Button, auto-increment
ID, and the four auto-metadata properties.

**Views** — Table, Board (with drag between groups), List, Gallery, Calendar,
**Timeline** (day/week/month/quarter scale, today line, drag to move, drag the
edge to resize, grouped sections), **Chart** (bar/line/pie as hand-written SVG,
with x/y property and aggregate pickers, top-12 + Other bucketing), **Form**
(per-type inputs, required-field validation, editable field list). Multi-rule
filter, multi-level sort, grouping, property visibility, footer aggregations
(count, sum, avg, median, min/max, range, % checked).

**Workspace** — full-text search, page version history with restore, trash with
restore and purge, server-side undo/redo (the op log, wired to the titlebar and
to Ctrl+Shift+Z / Ctrl+Y), word count and reading time in the statusbar,
Markdown/HTML/CSV import and export, Notion-export import, whole-workspace
Markdown export, and **PDF export** (the server renders a print-optimised
document; the browser writes the PDF).

**Template library** — 15 first-party templates, installed from the Templates
panel: Meeting notes, Weekly review, Project brief, Product spec (PRD), Bug
tracker, Reading list, Content calendar, CRM / contacts, OKRs, Sprint retro,
Daily journal, Recipe, Wiki article, Habit tracker, Goal tracker. Together they
are 298 blocks, 96 rows and 178 formulas, all of which the seeder evaluates
before it reports success.

**Local AI** — inline summarize, translate, fix grammar, change tone; database
property autofill validated against the real property schema; workspace Q&A
over an embedding index with citations.

The AI surface is built like the tools people already use, because "it works
with Ollama" is only useful if finding the right model is not a research
project:

- **Two-pane provider settings.** The left pane is the fleet with a live status
  per provider — *Ready · 6 models · 12 ms*, *Not running*, *No models*,
  *Disabled*, *Not tested*. The right pane is the selected provider: endpoint,
  model pickers, embedding probe, key reference, latency, and the last calls it
  made. A disabled provider is never probed, so the screen does not fill itself
  with red errors about things you switched off on purpose.
- **Detection.** `Detect` probes the loopback ports local model servers use
  (Ollama, LM Studio, vLLM, llamafile, LocalAI) and offers to add what answers,
  prefilling the chat model and the embedding model from the names it read.
- **Model pickers** read the provider's own list — Ollama `/api/tags`,
  OpenAI-compatible `/v1/models` — searchable, keyboard-driven, showing context
  length. A server that does not implement `/models` gets a typed fallback with
  the reason shown, rather than a dead end.
- **Streaming with a Stop that stops.** Tokens render as they arrive; the Stop
  button closes the socket, the server sees the close and aborts the upstream
  request, and the partial answer stays available to insert or discard.
- **The privacy line.** Before you run an action, the bar says what it will do:
  *"sends 33 words from this page to Strata at 127.0.0.1:47831"*. On a
  local-first app, that claim should be visible at the moment it matters.
- **Explicit outcomes.** Insert below, replace the selection, or discard. A
  model rewriting your paragraph without asking is the fastest way to lose
  someone's trust.
- **A call log.** Every request is recorded with latency, outcome, characters
  generated, and token counts *when the provider reports them* — `null` is kept
  as null, never rendered as a confident zero.

---

## Layout

```
shared/types.ts        the contract: blocks, properties, views, AI
server/
  schema.sql           DDL, FTS5 triggers
  db.ts                node:sqlite, migrations, workspace paths
  ids.ts               ULID, fractional index, rebalancing
  ops.ts               the write path: op log, undo/redo, backlinks
  library.ts           search, breadcrumbs, trash, history, templates, media
  databases.ts         schema, rows, query engine, grouping, aggregates
  formula.ts           parser + evaluator (no eval)
  import-export.ts     import materialising, exports
  pdf.ts               print-optimised HTML for PDF export
  port/                Markdown, HTML, CSV parsers and writers
  ai/                  provider adapters, actions, prompts, retrieval,
                       detection, the call log
  api.ts               Fastify routes
src/
  App.tsx              shell: titlebar, sidebar, main, inspector, statusbar
  editor/              BlockNote schema, custom blocks, columns, toc, mapping,
                       the AI bar (switcher, streaming, outcomes)
  db/                  Table, Board, List, Gallery, Calendar, Timeline, Chart,
                       Form, property cells, pure view logic, column layout
  components/          palette, inspector, trash, templates, settings,
                       AI provider panes, model picker
scripts/
  seed.ts              demo workspace
  seed-templates.ts    the 15 first-party templates (self-verifying)
  test*.ts, smoke.ts   the suites
  boot-check.mjs       start the real server, probe it over HTTP, shut it down
  licenses.mjs         every dependency and its license, from node_modules
```

**Tests** — 2107 assertions across 8 suites (data core 93, databases 132,
formula 305, import/export 416, AI 336, view logic 473, columns 277, HTTP smoke
75), plus `tsc --noEmit` clean and `boot:check` on Windows, macOS and Linux.

They are plain scripts, not a framework: `tsx scripts/test-ai.ts` runs one
suite, prints `ok`/`FAIL` lines and a summary, and exits non-zero on a failure.

---

## Security model

The server binds `127.0.0.1`, but any page in your browser can POST to
localhost. So every request must carry an `Origin` in the allow-list (a foreign
page cannot forge it) **and** a per-session token printed at boot.
`/api/bootstrap` is the only token-less route and it refuses foreign origins.
There is no CORS wildcard and no `OPTIONS` handling.

---

## Known gaps

- **PDF export depends on the browser.** The server produces the print document
  (A4/Letter, margins, repeating table headers, ink-exact colours, page-break
  rules); the PDF itself is written by the browser's "Save as PDF". Chromium
  does not implement CSS `@page` margin boxes, so page numbers come from the
  browser's own header/footer, not from this app.
- **Column resizing is verified in tests, not in a browser.** The width maths,
  add/remove with child reattachment, and the tree mapping are covered by 277
  assertions, and a 2-column layout was created, edited and reloaded in a real
  browser. Dragging the divider between columns has not been exercised by hand.
- **Multi-device sync is not built.** The op log is per-node, ordered and
  device-stamped so CRDT sync can be added without re-plumbing, but it is not
  there today. This is a single-device app.
- **The Web Clipper is not built.** Markdown import (including Notion exports)
  is the supported path in.
- **Person and Place properties are intentionally out of scope** — single-user,
  and geocoding needs a paid API.
- `node:sqlite` is still labelled experimental in Node 24 and prints a warning.
  All SQL sits behind `server/db.ts` so the driver can be swapped.
- The FTS trigger extracts `$.text` from inline runs, so text nested inside
  BlockNote-native link nodes is indexed via the flattened representation this
  app writes; content imported from other editors may index less completely.
- The product is named **Devotion**; internal identifiers keep the `strata-`
  prefix (`x-strata-token`, `strata-theme`, `.data/workspace`) so existing
  installs and running sessions are not broken by a cosmetic rename.
- **Token counts are usually unavailable.** OpenAI-compatible servers report
  `usage` on non-streaming responses; most local servers do not, and streaming
  responses rarely carry it. The UI shows characters, which are always real, and
  tokens only when the provider sends them. It never displays a zero for a
  number it does not have.
- **Detection knows the common local servers, not all of them.** It probes
  Ollama, LM Studio, vLLM, llamafile and LocalAI on loopback. Anything else is
  added by hand, which is the same answer every tool in this space gives.

---

## Deploying

**Anyone with Node 24 can run this on Windows, macOS or Linux.** There is no
native module, no Rust, no Electron, and nothing to compile: SQLite ships inside
Node, and Node 24 runs the server's TypeScript directly. The install is
`npm ci && npm run build && npm start`.

The constraints, stated honestly:

- **Node 24 is a hard floor.** `node:sqlite` does not exist in Node 20/22 LTS.
  The server checks the version and exits with a sentence, not a stack trace.
- **Single-user, single-device.** The session token is embedded in the HTML
  shell, and there are no accounts. It binds `127.0.0.1`; `DEVOTION_HOST` can
  change that, and the banner warns when it does. It is not built to face the
  internet and should not be put there.
- **No encryption at rest.** The workspace is a plain SQLite file. Back up the
  folder; use a full-disk-encrypted disk.
- **Windows file locks.** An open SQLite file blocks deletion, which matters for
  the seed scripts. Documented in `CONTRIBUTING.md`.

The release workflow publishes a multi-arch container image (`linux/amd64`,
`linux/arm64`) to GHCR on every tag, plus a GitHub Release with the built web
bundle.

---

## Screenshots

The dark theme is the design default; light and system are supported.

| | |
| --- | --- |
| `docs/screenshots/editor.png` | The block editor: callouts, nested lists, toggles, code, LaTeX, a table of contents and a two-column section |
| `docs/screenshots/table.png` | A 12-property database table: typed cells, relation pills, rollups, footer aggregates, columns that fit the column they are in |
| `docs/screenshots/timeline.png` | The timeline view at month scale, with the today line and drag-to-move |
| `docs/screenshots/chart.png` | A chart view: bar, line and pie drawn as hand-written SVG |
| `docs/screenshots/templates.png` | The template library: 15 first-party templates, each cloned independently on use |
| `docs/screenshots/ai-settings.png` | AI provider settings: two panes, live status per provider, model pickers, latency, and the call log |

---

## License

Personal, non-commercial use only — see [LICENSE](LICENSE). The short version:
use it at home, read the source, learn from it, modify it, write about it, put
it in a portfolio. Do not sell it, host it for pay, or embed it in a commercial
product; contact the maintainer if you want to.

Dependencies and their licenses, including the BlockNote XL licensing boundary,
are documented in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
