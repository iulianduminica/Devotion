/**
 * LLM-JSON extraction.
 *
 * Local models do not return clean JSON. They chatter ("Sure! Here you go:"),
 * wrap output in ```json fences, add trailing commas, quote keys with single
 * quotes, emit Python literals, and stop mid-object when they hit the context
 * window. `extractJson` is the one place that knows how to dig a value out of
 * that, so every action can stay declarative.
 *
 * Order of attack, cheapest first:
 *   1. parse the text as-is;
 *   2. parse every fenced block;
 *   3. scan for the first balanced `{}`/`[]` region (string- and escape-aware,
 *      so prose braces, apostrophes and escaped quotes cannot fool it);
 *   4. repair the candidate (comments, single quotes, bare keys, trailing
 *      commas, Python literals) and re-parse;
 *   5. close a truncated fragment (drop the dangling key, balance brackets).
 *
 * On failure the thrown `AiJsonError` carries the raw text, so the caller can
 * show it to the user instead of losing it.
 */

export type AiJsonErrorKind = "no-json" | "invalid-json" | "not-object";

export class AiJsonError extends Error {
  readonly kind: AiJsonErrorKind;
  /** The model output we failed to parse, attached for the UI / debugging. */
  readonly raw: string;

  constructor(message: string, raw: string, kind: AiJsonErrorKind = "invalid-json") {
    super(message);
    this.name = "AiJsonError";
    this.kind = kind;
    this.raw = raw;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The first value in `raw` that is a JSON object. Throws `AiJsonError`. */
export function extractJsonObject(raw: string): Record<string, unknown> {
  const value = extractJson(raw);
  if (!isRecord(value)) {
    throw new AiJsonError(
      `expected a JSON object, got ${Array.isArray(value) ? "an array" : typeof value}`,
      typeof raw === "string" ? raw : String(raw),
      "not-object",
    );
  }
  return value;
}

/**
 * The first JSON value (object or array) embedded in `raw`.
 * Throws `AiJsonError` with `raw` attached when nothing parses.
 */
export function extractJson(raw: string): unknown {
  if (typeof raw !== "string") {
    throw new AiJsonError("model output is not text", String(raw), "no-json");
  }
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.trim()) throw new AiJsonError("model output is empty", raw, "no-json");

  const tried = new Set<string>();
  for (const candidate of candidates(text)) {
    const key = candidate.trim();
    if (!key || tried.has(key)) continue;
    tried.add(key);
    const parsed = parseLoose(key);
    if (parsed.ok) return parsed.value;
  }
  throw new AiJsonError(
    "no JSON value found in the model output",
    raw,
    "no-json",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidates
// ─────────────────────────────────────────────────────────────────────────────

const FENCE_RE = /```(?:json|json5|JSON)?[ \t]*\r?\n?([\s\S]*?)(?:```|$)/g;
const MAX_REGIONS = 12;

function candidates(text: string): string[] {
  const out: string[] = [];
  const whole = text.trim();
  out.push(whole);

  // fenced blocks first: they are the model's own "this is the JSON" signal
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text))) {
    const inner = (m[1] ?? "").trim();
    if (inner) out.push(inner);
  }

  // then every balanced region, in document order
  let regions = 0;
  for (let i = 0; i < whole.length && regions < MAX_REGIONS; i++) {
    const ch = whole[i];
    if (ch !== "{" && ch !== "[") continue;
    const scan = scanBalanced(whole, i);
    if (!scan) continue;
    regions++;
    out.push(whole.slice(i, scan.end));
    if (!scan.complete) {
      const frag = closeFragment(whole.slice(i), scan);
      if (frag) out.push(frag);
    }
  }
  return out;
}

interface Scan {
  /** index just past the last consumed char */
  end: number;
  /** closers needed to balance an unfinished fragment */
  closers: string;
  /** true when the region closed on its own */
  complete: boolean;
  /** true when the scan ended inside an open string */
  inString: boolean;
  quote: string;
}

/**
 * String- and escape-aware brace matcher. Starts at `open`, which must be `{`
 * or `[`. Single quotes are treated as string delimiters only where a token can
 * start, so an apostrophe inside prose ("here's") does not derail the scan.
 */
function scanBalanced(s: string, open: number): Scan | null {
  const stack: string[] = [];
  let inStr: string | null = null;
  let escaped = false;

  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"') {
      inStr = '"';
      continue;
    }
    if (ch === "'" && tokenStart(s, i)) {
      inStr = "'";
      continue;
    }
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      const want = stack[stack.length - 1];
      if (want === ch) stack.pop();
      else if (stack.length) stack.pop(); // mismatched closer: tolerate, keep going
      if (stack.length === 0) {
        return { end: i + 1, closers: "", complete: true, inString: false, quote: "" };
      }
    }
  }
  return {
    end: s.length,
    closers: stack.join(""),
    complete: false,
    inString: inStr !== null,
    quote: inStr ?? '"',
  };
}

/** Repair a fragment the model never finished: drop the dangling tail, balance. */
function closeFragment(frag: string, scan: Scan): string {
  let s = frag;
  if (scan.inString) s += scan.quote;
  // drop a trailing comma, then a dangling `"key":` with no value
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(/,\s*$/, "");
    s = s.replace(/(?:"[^"]*"|'[^']*'|[A-Za-z_$][\w$]*)\s*:\s*$/, "");
    s = s.replace(/[,:\s]+$/, "");
    if (s === before) break;
  }
  const rescan = scanBalanced(s, 0);
  if (!rescan) return "";
  return s + rescan.closers;
}

function tokenStart(s: string, i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    const c = s[j]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
    return c === "{" || c === "[" || c === "," || c === ":" || c === "(" || c === "=";
  }
  return true; // start of the string
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing, with escalating repairs
// ─────────────────────────────────────────────────────────────────────────────

interface LooseParse {
  ok: boolean;
  value?: unknown;
}

function parseLoose(s: string): LooseParse {
  const t = s.trim();
  if (!t) return { ok: false };

  // Each stage is a strictly stronger repair; try them in order so a clean
  // document is never rewritten by a heuristic.
  const stages: string[] = [t];
  const noComments = stripComments(t);
  stages.push(noComments);
  const noTrailing = stripTrailingCommas(noComments);
  stages.push(noTrailing);
  const quoted = normalizeQuotes(noTrailing);
  stages.push(quoted);
  const bareKeys = quoteBareKeys(quoted);
  stages.push(bareKeys);
  const literals = normalizeLiterals(bareKeys);
  stages.push(literals);
  const smart = smartQuotes(literals);
  stages.push(smart);

  for (const stage of stages) {
    if (!stage.trim()) continue;
    try {
      return { ok: true, value: JSON.parse(stage) };
    } catch {
      /* next repair */
    }
  }
  return { ok: false };
}

function stripComments(s: string): string {
  let out = "";
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        const nx = s[i + 1];
        if (nx !== undefined) {
          out += nx;
          i++;
        }
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || (ch === "'" && tokenStart(s, i))) {
      inStr = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function stripTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, "$1");
}

/** `'key': 'value'` → `"key": "value"`, escaping what needs escaping. */
function normalizeQuotes(s: string): string {
  let out = "";
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inDouble) {
      out += ch;
      if (ch === "\\") {
        const nx = s[i + 1];
        if (nx !== undefined) {
          out += nx;
          i++;
        }
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "\\") {
        const nx = s[i + 1];
        if (nx === undefined) {
          out += "\\\\";
          continue;
        }
        // Inside a single-quoted string, `\'` is just `'`; `"` needs escaping.
        if (nx === "'") out += "'";
        else if (nx === '"') out += '\\"';
        else out += "\\" + nx;
        i++;
        continue;
      }
      if (ch === "'") {
        inSingle = false;
        out += '"';
        continue;
      }
      if (ch === '"') {
        out += '\\"';
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      continue;
    }
    if (ch === "'" && tokenStart(s, i)) {
      inSingle = true;
      out += '"';
      continue;
    }
    out += ch;
  }
  return out;
}

function quoteBareKeys(s: string): string {
  return s.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$.\-]*)(\s*:)/g, '$1"$2"$3');
}

function normalizeLiterals(s: string): string {
  return s
    .replace(/(^|[\s:,[{])(True)(?=$|[\s,}\]:])/g, "$1true")
    .replace(/(^|[\s:,[{])(False)(?=$|[\s,}\]:])/g, "$1false")
    .replace(/(^|[\s:,[{])(None|undefined|nullptr|nil)(?=$|[\s,}\]:])/g, "$1null")
    .replace(/(^|[\s:,[{])(NaN|Infinity|-Infinity|inf)(?=$|[\s,}\]:])/g, "$1null");
}

function smartQuotes(s: string): string {
  return s
    .replace(/[\u201C\u201E\u201F\u2033]/g, '"')
    .replace(/\u201D/g, '"');
}
