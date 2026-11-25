# Contributing

Devotion is a personal, non-commercial project (see `LICENSE`). Contributions
are welcome, and a bug report with a reproduction is the most useful one.

## Getting it running

```
npm ci
npm run seed     # a demo workspace in .data/workspace
npm run build
npm start        # http://127.0.0.1:8790
```

Node 24 or newer. The workspace is stored through `node:sqlite`, which older Node
versions don't ship. On an older Node the server exits with a message saying so,
instead of `ERR_UNKNOWN_BUILTIN_MODULE`.

For hot reload: `npm run dev`, which puts Vite on :5175 and the API on :8790.

## The checks

```
npm run typecheck
npm run test:all     # eight suites, ~2100 assertions
npm run boot:check   # starts the real server, hits it over HTTP, shuts it down
```

The suites are plain scripts, no framework. `tsx scripts/test-ai.ts` runs one of
them, prints `ok` and `FAIL` lines with a summary, and exits non-zero on a
failure. `test:all` runs all eight.

`boot:check` is there because the suites use Fastify's in-process `inject()`.
That's fast and needs no port, and for the same reason it never exercises the
listen path, the static shell, the token injection, or Node's TypeScript
handling.

## Layout

| Path | What lives there |
| --- | --- |
| `server/` | Fastify API, the node tree, the query engine, import/export, the AI layer |
| `server/ai/` | provider adapters, SSE parsing, actions, prompts, retrieval, detection, call log |
| `shared/types.ts` | the contract between client and server, change it first |
| `src/` | React app: editor, databases, views, panels |
| `src/db/tableLayout.ts` | table column sizing, pure and unit-tested |
| `scripts/` | seeds and test suites |

## Things that are easy to get wrong

The BlockNote boundary. `@blocknote/core`, `/react` and `/mantine` are MPL-2.0.
BlockNote's XL packages, which cover AI integration, multi-column layouts and
exporters, are dual-licensed GPL-3.0 or commercial. Devotion implements its own
columns, AI layer and exporters and imports no XL package, so adding one changes
this project's license. `THIRD-PARTY-NOTICES.md` explains it.

Column widths. The table uses `table-layout: fixed` with a `<colgroup>`, because
browsers ignore `min-width` on `<th>` under auto layout. The wrapper is sized by
its own content, so measuring it returns the table's width, and the bound you
want is the narrowest enclosing box. That logic lives in `src/db/tableLayout.ts`
and it's tested.

Migrations. `server/schema.sql` is the v1 baseline and runs only on a fresh
database. A new table has to go in the baseline and in a versioned migration in
`server/db.ts`, or existing workspaces never get it. I found this out by shipping
a table that 500'd on my own workspace.

AI provider status. A disabled provider is never probed. Probing one produces a
red "provider is disabled, enable it in Settings" error inside the screen where
you enable it.

Windows file locks. An open SQLite file blocks deletion, so a script that wipes a
workspace must not run while the server holds it.

## Style

The UI follows Atlas: AMOLED black, monochromatic surfaces, a 4px spacing grid,
3/4/6px radii, borders over shadows, 1.5px Lucide strokes, and blue `#0070f3`
kept for selection and focus, never as a call-to-action fill.

Comments explain why, not what. A comment that restates the line above it is
noise. The useful kind records a constraint the code has to respect, like the
browser rule behind the column layout.

Don't add a runtime dependency without a reason in the PR description. Keeping
the dependency list short is the point: nothing to compile, nothing native, the
same install on Windows, macOS and Linux.

## Pull requests

Say what problem the change solves and how you verified it. If it touches the
query engine, the AI layer, the table layout or the schema, it needs tests. UI
changes need a screenshot.

Keep `npm run typecheck`, `npm run test:all` and `npm run boot:check` green.
