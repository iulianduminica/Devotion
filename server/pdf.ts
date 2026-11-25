/**
 * Print-optimised HTML, for PDF export.
 *
 * There is deliberately no PDF library, no headless browser and no native
 * module in this project. The server renders a document whose print stylesheet
 * is written properly, and the browser's own "Save as PDF" produces the PDF:
 * real vector text, embedded fonts, and its own page numbering. That is better
 * than a rasterised screenshot pipeline and keeps the app a single folder.
 *
 * Honest limitation: CSS `@page { @bottom-center {…} }` margin boxes (the usual
 * way to print page numbers) are not implemented by Chromium, so page numbers
 * come from the browser's own print header/footer, not from this stylesheet.
 */

import type { Db } from "./db.ts";
import { getNode, getTree, nodeTitle } from "./library.ts";
import { blocksToHtml, escapeHtml, slug } from "./port/html.ts";
import { blockText, type ParsedBlock } from "./port/blocks.ts";
import { expandDatabases, treeToParsed } from "./import-export.ts";

export interface PrintOptions {
  /** "a4" | "letter" */
  page: "a4" | "letter";
  landscape: boolean;
  marginsMm: number;
  /** render child pages as sections of the same document */
  includeChildren: boolean;
  /** render embedded databases as tables */
  includeDatabases: boolean;
  /** emit a table of contents of the page's headings */
  toc: boolean;
  /** add the script that opens the print dialog on load */
  autoPrint: boolean;
  /** shown under the title, e.g. the workspace name */
  subtitle: string;
}

export const DEFAULT_PRINT: PrintOptions = {
  page: "a4",
  landscape: false,
  marginsMm: 16,
  includeChildren: true,
  includeDatabases: true,
  toc: false,
  autoPrint: false,
  subtitle: "",
};

export function parsePrintOptions(q: Record<string, string | undefined>): PrintOptions {
  const flag = (v: string | undefined, dflt: boolean): boolean =>
    v === undefined ? dflt : !(v === "0" || v === "false" || v === "no");
  const page = q.page === "letter" ? "letter" : "a4";
  const margins = Number.parseInt(q.margins ?? "", 10);
  return {
    page,
    landscape: flag(q.landscape, false),
    marginsMm: Number.isFinite(margins) && margins >= 0 && margins <= 50 ? margins : 16,
    includeChildren: flag(q.children, true),
    includeDatabases: flag(q.databases, true),
    toc: flag(q.toc, false),
    autoPrint: flag(q.print, false),
    subtitle: (q.subtitle ?? "").slice(0, 120),
  };
}

/** The @page rule. Chromium honours size + margin; margin boxes it does not. */
export function pageRule(o: PrintOptions): string {
  return `@page { size: ${o.page}${o.landscape ? " landscape" : ""}; margin: ${o.marginsMm}mm; }`;
}

export const PRINT_CSS = `
  /* Print is black-on-white with real ink: the app's AMOLED surfaces are for screens. */
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    background: #ffffff !important;
    color: #16161a !important;
    max-width: none;
    padding: 0;
    margin: 0;
    font-size: 10.5pt;
    line-height: 1.55;
  }
  a { color: inherit; text-decoration: none; }
  h1, h2, h3 { break-after: avoid-page; break-inside: avoid; }
  h1 { font-size: 20pt; margin: 0 0 6pt; }
  h2 { font-size: 14pt; margin-top: 14pt; }
  h3 { font-size: 12pt; }
  p, li { orphans: 3; widows: 3; }
  pre, code {
    break-inside: avoid;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 9pt;
    background: #f5f5f6 !important;
    border: 1px solid #e2e2e5;
    border-radius: 3px;
  }
  code { padding: 0 2px; }
  pre { padding: 8pt; }
  table { width: 100%; border-collapse: collapse; break-inside: auto; font-size: 9.5pt; }
  th, td { border: 1px solid #d8d8dc; padding: 4pt 6pt; text-align: left; vertical-align: top; }
  th { background: #f2f2f4 !important; font-weight: 600; }
  tr { break-inside: avoid; }
  thead { display: table-header-group; }
  tfoot { display: table-footer-group; }
  blockquote, figure, img, .katex, .callout, [data-callout] { break-inside: avoid; }
  blockquote { border-left: 2px solid #d0d0d4; padding-left: 8pt; color: #3f3f46; }
  img { max-width: 100%; height: auto; }
  ul, ol { padding-left: 16pt; }
  li { margin: 1pt 0; }
  hr { border: 0; border-top: 1px solid #d8d8dc; margin: 10pt 0; }

  /* a page break the author asked for */
  .devotion-page-break { break-after: page; }

  /* anything interactive is noise on paper */
  button, input, select, textarea, .sn-toolbar, .devotion-no-print { display: none !important; }

  .devotion-meta { color: #6b6b72; font-size: 9pt; margin: 0 0 12pt; }
  .devotion-toc {
    border: 1px solid #e2e2e5;
    border-radius: 4px;
    padding: 8pt 10pt;
    margin: 0 0 14pt;
    break-inside: avoid;
  }
  .devotion-toc-title { font-weight: 600; font-size: 9pt; letter-spacing: 0.08em; text-transform: uppercase; color: #6b6b72; margin-bottom: 4pt; }
  .devotion-toc ol { margin: 0; padding-left: 12pt; }
  .devotion-toc li { font-size: 9.5pt; }
  .devotion-toc .lv2 { padding-left: 10pt; }
  .devotion-toc .lv3 { padding-left: 20pt; }
  .devotion-child { break-before: auto; }
`;

/** Headings in document order, for the table of contents. */
export function collectHeadings(blocks: readonly ParsedBlock[], depth = 0): { text: string; level: number }[] {
  const out: { text: string; level: number }[] = [];
  for (const b of blocks) {
    const m = /^heading_([1-3])$/.exec(b.type);
    if (m) {
      const text = blockText(b).trim();
      if (text) out.push({ text, level: Number(m[1]) });
    }
    if (b.children?.length) out.push(...collectHeadings(b.children, depth + 1));
  }
  return out;
}

function tocHtml(headings: { text: string; level: number }[]): string {
  if (!headings.length) return "";
  const items = headings
    .map((h) => `<li class="lv${h.level}"><a href="#${escapeHtml(slug(h.text))}">${escapeHtml(h.text)}</a></li>`)
    .join("");
  return `<nav class="devotion-toc"><div class="devotion-toc-title">Contents</div><ol>${items}</ol></nav>`;
}

/** Drop child-page blocks (and their subtrees). */
function stripChildren(blocks: readonly ParsedBlock[]): ParsedBlock[] {
  const out: ParsedBlock[] = [];
  for (const b of blocks) {
    if (b.type === "child_page") continue;
    out.push(b.children?.length ? { ...b, children: stripChildren(b.children) } : b);
  }
  return out;
}

/** Drop embedded-database blocks. */
function stripDatabases(blocks: readonly ParsedBlock[]): ParsedBlock[] {
  const out: ParsedBlock[] = [];
  for (const b of blocks) {
    if (b.type === "child_database") continue;
    out.push(b.children?.length ? { ...b, children: stripDatabases(b.children) } : b);
  }
  return out;
}

export interface PrintDocument {
  title: string;
  html: string;
  blocks: number;
  headings: number;
}

/**
 * Render a page (with its subtree) as a print-ready document.
 * Returns "" for an unknown node so the route can 404.
 */
export function printDocumentHtml(
  db: Db,
  nodeId: string,
  opts: Partial<PrintOptions> = {},
): PrintDocument | null {
  const o: PrintOptions = { ...DEFAULT_PRINT, ...opts };
  const tree = getTree(db, nodeId, 30);
  if (!tree) return null;
  const node = getNode(db, nodeId);
  const title = node ? nodeTitle(node) : "Untitled";

  let blocks: ParsedBlock[] = (tree.children ?? []).map(treeToParsed);
  if (o.includeDatabases) blocks = expandDatabases(db, blocks);
  if (!o.includeChildren) blocks = stripChildren(blocks);
  if (!o.includeDatabases) blocks = stripDatabases(blocks);

  const headings = collectHeadings(blocks);
  const meta = [
    o.subtitle ? escapeHtml(o.subtitle) : "",
    `Exported ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
    `${blocks.length} blocks`,
  ]
    .filter(Boolean)
    .join(" · ");

  const rendered = blocksToHtml(
    [{ type: "heading_1", props: {}, body: tree.body, children: [] }, ...blocks],
    {
      title,
      lang: "en",
      includeCss: true,
      dark: false,
      headingIds: true,
      katexScripts: false,
      css: `${pageRule(o)}\n${PRINT_CSS}`,
    },
  );

  // the title line is emitted as the first <h1>; the meta strip goes under it
  const head = `<h1>${escapeHtml(title)}</h1>`;
  const metaHtml = `<p class="devotion-meta">${meta}</p>${o.toc ? tocHtml(headings) : ""}`;
  let html = rendered.includes(head)
    ? rendered.replace(head, `${head}${metaHtml}`)
    : rendered.replace(/<body[^>]*>/, (m) => `${m}${metaHtml}`);

  if (o.autoPrint) {
    // deferred so KaTeX-free, CSS-loaded content is laid out before the dialog
    html = html.replace(
      /<\/body>/,
      `<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},250)});</script></body>`,
    );
  }

  return { title, html, blocks: blocks.length, headings: headings.length };
}
