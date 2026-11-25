# Third-party notices

Devotion is built on open-source work. This file lists the direct dependencies
and the licenses they were published under, read from the installed packages.

| Package | Version | License |
| --- | --- | --- |
| @blocknote/core | 0.57.0 | MPL-2.0 |
| @blocknote/react | 0.57.0 | MPL-2.0 |
| @blocknote/mantine | 0.57.0 | MPL-2.0 |
| @fastify/static | 10.1.12 | MIT |
| @mantine/core | 9.8.2 | MIT |
| @mantine/hooks | 9.8.2 | MIT |
| @tailwindcss/vite | 4.3.5 | MIT |
| date-fns | 4.4.0 | MIT |
| fastify | 5.12.8 | MIT |
| katex | 0.19.1 | MIT |
| lucide-react | 1.79.0 | ISC |
| react | 19.3.1 | MIT |
| react-dom | 19.3.1 | MIT |
| tailwindcss | 4.3.5 | MIT |
| tsx | 4.23.15 | MIT (dev) |
| typescript | 5.9.3 | Apache-2.0 (dev) |
| vite | 8.3.8 | MIT (dev) |
| @types/node | 24.19.2 | MIT (dev) |

Transitive dependencies (TipTap, ProseMirror, Mantine internals, the Fastify
plugin family) are MIT, ISC, Apache-2.0 or MPL-2.0. Run
`node scripts/licenses.mjs` to print the full list from `node_modules`.

## The BlockNote licensing boundary

[BlockNote's pricing page](https://www.blocknotejs.org/pricing) states that the
core source is MPL-2.0, **except the XL packages** — AI integration,
multi-column layouts and exporters — which are dual-licensed **GPL-3.0 or
commercial**.

Devotion depends only on `@blocknote/core`, `@blocknote/react` and
`@blocknote/mantine`. The multi-column layout, the AI layer, the exporters
(Markdown, HTML, CSV, PDF) and the table of contents are implemented in this
repository, not imported from an XL package.

This is a load-bearing detail. Importing `@blocknote/xl-*` would put this
project under GPL-3.0 (or require a BlockNote Business subscription), and the
license in `LICENSE` would no longer be tenable. If you take this codebase
further, keep that boundary.

## Design system

The UI follows **Atlas**, a design language for agent interfaces: AMOLED-black
canvas, monochromatic surfaces, a 4px spacing grid, 3/4/6px radii, borders over
shadows, 1.5px Lucide strokes, and blue `#0070f3` reserved for selection and
focus — never for a call to action.

## Data

No telemetry, no analytics, no phone-home. The only network requests this
application makes are to model servers you configure yourself, on addresses you
typed. By default that is a loopback address.
