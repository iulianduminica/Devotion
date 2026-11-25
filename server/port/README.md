# `server/port` — import & export

Markdown, HTML and CSV in and out of the block model. **Dependency-free and
hand-written**: no `remark`, `unified`, `marked`, `papaparse`. Parsers are line
scanners; serialisers are string builders. Nothing in this folder touches SQLite,
the filesystem, or the network — the layer is pure `string ↔ structure`, so it is
trivially testable and can run in the browser later.

```
shared/types.ts  ──►  port/blocks.ts   (transport shape, no ids)
                          ▲        ▲
                    port/csv.ts   │
                          ▲  ┌────┴─────┐
                          │  │           │
                   port/markdown.ts   port/html.ts
                          └────┬────────┘
                        port/index.ts  (+ detectFormat)
```

`server/import-export.ts` (owned by the lead) is the seam: it turns an
`ImportResult` into real nodes through `ops.createNode`, and builds
`ParsedBlock[]` from the node tree for the exporters.

Run the tests:

```powershell
& .\node_modules\.bin\tsx.cmd scripts/test-port.ts     # 416 assertions
```

---

## Public API

### `blocks.ts` — transport shape

```ts
interface ParsedBlock { type: BlockType; props: Record<string, unknown>; body: Body | null; children: ParsedBlock[] }
interface ImportResult { blocks: ParsedBlock[]; databases: ParsedDatabase[]; warnings: string[] }
interface ParsedDatabase { title: string; properties: { name: string; type: PropertyType }[]; rows: Record<string, PropertyValueInput>[] }
interface TableData extends ParsedDatabase {}          // what rides on props.table
interface SimpleTableData { header: string[]; rows: string[][]; title?: string }

block(type, { props?, body?, text?, children? })       // ParsedBlock factory
textInline(text, styles?, links?) · mergeInlines(runs) · sameRun(a, b)
bodyText(body) · blockText(block) · isEmptyBody(body)
asTableData(unknown) → ParsedDatabase | null           // accepts both table shapes
blockTable(parsedBlock) → ParsedDatabase | null
databaseToTableData(db) · tableDataToDatabase(data)
detectLeadingEmoji(text) · startsWithEmoji(text) · optionsFromConfig(prop)
TABLE_PROPS_KEY = "table"
```

`children` is always an array. `body` is the shared `Inline[]` contract, never a
plain string. Databases are referenced by a `child_database` block whose
`props.table` carries the data, so the block list alone is enough to re-export.

### `markdown.ts`

```ts
markdownToBlocks(text, opts?) → ImportResult
blocksToMarkdown(blocks, opts?) → string
importNotionZipLayout(files: {path, content}[], opts?) → ImportResult

// building blocks, exported for reuse and tests
parseInlineNodes(src, ctx, styles?, links?) → InlineNode[]   // text | math nodes
nodesToBody(nodes, ctx) → Body
bodyToMarkdown(body, opts?) → string
tableToMarkdown(properties, rows) → string                    // GFM pipe table
escapeMarkdownText(text) · normalizeLanguage(lang) · resolvePath(base, rel)
LANGUAGE_ALIASES
```

`ImportOptions`: `tabsWidth` (default 4), `pageKeyFor(resolvedPath) → title | null`,
`baseDir`.
`ExportOptions`: `bullet` (`-`), `indentWidth` (2), `pageLink(key) → path`,
`titleHeading` (false), `finalNewline` (true), `tabsWidth`.

### `html.ts`

```ts
blocksToHtml(blocks, opts?) → string        // complete standalone document
blocksToHtmlBody(blocks, opts?) → string    // fragment only
blockToHtmlFragment(block, opts?) → string
escapeHtml(text) · sanitizeUrl(url) · DEFAULT_CSS
```

`HtmlOptions`: `title`, `lang`, `includeCss`, `dark`, `css`, `headingIds`,
`pageLink`, `mediaLink`, `katexScripts`, plus the markdown export options.

### `csv.ts`

```ts
parseCsv(text, opts?) → { rows: string[][]; delimiter: string }
toCsv(rows, opts?) → string
csvCell(value, opts?) → string
csvToDatabase(text, opts?) → ParsedDatabase
rowsToCsv(rows, properties, titlePropId, opts?) → string
inferPropertyType(values) → PropertyType
cellToValue(cell, type) · valueToCell(value, prop, opts) · sniffDelimiter(text)
normalizeCsvText · propertyNamesFromHeader · isNumericCell/isBooleanCell/isDateCell/isUrlCell
CSV_DELIMITERS
```

### `index.ts`

Re-exports all of the above, plus:

```ts
detectFormat(text, { filename? }) → "markdown" | "html" | "csv" | "text"
detectFormatDetailed(text, opts) → { format, reason }
importText(text, opts) → ImportResult      // detect + import in one call
```

Detection order: known extension → HTML document start → markdown markers
(≥ 2) → consistent CSV delimiter (≥ 2 rows, ≥ 2 columns) → plain text.
`importText` never throws: plain text becomes paragraphs, an HTML drop goes
through the markdown importer (which strips tags and warns).

---

## Markdown import — supported

| Syntax | Result |
| --- | --- |
| `#`, `##`, `###` | `heading_1/2/3` (`####`+ → `heading_3` + warning) |
| `===` / `---` under a single line | `heading_1` / `heading_2` (Setext) |
| text, blank-line separated | `paragraph` (a multi-line paragraph joins with `\n`) |
| `> text` | `quote`; a deeper line inside the quote becomes a child block |
| `---`, `***`, `___` | `divider` |
| `-` / `*` / `+` | `bulleted_list_item` |
| `1.` / `1)` | `numbered_list_item` (`props.number` keeps the source number) |
| `- [ ]` / `- [x]` / `- [X]` | `to_do` (`props.checked`) |
| `<details><summary>T</summary>…</details>` | `toggle` (`props.open = false`), single-line **and** multi-line forms, nested `<details>` |
| `> 💡 **Note** text` | `callout` (`props.icon`), only when the quote's first **source** line starts with an emoji + space |
| ` ```lang ` / `~~~lang` | `code` (`props.language`, aliases normalised) |
| `![alt](src)` on its own line, `<img …>`, `<figure><img><figcaption>` | `image` (`props.url`, `props.caption`) |
| `[text](url)`, `<https://…>` inline | link runs (`Inline.links`, `kind: "url"`) |
| `<https://…>` alone on a line | `link_preview` (`props.url`) |
| `$$ … $$` across lines, or `$$x$$` | `latex` (`props.latex`, `inlineMode: false`) |
| `$x$` | `latex` with `inlineMode: true`; a paragraph containing it is **split** into paragraph / latex / paragraph |
| `**b**`, `__b__`, `*i*`, `_i_`, `` `c` ``, `~~s~~`, nesting | `Inline.styles` |
| 2 spaces, 4 spaces, tab indentation | child nesting (indent is measured in columns, tab = `tabsWidth`) |
| GFM pipe table | `ParsedDatabase` + a `child_database` block (`props.table`) |
| HTML `<table>` with a bold/`<th>` header row | `ParsedDatabase` (+ warning) |
| `<div class="column_list">` / `<div class="column">` | `column_list` / `column` (`props.ratio = 100/n`) |
| `\*` escapes, `&amp;`/`&#39;` entities, `<br>`, `<b>/<strong>/<em>/<code>/<s>/<a href>/<span>/<time>` | decoded / mapped |
| `<audio>/<video>/<iframe>` | `audio` / `file` with `props.url` (+ warning) |

Column nesting rule: a line indented deeper than the block above it becomes that
block's child; equal or smaller indent returns to the parent. This is what makes
`- a` + `  - b`, `> q` + `>   child`, `# H` + `  sub`, and a fence under a list
item all round-trip.

### Column type inference (GFM tables, HTML tables, CSV)

Checked in this order over the non-empty cells of a column:

1. `number` — `3`, `-2`, `4.5`, `1,234`, `7%`
2. `checkbox` — `true/false`, `yes/no`, `y/n`, `checked/unchecked`, `x/✓`, `✗`
3. `date` — `2024-01-15`, `2024-01-15T10:30`, `1/15/2024`, `12 Mar 2024`
4. `url` — `https://…`, `www.…`, `mailto:…`, anything with `://` and no spaces
5. `multi_select` — every value is a comma list (`red, blue`)
6. `select` — single tokens from ≤ 6 distinct values, and not every row is distinct
7. `text` — everything else

The **first** column becomes `title` when its inferred type is `text`.
Values are stored as `PropertyValueInput`: number → `number`, checkbox →
`boolean`, date → `{ start, end: null, allDay: true }` (UTC midnight for
date-only), select/multi_select → **option names** (the importer has no ids; the
database layer creates options with matching ids), everything else → `string`.

### Notion's real export layout

`importNotionZipLayout(files)` takes the unzipped file list and produces a page
tree:

- every `.md` file becomes a `page` (top level) or `child_page` block titled from
  its filename (`%20` decoded, extension dropped);
- `Folder/Child.md` nests under `Folder.md`, or under `Folder/index.md` when the
  folder has an index;
- the export's root `index.md` becomes the first `page`;
- a **top-level page linked by title** from another page's body is adopted as
  that page's `child_page` (Notion's root page lists its sub-pages as links);
- a relative `.md` link becomes `Inline.links = [{ url: <target title>, kind: "page" }]`
  — the title is the stable key the backlink layer resolves;
- a paragraph/bullet whose entire body is a link to a child page is dropped,
  because the `child_page` node already represents it;
- non-markdown files (images) are skipped with one warning; a `.md` link that
  does not resolve keeps its URL and warns.

---

## Markdown export — canonical syntax

`blocksToMarkdown` emits exactly the syntax the importer accepts, so
`md → blocks → md` is byte-identical for everything supported. The rule is
asserted on a rich fixture in `scripts/test-port.ts`.

- nesting is indented by `indentWidth` (2); consecutive list items share one
  newline, every other block pair is separated by a blank line;
- text is escaped where it would parse as syntax: leading `-`, `+`, `>`, `#`,
  `1.` / `1)`, `![`; and everywhere: `\`, `` ` ``, `*`, `_`, `~`, `$`, `[`, `]`,
  `|`, `<` before a letter;
- italic is `_…_`, bold `**…**`, bold+italic `**_…_**`, strike `~~…~~`, code
  spans grow their backtick run when the text contains backticks;
- code fences grow past any fence inside the code (` ```` ` for a block holding
  ` ``` `), and `plaintext` is written as an empty info string;
- `- [x]` checkbox, `<details><summary>` toggle, `> 💡` callout,
  `![caption](src)` image, `<url>` link preview, `$$ … $$` / `$…$` latex,
  GFM tables from `props.table`, `- [Title](./Title.md)` for `child_page`,
  `<div class="column_list">` for columns;
- a `page` block exports its children (its title only with `titleHeading: true`);
  the HTML export shows the page title by default.

## HTML export

One self-contained file: `<!doctype html>`, `<meta charset>`, `<title>`,
embedded CSS with light **and** dark via `prefers-color-scheme`, print rules.

Semantic tags: `h1-h3` (with `id` anchors), `ul/ol/li` (nested inside the parent
`li`), `ul.to-do-list` + disabled `input[type=checkbox]`, `blockquote`,
`details/summary`, `hr`, `pre>code.language-x`, `figure>img+figcaption`,
`div.callout` with `span.callout-icon`, `table>thead+tbody`,
`div.column-list>div.column`, `section.page`, and KaTeX-ready
`<div class="katex katex-eq" data-latex="…">` / `span.katex-inline`.

**Escaping is a correctness requirement, not a nicety.** Every text run goes
through `escapeHtml` (`& < > " '`), every attribute through `escapeAttr`, code
content is escaped exactly once, and `sanitizeUrl` turns `javascript:`,
`data:text/html`, `vbscript:`, `file:` and `blob:` hrefs into `#`
(`data:image/*` stays allowed). A paragraph containing `<script>alert(1)</script>`
renders as text; the test suite asserts both the escaped output and the absence
of a live `<script>` element.

Inline styles map to `strong/em/u/s/code`, `span.fg-*`, `span.bg-*`,
`span.mention[data-page]`, and `a.page-link`.

## CSV

- `parseCsv` is RFC 4180: quoted fields, embedded commas, embedded newlines,
  `""` escapes, BOM stripped, CRLF/CR/LF, unterminated quote ends at EOF,
  mid-field quotes are literal, ragged rows keep their own widths, blank rows
  skipped by default.
- Delimiter sniffing over `,` `;` tab: the candidate that repeats the same
  unquoted count on the most lines wins (ties in that order), quoted delimiters
  do not count.
- `toCsv` quotes only when needed (`delimiter`, `"`, `\n`, `\r`), doubles inner
  quotes, ends every record with CRLF, and prefixes a cell starting with
  `=`, `+`, `-`, `@`, tab or CR with `'` — **CSV-injection safety** (Excel and
  Sheets evaluate such cells). `guard: false` opts out.
- `rowsToCsv(rows, properties, titlePropId, opts)` maps typed values to cells:
  select/status → option name, multi_select → names joined `, `,
  date → ISO date (or full ISO with `withTime`), checkbox → `Checked`/`Unchecked`,
  relation → titles joined `, `, files → media ids, number → plain digits.
  Options come from `opts.optionsMap` (propId → `SelectOption[]`, or a function)
  and fall back to `prop.config`; titles from `opts.titles` (rowId → title, or a
  function) falling back to the id. The title column goes first and falls back to
  the node body, which is where the database layer mirrors titles.

---

## NOT supported (by design — behaviour is defined, and warned)

Notion / markdown constructs this module deliberately does **not** round-trip:

1. **Notion colors and highlights** in markdown export
   (`<span class="color_red">`, `class="background_…"`): text kept, color
   dropped. HTML export does emit `fg-*`/`bg-*` classes from `Inline.styles`.
2. **Underline** in markdown (`<u>`, `Ins`): text kept; no markdown marker exists
   for `InlineStyles.underline`. HTML export emits `<u>`.
3. **`:::` / `::: info` directive callouts** (Notion uses blockquote + emoji):
   imported as a paragraph.
4. **Toggleable headings** (a heading that is also a toggle): markdown has no
   marker; a heading is never a toggle. Use a `toggle` block.
5. **Synced blocks** (`<div class="synced_block">`), **table-of-contents**
   (`<div class="toc">`), **template badges**, **link-to-page** cards: stripped to
   text with a warning.
6. **Linked databases / views** in Notion's export (`[…](Page%20DB.csv)`,
   `<a name="uuid">` anchors, `.csv`/`.json` asset links): not resolved into
   databases — the link stays a URL and warns.
7. **Inline databases as HTML tables**: rows and cell text are read, and the
   first bold/`<th>` row becomes the header, but cell background colors,
   `<a name>` row anchors, multi-paragraph cells and inline formatting inside a
   cell are dropped (the cell keeps its literal markdown text).
8. **Multi-column layout metadata**: `<div class="column">` widths/styles are
   ignored; columns get an even `100/n` ratio.
9. **Images**: alignment, `previewWidth`, `caption`-only figures, image
   galleries, and inline images inside a paragraph (they become a linked text run
   + warning). Media bytes are not fetched — `props.url` only; `props.mediaId`
   must be wired by the caller.
10. **Audio/video/PDF embeds**: `<audio>`/`<video>`/`<iframe>` become an `audio`
    /`file` block with a URL and a warning; no player metadata, no thumbnails.
11. **`<time>` ranges** in exported tables: reduced to the visible text.
12. **Reference-style links** (`[x][ref]`, link definitions), **footnotes**
    (`[^1]`), **emphasis with `___triple___`**, **HTML comments** (dropped),
    **raw HTML blocks** generally (text kept, tags stripped): defined behaviour,
    not faithful.
13. **Heading levels 4-6** → `heading_3` (+ warning): the block model has three
    heading levels.
14. **Multi-line Setext headings** (a two-line paragraph under `===`): the
    paragraph and the divider are kept as separate blocks.
15. **Lazy list continuation**: a plain, more-indented line under a list item
    becomes a **child block**, not appended text (CommonMark merges it). This is
    what makes Notion's nested export round-trip.
16. **Numbered list start values and letters** (`3.` starts at 3, `a.`): every
    numbered item exports as `1.`; the source number is preserved on
    `props.number` for the importer's benefit only.
17. **Checkboxes on ordered items** (`1. [x] task`): imported as a numbered item
    whose text is `[x] task`. The `- [ ]`, `* [ ]` and `+ [x]` marker forms are
    recognised as `to_do`.
18. **Tables**: merged cells, column alignment (`:---:` is parsed and dropped),
    per-cell rich content, and a table without a header row (the first row is
    read as the header).
19. **Code block captions, line numbers, wrapping** (`props.showLineNumbers`,
    `props.wrap`, `props.captions`): not expressible in a fence; the HTML export
    honours `showLineNumbers`.
20. **Databases from markdown are name-keyed**: `ParsedDatabase.properties` has
    no ids, no `config` (no number format, no relation target, no status groups),
    and no views. The seam assigns ids, creates select options from the names,
    and picks a default view. Inferred types are the seven listed above;
    `formula`, `rollup`, `relation`, `status`, `files`, `email`, `phone`,
    `unique_id` are never inferred (CSV export handles all of them).
21. **HTML import**: there is none. HTML is export-only; an HTML drop is
    imported through the markdown importer, which strips tags and warns.
22. **PDF, DOCX, Notion `.zip` binary handling, TSV-specific column typing**:
    out of scope for this module.

## Notes for the seam (`server/import-export.ts`)

- `props.table` is read through `asTableData`, which accepts **both** the typed
  shape this module writes (`{ title, properties: [{name, type}], rows:
  PropertyValueInput[] }`) and the plain `{ header: string[], rows: string[][] }`
  shape the seam builds, so page markdown and page HTML render database tables
  today.
- `child_database` blocks carry `props.databaseIndex` (the index into
  `ImportResult.databases`) and `props.table`; the seam should create the
  database from `databases[i]` and store the real `databaseId` on the node —
  the export path keys off `props.databaseId`.
- `page` blocks are the import root; `child_page` blocks are sub-pages and
  already carry their content in `children`, so they map to a `child_page` node
  with children, not to a link.
- Page links use `kind: "page"` with the **target page title** as `url`. The
  backlink layer resolves titles to node ids at write time.
- `warnings` are deduped, human-readable, non-fatal: show them in the import
  preview, never throw on them.
