## What this fixes

One paragraph on the problem, in terms of what a person experiences. "Table
columns overlap when a database has 11 properties" beats "fix table layout".

## How

What changed and why this approach. Name the constraint that shaped it — a
browser rule, a licensing boundary, a Windows file lock — if there was one.

## Verification

- [ ] `npm run typecheck` — 0 errors
- [ ] `npm run test:all` — all eight suites green
- [ ] `npm run boot:check` — the real server answers over HTTP
- [ ] Tested on Windows / macOS / Linux (say which; CI covers all three)
- [ ] UI change: screenshot below

## Notes for the reviewer

- Does this touch `shared/types.ts`? Both sides of the contract change together.
- New table? It needs the baseline **and** a versioned migration in `server/db.ts`.
- New dependency? Say why. The dependency count is a feature.
- Any `@blocknote/xl-*` import? That changes the project's license — flag it.
