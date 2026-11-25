/**
 * Table of contents.
 *
 * A `toc` block has no content of its own and stores nothing: the outline is
 * read from the live document at render time, so headings added elsewhere show
 * up without a save round-trip. That is why the block's props are empty and
 * `serialize.ts` maps it to a body-less row.
 *
 * `"toc"` is NOT in `shared/types.ts`'s `BlockType`. This module exports
 * `TOC_BLOCK_TYPE` instead of editing that file — add `"toc"` to `BlockType`
 * yourself.
 */

import { createElement, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import type { Block, BlockNoteEditor } from "@blocknote/core";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** The node.type / BlockNote type for this block. Add `"toc"` to `BlockType`. */
export const TOC_BLOCK_TYPE = "toc";

/** BlockNote's heading block carries its level in a prop. */
export const HEADING_BN_TYPE = "heading";

/** Which heading levels the outline shows. */
export const TOC_LEVELS: readonly number[] = [1, 2, 3];

// ─────────────────────────────────────────────────────────────────────────────
// Pure logic — testable in Node
// ─────────────────────────────────────────────────────────────────────────────

/** The shape of a block these helpers need; structurally compatible with Block. */
export interface HeadingSource {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: HeadingSource[];
}

export interface TocEntry {
  id: string;
  level: number;
  text: string;
}

/**
 * Flatten a block tree depth-first, in document order.
 *
 * `editor.blocks` / `editor.document` are the top level only, and a heading
 * inside a column is a child of the column, so the outline has to walk. The
 * walk is pre-order (the block, then its children), which is the reading order
 * a table of contents needs.
 */
export function walkBlocks(blocks: readonly HeadingSource[], out: HeadingSource[] = []): HeadingSource[] {
  for (const b of blocks) {
    out.push(b);
    if (b.children?.length) walkBlocks(b.children, out);
  }
  return out;
}

/**
 * Turn BlockNote's inline content into plain text.
 *
 * A heading's content is an array of runs; a link run nests its own text, so
 * both shapes are handled. `null` / `undefined` content yields "".
 */
export function inlineContentToText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const node = item as { type?: string; text?: string; content?: unknown };
    if (node.type === "link") {
      out += inlineContentToText(node.content);
      continue;
    }
    if (typeof node.text === "string") out += node.text;
  }
  return out;
}

/** The heading level of a block, or `undefined` when it is not a heading. */
export function headingLevelOf(block: HeadingSource): number | undefined {
  if (block.type !== HEADING_BN_TYPE) return undefined;
  const raw = block.props?.level;
  const level = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(level) && level >= 1 && level <= 6 ? Math.round(level) : 1;
}

/**
 * The outline: every heading at a level in `levels`, in document order.
 *
 * Headings with no text are skipped — an empty heading is a placeholder, not a
 * section, and an outline full of blank rows is worse than a short one.
 */
export function collectHeadings(
  blocks: readonly HeadingSource[],
  levels: readonly number[] = TOC_LEVELS,
): TocEntry[] {
  const wanted = new Set(levels);
  const out: TocEntry[] = [];
  for (const b of walkBlocks(blocks)) {
    const level = headingLevelOf(b);
    if (level === undefined || !wanted.has(level)) continue;
    const text = inlineContentToText(b.content).trim();
    if (!text) continue;
    out.push({ id: b.id, level, text });
  }
  return out;
}

/**
 * The indent for an entry, relative to the shallowest level present.
 *
 * A page that starts at `heading_2` should not be indented as if it were a
 * subsection of nothing, so the top of the outline is always flush.
 */
export function tocIndent(entry: TocEntry, entries: readonly TocEntry[]): number {
  if (!entries.length) return 0;
  let top = entries[0]!.level;
  for (const e of entries) if (e.level < top) top = e.level;
  return Math.max(0, entry.level - top);
}

/**
 * The id of the entry the outline is "on": the last one at or above the caret.
 *
 * `currentId` is the block the caret is in, `order` maps every block id to its
 * document position. Returns `undefined` when the caret is above the first
 * heading, so the caller highlights nothing.
 */
export function activeEntry(
  entries: readonly TocEntry[],
  order: ReadonlyMap<string, number>,
  currentId: string | undefined,
): TocEntry | undefined {
  if (!entries.length || !currentId) return undefined;
  const at = order.get(currentId);
  if (at === undefined) return undefined;
  let hit: TocEntry | undefined;
  for (const e of entries) {
    const pos = order.get(e.id);
    if (pos === undefined) continue;
    if (pos <= at) hit = e;
    else break;
  }
  return hit;
}

/** Document order for every block id, from a flattened list. */
export function orderMap(blocks: readonly HeadingSource[]): Map<string, number> {
  const flat = walkBlocks(blocks);
  const out = new Map<string, number>();
  flat.forEach((b, i) => out.set(b.id, i));
  return out;
}

/**
 * Scroll to a heading.
 *
 * BlockNote stamps each block's DOM with `data-id`, so the element is found
 * without a ProseMirror position. `blockElementFor` is injectable so this file
 * can be tested without a DOM.
 */
export function scrollToBlock(
  id: string,
  find: (id: string) => Element | null | undefined = defaultFind,
): boolean {
  const el = find(id);
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

function defaultFind(id: string): Element | null {
  if (typeof document === "undefined") return null;
  // The attribute selector needs the id quoted: it can contain anything BlockNote
  // generated, and an unquoted selector would throw on it.
  return document.querySelector(`[data-id="${cssEscape(id)}"]`);
}

/** Escape a value for use inside a CSS attribute selector. */
export function cssEscape(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (css?.escape) return css.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

// ─────────────────────────────────────────────────────────────────────────────
// The block
// ─────────────────────────────────────────────────────────────────────────────

/** Read the outline from a live editor. */
export function headingsFromEditor(
  editor: BlockNoteEditor<any, any, any>,
  levels: readonly number[] = TOC_LEVELS,
): TocEntry[] {
  try {
    return collectHeadings(editor.document as unknown as HeadingSource[], levels);
  } catch {
    // The editor may be mid-teardown when a subscription fires.
    return [];
  }
}

/**
 * `toc` — content mode `"none"`, so it carries no `contentRef` and no props.
 *
 * It subscribes with `editor.onChange` and re-reads the document on every
 * change; the block itself never writes, so it cannot dirty the page.
 */
export const tocBlock = createReactBlockSpec(
  {
    type: TOC_BLOCK_TYPE,
    propSchema: {},
    content: "none",
  },
  {
    render: ({ editor }) => {
      const [entries, setEntries] = useState<TocEntry[]>(() => headingsFromEditor(editor));
      const [order, setOrder] = useState<Map<string, number>>(() => orderMap(editor.document as unknown as HeadingSource[]));
      const [currentId, setCurrentId] = useState<string | undefined>(undefined);

      useEffect(() => {
        const refresh = (): void => {
          const blocks = editor.document as unknown as HeadingSource[];
          setEntries(collectHeadings(blocks));
          setOrder(orderMap(blocks));
        };
        const offChange = editor.onChange(refresh);
        const offSelect = editor.onSelectionChange(() => {
          refresh();
          setCurrentId(editor.getSelection()?.blocks[0]?.id);
        });
        refresh();
        return () => {
          offChange();
          offSelect();
        };
      }, [editor]);

      const jump = useCallback(
        (id: string) => {
          if (!scrollToBlock(id)) {
            // The heading is in the document but its DOM node is virtualised
            // away; focus is the fallback that always works.
            try {
              editor.setTextCursorPosition(id, "start");
            } catch {
              /* ignore */
            }
          }
        },
        [editor],
      );

      const active = useMemo(() => activeEntry(entries, order, currentId), [entries, order, currentId]);

      if (!entries.length) {
        return createElement(
          "div",
          { className: "sn-toc sn-toc-empty", contentEditable: false },
          createElement(
            "div",
            { className: "sn-toc-title" },
            "Table of contents",
          ),
          createElement(
            "div",
            { className: "sn-toc-muted" },
            "Add a heading to build an outline.",
          ),
        );
      }

      const list = entries.map((e): ReactNode =>
        createElement(
          "li",
          { key: e.id, style: { paddingLeft: `${tocIndent(e, entries) * 12}px` } },
          createElement(
            "button",
            {
              type: "button",
              className: "sn-toc-link",
              "data-active": active?.id === e.id ? "true" : undefined,
              "data-level": e.level,
              title: e.text,
              onClick: () => jump(e.id),
              style: {
                display: "block",
                width: "100%",
                textAlign: "left",
                background: "none",
                border: 0,
                cursor: "pointer",
                padding: "2px 0",
                font: "inherit",
                color: active?.id === e.id ? "var(--text-primary)" : "var(--text-secondary)",
                fontSize: e.level === 1 ? "var(--text-sm)" : "var(--text-xs)",
                fontWeight: e.level === 1 ? 600 : 400,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              },
            },
            e.text,
          ),
        ),
      );

      return createElement(
        "div",
        { className: "sn-toc", contentEditable: false },
        createElement("div", { className: "sn-toc-title" }, "Table of contents"),
        createElement(
          "ul",
          {
            className: "sn-toc-list",
            style: {
              listStyle: "none",
              margin: 0,
              padding: 0,
              borderLeft: "1px solid var(--border-default)",
            },
          },
          ...list,
        ),
      );
    },
  },
);

/**
 * `createReactBlockSpec` returns a FACTORY in 0.57 — this must be CALLED.
 */
export const tocBlockSpec = tocBlock();
