/**
 * The transport shape shared by every importer and exporter in `server/port/`.
 *
 * `ParsedBlock` is a deliberately lossy, id-free mirror of `NodeRow`: importers
 * produce it, exporters consume it, and the lead's `ops.createNode` maps it to a
 * real node (type → type, props → props, body → body, children → children with
 * fresh ids and pos keys). Nothing in this folder touches the database, so the
 * whole port layer is pure string ↔ structure.
 *
 * Rules that keep the layer honest:
 *   - `body` is the shared `Inline[]` contract, never a plain string.
 *   - `children` is always an array (empty, not null) so exporters never branch
 *     on undefined.
 *   - A database that came from markdown/CSV is referenced by a
 *     `child_database` block whose `props.table` carries the data, so the block
 *     list alone is enough to re-export the table.
 */

import {
  plainTextToBody,
  bodyToPlainText,
  type BlockType,
  type Body,
  type Inline,
  type InlineLink,
  type InlineStyles,
  type PropertyType,
  type PropertyValueInput,
  type SelectOption,
  type StatusGroup,
} from "../../shared/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedBlock {
  type: BlockType;
  props: Record<string, unknown>;
  body: Body | null;
  children: ParsedBlock[];
}

/** A database as an importer understood it. Property identity is its name. */
export interface ParsedProperty {
  name: string;
  type: PropertyType;
}

export interface ParsedDatabase {
  title: string;
  properties: ParsedProperty[];
  /** keyed by property name (importers have no ids to hand out) */
  rows: Record<string, PropertyValueInput>[];
}

export interface ImportResult {
  blocks: ParsedBlock[];
  /** GFM tables, HTML tables and CSV become databases, never blocks */
  databases: ParsedDatabase[];
  /** non-fatal: unsupported syntax encountered, deduped, human readable */
  warnings: string[];
}

/** `props.table` — the table data carried on a `child_database` block. */
export interface TableData {
  title: string;
  properties: ParsedProperty[];
  rows: Record<string, PropertyValueInput>[];
}

/** Key on `ParsedBlock.props` holding a {@link TableData}. */
export const TABLE_PROPS_KEY = "table";

/**
 * The plain string table a caller may carry on `props.table` instead of the
 * typed {@link TableData}: `{ header, rows }`. `asTableData` accepts both.
 */
export interface SimpleTableData {
  header: string[];
  rows: string[][];
  title?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction helpers
// ─────────────────────────────────────────────────────────────────────────────

export function block(
  type: BlockType,
  opts: {
    props?: Record<string, unknown>;
    body?: Body | null;
    text?: string;
    children?: ParsedBlock[];
  } = {},
): ParsedBlock {
  const body =
    opts.body !== undefined
      ? opts.body
      : opts.text !== undefined
        ? plainTextToBody(opts.text)
        : null;
  return {
    type,
    props: opts.props ?? {},
    body,
    children: opts.children ?? [],
  };
}

export function textInline(
  text: string,
  styles: InlineStyles = {},
  links?: InlineLink[],
): Inline {
  const inline: Inline = { type: "text", text, styles };
  if (links && links.length) inline.links = links;
  return inline;
}

/** Two runs may be concatenated when style and links match exactly. */
export function sameRun(a: Inline, b: Inline): boolean {
  return (
    JSON.stringify(a.styles) === JSON.stringify(b.styles) &&
    JSON.stringify(a.links ?? null) === JSON.stringify(b.links ?? null)
  );
}

/** Join runs so a body never has two adjacent runs with identical formatting. */
export function mergeInlines(runs: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = out[out.length - 1];
    if (last && sameRun(last, run)) last.text += run.text;
    else out.push({ ...run, styles: { ...run.styles }, links: run.links ? [...run.links] : undefined });
  }
  if (!out.length) out.push(textInline(""));
  // drop the `links: undefined` key so JSON comparisons stay clean
  for (const run of out) if (run.links === undefined) delete run.links;
  return out;
}

export function bodyText(body: Body | null | undefined): string {
  return bodyToPlainText(body ?? null);
}

/** Plain text of a block, used for titles, table names and CSV cells. */
export function blockText(b: ParsedBlock): string {
  return bodyText(b.body);
}

export function isEmptyBody(body: Body | null | undefined): boolean {
  return !body?.length || body.every((i) => i.text === "");
}

export function databaseToTableData(db: ParsedDatabase): TableData {
  return {
    title: db.title,
    properties: db.properties.map((p) => ({ name: p.name, type: p.type })),
    rows: db.rows.map((r) => ({ ...r })),
  };
}

export function tableDataToDatabase(data: TableData | undefined | null): ParsedDatabase | null {
  if (!data || !Array.isArray(data.properties)) return null;
  return {
    title: data.title ?? "Table",
    properties: data.properties.map((p) => ({ name: p.name, type: p.type as PropertyType })),
    rows: Array.isArray(data.rows) ? data.rows : [],
  };
}

/** The table a `child_database` block carries, in either accepted shape. */
export function blockTable(b: ParsedBlock): ParsedDatabase | null {
  return asTableData(b.props[TABLE_PROPS_KEY]);
}

/**
 * Accept either table shape on `props.table`:
 *
 *  - the typed {@link TableData} this module produces
 *    (`{ title, properties: [{name, type}], rows: PropertyValueInput[] }`)
 *  - the plain string shape a caller may already build
 *    (`{ header: string[], rows: string[][] }`)
 *
 * Returns null for anything else, so the caller falls back to a caption.
 */
export function asTableData(value: unknown): ParsedDatabase | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (Array.isArray(v.properties) && Array.isArray(v.rows)) {
    return tableDataToDatabase(v as unknown as TableData);
  }
  if (Array.isArray(v.header) && Array.isArray(v.rows)) {
    const header = (v.header as unknown[]).map((h, i) => String(h ?? `Column ${i + 1}`));
    const properties: ParsedProperty[] = header.map((name) => ({ name, type: "text" }));
    const rows: Record<string, PropertyValueInput>[] = (v.rows as unknown[]).map((r) => {
      const cells = Array.isArray(r) ? r : [];
      const out: Record<string, PropertyValueInput> = {};
      header.forEach((name, i) => {
        out[name] = cells[i] === null || cells[i] === undefined ? null : String(cells[i]);
      });
      return out;
    });
    return {
      title: typeof v.title === "string" ? v.title : "",
      properties,
      rows,
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Emoji (Notion callouts start with one)
// ─────────────────────────────────────────────────────────────────────────────

const EMOJI_RUN =
  "\\p{Extended_Pictographic}(?:\\uFE0F)?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F)?)*";

/**
 * Split a leading emoji off a run of text. Returns null when the text does not
 * start with one, so `> 💡 Note` is a callout and `> Don't` is a quote.
 */
export function detectLeadingEmoji(text: string): { emoji: string; rest: string } | null {
  const m = new RegExp(`^(${EMOJI_RUN})\\s+`, "u").exec(text.trimStart());
  if (!m) return null;
  const consumed = (text.length - text.trimStart().length) + m[0].length;
  return { emoji: m[1]!, rest: text.slice(consumed) };
}

/** True when the text begins with an emoji followed by whitespace. */
export function startsWithEmoji(text: string): boolean {
  return detectLeadingEmoji(text) !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Select options (shared by CSV cell formatting)
// ─────────────────────────────────────────────────────────────────────────────

/** Read a property's option list out of its config, mirroring `databases.optionsOf`. */
export function optionsFromConfig(prop: {
  type: PropertyType;
  config?: unknown;
}): SelectOption[] {
  const config = (prop.config ?? {}) as {
    options?: SelectOption[];
    groups?: StatusGroup[];
  };
  if (prop.type === "status") {
    return (config.groups ?? []).flatMap((g) => g.options ?? []);
  }
  return config.options ?? [];
}
