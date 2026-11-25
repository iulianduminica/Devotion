/**
 * Custom BlockNote blocks.
 *
 * BlockNote 0.57 ships these defaults (verified against the installed package):
 *   paragraph, heading(level), bulletListItem, numberedListItem, checkListItem,
 *   toggleListItem, quote, codeBlock, divider, image, file, audio, video, table
 * — which covers most of Notion's text set. It ships NO callout, latex,
 * bookmark, page link, or database block, so those are defined here.
 *
 * NOT IMPLEMENTED (documented, not silently dropped): multi-column layout
 * (column_list / column). In 0.57 a block that contains other blocks goes
 * through the nodeArray + cell-render path (as `table` does), which is a
 * substantially larger integration than the rest of the editor. Shipping it
 * half-working would risk the editor for every other block, so it is deferred.
 */

import { createElement, type ReactNode } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import type { Block } from "@blocknote/core";
import katex from "katex";

import { columnBlockSpecs } from "./columns.tsx";
import { tocBlockSpec } from "./toc.tsx";

// ─────────────────────────────────────────────────────────────────────────────
// App hooks injected by the shell (blocks are module-scope, so they cannot
// import the router or the database component directly).
// ─────────────────────────────────────────────────────────────────────────────

type NavigateFn = (nodeId: string) => void;
type DatabaseRenderer = (props: { databaseId: string; nodeId: string }) => ReactNode;
type PageTitleResolver = (nodeId: string) => { title: string; icon?: string } | undefined;
type PickerFn = (nodeId: string, kind: "icon" | "cover") => void;
type RequestPickerFn = (nodeId: string, kind: "icon" | "cover") => void;

let navigate: NavigateFn = () => {};
let renderDatabase: DatabaseRenderer = () => null;
let resolveTitle: PageTitleResolver = () => undefined;
let openPicker: PickerFn = () => {};
/** set by the shell: lets app chrome (not just blocks) open the same picker */
let requestPicker: RequestPickerFn = () => {};

export const editorHost = {
  setNavigate(fn: NavigateFn): void {
    navigate = fn;
  },
  setDatabaseRenderer(fn: DatabaseRenderer): void {
    renderDatabase = fn;
  },
  setPageTitleResolver(fn: PageTitleResolver): void {
    resolveTitle = fn;
  },
  setPicker(fn: PickerFn): void {
    openPicker = fn;
  },
  /** Register the function the app uses to open the picker. */
  registerPicker(fn: RequestPickerFn): void {
    requestPicker = fn;
  },
  /** Ask the shell to open the icon/cover picker for a node. */
  pick(nodeId: string, kind: "icon" | "cover" = "icon"): void {
    requestPicker(nodeId, kind);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Callout
// ─────────────────────────────────────────────────────────────────────────────

export const calloutBlock = createReactBlockSpec(
  {
    type: "callout",
    propSchema: {
      icon: { default: "💡" },
      color: {
        default: "gray_background",
        values: [
          "default",
          "gray_background",
          "brown_background",
          "orange_background",
          "yellow_background",
          "green_background",
          "blue_background",
          "purple_background",
          "pink_background",
          "red_background",
        ] as const,
      },
    },
    content: "inline",
  },
  {
    render: ({ block, contentRef, editor }) =>
      createElement(
        "div",
        {
          className: "sn-callout",
          "data-color": block.props.color,
          style: {
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            padding: "16px 14px",
            borderRadius: 6,
            background: block.props.color === "default" ? "var(--sn-bg-2)" : `var(--sn-tint-${block.props.color})`,
          },
        },
        createElement(
          "button",
          {
            type: "button",
            className: "sn-callout-icon",
            contentEditable: false,
            title: "Change icon",
            onClick: () => openPicker(block.id, "icon"),
            style: { fontSize: 20, lineHeight: 1, background: "none", border: "none", cursor: "pointer" },
          },
          block.props.icon || "💡",
        ),
        createElement(
          "div",
          {
            ref: contentRef,
            className: "sn-callout-content",
            style: { flex: 1, minWidth: 0, outline: "none" },
          },
          "",
        ),
      ),
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// LaTeX
// ─────────────────────────────────────────────────────────────────────────────

export const latexBlock = createReactBlockSpec(
  {
    type: "latex",
    propSchema: {
      latex: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block }) => {
      const src = block.props.latex as string;
      let html = "";
      let failed = false;
      if (src.trim()) {
        try {
          html = katex.renderToString(src, { throwOnError: false, displayMode: true });
        } catch {
          failed = true;
        }
      }
      return createElement(
        "div",
        {
          className: "sn-latex",
          contentEditable: false,
          style: { padding: "8px 0", overflowX: "auto" },
        },
        src.trim() && !failed
          ? createElement("div", {
              dangerouslySetInnerHTML: { __html: html },
            })
          : createElement(
              "div",
              { className: "sn-latex-empty" },
              src.trim() ? `Invalid LaTeX: ${src}` : "Empty equation",
            ),
      );
    },
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Bookmark / link preview
// ─────────────────────────────────────────────────────────────────────────────

export const bookmarkBlock = createReactBlockSpec(
  {
    type: "bookmark",
    propSchema: {
      url: { default: "" },
      caption: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block }) => {
      const url = block.props.url as string;
      const host = (() => {
        try {
          return new URL(url).hostname.replace(/^www\./, "");
        } catch {
          return url;
        }
      })();
      return createElement(
        "a",
        {
          className: "sn-bookmark",
          href: url || "#",
          target: "_blank",
          rel: "noreferrer noopener",
          contentEditable: false,
          style: {
            display: "block",
            border: "1px solid var(--sn-border)",
            borderRadius: 6,
            padding: "12px 14px",
            textDecoration: "none",
            color: "inherit",
          },
        },
        createElement("div", { style: { fontWeight: 600 } }, block.props.caption || host || "Bookmark"),
        createElement("div", { style: { fontSize: 12, opacity: 0.65, marginTop: 2 } }, url),
      );
    },
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Child page — a link block. Its content is edited on its own page, matching
// Notion; keeping it out of the parent's editor keeps the SQL tree flat.
// ─────────────────────────────────────────────────────────────────────────────

export const childPageBlock = createReactBlockSpec(
  {
    type: "childPage",
    propSchema: {
      icon: { default: "" },
    },
    content: "inline",
  },
  {
    render: ({ block, contentRef }) => {
      const info = resolveTitle(block.id);
      const icon = (block.props.icon as string) || info?.icon || "📄";
      return createElement(
        "div",
        { className: "sn-child-page", style: { display: "flex", alignItems: "center", gap: 6 } },
        createElement(
          "button",
          {
            type: "button",
            className: "sn-child-page-icon",
            contentEditable: false,
            onClick: () => openPicker(block.id, "icon"),
            style: { background: "none", border: "none", cursor: "pointer", fontSize: 18 },
          },
          icon,
        ),
        createElement(
          "span",
          {
            ref: contentRef,
            className: "sn-child-page-title",
            style: { flex: 1, minWidth: 0, outline: "none", fontWeight: 500 },
          },
          "",
        ),
        createElement(
          "button",
          {
            type: "button",
            contentEditable: false,
            title: "Open page",
            onClick: () => navigate(block.id),
            style: {
              background: "none",
              border: "none",
              cursor: "pointer",
              opacity: 0.5,
              fontSize: 12,
              padding: "2px 6px",
            },
          },
          "↗",
        ),
      );
    },
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Child database — renders the view component the shell registered.
// ─────────────────────────────────────────────────────────────────────────────

export const childDatabaseBlock = createReactBlockSpec(
  {
    type: "childDatabase",
    propSchema: {
      databaseId: { default: "" },
    },
    content: "inline",
  },
  {
    render: ({ block, contentRef }) =>
      createElement(
        "div",
        { className: "sn-child-database" },
        createElement(
          "div",
          {
            ref: contentRef,
            className: "sn-child-database-title",
            style: { fontWeight: 600, marginBottom: 6, outline: "none" },
          },
          "",
        ),
        block.props.databaseId
          ? renderDatabase({ databaseId: String(block.props.databaseId), nodeId: block.id })
          : createElement("div", { className: "sn-muted" }, "Loading database…"),
      ),
  },
);

// ─────────────────────────────────────────────────────────────────────────────

/**
 * `createReactBlockSpec` returns a FACTORY (`(options?) => BlockSpec`) in 0.57,
 * so these are called. Passing the factories through raw builds a schema whose
 * block configs are functions, and the editor dies during init.
 */
export const customBlockSpecs = {
  callout: calloutBlock(),
  latex: latexBlock(),
  bookmark: bookmarkBlock(),
  childPage: childPageBlock(),
  childDatabase: childDatabaseBlock(),
  // columns/toc are already factories called in their own modules
  columnList: columnBlockSpecs.columnList,
  column: columnBlockSpecs.column,
  toc: tocBlockSpec,
};

/** BlockNote block → our node type, for the slash-menu / type menu labels. */
export const BLOCK_LABELS: Record<string, string> = {
  paragraph: "Text",
  heading: "Heading",
  bulletListItem: "Bulleted list",
  numberedListItem: "Numbered list",
  checkListItem: "To-do",
  toggleListItem: "Toggle",
  quote: "Quote",
  codeBlock: "Code",
  divider: "Divider",
  callout: "Callout",
  latex: "Equation",
  bookmark: "Bookmark",
  image: "Image",
  file: "File",
  audio: "Audio",
  video: "Video",
  table: "Table",
  childPage: "Page",
  childDatabase: "Database",
  columnList: "Columns",
  column: "Column",
  toc: "Table of contents",
};

export type AnyBlock = Block;
