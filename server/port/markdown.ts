/**
 * Markdown ↔ blocks. Hand-written, dependency-free: no remark, no unified, no
 * marked. The importer is a line scanner plus a small inline parser; the
 * exporter is the inverse and is written to be the importer's canonical syntax,
 * so `md → blocks → md` is byte-identical for everything supported.
 *
 * Supported constructs are listed in `server/port/README.md`, together with the
 * markdown that is deliberately NOT supported.
 */

import {
  plainTextToBody,
  type BlockType,
  type Body,
  type Inline,
  type InlineLink,
  type InlineStyles,
  type PropertyValueInput,
} from "../../shared/types.ts";
import {
  asTableData,
  block,
  blockText,
  bodyText,
  databaseToTableData,
  detectLeadingEmoji,
  mergeInlines,
  TABLE_PROPS_KEY,
  textInline,
  type ImportResult,
  type ParsedBlock,
  type ParsedDatabase,
  type ParsedProperty,
} from "./blocks.ts";
import { cellToValue, inferPropertyType } from "./csv.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface MarkdownOptions {
  /** columns a leading tab occupies when measuring nesting (default 4) */
  tabsWidth?: number;
}

export interface ImportOptions extends MarkdownOptions {
  /**
   * Turn a resolved relative link path into a stable page key. Used by
   * {@link importNotionZipLayout} to rewrite `.md` links into internal page
   * links. Return null when the target does not exist.
   */
  pageKeyFor?: (resolvedPath: string) => string | null;
  /** directory the markdown came from, used to resolve relative links */
  baseDir?: string;
}

export interface ExportOptions extends MarkdownOptions {
  /** list marker for bulleted items (default "-") */
  bullet?: "-" | "*" | "+";
  /** indent step for nested blocks (default 2) */
  indentWidth?: number;
  /** page-link key → path written into the markdown link */
  pageLink?: (key: string) => string;
  /** a `page` block emits its title as a leading `#` heading (default false) */
  titleHeading?: boolean;
  /** trailing newline at the end of the document (default true) */
  finalNewline?: boolean;
}

interface Ctx {
  warnings: string[];
  warned: Set<string>;
  databases: ParsedDatabase[];
  tabsWidth: number;
  pageKeyFor?: (resolvedPath: string) => string | null;
  baseDir: string;
  /** most recent heading text, used as a table title */
  lastHeading: string;
}

function warn(ctx: Ctx, key: string, message: string): void {
  if (ctx.warned.has(key)) return;
  ctx.warned.add(key);
  ctx.warnings.push(message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Language aliases (Notion's names are the canonical ones)
// ─────────────────────────────────────────────────────────────────────────────

export const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  py: "python",
  py3: "python",
  python3: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  shellsession: "bash",
  "plain text": "plaintext",
  plain: "plaintext",
  text: "plaintext",
  txt: "plaintext",
  md: "markdown",
  yml: "yaml",
  rb: "ruby",
  rs: "rust",
  cs: "csharp",
  "c#": "csharp",
  "f#": "fsharp",
  cpp: "cpp",
  "c++": "cpp",
  cxx: "cpp",
  h: "c",
  hpp: "cpp",
  kt: "kotlin",
  kts: "kotlin",
  objc: "objectivec",
  "objective-c": "objectivec",
  golang: "go",
  docker: "dockerfile",
  jsonc: "json",
  json5: "json",
  "plain-text": "plaintext",
  ps1: "powershell",
  bat: "batch",
  cmd: "batch",
  tex: "latex",
  diff: "diff",
  patch: "diff",
  toml: "toml",
  ini: "ini",
  make: "makefile",
  cmake: "cmake",
  sql: "sql",
  html: "html",
  xml: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  java: "java",
  php: "php",
  lua: "lua",
  r: "r",
  swift: "swift",
  dart: "dart",
  elixir: "elixir",
  erlang: "erlang",
  haskell: "haskell",
  clj: "clojure",
  vue: "vue",
  svelte: "svelte",
  graphql: "graphql",
  prisma: "prisma",
  protobuf: "protobuf",
  tf: "hcl",
  nginx: "nginx",
  dotenv: "bash",
  env: "bash",
};

/** Map a fence language to the name Strata/Notion stores in `props.language`. */
export function normalizeLanguage(lang: string | null | undefined): string {
  const raw = String(lang ?? "").trim();
  if (!raw) return "plaintext";
  const key = raw.toLowerCase().replace(/\s+/g, " ");
  return LANGUAGE_ALIASES[key] ?? key;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lines
// ─────────────────────────────────────────────────────────────────────────────

interface Line {
  /** leading whitespace measured in columns (tabs expanded) */
  indent: number;
  /** the line with its leading whitespace removed */
  text: string;
  /** the original line, needed to re-indent code fences */
  raw: string;
  blank: boolean;
}

function normalizeNewlines(text: string): string {
  let out = text;
  if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
  return out.replace(/\r\n?/g, "\n");
}

function toLines(text: string, tabsWidth: number): Line[] {
  return normalizeNewlines(text).split("\n").map((raw) => {
    let indent = 0;
    let i = 0;
    while (i < raw.length && (raw[i] === " " || raw[i] === "\t")) {
      indent += raw[i] === "\t" ? tabsWidth : 1;
      i++;
    }
    const text = raw.slice(i);
    return { indent, text, raw, blank: text.trim() === "" };
  });
}

/** Remove up to `cols` columns of leading whitespace from a raw line. */
function stripIndent(raw: string, cols: number, tabsWidth: number): string {
  let used = 0;
  let i = 0;
  while (i < raw.length && used < cols && (raw[i] === " " || raw[i] === "\t")) {
    used += raw[i] === "\t" ? tabsWidth : 1;
    i++;
  }
  if (used > cols) return " ".repeat(used - cols) + raw.slice(i);
  return raw.slice(i);
}

// ─────────────────────────────────────────────────────────────────────────────
// Block-start tests
// ─────────────────────────────────────────────────────────────────────────────

const FENCE_RE = /^(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const ATX_RE = /^(#{1,6})(?:[ \t]+(.*)|)$/;
const THEMATIC_RE = /^([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const SETEXT_EQ_RE = /^=+[ \t]*$/;
const SETEXT_DASH_RE = /^-+[ \t]*$/;
const LIST_RE = /^([-*+]|(?:\d{1,9})[.)])(?:[ \t]+(\s*)|$)/;
const CHECKBOX_RE = /^([-*+])[ \t]+\[([ xX])\][ \t]+/;
const QUOTE_RE = /^>[ \t]?/;
const MATH_BLOCK_RE = /^\$\$[ \t]*$/;
const MATH_ONE_LINE_RE = /^\$\$(?!\$)(.*)\$\$[ \t]*$/;
const IMAGE_LINE_RE = /^!\[([^\]]*)\]\(([^()]*)\)$/;
const AUTOLINK_LINE_RE = /^<((?:https?|ftp|mailto):[^<>\s]+)>$/;
const TABLE_DELIM_RE = /^[ \t]*:?:?-{1,}:?:?[ \t]*$/;
const HTML_BLOCK_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/;

/**
 * Tags that are inline in Notion's export. A line starting with one of these is
 * a paragraph, not an HTML block, so `mapInlineHtml` gets to translate it.
 */
const INLINE_HTML_TAGS = new Set([
  "b",
  "strong",
  "i",
  "em",
  "code",
  "s",
  "del",
  "strike",
  "u",
  "ins",
  "a",
  "span",
  "time",
  "small",
  "sub",
  "sup",
  "mark",
  "big",
  "font",
  "br",
  "wbr",
  "abbr",
  "q",
  "kbd",
  "samp",
  "var",
  "cite",
  "ruby",
  "rt",
  "rp",
  "bdi",
  "bdo",
]);

const IMG_LINE_RE = /^<img\b[^>]*\/?>$/i;

/** Blocks that render as list items, so adjacent ones share one line break. */
const LIST_ITEM_TYPES = new Set<BlockType>([
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
]);

/** Tags that must never disappear: kept as literal text so the exporter escapes them. */
const DANGEROUS_TAG_RE = /^<\/?(?:script|style|iframe|object|embed|link|meta|base|form|input|svg)\b/i;

function isFenceStart(text: string): boolean {
  return FENCE_RE.test(text);
}

/** True when a line starts a new block, i.e. ends a paragraph. */
function isBlockStart(line: Line): boolean {
  const t = line.text;
  if (line.blank) return true;
  if (isFenceStart(t)) return true;
  if (ATX_RE.test(t) && /^#{1,6}(\s|$)/.test(t)) return true;
  if (THEMATIC_RE.test(t)) return true;
  if (SETEXT_EQ_RE.test(t)) return true;
  if (SETEXT_DASH_RE.test(t)) return true;
  if (QUOTE_RE.test(t)) return true;
  if (LIST_RE.test(t)) return true;
  if (MATH_BLOCK_RE.test(t) || MATH_ONE_LINE_RE.test(t)) return true;
  if (IMAGE_LINE_RE.test(t) || AUTOLINK_LINE_RE.test(t)) return true;
  if (/^</.test(t)) {
    const m = HTML_BLOCK_RE.exec(t);
    if (!m) return false;
    // an inline tag does not start a block: the paragraph keeps collecting
    return !INLINE_HTML_TAGS.has(m[2]!.toLowerCase());
  }
  return false;
}

/** A pipe-table header: this line has pipes and the next is a delimiter row. */
function tableStartAt(lines: Line[], i: number): number {
  const header = lines[i];
  const delim = lines[i + 1];
  if (!header || !delim || header.blank || delim.blank) return 0;
  if (!header.text.includes("|")) return 0;
  if (!delim.text.includes("-")) return 0;
  const headerCells = splitRow(header.text);
  const delimCells = splitRow(delim.text);
  if (delimCells.length !== headerCells.length) return 0;
  if (!delimCells.every((c) => TABLE_DELIM_RE.test(c))) return 0;
  return headerCells.length;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (c === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline HTML / entities (Notion's export is markdown with HTML sprinkled in)
// ─────────────────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#34;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
  "&#160;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&copy;": "©",
  "&reg;": "®",
  "&deg;": "°",
  "&times;": "×",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&(?:[a-zA-Z]+|#\d{1,7});/g, (m) => {
      const direct = ENTITIES[m];
      if (direct !== undefined) return direct;
      const num = /^&#(\d{1,7});$/.exec(m);
      if (num) {
        const code = Number(num[1]);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return m;
    });
}

/** Map the handful of inline HTML tags Notion emits, then strip the rest. */
function mapInlineHtml(text: string, ctx: Ctx): string {
  let s = text;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<(?:b|strong)>([\s\S]*?)<\/(?:b|strong)>/gi, "**$1**");
  s = s.replace(/<(?:i|em)>([\s\S]*?)<\/(?:i|em)>/gi, "*$1*");
  s = s.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");
  s = s.replace(/<(?:s|del|strike)>([\s\S]*?)<\/(?:s|del|strike)>/gi, "~~$1~~");
  s = s.replace(/<u>([\s\S]*?)<\/u>/gi, "$1");
  s = s.replace(/<ins>([\s\S]*?)<\/ins>/gi, "$1");
  s = s.replace(/<a\b[^>]*?href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1");
  s = s.replace(/<time\b[^>]*>([\s\S]*?)<\/time>/gi, "$1");
  s = s.replace(/<span\b[^>]*>([\s\S]*?)<\/span>/gi, "$1");
  s = s.replace(/<(?:small|sub|sup|mark|big|font)\b[^>]*>([\s\S]*?)<\/(?:small|sub|sup|mark|big|font)>/gi, "$1");
  if (/<\/?(?:u|ins)\b/i.test(text)) warn(ctx, "html-underline", "underline via <u> is not supported; the text was kept plain");
  if (/<[a-zA-Z]/.test(s)) {
    s = s.replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?>/g, (tag) =>
      DANGEROUS_TAG_RE.test(tag)
        ? tag.replace(/</g, "&lt;").replace(/>/g, "&gt;")
        : "",
    );
    warn(ctx, "html-inline", "raw inline HTML was stripped; styles it carried are dropped");
  }
  return decodeEntities(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline parsing
// ─────────────────────────────────────────────────────────────────────────────

/** Inline math is not expressible in `Inline[]`, so it is a node, not a run. */
export type InlineNode =
  | { k: "text"; text: string; styles: InlineStyles; links?: InlineLink[] }
  | { k: "math"; latex: string; display: boolean };

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~|$<>"']/;

function countRun(src: string, from: number, ch: string): number {
  let n = 0;
  while (src[from + n] === ch) n++;
  return n;
}

/** Index of the closing run of exactly `size` chars, or -1. */
function findRunEnd(src: string, from: number, ch: string, size: number): number {
  for (let i = from; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (src[i] !== ch) continue;
    const run = countRun(src, i, ch);
    if (run === size) return i;
    i += run - 1;
  }
  return -1;
}

const BOUNDARY_RE = /[\s\p{P}]/u;

function isBoundary(src: string, i: number): boolean {
  if (i < 0 || i >= src.length) return true;
  return BOUNDARY_RE.test(src[i]!);
}

/**
 * The inline parser. Returns text and math nodes; emphasis is handled by
 * recursion with an accumulated style, so `**bold with *italic* inside**`
 * produces one bold run plus a bold-italic run.
 */
export function parseInlineNodes(
  src: string,
  ctx: Ctx,
  styles: InlineStyles = {},
  links?: InlineLink[],
): InlineNode[] {
  const out: InlineNode[] = [];
  let buf = "";

  const flush = (extra?: InlineStyles): void => {
    if (!buf) return;
    out.push({
      k: "text",
      text: buf,
      styles: extra ? { ...styles, ...extra } : { ...styles },
      ...(links && links.length ? { links } : {}),
    });
    buf = "";
  };

  const push = (text: string, extra?: InlineStyles): void => {
    if (!text) return;
    out.push({
      k: "text",
      text,
      styles: { ...styles, ...extra },
      ...(links && links.length ? { links } : {}),
    });
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i]!;

    // escapes
    if (c === "\\") {
      const next = src[i + 1];
      if (next && ESCAPABLE.test(next)) {
        buf += next;
        i += 2;
        continue;
      }
      buf += c;
      i++;
      continue;
    }

    // code spans: `run` lengths must match
    if (c === "`") {
      const run = countRun(src, i, "`");
      const close = findRunEnd(src, i + run, "`", run);
      if (close > 0) {
        let inner = src.slice(i + run, close);
        if (/^ [^]/.test(inner) && inner.endsWith(" ") && inner.trim() !== "") {
          inner = inner.slice(1, -1);
        }
        flush();
        push(inner, { code: true });
        i = close + run;
        continue;
      }
    }

    // inline math
    if (c === "$") {
      const run = countRun(src, i, "$");
      const close = findRunEnd(src, i + run, "$", run);
      if (close > 0 && close > i + run) {
        flush();
        out.push({ k: "math", latex: src.slice(i + run, close), display: run >= 2 });
        i = close + run;
        continue;
      }
    }

    // image
    if (c === "!" && src[i + 1] === "[") {
      const parsed = parseLinkLike(src, i + 1, ctx, true, styles);
      if (parsed) {
        flush();
        const label = parsed.text || parsed.links[0]!.url;
        out.push({ k: "text", text: label, styles: { ...styles }, links: parsed.links });
        warn(ctx, "inline-image", "an inline image became a linked text run; images are blocks in Strata");
        i = parsed.next;
        continue;
      }
    }

    // link
    if (c === "[") {
      const parsed = parseLinkLike(src, i, ctx, false, styles);
      if (parsed) {
        flush();
        for (const node of parsed.nodes) out.push(node);
        i = parsed.next;
        continue;
      }
    }

    // autolink <https://…>
    if (c === "<") {
      const m = /^<((?:https?|ftp|mailto):[^<>\s]+)>/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({
          k: "text",
          text: m[1]!,
          styles: { ...styles },
          links: [{ url: m[1]!, kind: "url" }],
        });
        i += m[0].length;
        continue;
      }
    }

    // strong
    if (c === "*" && src[i + 1] === "*") {
      const close = findRunEnd(src, i + 2, "*", 2);
      if (close > i + 2 && !/\s/.test(src[i + 2]!) && !/\s/.test(src[close - 1]!)) {
        flush();
        for (const node of parseInlineNodes(src.slice(i + 2, close), ctx, { ...styles, bold: true }, links)) {
          out.push(node);
        }
        i = close + 2;
        continue;
      }
    }
    if (c === "_" && src[i + 1] === "_" && isBoundary(src, i - 1)) {
      const close = findRunEnd(src, i + 2, "_", 2);
      if (close > i + 2 && !/\s/.test(src[i + 2]!) && !/\s/.test(src[close - 1]!) && isBoundary(src, close + 2)) {
        flush();
        for (const node of parseInlineNodes(src.slice(i + 2, close), ctx, { ...styles, bold: true }, links)) {
          out.push(node);
        }
        i = close + 2;
        continue;
      }
    }

    // emphasis
    if (c === "*") {
      const close = findRunEnd(src, i + 1, "*", 1);
      if (close > i + 1 && !/\s/.test(src[i + 1]!) && !/\s/.test(src[close - 1]!)) {
        flush();
        for (const node of parseInlineNodes(src.slice(i + 1, close), ctx, { ...styles, italic: true }, links)) {
          out.push(node);
        }
        i = close + 1;
        continue;
      }
    }
    if (c === "_" && isBoundary(src, i - 1)) {
      const close = findRunEnd(src, i + 1, "_", 1);
      if (close > i + 1 && !/\s/.test(src[i + 1]!) && !/\s/.test(src[close - 1]!) && isBoundary(src, close + 1)) {
        flush();
        for (const node of parseInlineNodes(src.slice(i + 1, close), ctx, { ...styles, italic: true }, links)) {
          out.push(node);
        }
        i = close + 1;
        continue;
      }
    }

    // strikethrough
    if (c === "~" && src[i + 1] === "~") {
      const close = findRunEnd(src, i + 2, "~", 2);
      if (close > i + 2) {
        flush();
        for (const node of parseInlineNodes(src.slice(i + 2, close), ctx, { ...styles, strike: true }, links)) {
          out.push(node);
        }
        i = close + 2;
        continue;
      }
    }

    buf += c;
    i++;
  }

  flush();
  return out;
}

/** `[text](url)` / `![alt](url)` starting at `at` (the `[`). */
function parseLinkLike(
  src: string,
  at: number,
  ctx: Ctx,
  image: boolean,
  styles: InlineStyles = {},
):
  | {
      next: number;
      text: string;
      styles: InlineStyles;
      links: InlineLink[];
      nodes: InlineNode[];
    }
  | null {
  if (src[at] !== "[") return null;
  let depth = 0;
  let close = -1;
  for (let i = at; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return null;
  let j = close + 1;
  if (src[j] !== "(") return null;
  j++;
  let depth2 = 1;
  let raw = "";
  while (j < src.length) {
    const c = src[j]!;
    if (c === "\\") {
      raw += c + (src[j + 1] ?? "");
      j += 2;
      continue;
    }
    if (c === "(") depth2++;
    else if (c === ")") {
      depth2--;
      if (depth2 === 0) break;
    }
    raw += c;
    j++;
  }
  if (depth2 !== 0) return null;

  let target = raw.trim();
  // drop a "title" suffix
  const titleMatch = /^(.*?)\s+["']([^"']*)["']$/.exec(target);
  if (titleMatch) target = titleMatch[1]!;
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  target = decodeUriSafe(target);

  const text = src.slice(at + 1, close);
  const link: InlineLink = { url: target, kind: "url" };
  if (!image) {
    const key = resolvePageKey(target, ctx);
    // a page link carries the target page's title as its stable key
    if (key) {
      link.kind = "page";
      link.url = key;
    }
  }
  const nodes = parseInlineNodes(text, ctx, { ...styles }, [link]);
  return {
    next: j + 1,
    text: image ? text : "",
    styles,
    links: [link],
    nodes,
  };
}

function decodeUriSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolvePageKey(target: string, ctx: Ctx): string | null {
  if (!ctx.pageKeyFor) return null;
  if (/^(?:[a-z]+:)?\/\//i.test(target) || target.startsWith("#")) return null;
  const clean = target.split("#")[0]!.split("?")[0]!;
  if (!/\.(md|markdown)$/i.test(clean)) return null;
  const base = clean.split("/").pop() ?? clean;
  // Notion writes links relative to the export root, but a hand-written file
  // links relative to itself; try both, then the bare filename.
  const candidates = [
    resolvePath("", clean),
    resolvePath(ctx.baseDir, clean),
    resolvePath(ctx.baseDir, base),
    base,
  ];
  for (const candidate of candidates) {
    const key = ctx.pageKeyFor(candidate);
    if (key) return key;
  }
  warn(ctx, `missing-page:${clean}`, `link to "${clean}" does not resolve to a page in this import`);
  return null;
}

/** Join a directory and a relative path, normalising `.` and `..`. */
export function resolvePath(baseDir: string, rel: string): string {
  const parts = [...(baseDir ? baseDir.split("/") : []), ...rel.split("/")];
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** `Inline[]` from nodes; inline math degrades to literal `$…$` text. */
export function nodesToBody(nodes: InlineNode[], ctx: Ctx): Body {
  const runs: Inline[] = [];
  for (const node of nodes) {
    if (node.k === "math") {
      warn(ctx, "inline-math", "inline $math$ inside this block was kept as literal text; only a standalone math block becomes a latex block");
      runs.push(textInline(`$${node.latex}$`));
      continue;
    }
    runs.push(node.links ? textInline(node.text, node.styles, node.links) : textInline(node.text, node.styles));
  }
  return mergeInlines(runs);
}

function bodyFrom(src: string, ctx: Ctx): Body {
  return nodesToBody(parseInlineNodes(mapInlineHtml(src, ctx), ctx), ctx);
}

/**
 * A paragraph's nodes may contain math, which has no place inside `Inline[]`.
 * Split into sibling blocks: paragraph, latex(inlineMode), paragraph, …
 */
function blocksFromNodes(nodes: InlineNode[], ctx: Ctx, type: "paragraph"): ParsedBlock[] {
  const runs: Inline[] = [];
  const out: ParsedBlock[] = [];
  const flush = (): void => {
    if (!runs.length) return;
    out.push(block(type, { body: mergeInlines(runs) }));
    runs.length = 0;
  };
  for (const node of nodes) {
    if (node.k === "math") {
      flush();
      out.push(
        block("latex", {
          props: { latex: node.latex, inlineMode: !node.display },
        }),
      );
      continue;
    }
    runs.push(node.links ? textInline(node.text, node.styles, node.links) : textInline(node.text, node.styles));
  }
  flush();
  if (!out.length) out.push(block(type, { body: mergeInlines([]) }));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Block parsing
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedRun {
  blocks: ParsedBlock[];
  next: number;
  indent: number;
}

function parseRegion(lines: Line[], ctx: Ctx): ParsedBlock[] {
  const root = block("paragraph", { body: null });
  const stack: { indent: number; block: ParsedBlock }[] = [
    { indent: -1, block: root },
  ];

  const attach = (indent: number, b: ParsedBlock): void => {
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }
    stack[stack.length - 1]!.block.children.push(b);
    stack.push({ indent, block: b });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.blank) {
      i++;
      continue;
    }
    const run = parseBlock(lines, i, ctx);
    if (!run) {
      i++;
      continue;
    }
    for (const b of run.blocks) attach(run.indent, b);
    i = run.next;
  }
  return root.children;
}

function parseBlock(lines: Line[], i: number, ctx: Ctx): ParsedRun | null {
  const line = lines[i]!;
  const d = line.indent;
  const rawText = line.text;

  // ── fenced code ────────────────────────────────────────────────────────────
  const fence = FENCE_RE.exec(rawText);
  if (fence) {
    const marker = fence[1]!;
    const ch = marker[0]!;
    const lang = fence[2] ?? "";
    const content: string[] = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      const t = l.text;
      if (
        l.indent <= d &&
        t.startsWith(marker) &&
        countRun(t, 0, ch) >= marker.length &&
        t.slice(countRun(t, 0, ch)).trim() === ""
      ) {
        closed = true;
        break;
      }
      content.push(stripIndent(l.raw, d, ctx.tabsWidth));
    }
    if (!closed) warn(ctx, "unclosed-fence", "a code fence was never closed; the rest of the file was taken as code");
    return {
      blocks: [
        block("code", {
          props: { language: normalizeLanguage(lang) },
          body: plainTextToBody(content.join("\n")),
        }),
      ],
      next: j + 1,
      indent: d,
    };
  }

  // ── block math ─────────────────────────────────────────────────────────────
  if (MATH_BLOCK_RE.test(rawText)) {
    const content: string[] = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      if (MATH_BLOCK_RE.test(lines[j]!.text)) {
        closed = true;
        break;
      }
      content.push(lines[j]!.text);
    }
    if (!closed) warn(ctx, "unclosed-math", "a $$ math block was never closed");
    return {
      blocks: [block("latex", { props: { latex: content.join("\n"), inlineMode: false } })],
      next: j + 1,
      indent: d,
    };
  }
  const oneLineMath = MATH_ONE_LINE_RE.exec(rawText);
  if (oneLineMath && !oneLineMath[1]!.includes("$")) {
    return {
      blocks: [block("latex", { props: { latex: oneLineMath[1]!.trim(), inlineMode: false } })],
      next: i + 1,
      indent: d,
    };
  }

  // ── <details> toggle ───────────────────────────────────────────────────────
  if (/^<details\b/i.test(rawText)) {
    return parseDetails(lines, i, ctx);
  }

  // ── standalone image / link preview (before HTML: `<https://…>` looks like a tag)
  const image = IMAGE_LINE_RE.exec(rawText);
  if (image) {
    const caption = image[1] ?? "";
    const url = decodeUriSafe(image[2] ?? "");
    return {
      blocks: [
        block("image", {
          props: {
            url,
            caption: bodyFrom(caption, ctx),
          },
        }),
      ],
      next: i + 1,
      indent: d,
    };
  }
  const auto = AUTOLINK_LINE_RE.exec(rawText);
  if (auto) {
    return {
      blocks: [block("link_preview", { props: { url: auto[1]! } })],
      next: i + 1,
      indent: d,
    };
  }
  if (IMG_LINE_RE.test(rawText)) {
    const src = attrOf(rawText, "src") ?? "";
    const alt = attrOf(rawText, "alt") ?? "";
    return {
      blocks: [
        block("image", {
          props: { url: decodeUriSafe(src), caption: bodyFrom(alt, ctx) },
        }),
      ],
      next: i + 1,
      indent: d,
    };
  }

  // ── other HTML blocks ──────────────────────────────────────────────────────
  if (/^</.test(rawText)) {
    const html = parseHtmlBlock(lines, i, ctx);
    if (html) return html;
  }

  // ── ATX heading ────────────────────────────────────────────────────────────
  const atx = ATX_RE.exec(rawText);
  if (atx && /^#{1,6}(\s|$)/.test(rawText)) {
    const hashes = atx[1]!;
    const level = Math.min(hashes.length, 3) as 1 | 2 | 3;
    if (hashes.length > 3) {
      warn(ctx, "deep-heading", `heading level ${hashes.length} is not supported; mapped to heading_3`);
    }
    const text = (atx[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
    ctx.lastHeading = text;
    return {
      blocks: [block(`heading_${level}` as "heading_1", { body: bodyFrom(text, ctx) })],
      next: i + 1,
      indent: d,
    };
  }

  // ── thematic break ─────────────────────────────────────────────────────────
  if (THEMATIC_RE.test(rawText)) {
    return { blocks: [block("divider")], next: i + 1, indent: d };
  }

  // ── blockquote / callout ───────────────────────────────────────────────────
  if (QUOTE_RE.test(rawText)) {
    return parseQuote(lines, i, ctx);
  }

  // ── pipe table ─────────────────────────────────────────────────────────────
  const width = tableStartAt(lines, i);
  if (width) return parseTable(lines, i, width, ctx);

  // ── list item ──────────────────────────────────────────────────────────────
  const list = LIST_RE.exec(rawText);
  if (list) return parseListItem(lines, i, ctx);

  // ── paragraph (with setext heading detection) ──────────────────────────────
  const collected: string[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.blank) break;
    // a line indented deeper than the paragraph starts a CHILD block, which is
    // how nesting is written in Notion's export and how it round-trips
    if (j > i && (isBlockStart(l) || tableStartAt(lines, j) > 0 || l.indent > d)) break;
    collected.push(l.text);
    j++;
  }
  if (!collected.length) return null;

  const nextLine = lines[j];
  const single = collected.length === 1;
  if (single && nextLine && SETEXT_EQ_RE.test(nextLine.text)) {
    ctx.lastHeading = collected[0]!;
    return {
      blocks: [block("heading_1", { body: bodyFrom(collected[0]!, ctx) })],
      next: j + 1,
      indent: d,
    };
  }
  if (single && nextLine && SETEXT_DASH_RE.test(nextLine.text)) {
    ctx.lastHeading = collected[0]!;
    return {
      blocks: [block("heading_2", { body: bodyFrom(collected[0]!, ctx) })],
      next: j + 1,
      indent: d,
    };
  }

  const text = mapInlineHtml(collected.join("\n"), ctx);
  return {
    blocks: blocksFromNodes(parseInlineNodes(text, ctx), ctx, "paragraph"),
    next: j,
    indent: d,
  };
}

// ── <details> ───────────────────────────────────────────────────────────────

/**
 * Notion writes toggles in two shapes: everything on one line, and
 * `<summary>` on the opening line with the children as blocks below. Both are
 * accepted, and the summary may be split across lines.
 */
function parseDetails(lines: Line[], i: number, ctx: Ctx): ParsedRun {
  const d = lines[i]!.indent;
  const openLine = lines[i]!.text;

  const summaryMatch = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(openLine);
  let summary = summaryMatch ? summaryMatch[1]! : "";
  const after = summaryMatch
    ? openLine.slice(summaryMatch.index + summaryMatch[0].length)
    : openLine.slice(openLine.indexOf(">") + 1);

  const body: string[] = [];
  let tail = after;
  let depth = countTag(openLine, "details") - countTag(openLine, "/details");
  const closedHere = /<\/details>/i.test(tail);
  if (closedHere) tail = tail.replace(/<\/details>[\s\S]*$/i, "");
  if (tail.trim()) body.push(tail);

  let next = i + 1;
  let summaryOpen = !summaryMatch; // the summary has not been closed yet

  if (depth > 0) {
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      const t = l.text;
      const delta = countTag(t, "details") - countTag(t, "/details");
      if (depth + delta <= 0) {
        let rest = t;
        if (summaryOpen && /<\/summary>/i.test(rest)) {
          summary += " " + rest.replace(/<\/summary>[\s\S]*$/i, "");
          rest = rest.replace(/^[\s\S]*<\/summary>/i, "");
          summaryOpen = false;
        }
        rest = rest.replace(/<\/details>[\s\S]*$/i, "");
        if (rest.trim()) body.push(stripIndent(l.raw, d, ctx.tabsWidth));
        next = j + 1;
        closed = true;
        break;
      }
      if (summaryOpen) {
        if (/<\/summary>/i.test(t)) {
          summary += " " + t.replace(/<\/summary>[\s\S]*$/i, "");
          const rest = t.replace(/^[\s\S]*<\/summary>/i, "");
          if (rest.trim()) body.push(stripIndent(l.raw, d, ctx.tabsWidth));
          summaryOpen = false;
        } else {
          summary += " " + t;
        }
        depth += delta;
        continue;
      }
      body.push(stripIndent(l.raw, d, ctx.tabsWidth));
      depth += delta;
    }
    if (!closed) {
      warn(ctx, "unclosed-details", "a <details> block was never closed");
      next = j;
    }
  }

  const innerLines = toLines(
    body.join("\n").replace(/<\/?(?:p|div|span)\b[^>]*>/gi, "\n"),
    ctx.tabsWidth,
  );
  const children = parseRegion(innerLines, ctx);
  const summaryBody = bodyFrom(summary.trim(), ctx);
  if (isEmptyBodyLocal(summaryBody)) {
    warn(ctx, "details-no-summary", "a <details> block had no <summary>; its title is empty");
  }
  const toggle = block("toggle", {
    props: { open: false },
    body: summaryBody,
    children,
  });
  return { blocks: [toggle], next, indent: d };
}

function isEmptyBodyLocal(body: Body): boolean {
  return body.every((i) => i.text === "");
}

function countTag(text: string, name: string): number {
  const re = new RegExp(`<${name}\\b`, "gi");
  return (text.match(re) ?? []).length;
}

// ── blockquote / callout ────────────────────────────────────────────────────

function parseQuote(lines: Line[], i: number, ctx: Ctx): ParsedRun {
  const d = lines[i]!.indent;
  const inner: string[] = [];
  let j = i;
  let lastWasQuote = true;
  for (; j < lines.length; j++) {
    const l = lines[j]!;
    if (l.blank) break;
    if (QUOTE_RE.test(l.text)) {
      inner.push(l.text.replace(QUOTE_RE, ""));
      lastWasQuote = true;
      continue;
    }
    // lazy continuation of the quoted paragraph
    if (lastWasQuote && !isBlockStart(l) && l.indent >= d) {
      inner.push(l.text);
      continue;
    }
    break;
  }
  const innerLines = toLines(inner.join("\n"), ctx.tabsWidth);

  // A callout is a quote whose first SOURCE line starts with an emoji: the
  // emoji is stripped from the source, so the styles after it survive.
  const emoji = detectLeadingEmoji(inner.join("\n"));
  if (emoji) {
    const calloutChildren = parseRegion(toLines(emoji.rest, ctx.tabsWidth), ctx);
    const head = calloutChildren[0];
    const rest = calloutChildren.slice(1);
    if (head && head.type === "paragraph") {
      return {
        blocks: [
          block("callout", {
            props: { icon: emoji.emoji },
            body: head.body,
            // a deeper line inside the quote nested under the first paragraph;
            // the callout is the container, so lift them
            children: [...(head.children ?? []), ...rest],
          }),
        ],
        next: j,
        indent: d,
      };
    }
  }

  const children = parseRegion(innerLines, ctx);

  const first = children[0];
  const rest = children.slice(1);
  if (!first) return { blocks: [block("quote", { body: null })], next: j, indent: d };

  const text = blockText(first);
  return {
    blocks: [
      block("quote", {
        body: first.type === "paragraph" ? first.body : bodyFrom(text, ctx),
        // as in the callout branch, a deeper line nested under the first
        // paragraph belongs to the quote itself
        children:
          first.type === "paragraph" ? [...(first.children ?? []), ...rest] : children,
      }),
    ],
    next: j,
    indent: d,
  };
}

// ── pipe table ──────────────────────────────────────────────────────────────

function parseTable(lines: Line[], i: number, width: number, ctx: Ctx): ParsedRun {
  const d = lines[i]!.indent;
  const header = splitRow(lines[i]!.text);
  const names = header.map((h, idx) => (h.trim() ? h.trim() : `Column ${idx + 1}`));
  const bodyRows: string[][] = [];
  let j = i + 2;
  for (; j < lines.length; j++) {
    const l = lines[j]!;
    if (l.blank) break;
    if (!l.text.includes("|")) break;
    if (l.indent !== d) break;
    const cells = splitRow(l.text);
    bodyRows.push(Array.from({ length: width }, (_, c) => cells[c] ?? ""));
  }

  const properties: ParsedProperty[] = names.map((name, c) => {
    let type = inferPropertyType(bodyRows.map((r) => r[c] ?? ""));
    // Notion tables always have a title column; the leftmost text column is it
    if (c === 0 && type === "text") type = "title";
    return { name, type };
  });

  const rows: Record<string, PropertyValueInput>[] = bodyRows.map((r) => {
    const values: Record<string, PropertyValueInput> = {};
    properties.forEach((prop, c) => {
      values[prop.name] = cellToValue(r[c] ?? "", prop.type);
    });
    return values;
  });

  const title = ctx.lastHeading || `Table ${ctx.databases.length + 1}`;
  const database: ParsedDatabase = { title, properties, rows };
  ctx.databases.push(database);

  return {
    blocks: [
      block("child_database", {
        body: plainTextToBody(title),
        props: {
          databaseIndex: ctx.databases.length - 1,
          [TABLE_PROPS_KEY]: databaseToTableData(database),
        },
      }),
    ],
    next: j,
    indent: d,
  };
}

// ── list items ──────────────────────────────────────────────────────────────

function parseListItem(lines: Line[], i: number, ctx: Ctx): ParsedRun {
  const line = lines[i]!;
  const d = line.indent;
  const text = line.text;

  const check = CHECKBOX_RE.exec(text);
  const marker = check ? check[1]! : (LIST_RE.exec(text)?.[1] ?? "-");
  const markerWidth = marker.length;
  const body = check
    ? text.slice(check[0].length)
    : text.slice(markerWidth).replace(/^[ \t]+/, "");

  // A more-indented line below an item is a CHILD block, not a text
  // continuation. Notion writes one line per block, and this is what makes
  // `- a` + `  text` round-trip as a paragraph child.
  const next = i + 1;

  if (check) {
    return {
      blocks: [
        block("to_do", {
          props: { checked: check[2] === "x" || check[2] === "X" },
          body: bodyFrom(body, ctx),
        }),
      ],
      next,
      indent: d,
    };
  }

  const numbered = /^\d/.test(marker);
  return {
    blocks: [
      block(numbered ? "numbered_list_item" : "bulleted_list_item", {
        props: numbered ? { number: Number(marker.replace(/\D+$/, "")) } : {},
        body: bodyFrom(body, ctx),
      }),
    ],
    next,
    indent: d,
  };
}

// ── HTML blocks Notion's export produces ────────────────────────────────────

function parseHtmlBlock(lines: Line[], i: number, ctx: Ctx): ParsedRun | null {
  const d = lines[i]!.indent;
  const open = HTML_BLOCK_RE.exec(lines[i]!.text);
  if (!open) return null;
  const closing = open[1] === "/";
  const tag = open[2]!.toLowerCase();

  // an inline tag is a paragraph in disguise; let the paragraph branch parse it
  if (INLINE_HTML_TAGS.has(tag)) return null;

  if (closing) {
    // a stray closing tag: skip the line
    return { blocks: [], next: i + 1, indent: d };
  }

  // collect the whole element, following nesting of the same tag
  const collected: string[] = [];
  let depth = 0;
  let j = i;
  for (; j < lines.length; j++) {
    const t = lines[j]!.text;
    depth += countTag(t, tag) - countTag(t, `/${tag}`);
    collected.push(t);
    if (depth <= 0) {
      j++;
      break;
    }
  }
  const html = collected.join("\n");

  // column list
  if (tag === "div" && /class\s*=\s*["']column_list["']/i.test(html)) {
    const chunks = html
      .split(/<div\b[^>]*class\s*=\s*["']column["'][^>]*>/i)
      .slice(1)
      .map((chunk) => chunk.replace(/<\/div>\s*$/i, ""));
    const ratio = chunks.length ? Math.round(100 / chunks.length) : 100;
    const columns = chunks.map((chunk) =>
      block("column", {
        props: { ratio },
        children: parseRegion(toLines(chunk, ctx.tabsWidth), ctx),
      }),
    );
    return {
      blocks: [block("column_list", { children: columns })],
      next: j,
      indent: d,
    };
  }

  // figure with an image
  if (tag === "figure") {
    const img = /<img\b[^>]*>/i.exec(html);
    if (img) {
      const src = attrOf(img[0], "src") ?? "";
      const alt = attrOf(img[0], "alt") ?? "";
      const caption = /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i.exec(html)?.[1] ?? alt;
      return {
        blocks: [
          block("image", { props: { url: decodeUriSafe(src), caption: bodyFrom(caption, ctx) } }),
        ],
        next: j,
        indent: d,
      };
    }
    warn(ctx, "figure", "a <figure> without an <img> is not supported; its text was kept");
    return {
      blocks: [block("paragraph", { body: bodyFrom(stripTags(html), ctx) })],
      next: j,
      indent: d,
    };
  }

  // table
  if (tag === "table") {
    return htmlTableToDatabase(html, d, ctx, j);
  }

  // audio / video / iframe embeds
  if (tag === "audio" || tag === "video" || tag === "iframe" || tag === "embed") {
    const url = attrOf(html, "src") ?? "";
    warn(ctx, `embed-${tag}`, `<${tag}> embeds are not supported; kept as a link`);
    return {
      blocks: [
        block(tag === "audio" ? "audio" : "file", {
          props: { url },
          body: plainTextToBody(url || tag),
        }),
      ],
      next: j,
      indent: d,
    };
  }

  // anything else: strip the tags, keep the text
  const stripped = stripTags(html).trim();
  warn(ctx, "html-block", `raw HTML block <${tag}> is not supported; its text was kept as a paragraph`);
  if (!stripped) return { blocks: [], next: j, indent: d };
  return {
    blocks: blocksFromNodes(parseInlineNodes(mapInlineHtml(stripped, ctx), ctx), ctx, "paragraph"),
    next: j,
    indent: d,
  };
}

function attrOf(html: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(html);
  return m ? m[1]! : null;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/[ \t]{2,}/g, " ").trim();
}

function htmlTableToDatabase(
  html: string,
  d: number,
  ctx: Ctx,
  next: number,
): ParsedRun {
  const rowsHtml = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
  const grid = rowsHtml.map(
    (row) =>
      (row.match(/<t[hd]\b[^>]*>[\s\S]*?<\/t[hd]>/gi) ?? []).map((cell) =>
        stripTags(cell.replace(/<[^>]*\/>/g, "")).trim(),
      ),
  );
  if (!grid.length) return { blocks: [], next, indent: d };

  const first = grid[0]!;
  const looksLikeHeader =
    /<th\b/i.test(rowsHtml[0]!) || /<(?:b|strong)\b/i.test(rowsHtml[0]!);
  const bodyRows = looksLikeHeader ? grid.slice(1) : grid;
  const width = Math.max(first.length, ...bodyRows.map((r) => r.length), 1);
  const names = Array.from({ length: width }, (_, c) => {
    const raw = (first[c] ?? "").trim();
    return looksLikeHeader ? raw || `Column ${c + 1}` : `Column ${c + 1}`;
  });
  const properties: ParsedProperty[] = names.map((name, c) => {
    let type = inferPropertyType(bodyRows.map((r) => r[c] ?? ""));
    if (c === 0 && type === "text") type = "title";
    return { name, type };
  });
  const rows: Record<string, PropertyValueInput>[] = bodyRows.map((r) => {
    const values: Record<string, PropertyValueInput> = {};
    properties.forEach((prop, c) => {
      values[prop.name] = cellToValue(r[c] ?? "", prop.type);
    });
    return values;
  });

  warn(ctx, "html-table", "an HTML <table> was converted to a database; cell formatting is dropped");
  const title = ctx.lastHeading || `Table ${ctx.databases.length + 1}`;
  const database: ParsedDatabase = { title, properties, rows };
  ctx.databases.push(database);
  return {
    blocks: [
      block("child_database", {
        body: plainTextToBody(title),
        props: {
          databaseIndex: ctx.databases.length - 1,
          [TABLE_PROPS_KEY]: databaseToTableData(database),
        },
      }),
    ],
    next,
    indent: d,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public import API
// ─────────────────────────────────────────────────────────────────────────────

export function markdownToBlocks(text: string, opts: ImportOptions = {}): ImportResult {
  const ctx: Ctx = {
    warnings: [],
    warned: new Set(),
    databases: [],
    tabsWidth: opts.tabsWidth ?? 4,
    pageKeyFor: opts.pageKeyFor,
    baseDir: opts.baseDir ?? "",
    lastHeading: "",
  };
  const blocks = parseRegion(toLines(normalizeNewlines(text), ctx.tabsWidth), ctx);
  return { blocks, databases: ctx.databases, warnings: ctx.warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Notion's real export layout
// ─────────────────────────────────────────────────────────────────────────────

export interface NotionFile {
  path: string;
  content: string;
}

export interface NotionLayoutOptions extends MarkdownOptions {
  /** title of the export's root page (default "Imported") */
  rootTitle?: string;
}

interface PageRecord {
  path: string;
  dir: string;
  title: string;
  content: string;
  children: PageRecord[];
  parent: PageRecord | null;
  blocks: ParsedBlock[];
}

function normPath(p: string): string {
  return decodeUriSafe(
    p
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/^\/+/, ""),
  );
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function baseOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function titleOf(path: string): string {
  const name = baseOf(path);
  return name.replace(/\.(md|markdown)$/i, "").trim() || "Untitled";
}

const isPagePath = (p: string): boolean => /\.(md|markdown)$/i.test(p);

/**
 * Notion exports a workspace as a folder of `.md` files: a page's sub-pages
 * live in a folder named after the page, and links between pages are relative
 * `.md` links. This turns such a path list into a page tree:
 *
 *  - every `.md` file becomes a `page` block titled from its filename
 *  - a file nested in a folder becomes a `child_page` of the page that folder
 *    is named after (or of that folder's `index.md`)
 *  - relative `.md` links in the body become `Inline.links` with
 *    `kind: "page"` and the target page's title as the stable key
 *  - a body block that is nothing but a link to a child page is dropped,
 *    because the `child_page` node already represents it
 */
export function importNotionZipLayout(
  files: readonly NotionFile[],
  opts: NotionLayoutOptions = {},
): ImportResult {
  const records = new Map<string, PageRecord>();
  const assets: string[] = [];

  for (const file of files) {
    const path = normPath(file.path);
    if (!isPagePath(path)) {
      assets.push(path);
      continue;
    }
    records.set(path, {
      path,
      dir: dirOf(path),
      title: titleOf(path),
      content: file.content,
      children: [],
      parent: null,
      blocks: [],
    });
  }

  const warnings: string[] = [];
  const warned = new Set<string>();
  const pushWarning = (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    warnings.push(message);
  };

  const findRecord = (path: string): PageRecord | null =>
    records.get(path.replace(/\/index\.(md|markdown)$/i, ".md")) ??
    records.get(path) ??
    null;

  // parent resolution
  for (const rec of records.values()) {
    if (rec.dir === "") {
      rec.parent = null;
      continue;
    }
    const candidates = [
      rec.dir,
      `${rec.dir}/index.md`,
      ...ancestors(rec.dir).flatMap((a) => [a, `${a}/index.md`]),
    ];
    let parent: PageRecord | null = null;
    for (const c of candidates) {
      parent = findRecord(c);
      if (parent && parent.path !== rec.path) break;
      parent = null;
    }
    rec.parent = parent;
    if (parent) parent.children.push(rec);
  }

  const databases: ParsedDatabase[] = [];
  for (const rec of records.values()) {
    const ctx: Ctx = {
      warnings,
      warned,
      databases,
      tabsWidth: opts.tabsWidth ?? 4,
      baseDir: rec.dir,
      lastHeading: "",
      pageKeyFor: (resolved) => {
        const target = findRecord(resolved);
        if (!target) return null;
        return target.title;
      },
    };
    rec.blocks = parseRegion(toLines(normalizeNewlines(rec.content), ctx.tabsWidth), ctx);
    for (const w of ctx.warnings) void w; // warnings are appended by reference
  }

  const rootIndex = findRecord("index.md");
  const byPath = (a: PageRecord, b: PageRecord): number => a.path.localeCompare(b.path);

  // Notion puts sub-pages in a folder named after the page, but its workspace
  // root (`index.md`) keeps its children as plain top-level files linked from
  // the body. Adopt those: a top-level page linked by title from another page
  // becomes that page's child.
  const pageLinkKeys = (rec: PageRecord): Set<string> => {
    const keys = new Set<string>();
    for (const b of walkBlocks(rec.blocks)) {
      for (const inline of b.body ?? []) {
        for (const link of inline.links ?? []) {
          if (link.kind === "page") keys.add(link.url);
        }
      }
    }
    return keys;
  };

  for (const rec of records.values()) {
    if (rec.parent) continue;
    const keys = pageLinkKeys(rec);
    if (!keys.size) continue;
    for (const candidate of records.values()) {
      if (candidate === rec || candidate === rootIndex) continue;
      if (candidate.parent) continue;
      if (keys.has(candidate.title)) {
        candidate.parent = rec;
        rec.children.push(candidate);
      }
    }
  }

  const buildPage = (rec: PageRecord, isRoot: boolean): ParsedBlock => {
    const childTitles = new Set(rec.children.map((c) => c.title));
    const kept = rec.blocks.filter((b) => !isLinkOnlyPageBlock(b, childTitles));
    const childBlocks = [...rec.children].sort(byPath).map((child) => buildPage(child, false));
    return block(isRoot ? "page" : "child_page", {
      body: plainTextToBody(rec.title),
      props: { path: rec.path },
      children: [...kept, ...childBlocks],
    });
  };

  const blocks: ParsedBlock[] = [];
  if (rootIndex) blocks.push(buildPage(rootIndex, true));
  const roots = [...records.values()].filter((r) => !r.parent && r !== rootIndex).sort(byPath);
  for (const rec of roots) blocks.push(buildPage(rec, true));

  if (assets.length) {
    pushWarning(
      "assets",
      `${assets.length} non-markdown file(s) in the export were skipped (media is imported separately)`,
    );
  }

  return { blocks, databases, warnings };
}

function ancestors(dir: string): string[] {
  const parts = dir.split("/");
  const out: string[] = [];
  for (let i = parts.length - 1; i > 0; i--) out.push(parts.slice(0, i).join("/"));
  return out;
}

function* walkBlocks(blocks: readonly ParsedBlock[]): Generator<ParsedBlock> {
  for (const b of blocks) {
    yield b;
    yield* walkBlocks(b.children);
  }
}

/** A paragraph / bulleted item whose whole body is one page link. */
function isLinkOnlyPageBlock(b: ParsedBlock, childTitles: Set<string>): boolean {
  if (b.type !== "paragraph" && b.type !== "bulleted_list_item") return false;
  if (b.children.length) return false;
  const runs = b.body ?? [];
  const nonEmpty = runs.filter((r) => r.text.trim() !== "");
  if (nonEmpty.length !== 1) return false;
  const run = nonEmpty[0]!;
  const link = run.links?.[0];
  if (!link || link.kind !== "page") return false;
  return childTitles.has(link.url) && run.text.trim() === link.url.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_LINK = (key: string): string => `./${encodeURIComponent(key)}.md`;

/**
 * Escape text so that re-importing it yields the same characters. Markers that
 * only matter at the start of a line (`#`, `-`, `+`, `>`, `1.`) are escaped
 * there; emphasis markers are escaped everywhere, which keeps the rule simple
 * and the round-trip exact.
 */
export function escapeMarkdownText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const prev = i === 0 ? "\n" : text[i - 1]!;
    const next = i + 1 < text.length ? text[i + 1]! : "";
    const lineStart = prev === "\n";
    const esc = (ch: string): void => {
      out += ch;
    };
    switch (c) {
      case "\\":
        out += "\\\\";
        break;
      case "`":
      case "*":
      case "_":
      case "~":
      case "$":
      case "[":
      case "]":
        out += "\\" + c;
        break;
      case "<":
        if (/[a-zA-Z/!?]/.test(next)) esc("\\<");
        else out += c;
        break;
      case ">":
        if (lineStart) esc("\\>");
        else out += c;
        break;
      case "#":
      case "+":
        if (lineStart) esc("\\" + c);
        else out += c;
        break;
      case "-":
        if (lineStart && (next === " " || next === "" || next === "\n")) esc("\\-");
        else out += c;
        break;
      case "!":
        if (lineStart && next === "[") esc("\\!");
        else out += c;
        break;
      case ".":
      case ")":
        if (isListMarkerPrefix(text, i)) esc("\\" + c);
        else out += c;
        break;
      case "|":
        out += "\\|";
        break;
      default:
        out += c;
    }
  }
  return out;
}

/** True at the `.` of `1.` or the `)` of `1)` when the digits start a line. */
function isListMarkerPrefix(text: string, at: number): boolean {
  let j = at - 1;
  if (j < 0 || !/\d/.test(text[j]!)) return false;
  while (j >= 0 && /\d/.test(text[j]!)) j--;
  const lineStart = j < 0 || text[j] === "\n";
  if (!lineStart) return false;
  const next = text[at + 1] ?? "";
  return next === " " || next === "" || next === "\n";
}

/** Backtick span whose delimiters grow past any run inside the code. */
function codeSpan(text: string): string {
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "`") {
      let n = 1;
      while (text[i + n] === "`") n++;
      run = Math.max(run, n);
      i += n - 1;
    }
  }
  const fence = "`".repeat(Math.max(1, run + 1));
  const pad = text.startsWith("`") || text.endsWith("`") || text === "" ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** `Inline[]` → markdown text for one block. */
export function bodyToMarkdown(body: Body | null, opts: ExportOptions = {}): string {
  if (!body?.length) return "";
  const pageLink = opts.pageLink ?? DEFAULT_PAGE_LINK;
  let out = "";
  for (const run of body) {
    let text = run.text;
    if (!text) continue;
    const styles = run.styles ?? {};
    if (styles.code) {
      text = codeSpan(text);
    } else {
      // a run that is exactly inline math round-trips without escaping
      const math = /^\$([^$\n]+)\$$/.exec(text);
      text = math && !/\\/.test(text) ? text : escapeMarkdownText(text);
      if (styles.strike) text = `~~${text}~~`;
      if (styles.italic) text = `_${text}_`;
      if (styles.bold) text = `**${text}**`;
    }
    const link = run.links?.[0];
    if (link) {
      const url = link.kind === "page" ? pageLink(link.url) : link.url;
      const safeUrl = /\s/.test(url) ? `<${url}>` : url.replace(/([()])/g, "\\$1");
      text = `[${text}](${safeUrl})`;
    }
    out += text;
  }
  return out;
}

/** Fence longer than any backtick run in the code, so nested fences survive. */
function fenceFor(code: string, ch: string = "`"): string {
  let run = 0;
  for (let i = 0; i < code.length; i++) {
    if (code[i] === ch) {
      let n = 1;
      while (code[i + n] === ch) n++;
      run = Math.max(run, n);
      i += n - 1;
    }
  }
  return ch.repeat(Math.max(3, run + 1));
}

function indentLines(text: string, width: number): string {
  const pad = " ".repeat(width);
  return text
    .split("\n")
    .map((l) => (l.trim() === "" ? l : pad + l))
    .join("\n");
}

function quoteLines(text: string, marker: string): string {
  return text
    .split("\n")
    .map((l) => (l.trim() === "" ? marker.trimEnd() : marker + l))
    .join("\n");
}

/** Render a table (from a `child_database` block) as a GFM pipe table. */
export function tableToMarkdown(
  properties: ParsedProperty[],
  rows: Record<string, PropertyValueInput>[],
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
  const escapeCell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines: string[] = [];
  lines.push(`| ${properties.map((p) => escapeCell(p.name)).join(" | ")} |`);
  lines.push(`| ${properties.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    lines.push(
      `| ${properties.map((p) => escapeCell(cell(row[p.name] ?? null))).join(" | ")} |`,
    );
  }
  return lines.join("\n");
}

function renderBlock(b: ParsedBlock, opts: Required<Pick<ExportOptions, "bullet" | "indentWidth">> & ExportOptions): string {
  const text = bodyToMarkdown(b.body, opts);
  const width = opts.indentWidth;
  // children render as a full document, so trim the trailing newline before
  // embedding them
  const children = () => blocksToMarkdown(b.children, opts).replace(/\n+$/, "");

  switch (b.type) {
    case "divider":
      return "---";
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item": {
      const head = `${opts.bullet} ${text}`;
      const inner = children();
      return inner ? `${head}\n${indentLines(inner, width)}` : head;
    }
    case "numbered_list_item": {
      const head = `1. ${text}`;
      const inner = children();
      return inner ? `${head}\n${indentLines(inner, width)}` : head;
    }
    case "to_do": {
      const checked = b.props.checked === true ? "x" : " ";
      const head = `- [${checked}] ${text}`;
      const inner = children();
      return inner ? `${head}\n${indentLines(inner, width)}` : head;
    }
    case "toggle": {
      const inner = children();
      const summary = text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return inner
        ? `<details><summary>${summary}</summary>\n\n${inner}\n\n</details>`
        : `<details><summary>${summary}</summary></details>`;
    }
    case "quote": {
      const inner = children();
      const head = quoteLines(text, "> ");
      return inner ? `${head}\n${quoteLines(indentLines(inner, 2), "> ")}` : head;
    }
    case "callout": {
      const icon = typeof b.props.icon === "string" && b.props.icon ? b.props.icon : "💡";
      const inner = children();
      const head = quoteLines(`${icon} ${text}`, "> ");
      return inner ? `${head}\n${quoteLines(indentLines(inner, 2), "> ")}` : head;
    }
    case "code": {
      // code is literal text: never markdown-escaped
      const code = bodyText(b.body);
      const fence = fenceFor(code);
      const lang =
        typeof b.props.language === "string" ? normalizeLanguage(b.props.language) : "plaintext";
      // a plain-text block round-trips best with an empty info string
      return `${fence}${lang === "plaintext" ? "" : lang}\n${code}\n${fence}`;
    }
    case "latex": {
      const latex = String(b.props.latex ?? "");
      return b.props.inlineMode ? `$${latex}$` : `$$\n${latex}\n$$`;
    }
    case "image": {
      const url = String(b.props.url ?? "");
      const caption = b.props.caption
        ? bodyToMarkdown(b.props.caption as Body, opts)
        : text;
      const safeUrl = /\s/.test(url) ? `<${url}>` : url.replace(/([()])/g, "\\$1");
      return `![${caption}](${safeUrl})`;
    }
    case "link_preview":
      return `<${String(b.props.url ?? "")}>`;
    case "bookmark":
      return `[${text || String(b.props.url ?? "")}](${String(b.props.url ?? "")})`;
    case "audio":
    case "file":
      return `![${text}](${String(b.props.url ?? "")})`;
    case "child_database": {
      const table = asTableData(b.props[TABLE_PROPS_KEY]);
      if (table?.properties.length) return tableToMarkdown(table.properties, table.rows);
      return text ? `**${escapeMarkdownText(text)}**` : "";
    }
    case "child_page": {
      const pageLink = opts.pageLink ?? DEFAULT_PAGE_LINK;
      return `- [${escapeMarkdownText(text)}](${pageLink(text)})`;
    }
    case "column_list": {
      const columns = b.children
        .map((c) => `<div class="column">\n\n${blocksToMarkdown(c.children, opts).trimEnd()}\n\n</div>`)
        .join("\n");
      return `<div class="column_list">\n${columns}\n</div>`;
    }
    case "column":
      return blocksToMarkdown(b.children, opts).trimEnd();
    case "page": {
      const inner = children();
      const heading = opts.titleHeading
        ? `# ${escapeMarkdownText(text)}\n\n`
        : "";
      return `${heading}${inner}`;
    }
    case "table_row":
      return text;
    default: {
      // a caller-supplied table block (any type name) that carries props.table
      const table = asTableData(b.props[TABLE_PROPS_KEY]);
      if (table?.properties.length) return tableToMarkdown(table.properties, table.rows);
      return text;
    }
  }
}

/**
 * Blocks → markdown. The output is the importer's canonical syntax: re-importing
 * it produces the same blocks, and re-exporting produces the same text.
 *
 * Consecutive list items of the same kind are joined by one newline (a blank
 * line between them would restart the list); everything else is separated by a
 * blank line.
 */
export function blocksToMarkdown(
  blocks: readonly ParsedBlock[],
  opts: ExportOptions = {},
): string {
  const resolved = {
    ...opts,
    bullet: opts.bullet ?? "-",
    indentWidth: opts.indentWidth ?? 2,
  };
  const rendered: { text: string; type: BlockType }[] = [];
  for (const b of blocks) {
    const text = renderBlock(b, resolved).replace(/\n+$/, "");
    if (text.trim() === "") continue;
    rendered.push({ text, type: b.type });
  }

  let out = "";
  rendered.forEach((part, i) => {
    if (i === 0) {
      out = part.text;
      return;
    }
    const prev = rendered[i - 1]!;
    const sameList = LIST_ITEM_TYPES.has(prev.type) && prev.type === part.type;
    out += (sameList ? "\n" : "\n\n") + part.text;
  });

  if (resolved.finalNewline === false) return out;
  return out ? `${out}\n` : "";
}
