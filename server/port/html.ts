/**
 * Blocks → a standalone HTML document.
 *
 * Three rules drive this file:
 *   1. every piece of text is escaped, and every attribute is escaped, so a
 *      paragraph containing `<script>` renders as text and never executes;
 *   2. the markup is semantic (h1-h3, ul/ol, blockquote, details/summary,
 *      pre>code with a `language-x` class, figure/figcaption, table);
 *   3. the output is one self-contained file: embedded CSS, light and dark via
 *      `prefers-color-scheme`, and KaTeX-ready equation nodes
 *      (`<div class="katex-eq" data-latex="…">`) that a renderer can pick up.
 */

import {
  type Body,
  type Inline,
  type PropertyValueInput,
} from "../../shared/types.ts";
import {
  asTableData,
  blockText,
  TABLE_PROPS_KEY,
  type ParsedBlock,
  type ParsedProperty,
} from "./blocks.ts";
import type { ExportOptions } from "./markdown.ts";

export interface HtmlOptions extends ExportOptions {
  /** <title> of the document (default "Strata Notes export") */
  title?: string;
  /** <html lang> (default "en") */
  lang?: string;
  /** embed the built-in stylesheet (default true) */
  includeCss?: boolean;
  /** emit the `prefers-color-scheme: dark` block (default true) */
  dark?: boolean;
  /** extra CSS appended after the built-in one */
  css?: string;
  /** add `id` anchors to headings (default true) */
  headingIds?: boolean;
  /** page-link key → href (default `#page-<slug>`) */
  pageLink?: (key: string) => string;
  /** image/file url → src, for rewriting media ids into file paths */
  mediaLink?: (url: string) => string;
  /** emit `<script>` tags for KaTeX (default false: no remote scripts) */
  katexScripts?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Escaping
// ─────────────────────────────────────────────────────────────────────────────

export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Same table as `escapeHtml`; kept separate so intent stays readable. */
export function escapeAttr(text: string): string {
  return escapeHtml(text);
}

const DANGEROUS_URL = /^\s*(?:javascript|vbscript|livescript|data|file|blob):/i;

/** Neutralise executable URLs; `data:image/*` stays allowed for inline art. */
export function sanitizeUrl(url: string): string {
  const raw = String(url ?? "").trim();
  if (!raw) return "#";
  if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);/i.test(raw)) return escapeAttr(raw);
  if (DANGEROUS_URL.test(raw)) return "#";
  // a bare "javascript:alert(1)" with no scheme prefix is still not a link
  if (/^\s*javascript:/i.test(raw)) return "#";
  return escapeAttr(raw);
}

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline
// ─────────────────────────────────────────────────────────────────────────────

function inlineToHtml(body: Body | null, opts: RequiredHtml): string {
  if (!body?.length) return "";
  const parts: string[] = [];
  for (const run of body) {
    let html = escapeHtml(run.text).replace(/\n/g, "<br>");
    if (!html) continue;
    const styles = run.styles ?? {};
    if (styles.code) html = `<code>${html}</code>`;
    if (styles.strike) html = `<s>${html}</s>`;
    if (styles.underline) html = `<u>${html}</u>`;
    if (styles.italic) html = `<em>${html}</em>`;
    if (styles.bold) html = `<strong>${html}</strong>`;
    if (styles.color && styles.color !== "default") {
      html = `<span class="fg-${escapeAttr(styles.color)}">${html}</span>`;
    }
    if (styles.backgroundColor && styles.backgroundColor !== "default") {
      html = `<span class="bg-${escapeAttr(styles.backgroundColor)}">${html}</span>`;
    }
    if (styles.mention) {
      html = `<span class="mention" data-page="${escapeAttr(styles.mention)}">${html}</span>`;
    }
    const link = run.links?.[0];
    if (link) {
      const href =
        link.kind === "page"
          ? sanitizeUrl(opts.pageLink(link.url))
          : sanitizeUrl(link.url);
      html = `<a href="${href}"${link.kind === "page" ? ' class="page-link"' : ""}>${html}</a>`;
    }
    parts.push(html);
  }
  return parts.join("");
}

type RequiredHtml = Required<Pick<HtmlOptions, "pageLink" | "mediaLink">> &
  HtmlOptions;

const defaultPageLink = (key: string): string => `#page-${slug(key)}`;
const defaultMediaLink = (url: string): string => url;

// ─────────────────────────────────────────────────────────────────────────────
// Blocks
// ─────────────────────────────────────────────────────────────────────────────

function tableToHtml(
  properties: ParsedProperty[],
  rows: Record<string, PropertyValueInput>[],
  opts: RequiredHtml,
): string {
  const cell = (value: PropertyValueInput): string => {
    if (value === null || value === undefined) return "";
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return value ? "Checked" : "Unchecked";
    if (Array.isArray(value)) return value.join(", ");
    if (typeof value === "object") {
      const v = value as { start?: number | null; rows?: string[]; mediaIds?: string[] };
      if (v.start != null) return new Date(v.start).toISOString().slice(0, 10);
      if (v.rows) return v.rows.join(", ");
      if (v.mediaIds) return v.mediaIds.join(", ");
      return "";
    }
    return String(value);
  };
  const head = properties
    .map((p) => `<th>${escapeHtml(p.name)}</th>`)
    .join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${properties
          .map((p) => `<td>${escapeHtml(cell(row[p.name] ?? null))}</td>`)
          .join("")}</tr>`,
    )
    .join("\n");
  return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

function renderBlock(b: ParsedBlock, opts: RequiredHtml): string {
  const inner = () => blocksToHtmlBody(b.children, opts);
  const text = inlineToHtml(b.body, opts);

  switch (b.type) {
    case "divider":
      return "<hr>";
    case "heading_1":
    case "heading_2":
    case "heading_3": {
      const level = b.type.slice(-1);
      const id = opts.headingIds ?? true ? ` id="${escapeAttr(slug(blockText(b)))}"` : "";
      const html = `<h${level}${id}>${text}</h${level}>`;
      return b.children.length ? `${html}\n${inner()}` : html;
    }
    case "bulleted_list_item":
    case "numbered_list_item":
    case "to_do": {
      if (b.type === "to_do") {
        const checked = b.props.checked === true ? " checked" : "";
        return `<li class="to-do"><label><input type="checkbox" disabled${checked}> <span>${text}</span></label>${
          b.children.length ? `\n${inner()}` : ""
        }</li>`;
      }
      return `<li>${text}${b.children.length ? `\n${inner()}` : ""}</li>`;
    }
    case "toggle": {
      const open = b.props.open === true ? " open" : "";
      return `<details${open}>\n<summary>${text}</summary>\n${inner()}\n</details>`;
    }
    case "quote":
      return `<blockquote>\n<p>${text}</p>${b.children.length ? `\n${inner()}` : ""}\n</blockquote>`;
    case "callout": {
      const icon =
        typeof b.props.icon === "string" && b.props.icon ? b.props.icon : "💡";
      const color =
        typeof b.props.color === "string" && b.props.color
          ? ` bg-${escapeAttr(b.props.color)}`
          : "";
      return `<div class="callout${color}">\n<span class="callout-icon" aria-hidden="true">${escapeHtml(
        icon,
      )}</span>\n<div class="callout-body">\n<p>${text}</p>${
        b.children.length ? `\n${inner()}` : ""
      }\n</div>\n</div>`;
    }
    case "code": {
      const lang = typeof b.props.language === "string" ? b.props.language : "plaintext";
      const code = b.props.showLineNumbers ? " data-line-numbers" : "";
      // code is literal text: escape once, never run it through the inline path
      return `<pre${code}><code class="language-${escapeAttr(
        lang.toLowerCase(),
      )}">${escapeHtml(blockText(b))}</code></pre>`;
    }
    case "latex": {
      const latex = String(b.props.latex ?? "");
      if (b.props.inlineMode) {
        return `<span class="katex katex-inline" data-latex="${escapeAttr(
          latex,
        )}">${escapeHtml(latex)}</span>`;
      }
      return `<div class="katex katex-eq" data-latex="${escapeAttr(
        latex,
      )}">${escapeHtml(latex)}</div>`;
    }
    case "image": {
      const url = opts.mediaLink(String(b.props.url ?? ""));
      const caption = b.props.caption
        ? inlineToHtml(b.props.caption as Body, opts)
        : text;
      const width =
        typeof b.props.previewWidth === "number"
          ? ` style="max-width:${Math.round(b.props.previewWidth)}px"`
          : "";
      return `<figure class="image">\n<img src="${sanitizeUrl(
        url,
      )}" alt="${escapeAttr(caption.replace(/<[^>]*>/g, ""))}"${width}>\n${
        caption ? `<figcaption>${caption}</figcaption>` : ""
      }\n</figure>`;
    }
    case "link_preview":
      return `<div class="link-preview"><a href="${sanitizeUrl(
        String(b.props.url ?? ""),
      )}" rel="noopener noreferrer">${escapeHtml(String(b.props.url ?? ""))}</a></div>`;
    case "bookmark":
      return `<div class="bookmark"><a href="${sanitizeUrl(
        String(b.props.url ?? ""),
      )}" rel="noopener noreferrer">${
        text || escapeHtml(String(b.props.url ?? ""))
      }</a></div>`;
    case "audio":
      return `<div class="audio"><audio controls src="${sanitizeUrl(
        opts.mediaLink(String(b.props.url ?? "")),
      )}"></audio>${text ? `<p class="caption">${text}</p>` : ""}</div>`;
    case "file":
      return `<div class="file"><a href="${sanitizeUrl(
        opts.mediaLink(String(b.props.url ?? "")),
      )}">${text || "File"}</a></div>`;
    case "child_database": {
      const table = asTableData(b.props[TABLE_PROPS_KEY]);
      if (!table?.properties.length) {
        return `<div class="database-empty">${text || "<i>Empty database</i>"}</div>`;
      }
      const title = table.title || blockText(b);
      return `<div class="database" data-title="${escapeAttr(title)}">\n${tableToHtml(
        table.properties,
        table.rows,
        opts,
      )}\n</div>`;
    }
    case "child_page":
      return `<div class="child-page"><a href="${sanitizeUrl(
        opts.pageLink(blockText(b)),
      )}">${text}</a></div>`;
    case "column_list": {
      const columns = b.children
        .map((c) => {
          const ratio = typeof c.props.ratio === "number" ? c.props.ratio : 100;
          return `<div class="column" style="width:${Math.round(ratio)}%">\n${blocksToHtmlBody(
            c.children,
            opts,
          )}\n</div>`;
        })
        .join("\n");
      return `<div class="column-list">\n${columns}\n</div>`;
    }
    case "column":
      return blocksToHtmlBody(b.children, opts);
    case "page": {
      const title = blockText(b);
      const heading =
        opts.titleHeading === false
          ? ""
          : `<h1 class="page-title"${
              opts.headingIds ?? true ? ` id="page-${escapeAttr(slug(title))}"` : ""
            }>${inlineToHtml(b.body, opts)}</h1>`;
      return `<section class="page" data-title="${escapeAttr(title)}">\n${
        heading ? heading + "\n" : ""
      }${inner()}\n</section>`;
    }
    case "table_row":
      return `<p class="table-row">${text}</p>`;
    default: {
      // a caller-supplied table block (any type name) that carries props.table
      const table = asTableData(b.props[TABLE_PROPS_KEY]);
      if (table?.properties.length) {
        return `<div class="database" data-title="${escapeAttr(table.title || blockText(b))}">\n${tableToHtml(
          table.properties,
          table.rows,
          opts,
        )}\n</div>`;
      }
      return text ? `<p>${text}</p>` : "";
    }
  }
}

/** Group consecutive list items into one `<ul>` / `<ol>`, as HTML expects. */
export function blocksToHtmlBody(
  blocks: readonly ParsedBlock[],
  opts: HtmlOptions = {},
): string {
  const resolved: RequiredHtml = {
    ...opts,
    pageLink: opts.pageLink ?? defaultPageLink,
    mediaLink: opts.mediaLink ?? defaultMediaLink,
  };
  const out: string[] = [];
  let list: { type: "ul" | "ol"; items: string[]; cls: string } | null = null;

  const closeList = (): void => {
    if (!list) return;
    const attrs = list.cls ? ` class="${list.cls}"` : "";
    out.push(`<${list.type}${attrs}>\n${list.items.join("\n")}\n</${list.type}>`);
    list = null;
  };

  for (const b of blocks) {
    const isTodo = b.type === "to_do";
    const listType =
      b.type === "numbered_list_item"
        ? ("ol" as const)
        : b.type === "bulleted_list_item" || isTodo
          ? ("ul" as const)
          : null;
    if (listType) {
      const cls = isTodo ? "to-do-list" : "";
      if (!list || list.type !== listType || list.cls !== cls) {
        closeList();
        list = { type: listType, items: [], cls };
      }
      list.items.push(renderBlock(b, resolved));
      continue;
    }
    closeList();
    const html = renderBlock(b, resolved);
    if (html.trim()) out.push(html);
  }
  closeList();
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Document
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_CSS = `:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1f1f1e;
  --muted: #6b6b6b;
  --line: #e6e6e4;
  --code-bg: #f5f5f4;
  --callout-bg: #f1f1ef;
  --accent: #2b7de0;
  --max: 46rem;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #191919;
    --fg: #d4d4d2;
    --muted: #9b9b99;
    --line: #2f2f2f;
    --code-bg: #202020;
    --callout-bg: #242422;
    --accent: #4d9fff;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.6 ui-sans-serif, -apple-system, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
}
main.strata { max-width: var(--max); margin: 0 auto; padding: 3rem 1.5rem 6rem; }
h1, h2, h3 { line-height: 1.25; margin: 1.6rem 0 0.4rem; }
h1 { font-size: 1.9rem; }
h2 { font-size: 1.5rem; }
h3 { font-size: 1.2rem; }
p { margin: 0.45rem 0; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
ul, ol { margin: 0.35rem 0; padding-left: 1.5rem; }
li { margin: 0.15rem 0; }
li > ul, li > ol { margin: 0.1rem 0; }
li.to-do { list-style: none; margin-left: -1.25rem; }
li.to-do input { margin-right: 0.4rem; }
li.to-do input:checked + span { color: var(--muted); text-decoration: line-through; }
blockquote {
  margin: 0.6rem 0;
  padding-left: 0.9rem;
  border-left: 3px solid var(--fg);
}
hr { border: 0; border-top: 1px solid var(--line); margin: 1.4rem 0; }
pre {
  background: var(--code-bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0.9rem 1rem;
  overflow-x: auto;
}
pre code { font: 14px/1.55 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; white-space: pre; }
code { background: var(--code-bg); border-radius: 4px; padding: 0.1rem 0.3rem; font: 0.9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre > code { background: none; padding: 0; }
details { margin: 0.5rem 0; }
summary { cursor: pointer; font-weight: 600; }
.callout {
  display: flex;
  gap: 0.7rem;
  align-items: flex-start;
  background: var(--callout-bg);
  border-radius: 6px;
  padding: 0.8rem 0.9rem;
  margin: 0.7rem 0;
}
.callout-icon { font-size: 1.2rem; line-height: 1.3; }
.callout-body { flex: 1; }
figure { margin: 0.9rem 0; }
figure img { max-width: 100%; border-radius: 4px; display: block; }
figcaption { color: var(--muted); font-size: 0.85rem; margin-top: 0.35rem; }
table { border-collapse: collapse; width: 100%; margin: 0.8rem 0; font-size: 0.95rem; }
th, td { border: 1px solid var(--line); padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
th { background: var(--code-bg); font-weight: 600; }
.database { overflow-x: auto; }
.column-list { display: flex; gap: 1.2rem; flex-wrap: wrap; margin: 0.6rem 0; }
.column { flex: 1 1 0; min-width: 12rem; }
.katex-eq { display: block; text-align: center; margin: 0.9rem 0; font-family: ui-monospace, Menlo, Consolas, monospace; }
.katex-inline { font-family: ui-monospace, Menlo, Consolas, monospace; }
.link-preview a, .bookmark a, .file a, .child-page a { display: inline-block; margin: 0.35rem 0; }
.child-page a::before { content: "📄 "; }
.page { margin: 1.2rem 0; }
.page-title { border-bottom: 1px solid var(--line); padding-bottom: 0.3rem; }
.muted, figcaption, .caption { color: var(--muted); }
.fg-gray { color: #737373; } .fg-brown { color: #9c6b4e; } .fg-orange { color: #d9730d; }
.fg-yellow { color: #cb9808; } .fg-green { color: #0f7b6c; } .fg-blue { color: #0b6a9e; }
.fg-purple { color: #6f42c1; } .fg-pink { color: #ad2f7f; } .fg-red { color: #c4554d; }
.bg-gray_background { background: #f1f1f1; } .bg-blue_background { background: #dbedfb; }
.bg-yellow_background { background: #fdf4dd; } .bg-green_background { background: #dce3da; }
.bg-red_background { background: #fbe4e5; } .bg-purple_background { background: #f4ecfe; }
.bg-pink_background { background: #f8dde8; } .bg-orange_background { background: #fae9dd; }
.bg-brown_background { background: #f5e7e0; }
@media (prefers-color-scheme: dark) {
  .bg-gray_background { background: #2f2f2f; } .bg-blue_background { background: #153346; }
  .bg-yellow_background { background: #3a3020; } .bg-green_background { background: #243125; }
  .bg-red_background { background: #3a2424; } .bg-purple_background { background: #2b2340; }
  .bg-pink_background { background: #3a2331; } .bg-orange_background { background: #3a2b20; }
  .bg-brown_background { background: #33261f; }
}
@media print {
  main.strata { max-width: none; padding: 0; }
  details { display: block; }
  details > * { display: block !important; }
}`;

/** A complete, standalone document: doctype, head, embedded CSS, body. */
export function blocksToHtml(
  blocks: readonly ParsedBlock[],
  opts: HtmlOptions = {},
): string {
  const includeCss = opts.includeCss ?? true;
  const title = opts.title ?? "Strata Notes export";
  const body = blocksToHtmlBody(blocks, opts);
  const styles = includeCss
    ? `<style>\n${DEFAULT_CSS}${opts.css ? `\n${opts.css}\n` : "\n"}</style>`
    : opts.css
      ? `<style>\n${opts.css}\n</style>`
      : "";
  const katex = opts.katexScripts
    ? `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>`
    : "";
  const dark = (opts.dark ?? true) ? "" : "";
  void dark;
  return `<!doctype html>
<html lang="${escapeAttr(opts.lang ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${styles}
${katex}
</head>
<body>
<main class="strata">
${body}
</main>
</body>
</html>
`;
}

/** One block → an HTML fragment (handy for previews and tests). */
export function blockToHtmlFragment(b: ParsedBlock, opts: HtmlOptions = {}): string {
  return blocksToHtmlBody([b], opts);
}

export type { Inline };
