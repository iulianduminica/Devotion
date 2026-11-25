/**
 * Node rows ↔ BlockNote 0.57 blocks.
 *
 * Two deliberate choices:
 *
 * 1. Block type names differ from ours (BlockNote uses `bulletListItem`,
 *    `checkListItem`, `heading` with a `level` prop). A table maps them, so the
 *    database schema keeps Notion-style names and the editor keeps its own.
 *
 * 2. Links are stored FLATTENED in `node.body` as `{ ..., links: [{url, kind}] }`
 *    on the text run. BlockNote's native format nests text inside a `link`
 *    inline-content node; the SQL FTS trigger extracts `$.text` from each run,
 *    so nested text would be invisible to search. Flattening keeps search and
 *    backlink extraction correct, and this module converts both directions.
 */

import type { NodeTree } from "../../shared/types.ts";
import type { Block, PartialBlock } from "@blocknote/core";

export type BNContent = unknown[];

// ── type maps ────────────────────────────────────────────────────────────────

/** our node.type → BlockNote block type */
export const TO_BLOCKNOTE: Record<string, string> = {
  paragraph: "paragraph",
  heading_1: "heading",
  heading_2: "heading",
  heading_3: "heading",
  bulleted_list_item: "bulletListItem",
  numbered_list_item: "numberedListItem",
  to_do: "checkListItem",
  toggle: "toggleListItem",
  quote: "quote",
  divider: "divider",
  code: "codeBlock",
  image: "image",
  file: "file",
  audio: "audio",
  callout: "callout",
  latex: "latex",
  bookmark: "bookmark",
  child_page: "childPage",
  child_database: "childDatabase",
  column_list: "columnList",
  column: "column",
  toc: "toc",
  page: "paragraph",
  table_row: "paragraph",
};

/** BlockNote type (+ level) → our node.type */
export function fromBlockNote(bnType: string, props: Record<string, unknown>): string {
  switch (bnType) {
    case "heading": {
      const level = Number(props.level ?? 1);
      return level === 1 ? "heading_1" : level === 2 ? "heading_2" : "heading_3";
    }
    case "bulletListItem":
      return "bulleted_list_item";
    case "numberedListItem":
      return "numbered_list_item";
    case "checkListItem":
      return "to_do";
    case "toggleListItem":
      return "toggle";
    case "codeBlock":
      return "code";
    case "childPage":
      return "child_page";
    case "childDatabase":
      return "child_database";
    case "columnList":
      return "column_list";
    case "column":
      return "column";
    case "toc":
      return "toc";
    default:
      return bnType;
  }
}

// ── inline content ───────────────────────────────────────────────────────────

interface BNText {
  type: "text";
  text: string;
  styles: Record<string, unknown>;
}
interface BNLink {
  type: "link";
  href: string;
  content: BNText[];
}

const PAGE_PREFIX = "page:";

export function pageHref(nodeId: string): string {
  return `${PAGE_PREFIX}${nodeId}`;
}

export function isPageHref(href: string): boolean {
  return href.startsWith(PAGE_PREFIX);
}

/** BlockNote content → our flattened Body. */
export function toBody(content: BNContent | undefined | null): BodyLike[] {
  const out: BodyLike[] = [];
  for (const item of content ?? []) {
    const node = item as BNText | BNLink;
    if (node.type === "text") {
      out.push({
        type: "text",
        text: node.text,
        styles: normalizeStyles(node.styles ?? {}),
      });
      continue;
    }
    if (node.type === "link") {
      const href = node.href ?? "";
      const link = {
        url: isPageHref(href) ? href.slice(PAGE_PREFIX.length) : href,
        kind: (isPageHref(href) ? "page" : "url") as "page" | "url",
      };
      for (const inner of node.content ?? []) {
        out.push({
          type: "text",
          text: inner.text,
          styles: normalizeStyles(inner.styles ?? {}),
          links: [link],
          ...(link.kind === "page" ? { mention: link.url } : {}),
        });
      }
    }
  }
  if (!out.length) out.push({ type: "text", text: "", styles: {} });
  return out;

  function normalizeStyles(styles: Record<string, unknown>): Record<string, unknown> {
    const s: Record<string, unknown> = {};
    if (styles.bold) s.bold = true;
    if (styles.italic) s.italic = true;
    if (styles.underline) s.underline = true;
    if (styles.strike) s.strike = true;
    if (styles.code) s.code = true;
    if (styles.textColor && styles.textColor !== "default") s.color = styles.textColor;
    if (styles.backgroundColor && styles.backgroundColor !== "default") s.backgroundColor = styles.backgroundColor;
    return s;
  }
}

export interface BodyLike {
  type: "text";
  text: string;
  styles: Record<string, unknown>;
  links?: { url: string; kind: "page" | "url" }[];
  mention?: string;
  [key: string]: unknown;
}

/** Our flattened Body → BlockNote content (consecutive runs of the same link merge). */
export function toContent(body: BodyLike[] | undefined | null): BNContent {
  // Defensive: a code block's body is stored as plain text, and iterating a
  // string yields characters — which previously turned a saved code block into
  // one run per letter on reload.
  if (typeof body === "string") return toContent(fromPlainText(body));
  const out: BNContent = [];
  let bucket: { href: string; content: BNText[] } | null = null;

  const flush = (): void => {
    if (bucket && bucket.content.length) out.push({ type: "link", href: bucket.href, content: bucket.content });
    bucket = null;
  };

  for (const run of body ?? []) {
    const styles = denormalizeStyles(run.styles ?? {});
    const link = run.links?.[0] ?? (run.mention ? { url: run.mention, kind: "page" as const } : undefined);

    if (!link) {
      flush();
      out.push({ type: "text", text: run.text ?? "", styles });
      continue;
    }

    const href = link.kind === "page" ? pageHref(link.url) : link.url;
    if (!bucket || bucket.href !== href) {
      flush();
      bucket = { href, content: [] };
    }
    bucket.content.push({ type: "text", text: run.text ?? "", styles });
  }
  flush();

  if (!out.length) out.push({ type: "text", text: "", styles: {} });
  return out;

  function denormalizeStyles(styles: Record<string, unknown>): Record<string, unknown> {
    // BlockNote's block format is sparse: emit ONLY styles that are set.
    // Writing `code:false` / `textColor:"default"` explicitly produces an
    // "Invalid collection of marks" and the document fails to build.
    const out: Record<string, unknown> = {};
    if (styles.bold) out.bold = true;
    if (styles.italic) out.italic = true;
    if (styles.underline) out.underline = true;
    if (styles.strike) out.strike = true;
    if (styles.code) out.code = true;
    if (styles.color && styles.color !== "default") out.textColor = styles.color;
    if (styles.backgroundColor && styles.backgroundColor !== "default") out.backgroundColor = styles.backgroundColor;
    return out;
  }
}

// ── props ────────────────────────────────────────────────────────────────────

/** our props → BlockNote props */
export function toBnProps(type: string, props: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
    case "heading_1":
      return { level: 1, ...props };
    case "heading_2":
      return { level: 2, ...props };
    case "heading_3":
      return { level: 3, ...props };
    case "to_do":
      return { checked: !!props.checked };
    case "code":
      return { language: (props.language as string) ?? "Plain text" };
    case "image":
    case "file":
    case "audio":
      return {
        url: (props.url as string) ?? (props.mediaId ? `/media/${props.mediaId}` : ""),
        name: (props.name as string) ?? "",
        caption: (props.caption as string) ?? "",
        previewWidth: props.previewWidth as number | undefined,
      };
    case "callout":
      return { icon: (props.icon as string) ?? "💡", color: (props.color as string) ?? "gray_background" };
    case "latex":
      return { latex: (props.latex as string) ?? "" };
    case "bookmark":
      return { url: (props.url as string) ?? "", caption: (props.caption as string) ?? "" };
    case "child_page":
      return { icon: (props.icon as string) ?? "" };
    case "child_database":
      return { databaseId: (props.databaseId as string) ?? "" };
    default:
      return { ...props };
  }
}

/** BlockNote props → ours (drop defaults to keep rows small and diffs clean) */
export function fromBnProps(bnType: string, props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  switch (bnType) {
    case "checkListItem":
      if (props.checked) out.checked = true;
      break;
    case "codeBlock":
      if (props.language && props.language !== "Plain text") out.language = props.language;
      break;
    case "image":
    case "file":
    case "audio":
      if (props.url) out.url = props.url;
      if (props.name) out.name = props.name;
      if (props.caption) out.caption = props.caption;
      if (typeof props.previewWidth === "number") out.previewWidth = props.previewWidth;
      break;
    case "callout":
      if (props.icon && props.icon !== "💡") out.icon = props.icon;
      if (props.color && props.color !== "gray_background") out.color = props.color;
      break;
    case "latex":
      out.latex = props.latex ?? "";
      break;
    case "bookmark":
      out.url = props.url ?? "";
      if (props.caption) out.caption = props.caption;
      break;
    case "childPage":
      if (props.icon) out.icon = props.icon;
      break;
    case "childDatabase":
      out.databaseId = props.databaseId ?? "";
      break;
    default:
      break;
  }
  // preserve our own extras BlockNote does not model
  for (const key of ["mediaId", "databaseId", "ratio"] as const) {
    if (props[key] !== undefined) out[key] = props[key];
  }
  return out;
}

/**
 * BlockNote content modes, per block type. Passing the wrong shape is fatal —
 * `initialContent` throws "Error creating document from blocks" — so:
 *   "none"  → no content at all (divider, image, file, audio, latex, bookmark)
 *   "plain" → a plain string (codeBlock)
 *   "inline"→ an array of styled runs
 */
export const CONTENT_MODE: Record<string, "inline" | "none" | "plain"> = {
  divider: "none",
  image: "none",
  file: "none",
  audio: "none",
  video: "none",
  latex: "none",
  bookmark: "none",
  linkPreview: "none",
  columnList: "none",
  column: "none",
  toc: "none",
  codeBlock: "plain",
};

/** Build the `content` value BlockNote expects for this block type. */
export function contentForType(
  bnType: string,
  body: BodyLike[] | undefined | null,
): unknown {
  const mode = CONTENT_MODE[bnType] ?? "inline";
  if (mode === "none") return undefined;
  if (mode === "plain") {
    // codeBlock keeps its text in props._text so the round-trip preserves newlines
    const text = (body as unknown as { _text?: string } | null)?._text ?? toPlainText(body);
    return text;
  }
  return toContent(body);
}

export function toPlainText(body: BodyLike[] | undefined | null): string {
  return (body ?? []).map((r) => r.text ?? "").join("");
}

/** Plain text → the storage shape for a "plain" block (code). */
export function fromPlainText(text: string): BodyLike[] {
  return [{ type: "text", text, styles: {}, _text: text } as unknown as BodyLike];
}

/**
 * The `body` value to persist for a block, given its content mode.
 * BlockNote hands back a bare string for "plain" blocks (code); storing that
 * straight into node.body breaks the reload round-trip, so it is normalised.
 */
export function bodyForType(bnType: string, content: unknown): BodyLike[] | null {
  const mode = CONTENT_MODE[bnType] ?? "inline";
  if (mode === "none") return null;
  if (mode === "plain") return fromPlainText(typeof content === "string" ? content : toPlainText(content as BodyLike[]));
  return (content ?? []) as BodyLike[];
}

// ── block mapping ────────────────────────────────────────────────────────────

export interface FlatBlock {
  id: string;
  type: string;
  bnType: string;
  props: Record<string, unknown>;
  content: BNContent;
  parentId: string | null;
  pos: string;
  index: number;
}

/**
 * Which BlockNote types may carry child blocks. A spec accepts `children` only
 * if it declares a nodeArray prop; passing children to a block that does not
 * declare them makes document creation throw.
 *
 * childPage / childDatabase keep their content elsewhere (the page node and the
 * database rows), so their tree children are dropped, not promoted.
 */
const NESTING_TYPES = new Set([
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "toggleListItem",
  "columnList",
  "column",
  "table",
]);

const OPAQUE_TYPES = new Set(["childPage", "childDatabase"]);

function buildBlock(node: NodeTree, meta: Map<string, FlatBlock>): Record<string, unknown>[] {
  const bnType = TO_BLOCKNOTE[node.type] ?? "paragraph";

  meta.set(node.id, {
    id: node.id,
    type: node.type,
    bnType,
    props: node.props as Record<string, unknown>,
    content: (contentForType(bnType, node.body as unknown as BodyLike[]) ?? []) as unknown[],
    parentId: null,
    pos: node.pos,
    index: 0,
  });

  const self: Record<string, unknown> = {
    id: node.id,
    type: bnType,
    props: toBnProps(node.type, node.props as Record<string, unknown>),
  };
  const content = contentForType(bnType, node.body as unknown as BodyLike[]);
  if (content !== undefined) self.content = content;

  const kids = node.children ?? [];

  if (OPAQUE_TYPES.has(bnType)) return [self];

  if (NESTING_TYPES.has(bnType) && kids.length) {
    self.children = kids.flatMap((c) => buildBlock(c, meta));
    return [self];
  }

  if (!kids.length) return [self];

  // non-nesting block with children: emit it, then promote the children so
  // their content stays visible instead of becoming an invalid shape
  return [self, ...kids.flatMap((c) => buildBlock(c, meta))];
}

/** Tree → the flat list the editor consumes, plus the ordering metadata. */
export function treeToBlocks(tree: NodeTree | null): { blocks: PartialBlock[]; meta: Map<string, FlatBlock> } {
  const meta = new Map<string, FlatBlock>();
  const blocks: PartialBlock[] = [];

  if (tree) {
    for (const child of tree.children ?? []) {
      blocks.push(...(buildBlock(child, meta) as unknown as PartialBlock[]));
    }
  }

  // stamp parent/index for the diff, from the structure we actually produced
  const stamp = (list: readonly Record<string, unknown>[], parentId: string | null): void => {
    list.forEach((b, index) => {
      const m = meta.get(String(b.id));
      if (m) {
        m.parentId = parentId;
        m.index = index;
      }
      const kids = (b.children ?? []) as readonly Record<string, unknown>[];
      if (kids.length) stamp(kids, String(b.id));
    });
  };
  stamp(blocks as unknown as readonly Record<string, unknown>[], tree?.id ?? null);

  return { blocks, meta };
}

/**
 * Models answer in Markdown. Pasting that in as plain text leaves literal
 * `- ` bullets and `**` asterisks on the page, so AI output is converted into
 * real blocks first. Deliberately small: the subset a chat model emits.
 */
function inlineRuns(text: string): BNContent {
  const out: BNContent = [];
  const run = (t: string, styles: Record<string, unknown>): void => {
    out.push({ type: "text", text: t, styles } as unknown as BNContent[number]);
  };
  const re =
    /\*\*(?<b>[^*]+)\*\*|~~(?<s>[^~]+)~~|`(?<c>[^`]+)`|\*(?<i>[^*]+)\*|_(?<i2>[^_]+)_/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) run(text.slice(last, m.index), {});
    const g = m.groups ?? {};
    if (g.b) run(g.b, { bold: true });
    else if (g.s) run(g.s, { strike: true });
    else if (g.c) run(g.c, { code: true });
    else if (g.i) run(g.i, { italic: true });
    else if (g.i2) run(g.i2, { italic: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) run(text.slice(last), {});
  return out.length ? out : [{ type: "text", text: "", styles: {} } as unknown as BNContent[number]];
}

export function markdownToBnBlocks(text: string): PartialBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // built loosely, cast once at the return: PartialBlock's content union is
  // stricter than the shapes assembled here
  const blocks: Record<string, unknown>[] = [];
  let inCode = false;
  let codeLang = "";
  let codeLines: string[] = [];

  for (const raw of lines) {
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(raw);
    if (fence) {
      if (inCode) {
        blocks.push({ type: "codeBlock", props: { language: codeLang }, content: codeLines.join("\n") });
        codeLines = [];
        codeLang = "";
      }
      inCode = !inCode;
      if (inCode) codeLang = fence[1] ?? "";
      continue;
    }
    if (inCode) {
      codeLines.push(raw);
      continue;
    }

    const t = raw.trim();
    if (!t) continue;

    const h = /^(#{1,3})\s+(.*)$/.exec(t);
    if (h) {
      blocks.push({ type: "heading", props: { level: h[1]!.length }, content: inlineRuns(h[2]!) });
      continue;
    }
    const task = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(t);
    if (task) {
      blocks.push({ type: "checkListItem", props: { checked: task[1] !== " " }, content: inlineRuns(task[2]!) });
      continue;
    }
    const ul = /^[-*+]\s+(.*)$/.exec(t);
    if (ul) {
      blocks.push({ type: "bulletListItem", content: inlineRuns(ul[1]!) });
      continue;
    }
    const ol = /^\d+[.)]\s+(.*)$/.exec(t);
    if (ol) {
      blocks.push({ type: "numberedListItem", content: inlineRuns(ol[1]!) });
      continue;
    }
    const q = /^>\s?(.*)$/.exec(t);
    if (q) {
      blocks.push({ type: "quote", content: inlineRuns(q[1]!) });
      continue;
    }
    blocks.push({ type: "paragraph", content: inlineRuns(t) });
  }

  // an unterminated fence: keep the text rather than dropping it
  if (inCode && codeLines.length) {
    blocks.push({ type: "codeBlock", props: { language: codeLang }, content: codeLines.join("\n") });
  }

  return (blocks.length
    ? blocks
    : [{ type: "paragraph", content: inlineRuns(text.trim()) }]) as unknown as PartialBlock[];
}

/** Extract plain text from a BlockNote content array (for labels and previews). */
export function contentToText(content: BNContent | undefined | null): string {
  let out = "";
  for (const item of content ?? []) {
    const node = item as BNText | BNLink;
    if (node.type === "text") out += node.text;
    else if (node.type === "link") out += (node.content ?? []).map((t) => t.text).join("");
  }
  return out;
}

export type { Block };
