/**
 * The port layer's public surface.
 *
 * Importers return an {@link ImportResult} (blocks + databases + warnings);
 * exporters take blocks and return a string. `detectFormat` is the one entry
 * point the API needs before it knows what a dropped file is.
 */

import { plainTextToBody } from "../../shared/types.ts";
import {
  block,
  databaseToTableData,
  TABLE_PROPS_KEY,
  type ImportResult,
} from "./blocks.ts";
import { csvToDatabase } from "./csv.ts";
import { markdownToBlocks, type ImportOptions } from "./markdown.ts";

export {
  asTableData,
  block,
  blockTable,
  blockText,
  bodyText,
  databaseToTableData,
  detectLeadingEmoji,
  isEmptyBody,
  mergeInlines,
  optionsFromConfig,
  sameRun,
  startsWithEmoji,
  tableDataToDatabase,
  textInline,
  TABLE_PROPS_KEY,
  type ImportResult,
  type ParsedBlock,
  type ParsedDatabase,
  type ParsedProperty,
  type SimpleTableData,
  type TableData,
} from "./blocks.ts";

export {
  blocksToMarkdown,
  bodyToMarkdown,
  escapeMarkdownText,
  importNotionZipLayout,
  LANGUAGE_ALIASES,
  markdownToBlocks,
  normalizeLanguage,
  nodesToBody,
  parseInlineNodes,
  resolvePath,
  tableToMarkdown,
  type ExportOptions,
  type ImportOptions,
  type InlineNode,
  type MarkdownOptions,
  type NotionFile,
  type NotionLayoutOptions,
} from "./markdown.ts";

export {
  blocksToHtml,
  blocksToHtmlBody,
  blockToHtmlFragment,
  DEFAULT_CSS,
  escapeHtml,
  sanitizeUrl,
  type HtmlOptions,
} from "./html.ts";

export {
  cellToValue,
  csvCell,
  csvToDatabase,
  inferPropertyType,
  isBooleanCell,
  isDateCell,
  isNumericCell,
  isUrlCell,
  normalizeCsvText,
  parseCsv,
  propertyNamesFromHeader,
  rowsToCsv,
  sniffDelimiter,
  toCsv,
  valueToCell,
  CSV_DELIMITERS,
  type CsvRowInput,
  type CsvToDatabaseOptions,
  type ParseCsvOptions,
  type ParsedCsv,
  type RowsToCsvOptions,
  type ToCsvOptions,
} from "./csv.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Format detection
// ─────────────────────────────────────────────────────────────────────────────

export type DetectedFormat = "markdown" | "html" | "csv" | "text";

export interface DetectOptions {
  /** the dropped file's name, when there is one — the strongest signal */
  filename?: string;
}

const MD_MARKERS: RegExp[] = [
  /^#{1,6}[ \t]+\S/m,
  /^[ \t]*[-*+][ \t]+\S/m,
  /^[ \t]*\d+\.[ \t]+\S/m,
  /^[ \t]*>[ \t]+\S/m,
  /^```/m,
  /^~~~/m,
  /^[ \t]*\|.*\|[ \t]*$/m,
  /\*\*[^*\n]+\*\*/,
  /\[[^\]\n]*\]\([^)\n]+\)/,
  /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/m,
  /^[ \t]*<details\b/im,
  /^\$\$/m,
];

const EXT_FORMATS: Record<string, DetectedFormat> = {
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  html: "html",
  htm: "html",
  csv: "csv",
  tsv: "csv",
  txt: "text",
};

function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Rows that share one column count under `delimiter`. */
function csvShape(text: string, delimiter: string): { rows: number; cols: number } {
  const lines = text
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim() !== "")
    .slice(0, 40);
  if (lines.length < 2) return { rows: 0, cols: 0 };
  const counts = lines.map((l) => l.split(delimiter).length);
  const cols = mostFrequent(counts);
  const rows = counts.filter((c) => c === cols).length;
  return { rows, cols };
}

function mostFrequent(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0] ?? 0;
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = value;
    }
  }
  return best;
}

/**
 * Sniff what a dropped file is. The extension wins when it is one we know;
 * otherwise HTML is decided by its document start, CSV by a delimiter that
 * repeats on most lines, markdown by structural markers, and anything else is
 * plain text (which imports as paragraphs, so a drop never fails).
 */
export function detectFormat(text: string, opts: DetectOptions = {}): DetectedFormat {
  if (opts.filename) {
    const ext = EXT_FORMATS[extensionOf(opts.filename)];
    if (ext) return ext;
  }

  const head = text.replace(/^\s+/, "");
  if (/^<!doctype\s+html/i.test(head) || /^<html[\s>]/i.test(head)) return "html";
  if (/^<[a-z][a-z0-9]*\b[^>]*>/i.test(head)) {
    const tags = (
      text.match(/<\/?(?:html|head|body|div|p|h[1-6]|table|section|article|figure)\b/gi) ?? []
    ).length;
    if (tags >= 3) return "html";
  }

  const mdScore = MD_MARKERS.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
  if (mdScore >= 2) return "markdown";

  for (const delimiter of [",", ";", "\t"]) {
    const { rows, cols } = csvShape(text, delimiter);
    if (rows >= 2 && cols >= 2) return "csv";
  }

  const trimmed = text.trim();
  if (!trimmed) return "text";
  if (mdScore === 1) return "markdown";
  return "text";
}

export interface DetectResult {
  format: DetectedFormat;
  /** a short human-readable reason, for the import preview UI */
  reason: string;
}

export function detectFormatDetailed(
  text: string,
  opts: DetectOptions = {},
): DetectResult {
  const format = detectFormat(text, opts);
  const ext = opts.filename ? extensionOf(opts.filename) : "";
  const reason =
    ext && EXT_FORMATS[ext]
      ? `extension .${ext}`
      : format === "html"
        ? "starts with an HTML document"
        : format === "csv"
          ? "consistent delimiter on most lines"
          : format === "markdown"
            ? "markdown structure (headings, lists, fences, links)"
            : "no structure recognised";
  return { format, reason };
}

export interface ImportTextInput extends ImportOptions, DetectOptions {
  title?: string;
}

/**
 * Import a dropped file of any supported kind into the transport shape.
 * HTML import is export-only, so an HTML drop goes through the markdown
 * importer, which strips tags and keeps the text (with a warning).
 */
export function importText(text: string, opts: ImportTextInput = {}): ImportResult {
  const format = detectFormat(text, opts);

  if (format === "csv") {
    const database = csvToDatabase(text, {
      title: opts.title ?? opts.filename ?? "Imported database",
    });
    return {
      blocks: [
        block("child_database", {
          body: plainTextToBody(database.title),
          props: {
            databaseIndex: 0,
            [TABLE_PROPS_KEY]: databaseToTableData(database),
          },
        }),
      ],
      databases: [database],
      warnings: [],
    };
  }

  if (format === "text") {
    const paragraphs = text
      .split(/\r?\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p !== "");
    return {
      blocks: paragraphs.map((p) => block("paragraph", { text: p })),
      databases: [],
      warnings: ["plain text imported as paragraphs; markdown syntax kept as typed"],
    };
  }

  return markdownToBlocks(text, opts);
}
