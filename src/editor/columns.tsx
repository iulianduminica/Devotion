/**
 * Multi-column layout: `column_list` + `column`.
 *
 * BlockNote 0.57 makes a block that contains other blocks a **layout block**:
 * `content: "none"`, `layoutOnly: true`, and its children live in its own
 * ProseMirror node (not in a `blockGroup` under a `blockContainer`). It draws
 * its box in `renderFrame` and hands the children to `slotRef`. `render` is
 * illegal on a layout block — core throws
 * `Layout block "x" draws its box in renderFrame, and has no content for render to draw.`
 *
 * `column` is `placeable: "namedOnly"`, which is what keeps a column from
 * appearing where a plain block goes; the parent must name it in
 * `children.allow`, and core throws if nothing names it.
 *
 * All the arithmetic — width distribution, resizing, adding and removing
 * columns, and the node-tree mapping — is factored into the exported pure
 * functions at the top so `scripts/test-columns.ts` can run it in Node with no
 * DOM. The React below is thin.
 */

import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import type { Block, BlockNoteEditor } from "@blocknote/core";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const COLUMN_LIST_TYPE = "column_list";
export const COLUMN_TYPE = "column";

/** BlockNote's node names are camelCase; our node.type names are snake_case. */
export const BN_COLUMN_LIST = "columnList";
export const BN_COLUMN = "column";

/** A column narrower than this is unusable, so resizing stops there. */
export const MIN_COLUMN_WIDTH = 15;
/** Notion caps a column list at 5; we support 2–4 and allow 5 as a ceiling. */
export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 5;

/** The widths a fresh column list gets, keyed by column count. */
export const PRESETS: Record<number, readonly number[]> = {
  2: [50, 50],
  3: [33, 33, 34],
  4: [25, 25, 25, 25],
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure logic: widths
// ─────────────────────────────────────────────────────────────────────────────

/** True when `n` is a usable column count. */
export function isValidColumnCount(n: number): boolean {
  return Number.isInteger(n) && n >= MIN_COLUMNS && n <= MAX_COLUMNS;
}

/**
 * Clamp a column count into range. Anything under 2 becomes 2 (a one-column
 * "column list" is just a block), anything over the cap becomes the cap.
 */
export function normalizeColumnCount(n: number): number {
  if (Number.isNaN(n)) return MIN_COLUMNS;
  if (n === Number.POSITIVE_INFINITY) return MAX_COLUMNS;
  if (n === Number.NEGATIVE_INFINITY) return MIN_COLUMNS;
  if (!Number.isFinite(n)) return MIN_COLUMNS;
  const i = Math.round(n);
  if (i < MIN_COLUMNS) return MIN_COLUMNS;
  if (i > MAX_COLUMNS) return MAX_COLUMNS;
  return i;
}

/**
 * Equal widths that always sum to exactly 100. The remainder is spread over the
 * first columns, so 3 columns are [34, 33, 33] and never [33.33, 33.33, 33.34].
 */
export function equalWidths(count: number): number[] {
  const n = normalizeColumnCount(count);
  const base = Math.floor(100 / n);
  const rem = 100 - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

/**
 * The widths a column list is stored with.
 *
 * A saved list whose widths do not sum to 100 (hand-edited rows, a column added
 * by an older build), that has fewer than `MIN_COLUMNS` usable entries, or that
 * puts a column under the floor, is repaired by re-distributing equally — so
 * the renderer never has to defend against a broken invariant.
 */
export function normalizeWidths(widths: readonly number[]): number[] {
  const clean = widths.map((w) => (Number.isFinite(w) ? Math.round(w) : 0));
  if (clean.length < MIN_COLUMNS) return equalWidths(clean.length || MIN_COLUMNS);
  // A list with missing or zero widths is repaired across the columns it
  // actually has. Redistributing across only the valid ones silently shrinks the
  // layout — a 3-column list with no ratios became [50,50,0].
  if (clean.some((w) => w <= 0)) return equalWidths(clean.length);
  const sum = clean.reduce((a, b) => a + b, 0);
  if (sum !== 100) return equalWidths(clean.length);
  const min = minFor(clean.length);
  if (clean.some((w) => w < min)) return equalWidths(clean.length);
  return clean;
}

/** The per-column floor for a given count: 15%. */
export function minFor(count: number): number {
  void count;
  return MIN_COLUMN_WIDTH;
}

/**
 * Resize the pair straddling a divider.
 *
 * `index` is the divider: the left column is `widths[index]`, the right is
 * `widths[index + 1]`. `delta` is the movement in percentage points. The two
 * widths trade against each other, so the total is untouched, and each side is
 * clamped to the floor.
 *
 * The pair is a closed system, so the left column can only range over
 * `[min, pair - min]`. The other columns are untouched, which means a pair that
 * is itself too small to split at the floor (a 3-column list at [70, 15, 15]
 * cannot widen its last divider) is left alone rather than pushed under it.
 *
 * Returns the original array (by value) when the divider index is out of range
 * or the pair is already at its limits.
 */
export function resizePair(widths: readonly number[], index: number, delta: number): number[] {
  const out = normalizeWidths(widths);
  const n = out.length;
  if (!Number.isInteger(index) || index < 0 || index > n - 2) return out;
  if (!Number.isFinite(delta)) return out;

  const min = minFor(n);
  const left = out[index]!;
  const right = out[index + 1]!;
  const pair = left + right;

  const lo = min;
  const hi = pair - min;
  if (lo > hi) return out;

  const next = Math.round(Math.min(hi, Math.max(lo, left + delta)));
  if (next === left) return out;

  out[index] = next;
  out[index + 1] = pair - next;
  return out;
}

/**
 * Resize by dragging to an absolute position.
 *
 * `leftEdge` / `totalWidth` are the pixel geometry of the column list's row and
 * `pointerX` is where the pointer is. The divider is placed under the pointer:
 * the left column grows to `pointerX - (its left edge)`, then `resizePair`
 * clamps it and pays for it out of the right column.
 */
export function resizeAt(
  widths: readonly number[],
  index: number,
  leftEdge: number,
  totalWidth: number,
  pointerX: number,
): number[] {
  if (!Number.isFinite(totalWidth) || totalWidth <= 0) return normalizeWidths(widths);
  const out = normalizeWidths(widths);
  const n = out.length;
  if (!Number.isInteger(index) || index < 0 || index > n - 2) return out;

  // The left column's left edge, in percent of the row.
  let before = 0;
  for (let i = 0; i < index; i++) before += out[i]!;

  const target = ((pointerX - leftEdge) / totalWidth) * 100 - before;
  if (!Number.isFinite(target)) return out;
  return resizePair(out, index, Math.round(target) - out[index]!);
}

/** Round to whole percent and force the total back to 100 by fixing the widest
 *  column, so a drag never leaves 99 or 101 behind. */
export function normalizeTo100(widths: readonly number[]): number[] {
  const out = widths.map((w) => (Number.isFinite(w) ? Math.round(w) : 0));
  if (!out.length) return out;
  const sum = out.reduce((a, b) => a + b, 0);
  if (sum === 0) return equalWidths(out.length);
  const scale = 100 / sum;
  const scaled = out.map((w) => Math.round(w * scale));
  let drift = 100 - scaled.reduce((a, b) => a + b, 0);
  if (drift !== 0) {
    // Rounding can leave the total a point or two off. Putting the remainder in
    // the last column keeps the earlier ones at their floor value, so a list of
    // three is [33,33,34] rather than an arbitrary column winning the point.
    scaled[scaled.length - 1] = scaled[scaled.length - 1]! + drift;
  }
  return scaled;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure logic: adding / removing columns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Insert a column after `index`, splitting the widest column's width so the
 * total stays 100.
 *
 * `children` is the list of per-column child arrays, in order. The new column
 * starts empty; no child is moved, so nothing is orphaned.
 */
export function addColumn(
  widths: readonly number[],
  index: number,
): { widths: number[]; index: number } {
  const out = normalizeWidths(widths);
  if (out.length >= MAX_COLUMNS) return { widths: out, index: Math.min(Math.max(index, 0), out.length - 1) };

  const at = Math.min(Math.max(index + 1, 1), out.length);
  const min = minFor(out.length + 1);

  // Take width from the widest column that can spare it.
  let donor = 0;
  for (let i = 1; i < out.length; i++) if (out[i]! > out[donor]!) donor = i;
  const spare = out[donor]! - min;
  // Only refuse when no column can give up a single point.
  if (spare < 1) return { widths: out, index: at };
  const give = Math.min(spare, Math.round(out[donor]! / 2));
  out[donor] = out[donor]! - give;
  out.splice(at, 0, give);

  // `normalizeTo100` rescales, and a rescale can push a narrow column under the
  // floor, so the widths are re-distributed equally when that happens.
  const scaled = normalizeTo100(out);
  if (scaled.some((w) => w < min)) return { widths: equalWidths(scaled.length), index: at };
  return { widths: scaled, index: at };
}

/**
 * Remove the column at `index`.
 *
 * Its children are appended to the previous column (or to the next one when
 * removing the first), so nothing is orphaned. The removed column's width is
 * given to the neighbour that absorbed its children, keeping the total at 100.
 *
 * Refuses when only `MIN_COLUMNS` are left: a one-column list is not a layout,
 * and BlockNote's own repair dissolves it, which would fight our tree mapping.
 */
export function removeColumn(
  widths: readonly number[],
  children: readonly (readonly unknown[])[],
  index: number,
): { widths: number[]; children: unknown[][]; index: number } {
  const w = normalizeWidths(widths);
  const kids: unknown[][] = children.map((c) => [...c]);
  while (kids.length < w.length) kids.push([]);
  kids.length = w.length;

  if (!Number.isInteger(index) || index < 0 || index >= w.length) {
    return { widths: w, children: kids, index: Math.min(Math.max(index || 0, 0), w.length - 1) };
  }
  if (w.length <= MIN_COLUMNS) return { widths: w, children: kids, index };

  // Absorbing neighbour: previous, or next when removing the first column.
  const target = index === 0 ? 1 : index - 1;
  // Merge with the ORIGINAL indices, then splice: splicing first shifts the
  // absorber left and the merge lands on the wrong column (removing the first
  // column duplicated its own blocks). The blocks are concatenated in
  // left-to-right document order, so the page reads as it did before.
  const merged = target > index ? [...(kids[index] ?? []), ...(kids[target] ?? [])] : [...(kids[target] ?? []), ...(kids[index] ?? [])];
  kids[target] = merged;
  kids.splice(index, 1);

  const out = [...w];
  out[target] = out[target]! + out[index]!;
  out.splice(index, 1);

  const min = minFor(out.length);
  for (let i = 0; i < out.length; i++) if (out[i]! < min) out[i] = min;

  // The caret follows the blocks that moved, so it lands in the absorber — at
  // its position AFTER the splice, which is one left when it sat right of the gap.
  const landed = target > index ? target - 1 : target;
  return { widths: normalizeTo100(out), children: kids, index: Math.min(landed, out.length - 1) };
}

/**
 * Change the column count, keeping the columns that survive and re-distributing
 * widths equally.
 *
 * Growing appends empty columns; shrinking merges the trailing columns' children
 * into the last surviving one, so no child is dropped.
 */
export function setColumnCount(
  widths: readonly number[],
  children: readonly (readonly unknown[])[],
  count: number,
): { widths: number[]; children: unknown[][] } {
  const n = normalizeColumnCount(count);
  const kids: unknown[][] = children.map((c) => [...c]);
  while (kids.length < n) kids.push([]);

  if (kids.length > n) {
    const tail = kids.splice(n).flat();
    kids[n - 1] = [...(kids[n - 1] ?? []), ...tail];
  }

  return { widths: equalWidths(n), children: kids };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure logic: node-tree mapping
// ─────────────────────────────────────────────────────────────────────────────

/** The minimal shape of a node row these helpers need. Structurally compatible
 *  with `NodeTree` without importing it, so the tests run in Node. */
export interface ColumnNodeLike {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children?: ColumnNodeLike[];
}

/** Our `column_list` node → the BlockNote `columnList` shape. */
export function columnListNodeToBn(node: ColumnNodeLike): Record<string, unknown> {
  const columns = node.children ?? [];
  const widths = normalizeWidths(columns.map((c) => Number(c.props.ratio)));
  return {
    id: node.id,
    type: BN_COLUMN_LIST,
    props: {},
    children: columns.map((c, i) => columnNodeToBn(c, widths[i] ?? 0)),
  };
}

/** Our `column` node → the BlockNote `column` shape. */
export function columnNodeToBn(node: ColumnNodeLike, width: number): Record<string, unknown> {
  return {
    id: node.id,
    type: BN_COLUMN,
    props: { width: Math.round(width) },
    children: (node.children ?? []).map(childToBn),
  };
}

/**
 * A plain child of a column. `serialize.ts` owns the real conversion; this is
 * the shape the tests assert on, and the identity case for a node already in
 * BlockNote form.
 */
export function childToBn(node: ColumnNodeLike): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type,
    props: node.props,
    children: node.children ? node.children.map(childToBn) : [],
  };
}

/**
 * BlockNote `columnList` → our tree.
 *
 * `widths` are read back off each column's props, so the tree carries the
 * per-column ratio in `props.ratio` and the server stores it on the `column`
 * row — the layout survives a reload without a separate table.
 */
export function bnToColumnTree(bn: Record<string, unknown>): {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children: { id: string; type: string; props: Record<string, unknown>; children: unknown[] }[];
} {
  const columns = (bn.children ?? []) as Record<string, unknown>[];
  const kids = columns.map((c) => ({
    id: String(c.id),
    type: COLUMN_TYPE,
    props: { ratio: Math.round(Number((c.props as Record<string, unknown>)?.width ?? 0)) },
    children: ((c.children ?? []) as Record<string, unknown>[]).map(bnToChild),
  }));
  return {
    id: String(bn.id),
    type: COLUMN_LIST_TYPE,
    props: {},
    children: kids,
  };
}

function bnToChild(bn: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(bn.id),
    type: String(bn.type),
    props: (bn.props ?? {}) as Record<string, unknown>,
    children: ((bn.children ?? []) as Record<string, unknown>[]).map(bnToChild),
  };
}

/**
 * The widths a column list should be saved with, read from its columns.
 *
 * Missing, zero and non-numeric ratios are treated as absent, so a list whose
 * columns were created without widths falls back to equal widths.
 */
export function widthsFromColumns(columns: readonly ColumnNodeLike[]): number[] {
  if (!columns.length) return equalWidths(MIN_COLUMNS);
  const raw = columns.map((c) => {
    const n = Number(c.props.ratio);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  });
  if (raw.some((w) => w === 0)) return equalWidths(columns.length);
  if (raw.reduce((a, b) => a + b, 0) !== 100) return equalWidths(columns.length);
  return raw;
}

/**
 * Flatten a column list's rows for the `parent_id` + `pos` store.
 *
 * Returns `[nodeId, parentId]` pairs in document order: the columns hang off
 * the list, and each column's children hang off the column — and a child of one
 * of those children hangs off *it*, at any depth. `serialize.ts` stamps `pos`
 * from the index, so this only has to get the parents right.
 */
export function columnListParentPairs(node: ColumnNodeLike): [string, string][] {
  const out: [string, string][] = [];
  const walk = (parent: ColumnNodeLike): void => {
    for (const kid of parent.children ?? []) {
      out.push([kid.id, parent.id]);
      walk(kid);
    }
  };
  walk(node);
  return out;
}

/**
 * The ids a column list owns, transitively. Used to tell "this row belongs to
 * the layout" from "this row is a top-level block", which is what keeps cell
 * children from being promoted to the page root.
 */
export function columnListDescendantIds(node: ColumnNodeLike): Set<string> {
  const ids = new Set<string>();
  for (const col of node.children ?? []) {
    ids.add(col.id);
    const walk = (n: ColumnNodeLike): void => {
      for (const kid of n.children ?? []) {
        ids.add(kid.id);
        walk(kid);
      }
    };
    walk(col);
  }
  return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor plumbing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A block, seen structurally.
 *
 * The default `Block` type is parameterised by the schema, so `props.width` and
 * `type === "column"` are rejected for blocks the schema does not declare.
 * Columns are exactly those blocks, so this module reads them structurally.
 */
type AnyBlock = {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: unknown;
  children?: AnyBlock[];
};

/** The columns of a column list, in order. */
export function columnsOf(block: AnyBlock | undefined): AnyBlock[] {
  if (!block) return [];
  return (block.children ?? []).filter((c) => c.type === BN_COLUMN);
}

/**
 * The column that follows `columnId` in its list, wrapping to the first.
 * `Tab` between columns uses this; returns `undefined` when there is nowhere to
 * go, so the caller leaves the key to BlockNote.
 */
export function nextColumnId(editor: BlockNoteEditor<any, any, any>, columnId: string): string | undefined {
  const column = editor.getBlock(columnId) as AnyBlock | undefined;
  if (!column) return undefined;
  const list = editor.getParentBlock(columnId) as AnyBlock | undefined;
  if (!list || list.type !== BN_COLUMN_LIST) return undefined;
  const cols = columnsOf(list);
  const at = cols.findIndex((c) => c.id === columnId);
  if (at < 0 || cols.length < 2) return undefined;
  return cols[(at + 1) % cols.length]!.id;
}

/** The column before `columnId`, wrapping to the last. */
export function prevColumnId(editor: BlockNoteEditor<any, any, any>, columnId: string): string | undefined {
  const list = editor.getParentBlock(columnId) as AnyBlock | undefined;
  if (!list || list.type !== BN_COLUMN_LIST) return undefined;
  const cols = columnsOf(list);
  const at = cols.findIndex((c) => c.id === columnId);
  if (at < 0 || cols.length < 2) return undefined;
  return cols[(at - 1 + cols.length) % cols.length]!.id;
}

/**
 * Move the caret into `columnId`: to the start of its first leaf block.
 *
 * A layout block has no content of its own, so `setTextCursorPosition` on the
 * column resolves through its children (core's `blockEdgeSelection` does exactly
 * this for a container).
 */
export function focusColumn(editor: BlockNoteEditor<any, any, any>, columnId: string): void {
  try {
    editor.setTextCursorPosition(columnId, "start");
  } catch {
    // An empty column has no caret position; focus is best-effort.
  }
}

/**
 * Set one column's stored width.
 *
 * `updateBlock` on a layout block replaces its props, so the width is the only
 * key written and the children are left alone.
 */
export function setColumnWidth(editor: BlockNoteEditor<any, any, any>, columnId: string, width: number): void {
  const w = Math.round(width);
  if (!Number.isFinite(w)) return;
  try {
    editor.updateBlock(columnId, { props: { width: w } } as never);
  } catch {
    // The column may have been deleted mid-drag.
  }
}

/**
 * Replace a column list's whole prop set in one transaction, so a drag that
 * moves two widths writes one undo step and one save.
 */
export function setColumnWidths(
  editor: BlockNoteEditor<any, any, any>,
  columns: readonly AnyBlock[],
  widths: readonly number[],
): void {
  editor.transact(() => {
    columns.forEach((col, i) => {
      const w = Math.round(widths[i] ?? 0);
      if (!Number.isFinite(w)) return;
      if (Math.round(Number(col.props.width) || 0) === w) return;
      try {
        editor.updateBlock(col.id, { props: { width: w } } as never);
      } catch {
        /* the column may have been deleted mid-drag */
      }
    });
  });
}

/**
 * Add a column after `index`.
 *
 * The new column is inserted as a child of the list, and the widths of all the
 * columns are rewritten from `addColumn` so the total stays 100.
 */
export function insertColumn(
  editor: BlockNoteEditor<any, any, any>,
  listId: string,
  index: number,
): string | undefined {
  const list = editor.getBlock(listId) as AnyBlock | undefined;
  const cols = columnsOf(list);
  const widths = cols.map((c) => Number(c.props.width) || 0);
  const next = addColumn(widths, index);
  if (next.widths.length === widths.length) return undefined;

  const anchor = cols[Math.min(Math.max(index, 0), cols.length - 1)];
  if (!anchor) return undefined;

  let newId: string | undefined;
  editor.transact(() => {
    const inserted = editor.insertBlocks(
      [
        {
          type: BN_COLUMN,
          props: { width: next.widths[next.index] },
          children: [{ type: "paragraph" }],
        },
      ] as never,
      anchor.id,
      "after",
    ) as AnyBlock[];
    newId = inserted[0]?.id;
    // Re-read the columns: the insert changed the list, and the widths of the
    // survivors have to move to make room for the newcomer.
    const now = columnsOf(editor.getBlock(listId) as AnyBlock | undefined);
    now.forEach((col, i) => {
      const w = next.widths[i];
      if (w === undefined || col.id === newId) return;
      if (Math.round(Number(col.props.width) || 0) === w) return;
      try {
        editor.updateBlock(col.id, { props: { width: w } } as never);
      } catch {
        /* gone */
      }
    });
  });
  return newId;
}

/**
 * Remove the column at `index`, merging its children into the previous column
 * (the next one when removing the first) so nothing is orphaned.
 */
export function deleteColumn(editor: BlockNoteEditor<any, any, any>, listId: string, index: number): void {
  const list = editor.getBlock(listId) as AnyBlock | undefined;
  const cols = columnsOf(list);
  if (cols.length <= MIN_COLUMNS) return;
  const victim = cols[index];
  if (!victim) return;

  const target = cols[index === 0 ? 1 : index - 1];
  if (!target) return;

  const moved = victim.children ?? [];
  const widths = cols.map((c) => Number(c.props.width) || 0);
  const next = removeColumn(widths, cols.map((c) => c.children ?? []), index);

  editor.transact(() => {
    if (moved.length) {
      editor.insertBlocks(
        moved.map((b) => ({
          type: b.type,
          props: b.props,
          content: b.content,
          children: b.children,
        })) as never,
        target.id,
        "last-child",
      );
    }
    editor.removeBlocks([victim.id]);
    const survivors = cols.filter((_, i) => i !== index);
    survivors.forEach((col, i) => {
      const w = next.widths[i];
      if (w !== undefined) {
        try {
          editor.updateBlock(col.id, { props: { width: w } } as never);
        } catch {
          /* gone */
        }
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

/** Inline styles, so the feature needs no edit of `src/styles.css`. The class
 *  names are there for anyone who wants to theme it later. */
const css = {
  row: "sn-columns",
  col: "sn-column",
  divider: "sn-column-divider",
  controls: "sn-column-controls",
  btn: "sn-btn sn-btn-ghost sn-btn-sm",
} as const;

function chromeStyle(): React.CSSProperties {
  return {
    background: "none",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-sm)",
    color: "var(--text-secondary)",
    cursor: "pointer",
    fontSize: "var(--text-xs)",
    lineHeight: 1,
    padding: "2px 5px",
  };
}

/**
 * The divider between two columns.
 *
 * It is frame chrome — outside `slotRef` — so ProseMirror leaves its pointer
 * events alone (core's `isFrameChromeEvent`). The drag writes the widths once,
 * on pointerup, through `setColumnWidths`, so a drag is one undo step.
 */
function ColumnDivider(props: {
  index: number;
  widths: number[];
  rowRef: { current: HTMLElement | null };
  onCommit: (index: number, widths: number[]) => void;
}): ReactNode {
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<number[] | null>(null);
  const start = useRef<{ x: number; widths: number[] } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      start.current = { x: e.clientX, widths: [...props.widths] };
      setDragging(true);
    },
    [props.widths],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const base = start.current;
      const row = props.rowRef.current;
      if (!base || !row) return;
      const rect = row.getBoundingClientRect();
      const delta = ((e.clientX - base.x) / rect.width) * 100;
      setPreview(resizePair(base.widths, props.index, Math.round(delta)));
    },
    [props.index, props.rowRef],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const base = start.current;
      const row = props.rowRef.current;
      start.current = null;
      setDragging(false);
      if (!base || !row) {
        setPreview(null);
        return;
      }
      const rect = row.getBoundingClientRect();
      const delta = ((e.clientX - base.x) / rect.width) * 100;
      const next = resizePair(base.widths, props.index, Math.round(delta));
      setPreview(null);
      props.onCommit(props.index, next);
    },
    [props.index, props.onCommit, props.rowRef],
  );

  const shown = preview ?? props.widths;
  let before = 0;
  for (let i = 0; i < props.index; i++) before += shown[i] ?? 0;
  const left = before + (shown[props.index] ?? 0);

  return createElement("div", {
    className: css.divider,
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "Resize columns",
    tabIndex: 0,
    onPointerDown,
    onPointerMove: dragging ? onPointerMove : undefined,
    onPointerUp,
    onPointerCancel: () => {
      start.current = null;
      setDragging(false);
      setPreview(null);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 10 : 2;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        props.onCommit(props.index, resizePair(props.widths, props.index, -step));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        props.onCommit(props.index, resizePair(props.widths, props.index, step));
      }
    },
    style: {
      position: "absolute",
      top: 0,
      bottom: 0,
      left: `calc(${left}% - 5px)`,
      width: 11,
      cursor: "col-resize",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      touchAction: "none",
      zIndex: 2,
    },
  },
    createElement("div", {
      style: {
        width: 2,
        height: "60%",
        borderRadius: "var(--radius-full)",
        background: dragging ? "var(--accent-highlight)" : "var(--border-strong)",
      },
    }),
  );
}

/**
 * `column_list` — a layout block whose children are `column` blocks.
 *
 * `renderFrame` draws the flex row, the dividers, and the add/remove controls;
 * `slotRef` is where BlockNote mounts the columns' own frames. The columns are
 * laid out by the CSS on `.sn-column` (`flex-basis: <width>%`), which the
 * column's own frame sets from its `width` prop — the list does not position
 * them, so a width change needs no reflow of the list.
 */
export const columnListBlock = createReactBlockSpec(
  {
    type: BN_COLUMN_LIST,
    propSchema: {},
    content: "none",
    layoutOnly: true,
    children: { allow: [BN_COLUMN], min: 2 },
  },
  {
    renderFrame: ({ block, editor, slotRef }) => {
      const list = block as AnyBlock;
      const rowRef = useRef<HTMLDivElement | null>(null);
      const [tick, setTick] = useState(0);

      // The frame is rebuilt when the block's own props change, not when its
      // children do, so subscribe to keep the divider positions honest.
      useEffect(() => {
        const off = editor.onChange(() => setTick((t) => t + 1));
        return () => {
          off();
        };
      }, [editor]);
      void tick;

      const cols = columnsOf(list);
      const widths = normalizeWidths(cols.map((c) => Number(c.props.width) || 0));

      const commit = useCallback(
        (index: number, next: number[]) => {
          setColumnWidths(editor, cols, next);
          void index;
        },
        [editor, cols],
      );

      const slot = (el: HTMLDivElement | null): void => {
        rowRef.current = el;
        slotRef(el);
      };

      return createElement(
        "div",
        {
          className: css.row,
          "data-count": widths.length,
          style: { position: "relative", display: "flex", alignItems: "flex-start" },
        },
        createElement("div", {
          ref: slot,
          className: "sn-columns-slot",
          style: { display: "flex", alignItems: "flex-start", width: "100%" },
        }),
        // One divider per gap, positioned from the widths.
        widths.slice(0, -1).map((_, i) =>
          createElement(ColumnDivider, {
            key: `div-${i}`,
            index: i,
            widths,
            rowRef,
            onCommit: commit,
          }),
        ),
        // Add / remove live in the frame chrome, not in the document.
        createElement(
          "div",
          {
            className: css.controls,
            contentEditable: false,
            style: {
              position: "absolute",
              top: -18,
              right: 0,
              display: "flex",
              gap: 2,
              opacity: 0.55,
            },
          },
          widths.length < MAX_COLUMNS
            ? createElement(
                "button",
                {
                  type: "button",
                  title: "Add a column",
                  className: css.btn,
                  style: chromeStyle(),
                  onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
                  onClick: () => insertColumn(editor, list.id, widths.length - 1),
                },
                "+ column",
              )
            : null,
          widths.length > MIN_COLUMNS
            ? createElement(
                "button",
                {
                  type: "button",
                  title: "Remove the last column, merging its blocks into the one before",
                  className: css.btn,
                  style: chromeStyle(),
                  onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
                  onClick: () => deleteColumn(editor, list.id, widths.length - 1),
                },
                "− column",
              )
            : null,
        ),
      );
    },
  },
);

/**
 * `column` — a layout block holding ordinary blocks.
 *
 * `placeable: "namedOnly"` is what keeps it out of the top level; the list names
 * it in `children.allow`. Its width is a prop, so it round-trips through the
 * node row.
 */
export const columnBlock = createReactBlockSpec(
  {
    type: BN_COLUMN,
    propSchema: {
      /** percentage of the parent column_list, 0-100 */
      width: { default: 50 },
    },
    content: "none",
    layoutOnly: true,
    placeable: "namedOnly",
    children: { allow: "blocks", exclude: [BN_COLUMN_LIST] },
  },
  {
    renderFrame: ({ block, editor, slotRef }) => {
      const col = block as AnyBlock;
      const width = Math.max(minFor(2), Math.round(Number(col.props.width) || 0));

      return createElement(
        "div",
        {
          className: css.col,
          "data-width": width,
          style: {
            flex: `0 1 ${width}%`,
            width: `${width}%`,
            minWidth: 0,
            boxSizing: "border-box",
            padding: "0 10px",
          },
          onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
            if (e.key !== "Tab") return;
            const target = e.shiftKey ? prevColumnId(editor, col.id) : nextColumnId(editor, col.id);
            if (!target) return;
            e.preventDefault();
            focusColumn(editor, target);
          },
        },
        createElement("div", { ref: slotRef, style: { minWidth: 0 } }),
      );
    },
  },
);

/**
 * `createReactBlockSpec` returns a FACTORY in 0.57 — these must be CALLED.
 * Passing the factories through raw builds a schema whose block configs are
 * functions, and the editor dies during init.
 */
export const columnBlockSpecs = {
  columnList: columnListBlock(),
  column: columnBlock(),
};
