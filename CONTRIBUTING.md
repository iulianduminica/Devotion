# Contributing

Devotion is a personal, non-commercial project (see `LICENSE`). Contributions
are welcome, especially bug reports with a reproduction.

## Getting it running

```
npm ci
npm run seed     # a demo workspace in .data/workspace
npm run build
npm start        # http://127.0.0.1:8790
```

**Node 24 or newer is required.** The workspace is stored through `node:sqlite`,
which older Node versions do not ship. On an older Node the server exits with a
message saying so, rather than `ERR_UNKNOWN_BUILTIN_MODULE`.

For development with hot reload: `npm run dev` (Vite on :5175, API on :8790).

## The checks

```
npm run typecheck
npm run test:all     # eight suites, ~2100 assertions
npm run boot:check   # starts the real server, hits it over HTTP, shuts it down
```

The suites are plain scripts with no test framework — `tsx scripts/test-ai.ts`
runs one. They print `ok`/`FAIL` lines and a summary, and exit non-zero on a
failure. `test:all` runs all eight.

`boot:check` exists because the suites use Fastify's in-process `inject()`,
which is fast and needs no port — and therefore never exercises the listen path,
the static shell, the token injection, or Node's TypeScript handling.

## Layout

| Path | What lives there |
| --- | --- |
| `server/` | Fastify API, the node tree, the query engine, import/export, the AI layer |
| `server/ai/` | provider adapters, SSE parsing, actions, prompts, retrieval, detection, call log |
| `shared/types.ts` | the contract between client and server — change it first |
| `src/` | React app: editor, databases, views, panels |
| `src/db/tableLayout.ts` | table column sizing, pure and unit-tested |
| `scripts/` | seeds and test suites |

## Things that are easy to get wrong

**The BlockNote boundary.** `@blocknote/core`, `/react` and `/mantine` are
MPL-2.0. BlockNote's **XL packages** — AI integration, multi-column layouts,
exporters — are dual-licensed **GPL-3.0 or commercial**. Devotion implements its
own columns, AI layer and exporters and imports no XL package. Adding one
changes this project's license. See `THIRD-PARTY-NOTICES.md`.

**Column widths.** The table uses `table-layout: fixed` with a `<colgroup>`,
because browsers ignore `min-width` on `<th>` under auto layout. The wrapper is
sized by its content, so measuring it returns the table's own width — the bound
is the narrowest enclosing box. `src/db/tableLayout.ts` is where that logic
lives, and it is tested.

**Migrations.** `server/schema.sql` is the v1 baseline and runs only on a fresh
database. A new table goes in the baseline **and** as a versioned migration in
`server/db.ts`, or existing workspaces never get it.

**AI provider status.** A disabled provider is never probed. Probing one
produces a red "provider is disabled — enable it in Settings → AI" error inside
the screen where you enable it.

**Windows file locks.** An open SQLite file blocks deletion. Scripts that wipe a
workspace must not run while the server holds it.

## Style

- The UI follows **Atlas**: AMOLED black, monochromatic surfaces, a 4px spacing
  grid, 3/4/6px radii, borders over shadows, 1.5px Lucide strokes, blue
  `#0070f3` for selection and focus only — never a call-to-action fill.
- Comments explain **why**, not what. A comment that restates the code is noise;
  a comment that records a constraint the code has to respect is the most useful
  thing in the file.
- No new runtime dependencies without a reason in the PR description. The
  dependency count is a feature: nothing to compile, nothing native, runs the
  same on Windows, macOS and Linux.

## Pull requests

Describe the problem the change solves, and how you verified it. A PR that
touches the query engine, the AI layer, the table layout, or the schema should
come with tests. Screenshots for UI changes.

Keep `npm run typecheck`, `npm run test:all` and `npm run boot:check` green.
