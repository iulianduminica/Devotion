/**
 * CSV: RFC 4180 parsing, injection-safe serialising, and the mapping from
 * typed property values to cells (and back).
 *
 * Deliberately dependency-free. The parser is a single character scan, so
 * quoted fields with embedded newlines, doubled quotes, a leading BOM, CRLF and
 * ragged rows all work without a grammar.
 *
 * Type inference lives here (`inferPropertyType`) because both the CSV importer
 * and the markdown table importer need it, and markdown.ts imports this file —
 * never the other way round.
 */

import {
  type Body,
  type NodeRow,
  type PropertyDef,
  type PropertyValueInput,
  type PropertyType,
  type SelectOption,
} from "../../shared/types.ts";
import {
  blockText,
  optionsFromConfig,
  type ParsedDatabase,
  type ParsedProperty,
} from "./blocks.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedCsv {
  rows: string[][];
  /** the delimiter that was sniffed, so callers can re-emit with the same one */
  delimiter: string;
}

export const CSV_DELIMITERS = [",", ";", "\t"] as const;

/** Strip a UTF-8 BOM and normalise CRLF/CR to LF. */
export function normalizeCsvText(text: string): string {
  let out = text;
  if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
  return out.replace(/\r\n?/g, "\n");
}

/** Count unquoted occurrences of `delimiter` in one line. */
function countDelimiter(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && c === delimiter) count++;
  }
  return count;
}

/**
 * Pick `,`, `;` or tab by looking for the candidate that appears the same number
 * of times on the most lines. Ties go to the order in {@link CSV_DELIMITERS},
 * and a file with no consistent delimiter is reported as `,`.
 */
export function sniffDelimiter(text: string): string {
  const lines = normalizeCsvText(text)
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(0, 20);
  if (lines.length < 2) return ",";

  let best = ",";
  let bestScore = -1;
  for (const d of CSV_DELIMITERS) {
    const counts = lines.map((l) => countDelimiter(l, d));
    const positive = counts.filter((c) => c > 0);
    if (!positive.length) continue;
    const mode = mostFrequent(positive);
    const consistent = counts.filter((c) => c === mode).length;
    const score = consistent * 1000 + mode; // consistency first, then width
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return bestScore <= 0 ? "," : best;
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
 * RFC 4180 scan. A `"` only opens a quoted field at a field start; `""` inside a
 * quoted field is one literal quote; newlines inside quotes stay in the field;
 * an unterminated quote ends at EOF rather than throwing.
 */
function scanCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let started = false; // a quoted empty field is still a field

  const pushField = (): void => {
    row.push(field);
    field = "";
    started = false;
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && !started) {
      inQuotes = true;
      started = true;
      continue;
    }
    if (c === delimiter) {
      pushField();
      continue;
    }
    if (c === "\n") {
      pushRow();
      continue;
    }
    field += c;
    started = true;
  }

  if (inQuotes) {
    // unterminated quote: keep what we have, do not invent a row
  }
  if (field !== "" || row.length || started) pushRow();
  return rows;
}

export interface ParseCsvOptions {
  /** force a delimiter instead of sniffing */
  delimiter?: string;
  /** drop rows that are entirely empty cells (default true) */
  skipBlankRows?: boolean;
}

export function parseCsv(text: string, opts: ParseCsvOptions = {}): ParsedCsv {
  const delimiter = opts.delimiter ?? sniffDelimiter(text);
  const normalized = normalizeCsvText(text);
  let rows = scanCsv(normalized, delimiter);
  if (opts.skipBlankRows ?? true) {
    rows = rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ""));
  }
  return { rows, delimiter };
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialising
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cells a spreadsheet would execute. Excel/Sheets evaluate a cell whose first
 * character is `= + - @` (and tab/CR, which shift a formula), so the value is
 * prefixed with `'` — the standard mitigation.
 */
const INJECTION_RE = /^[=+\-@\t\r]/;

export interface ToCsvOptions {
  delimiter?: string;
  lineEnding?: string;
  /** apply the CSV-injection prefix (default true) */
  guard?: boolean;
}

export function csvCell(value: unknown, opts: ToCsvOptions = {}): string {
  const delimiter = opts.delimiter ?? ",";
  let s = value === null || value === undefined ? "" : String(value);
  if (opts.guard ?? true) {
    if (INJECTION_RE.test(s)) s = "'" + s;
  }
  if (
    s.includes(delimiter) ||
    s.includes('"') ||
    s.includes("\n") ||
    s.includes("\r")
  ) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Every record ends with the line ending, per RFC 4180. */
export function toCsv(rows: (readonly string[])[], opts: ToCsvOptions = {}): string {
  const delimiter = opts.delimiter ?? ",";
  const lineEnding = opts.lineEnding ?? "\r\n";
  if (!rows.length) return "";
  return (
    rows.map((row) => row.map((cell) => csvCell(cell, opts)).join(delimiter)).join(
      lineEnding,
    ) + lineEnding
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Type inference
// ─────────────────────────────────────────────────────────────────────────────

const NUMBER_RE = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/;
const BOOL_TRUE = new Set(["true", "yes", "y", "checked", "x", "✓", "si", "da"]);
const BOOL_FALSE = new Set(["false", "no", "n", "unchecked", "-", "✗", "nu", "ne"]);
const URL_RE = /^(?:https?:\/\/|www\.|ftp:\/\/|mailto:)\S+$/i;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const DATE_SLASH_RE = /^(?:\d{1,2}[/.]\d{1,2}[/.]\d{2,4}|\d{1,2}\s+\w{3,9}\s+\d{4}|\w{3,9}\s+\d{1,2},?\s+\d{4})$/;
const TOKEN_RE = /^[^\s,]+$/;

export function isNumericCell(v: string): boolean {
  return NUMBER_RE.test(v.trim());
}

export function isBooleanCell(v: string): boolean {
  const s = v.trim().toLowerCase();
  return BOOL_TRUE.has(s) || BOOL_FALSE.has(s);
}

export function isDateCell(v: string): boolean {
  const s = v.trim();
  return DATE_ONLY_RE.test(s) || DATE_TIME_RE.test(s) || DATE_SLASH_RE.test(s);
}

export function isUrlCell(v: string): boolean {
  const s = v.trim();
  if (!s || /\s/.test(s)) return false;
  if (URL_RE.test(s)) return true;
  // anything with a scheme separator, minus the bare e-mail case
  return s.includes("://");
}

export function isCommaList(v: string): boolean {
  const parts = v.split(",");
  if (parts.length < 2) return false;
  return parts.every((p) => p.trim() !== "");
}

/**
 * Infer a column type from its cells. Empty cells never disqualify a type.
 * Order matters: number before comma-list (thousands separators), boolean
 * before date, select last because it is the weakest signal.
 */
export function inferPropertyType(values: readonly string[]): PropertyType {
  const filled = values.map((v) => String(v ?? "")).filter((v) => v.trim() !== "");
  if (!filled.length) return "text";

  if (filled.every(isNumericCell)) return "number";
  if (filled.every(isBooleanCell)) return "checkbox";
  if (filled.every(isDateCell)) return "date";
  if (filled.every(isUrlCell)) return "url";
  if (filled.every(isCommaList)) return "multi_select";

  const distinct = new Set(filled.map((v) => v.trim().toLowerCase()));
  const singleToken = filled.every((v) => TOKEN_RE.test(v.trim()));
  if (singleToken && distinct.size <= 6 && distinct.size < filled.length) return "select";

  return "text";
}

// ─────────────────────────────────────────────────────────────────────────────
// Cells ↔ PropertyValueInput
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a date cell into the `{ start, end, allDay }` shape the UI expects. */
export function parseDateCell(cell: string): PropertyValueInput {
  const s = cell.trim();
  if (!s) return null;
  const withTime = DATE_TIME_RE.test(s);
  const iso = DATE_ONLY_RE.exec(s);
  if (iso) {
    const [y, m, d] = s.split("-").map(Number);
    return { start: Date.UTC(y!, (m ?? 1) - 1, d ?? 1), end: null, allDay: true };
  }
  const slash = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(s);
  if (slash) {
    const [, a, b, y] = slash;
    return {
      start: Date.UTC(Number(y), Number(a) - 1, Number(b)),
      end: null,
      allDay: true,
    };
  }
  const ts = Date.parse(withTime ? s : s);
  if (Number.isFinite(ts)) {
    return { start: ts, end: null, allDay: !withTime };
  }
  return { start: null, end: null, allDay: true };
}

/** A cell → a typed value, used by the CSV and markdown table importers. */
export function cellToValue(cell: string, type: PropertyType): PropertyValueInput {
  const raw = String(cell ?? "");
  const s = raw.trim();
  if (s === "") return null;
  switch (type) {
    case "number": {
      const n = Number(s.replace(/[$€%\s,]/g, ""));
      return Number.isFinite(n) ? n : s;
    }
    case "checkbox":
      return BOOL_TRUE.has(s.toLowerCase());
    case "date":
      return parseDateCell(s);
    case "select":
    case "status":
      return [s];
    case "multi_select":
      return s
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p !== "");
    case "title":
    case "text":
    case "url":
    case "email":
    case "phone":
      return raw;
    default:
      return raw;
  }
}

export interface CellFormatOptions {
  /** propId → options, for select/multi_select/status */
  optionsMap?: Record<string, SelectOption[]> | ((propId: string) => SelectOption[]);
  /** rowId → title, for relation cells */
  titles?: Record<string, string> | ((rowId: string) => string);
  /** date cells get a time component when the property config asks for one */
  withTime?: boolean;
}

function lookupOptions(prop: PropertyDef, opts: CellFormatOptions): SelectOption[] {
  if (opts.optionsMap) {
    const list =
      typeof opts.optionsMap === "function"
        ? opts.optionsMap(prop.id)
        : (opts.optionsMap[prop.id] ?? []);
    if (list.length) return list;
  }
  return optionsFromConfig(prop);
}

function lookupTitle(rowId: string, opts: CellFormatOptions): string {
  if (opts.titles) {
    const t = typeof opts.titles === "function" ? opts.titles(rowId) : (opts.titles[rowId] ?? "");
    if (t) return t;
  }
  return rowId;
}

export function isoDate(ms: number, withTime: boolean): string {
  const d = new Date(ms);
  return withTime ? d.toISOString() : d.toISOString().slice(0, 10);
}

/** One property value → one spreadsheet cell. */
export function valueToCell(
  value: PropertyValueInput,
  prop: PropertyDef,
  opts: CellFormatOptions = {},
): string {
  if (value === null || value === undefined) return "";

  switch (prop.type) {
    case "title":
    case "text":
    case "url":
    case "email":
    case "phone":
    case "created_by":
    case "last_edited_by":
      return typeof value === "string" ? value : String(value);

    case "number":
    case "unique_id": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? String(n) : String(value);
    }

    case "checkbox":
      return value === true || value === "true" ? "Checked" : "Unchecked";

    case "date":
    case "created_time":
    case "last_edited_time": {
      const v = value as { start: number | null };
      if (v?.start == null) return "";
      const config = prop.config as { withTime?: boolean };
      return isoDate(v.start, opts.withTime || !!config.withTime);
    }

    case "select":
    case "status": {
      const ids = Array.isArray(value) ? value : [String(value)];
      const id = ids[0];
      if (!id) return "";
      const opt = lookupOptions(prop, opts).find((o) => o.id === id);
      return opt ? opt.name : id;
    }

    case "multi_select": {
      const ids = Array.isArray(value) ? value : [String(value)];
      const options = lookupOptions(prop, opts);
      return ids
        .map((id) => options.find((o) => o.id === id)?.name ?? id)
        .join(", ");
    }

    case "relation": {
      const v = value as { rows?: string[] } | string[];
      const rows = Array.isArray(v) ? v : (v?.rows ?? []);
      return rows.map((r) => lookupTitle(r, opts)).join(", ");
    }

    case "files": {
      const v = value as { mediaIds?: string[] } | string[];
      const ids = Array.isArray(v) ? v : (v?.mediaIds ?? []);
      return ids.join(", ");
    }

    default: {
      // formula, rollup, button, and anything computed
      if (typeof value === "object") {
        const v = value as { v?: unknown };
        if ("v" in v) return v.v == null ? "" : String(v.v);
        return "";
      }
      return String(value);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows → CSV
// ─────────────────────────────────────────────────────────────────────────────

/** Loose on purpose: `RowWithProperties` from shared/types.ts satisfies it. */
export interface CsvRowInput {
  node: Pick<NodeRow, "id"> & { body?: Body | null };
  values: Record<string, PropertyValueInput>;
}

export interface RowsToCsvOptions extends CellFormatOptions {
  /** emit the header row of property names (default true) */
  header?: boolean;
  delimiter?: string;
  lineEnding?: string;
}

/**
 * Rows + their property definitions → CSV text.
 *
 * `titlePropId` names the Title property; its column comes first, and a row with
 * an empty title value falls back to the node body, which is where the database
 * layer mirrors titles.
 */
export function rowsToCsv(
  rows: readonly CsvRowInput[],
  properties: readonly PropertyDef[],
  titlePropId: string,
  opts: RowsToCsvOptions = {},
): string {
  const byId = new Map(properties.map((p) => [p.id, p]));
  const titleProp = byId.get(titlePropId);
  const ordered = titleProp
    ? [titleProp, ...properties.filter((p) => p.id !== titlePropId)]
    : [...properties];

  const out: string[][] = [];
  if (opts.header ?? true) out.push(ordered.map((p) => p.name));

  for (const row of rows) {
    const cells = ordered.map((prop) => {
      let value = row.values[prop.id] ?? null;
      if (prop.type === "title" && (value === null || value === "")) {
        value = blockTextOf(row.node);
      }
      return valueToCell(value, prop, opts);
    });
    out.push(cells);
  }
  return toCsv(out, { delimiter: opts.delimiter, lineEnding: opts.lineEnding });
}

function blockTextOf(node: CsvRowInput["node"]): string {
  const body = node.body;
  if (!body) return "";
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as { text: string }[];
      return parsed.map((i) => i.text).join("");
    } catch {
      return "";
    }
  }
  return body.map((i) => i.text).join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV → database
// ─────────────────────────────────────────────────────────────────────────────

export interface CsvToDatabaseOptions {
  title?: string;
  delimiter?: string;
  /** the first row holds column names (default true) */
  hasHeader?: boolean;
  /** make the first text column a Title property (default true) */
  firstColumnIsTitle?: boolean;
}

/** Unique, non-empty property names, in column order. */
export function propertyNamesFromHeader(header: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return header.map((raw, i) => {
    let name = String(raw ?? "").trim();
    if (!name) name = `Column ${i + 1}`;
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name} (${count + 1})`;
  });
}

export function csvToDatabase(text: string, opts: CsvToDatabaseOptions = {}): ParsedDatabase {
  const { rows } = parseCsv(text, { delimiter: opts.delimiter });
  if (!rows.length) {
    return { title: opts.title ?? "Imported database", properties: [], rows: [] };
  }
  const hasHeader = opts.hasHeader ?? true;
  const headerRow = hasHeader ? (rows[0] ?? []) : [];
  const body = hasHeader ? rows.slice(1) : rows;
  const width = Math.max(
    headerRow.length,
    ...body.map((r) => r.length),
    1,
  );

  const names = hasHeader
    ? propertyNamesFromHeader(Array.from({ length: width }, (_, i) => headerRow[i] ?? ""))
    : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);

  const columns: ParsedProperty[] = [];
  for (let c = 0; c < width; c++) {
    let type = inferPropertyType(body.map((r) => r[c] ?? ""));
    if (c === 0 && type === "text" && (opts.firstColumnIsTitle ?? true)) type = "title";
    columns.push({ name: names[c]!, type });
  }

  return {
    title: opts.title ?? "Imported database",
    properties: columns,
    rows: body.map((r) => {
      const values: Record<string, PropertyValueInput> = {};
      columns.forEach((prop, i) => {
        values[prop.name] = cellToValue(r[i] ?? "", prop.type);
      });
      return values;
    }),
  };
}
