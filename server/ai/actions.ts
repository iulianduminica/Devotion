/**
 * AI actions: summarize, translate, fixGrammar, changeTone, autofill,
 * askWorkspace.
 *
 * The contract with the UI is `runAction(req, deps) -> AiResult`, and the rule
 * that shapes this file is that a model is a text generator, not a data source:
 *   - text actions return the transformed text and nothing else — a preamble
 *     like "Here is the summary:" is stripped, an empty answer is a failure;
 *   - the input is always clamped, so a 400 KB page can never be shipped to a
 *     8k-context model;
 *   - autofill treats the model's JSON as untrusted input: every key is checked
 *     against the real `PropertyDef` list and every value against its type.
 *     Select/status values must name an existing option, and are mapped to the
 *     option id — a value that matches nothing is dropped with a warning, never
 *     written. This validation is the whole point of the action.
 *   - askWorkspace only answers from retrieved sources and returns the ones the
 *     model actually cited.
 */

import type {
  AiAction,
  AiRequest,
  AiResult,
  PropertyDef,
  PropertyValueInput,
  SelectOption,
} from "../../shared/types.ts";
import { AiJsonError, extractJson, isRecord } from "./json.ts";
import { isAiError, type ChatMessage, type ProviderAdapter } from "./providers.ts";
import {
  actionTemperature,
  autofillPrompt,
  isAutofillable,
  promptFor,
  type PromptSource,
} from "./prompts.ts";

export const DEFAULT_MAX_INPUT_CHARS = 12_000;
export const DEFAULT_AUTOFILL_CONTEXT_CHARS = 6_000;
export const DEFAULT_RETRIEVAL_K = 6;
export const MAX_SOURCES = 8;
export const SNIPPET_CHARS = 240;

export interface RetrievedHit {
  node_id: string;
  title: string;
  text: string;
  score: number;
}

export interface RowContext {
  title: string;
  values: Record<string, unknown>;
  properties: PropertyDef[];
}

/**
 * Retrieval can come back as a bare hit list, or as the retrieval module's
 * `{hits, mode}` envelope (vector vs keyword). Both are accepted so the API
 * layer can pass its retrieval function straight through.
 */
export type RetrievalResult = RetrievedHit[] | { hits: RetrievedHit[]; mode?: string };

function normalizeHits(result: RetrievalResult | null | undefined): RetrievedHit[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  return Array.isArray(result.hits) ? result.hits : [];
}

export interface ActionDeps {
  adapter: ProviderAdapter;
  /** vector search over the workspace; absent when nothing is indexed */
  retrieve?: (query: string, k: number) => Promise<RetrievalResult>;
  getRowContext?: (rowId: string) => Promise<RowContext | null>;
  maxInputChars?: number;
  /** sources pulled for askWorkspace */
  k?: number;
  /** injectable clock, so `ms` is testable */
  now?: () => number;
  /** caller cancellation: the Stop button in the editor */
  signal?: AbortSignal;
}

type Base = { provider: string; model: string };

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function runAction(req: AiRequest, deps: ActionDeps): Promise<AiResult> {
  const adapter = deps.adapter;
  const base: Base = { provider: adapter.config.id, model: adapter.config.model };
  const started = deps.now?.() ?? Date.now();
  const stamp = (r: Omit<AiResult, keyof Base | "ms">): AiResult => ({
    ...base,
    ...r,
    ms: (deps.now?.() ?? Date.now()) - started,
  });

  try {
    switch (req.action) {
      case "summarize":
      case "translate":
      case "fixGrammar":
      case "changeTone":
        return stamp(await textAction(req, deps, base));
      case "autofill":
        return stamp(await autofillAction(req, deps, base));
      case "askWorkspace":
        return stamp(await askWorkspaceAction(req, deps, base));
      default:
        return stamp({ ok: false, error: `unknown action "${String(req.action)}"` });
    }
  } catch (e) {
    return stamp({ ok: false, error: describeError(e) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming
// ─────────────────────────────────────────────────────────────────────────────

export type AiStreamEvent =
  | { type: "meta"; provider: string; model: string }
  | { type: "delta"; text: string }
  | { type: "done"; result: AiResult }
  | { type: "error"; result: AiResult };

const TEXT_ACTIONS = new Set<AiAction>(["summarize", "translate", "fixGrammar", "changeTone"]);

/**
 * The same actions, streamed.
 *
 * Only the four text actions stream: `autofill` needs a complete JSON object
 * before anything can be validated, and `askWorkspace` needs its citations, so
 * for those the call falls through to `runAction` and arrives as one `done`
 * event. Streaming a JSON blob one token at a time would show the user raw
 * braces, which is worse than waiting.
 *
 * Deltas are forwarded verbatim; `cleanAnswer` runs once at the end, because a
 * model that opens with ``` can only be detected with the whole text in hand.
 */
export async function* runActionStream(
  req: AiRequest,
  deps: ActionDeps,
): AsyncGenerator<AiStreamEvent> {
  const adapter = deps.adapter;
  const base: Base = { provider: adapter.config.id, model: adapter.config.model };
  const started = deps.now?.() ?? Date.now();
  const stamp = (r: Omit<AiResult, keyof Base | "ms">): AiResult => ({
    ...base,
    ...r,
    ms: (deps.now?.() ?? Date.now()) - started,
  });

  if (!TEXT_ACTIONS.has(req.action)) {
    const result = await runAction(req, deps);
    yield result.ok ? { type: "done", result } : { type: "error", result };
    return;
  }

  yield { type: "meta", provider: base.provider, model: base.model };

  const missing = missingField(req);
  if (missing) {
    yield { type: "error", result: stamp({ ok: false, error: missing }) };
    return;
  }

  const max = deps.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  const clamped = clampInput(req.text ?? "", max);
  if (!clamped.text.trim()) {
    yield {
      type: "error",
      result: stamp({ ok: false, error: `nothing to ${ACTION_LABEL[req.action]}` }),
    };
    return;
  }

  const messages = promptFor(req.action, {
    text: clamped.text,
    targetLang: req.targetLang,
    tone: req.tone,
  });

  let raw = "";
  try {
    for await (const delta of adapter.stream({
      model: adapter.config.model,
      messages,
      temperature: actionTemperature(req.action),
      signal: deps.signal,
    })) {
      if (delta.done) break;
      if (!delta.text) continue;
      raw += delta.text;
      yield { type: "delta", text: delta.text };
    }
  } catch (e) {
    // A cancellation is not a failure: the user pressed Stop.
    yield { type: "error", result: stamp({ ok: false, error: describeError(e) }) };
    return;
  }

  const answer = cleanAnswer(raw);
  if (!answer) {
    yield { type: "error", result: stamp({ ok: false, error: "the model returned no text" }) };
    return;
  }

  yield {
    type: "done",
    result: stamp({
      ok: true,
      text: clamped.truncated ? `${answer}\n\n${clamped.notice}` : answer,
      // A streamed response carries no usage block from a local server, so
      // tokens stay null and the character count is the honest number.
      usage: { promptTokens: null, completionTokens: null, chars: answer.length },
    }),
  };
}

/** One human line for the UI toast. Never a stack, never a secret. */
export function describeError(e: unknown): string {
  if (e instanceof AiJsonError) return "the model did not return readable JSON";
  if (isAiError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

// ─────────────────────────────────────────────────────────────────────────────
// Text actions
// ─────────────────────────────────────────────────────────────────────────────

async function textAction(
  req: AiRequest,
  deps: ActionDeps,
  base: Base,
): Promise<Omit<AiResult, keyof Base | "ms">> {
  const missing = missingField(req);
  if (missing) return { ok: false, error: missing };

  const max = deps.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  const clamped = clampInput(req.text ?? "", max);
  if (!clamped.text.trim()) return { ok: false, error: `nothing to ${ACTION_LABEL[req.action]}` };

  const messages = promptFor(req.action, {
    text: clamped.text,
    targetLang: req.targetLang,
    tone: req.tone,
  });
  const usage = { promptTokens: null as number | null, completionTokens: null as number | null };
  const raw = await chat(deps, req, messages, req.action, (u) => {
    usage.promptTokens = u.promptTokens;
    usage.completionTokens = u.completionTokens;
  });
  const answer = cleanAnswer(raw);
  if (!answer) return { ok: false, error: "the model returned no text" };

  return {
    ok: true,
    text: clamped.truncated ? `${answer}\n\n${clamped.notice}` : answer,
    usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, chars: answer.length },
  };
}

const ACTION_LABEL: Record<AiAction, string> = {
  summarize: "summarize",
  translate: "translate",
  fixGrammar: "fix grammar",
  changeTone: "change the tone of",
  autofill: "fill this row",
  askWorkspace: "ask the workspace",
};

function missingField(req: AiRequest): string | null {
  if (req.action === "translate" && !(req.targetLang ?? "").trim()) {
    return "translate needs a target language (targetLang)";
  }
  if (req.action === "changeTone" && !(req.tone ?? "").trim()) {
    return "changeTone needs a tone (tone), e.g. \"formal\" or \"concise\"";
  }
  return null;
}

function chat(
  deps: ActionDeps,
  req: AiRequest,
  messages: ChatMessage[],
  action: AiAction,
  onUsage?: (u: { promptTokens: number | null; completionTokens: number | null }) => void,
): Promise<string> {
  return deps.adapter.chat({
    model: deps.adapter.config.model,
    messages,
    temperature: actionTemperature(action),
    jsonMode: action === "autofill",
    signal: deps.signal,
    onUsage,
  });
}

/**
 * Cap the payload. A local model has a small context and a big page: cut on a
 * line boundary and say so, rather than sending an unbounded document and
 * getting a truncation error back from the server.
 */
export function clampInput(
  text: string,
  max: number = DEFAULT_MAX_INPUT_CHARS,
): { text: string; truncated: boolean; notice: string; charsIn: number } {
  const limit = Math.max(200, Math.floor(max));
  const charsIn = text.length;
  if (charsIn <= limit) {
    return { text, truncated: false, notice: "", charsIn };
  }
  const cut = text.slice(0, limit);
  const nl = cut.lastIndexOf("\n");
  const body = nl > limit * 0.8 ? cut.slice(0, nl) : cut;
  const notice = `⚠ Input truncated to ${limit} of ${charsIn} characters — the answer covers only the first part.`;
  return { text: body, truncated: true, notice, charsIn };
}

/**
 * Turn model output into answer text: unwrap a fenced block, drop the preamble
 * and the closing pleasantries, drop wrapping quotes.
 */
export function cleanAnswer(text: string): string {
  if (!text) return "";
  let s = text.replace(/^\uFEFF/, "");

  const trimmed = s.trim();
  const fence = /^```[ \t]*[a-zA-Z0-9_+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  if (fence?.[1]) s = fence[1];
  s = s.replace(/```[a-zA-Z0-9_+-]*/g, "");

  const lines = s.split(/\r?\n/);
  while (lines.length && isPreambleLine(lines[0] ?? "")) lines.shift();
  while (lines.length && isCloserLine(lines[lines.length - 1] ?? "")) lines.pop();
  while (lines.length && (lines[0] ?? "").trim() === "") lines.shift();
  while (lines.length && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();

  let out = lines.join("\n").trim();
  if (out.length > 1 && out.startsWith('"') && out.endsWith('"') && !/[^"]"[^"]/.test(out.slice(1, -1))) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

const PREAMBLE_HEAD =
  /^(?:sure|okay|ok|certainly|of course|absolutely|no problem|done|sure thing|here|here's|here’s|this is|these are|the following|below is|below are|find below|output|result|summary|translation|rewrite|rewritten text|corrected text|fixed text|updated text)\b/i;
const PREAMBLE_TAIL =
  /\b(here|here's|here’s|is|are|following|below|summary|translation|rewrite|rewritten|corrected|fixed|updated|cleaned|improved|text|answer|output|result|version|notes|points)\b/i;

function isPreambleLine(line: string): boolean {
  const t = line.trim();
  if (t === "") return true;
  if (t.length > 160) return false;
  if (t.startsWith("-") || t.startsWith("*") || t.startsWith("#")) return false;
  if (/:\s*$/.test(t)) return PREAMBLE_HEAD.test(t) || PREAMBLE_TAIL.test(t);
  // "Sure, here is the summary" with no colon: only a short meta sentence.
  return /^(sure|okay|ok|certainly|of course|absolutely|no problem|done)\b/i.test(t) &&
    t.split(/\s+/).length <= 12;
}

function isCloserLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  return /^(i hope|we hope|hope (?:this|that) helps|let me know|feel free to ask|if you (?:need|want|have) (?:any|more)|enjoy!|cheers)/i.test(t);
}

// ─────────────────────────────────────────────────────────────────────────────
// autofill
// ─────────────────────────────────────────────────────────────────────────────

async function autofillAction(
  req: AiRequest,
  deps: ActionDeps,
  base: Base,
): Promise<Omit<AiResult, keyof Base | "ms">> {
  if (!deps.getRowContext) return { ok: false, error: "autofill needs a row context (getRowContext)" };
  const rowId = req.rowId;
  if (!rowId) return { ok: false, error: "autofill needs a rowId" };

  const ctx = await deps.getRowContext(rowId);
  if (!ctx) return { ok: false, error: `row ${rowId} not found` };
  const properties = ctx.properties ?? [];
  if (!properties.length) return { ok: false, error: "this database has no properties to fill" };

  const cap = Math.min(
    deps.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS,
    DEFAULT_AUTOFILL_CONTEXT_CHARS,
  );
  const page = clampInput(req.text ?? "", cap);
  const messages = autofillPrompt({
    title: ctx.title,
    values: ctx.values ?? {},
    properties,
    contextText: page.text,
  });

  const raw = await deps.adapter.chat({
    model: deps.adapter.config.model,
    messages,
    temperature: actionTemperature("autofill"),
    jsonMode: true,
  });

  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch (e) {
    return {
      ok: false,
      error: describeError(e),
      text: `Model said: ${preview(raw)}`,
    };
  }

  const filled = validateAutofill(parsed, properties);
  const count = Object.keys(filled.values).length;
  const notes = [...filled.warnings];
  if (page.truncated) notes.push(page.notice);

  if (!count) {
    return {
      ok: false,
      error: notes.length
        ? `no value survived validation — ${notes.join("; ")}`
        : "the model filled nothing",
      text: notes.join("\n"),
    };
  }
  const result: Omit<AiResult, keyof Base | "ms"> = { ok: true, values: filled.values };
  if (notes.length) result.text = notes.join("\n");
  return result;
}

export interface ValidatedAutofill {
  /** propId -> validated value, ready for `setPropertyValue` */
  values: Record<string, PropertyValueInput>;
  /** one line per dropped key/value, for the UI */
  warnings: string[];
}

/**
 * The core guard: model JSON in, database values out.
 *
 * Nothing leaves this function for a property that does not exist, and nothing
 * leaves for a select/multi_select/status whose value is not an existing option
 * name. Numbers and checkboxes are coerced, dates are parsed into epoch-ms
 * ranges, and every drop is explained in `warnings`.
 */
export function validateAutofill(
  raw: unknown,
  properties: PropertyDef[],
): ValidatedAutofill {
  const values: Record<string, PropertyValueInput> = {};
  const warnings: string[] = [];
  const obj = normalizeAutofillShape(raw);
  if (!obj) {
    warnings.push("the model returned something that is not a property map");
    return { values, warnings };
  }

  for (const [key, value] of Object.entries(obj)) {
    const prop = resolveProperty(properties, key);
    if (!prop) {
      warnings.push(`"${key}" is not a property of this database — dropped`);
      continue;
    }
    if (!isAutofillable(prop)) {
      warnings.push(`"${prop.name}" is a ${prop.type} property and cannot be filled — dropped`);
      continue;
    }
    if (value === null || value === undefined || value === "") continue;

    const coerced = coerceValue(prop, value);
    if (!coerced.ok) {
      warnings.push(`"${prop.name}": ${coerced.reason} — dropped`);
      continue;
    }
    values[prop.id] = coerced.value;
    if (coerced.note) warnings.push(`${prop.name}: ${coerced.note}`);
  }
  return { values, warnings };
}

/** Accept `{"Prop": v}` and `[{prop, value}]` and `{"values": {...}}`. */
function normalizeAutofillShape(raw: unknown): Record<string, unknown> | null {
  if (isRecord(raw)) {
    const wrapped = ["values", "fields", "properties", "autofill", "data", "updates", "row", "result"]
      .map((k) => raw[k])
      .find((v) => isRecord(v));
    if (isRecord(wrapped)) return { ...raw, ...wrapped };
    return raw;
  }
  if (Array.isArray(raw)) {
    const out: Record<string, unknown> = {};
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const key = item.prop ?? item.property ?? item.name ?? item.key;
      if (typeof key !== "string") continue;
      out[key] = item.value ?? item.v ?? item.val;
    }
    return Object.keys(out).length ? out : null;
  }
  return null;
}

/** Name (exact, trimmed, case- and punctuation-insensitive), then id. */
export function resolveProperty(properties: PropertyDef[], key: string): PropertyDef | null {
  const exact = properties.find((p) => p.name === key);
  if (exact) return exact;
  const trimmed = key.trim();
  const byTrimmed = properties.find((p) => p.name.trim() === trimmed);
  if (byTrimmed) return byTrimmed;
  const lower = trimmed.toLowerCase();
  const byCase = properties.find((p) => p.name.trim().toLowerCase() === lower);
  if (byCase) return byCase;
  const byId = properties.find((p) => p.id === key || p.id === trimmed);
  if (byId) return byId;
  const loose = normalizeWord(trimmed);
  const byLoose = properties.find((p) => normalizeWord(p.name) === loose);
  return byLoose ?? null;
}

function normalizeWord(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

type Coercion =
  | { ok: true; value: PropertyValueInput; note?: string }
  | { ok: false; reason: string };

const drop = (reason: string): Coercion => ({ ok: false, reason });

export function coerceValue(prop: PropertyDef, value: unknown): Coercion {
  switch (prop.type) {
    case "title":
    case "text":
    case "phone": {
      const s = asText(value);
      if (s === null) return drop(`expected text, got ${shapeOf(value)}`);
      if (!s.trim()) return drop("value is empty");
      return { ok: true, value: s.trim() };
    }

    case "url": {
      const s = asText(value);
      if (s === null) return drop(`expected a URL, got ${shapeOf(value)}`);
      const url = s.trim();
      if (!/^[a-z]+:\/\//i.test(url)) return drop(`"${truncateText(url, 60)}" is not a URL`);
      return { ok: true, value: url };
    }

    case "email": {
      const s = asText(value);
      if (s === null) return drop(`expected an email, got ${shapeOf(value)}`);
      const email = s.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        return drop(`"${truncateText(email, 60)}" is not an email address`);
      }
      return { ok: true, value: email };
    }

    case "number":
    case "unique_id": {
      const n = coerceNumber(value);
      if (n === null) return drop(`"${truncateText(asText(value) ?? shapeOf(value), 40)}" is not a number`);
      return { ok: true, value: n };
    }

    case "checkbox": {
      const b = coerceBool(value);
      if (b === null) return drop(`"${truncateText(asText(value) ?? shapeOf(value), 40)}" is not true/false`);
      return { ok: true, value: b };
    }

    case "date": {
      const d = parseDateValue(value);
      if (!d) {
        return drop(`"${truncateText(asText(value) ?? shapeOf(value), 40)}" is not a date (use YYYY-MM-DD)`);
      }
      return { ok: true, value: d };
    }

    case "select":
    case "status": {
      const options = selectOptions(prop);
      if (!options.length) return drop("this property has no options to choose from");
      const candidates = Array.isArray(value) ? value : [value];
      for (const c of candidates) {
        const opt = matchOption(String(c ?? ""), options);
        if (opt) return { ok: true, value: [opt.id] };
      }
      const asked = candidates.map((c) => String(c ?? "")).join(", ");
      return drop(
        `"${truncateText(asked, 60)}" is not an existing option (allowed: ${options.map((o) => o.name).join(", ")})`,
      );
    }

    case "multi_select": {
      const options = selectOptions(prop);
      if (!options.length) return drop("this property has no options to choose from");
      const asked = (Array.isArray(value) ? value : [value]).map((v) => String(v ?? "")).filter(Boolean);
      const ids: string[] = [];
      const missed: string[] = [];
      for (const a of asked) {
        const opt = matchOption(a, options);
        if (opt) {
          if (!ids.includes(opt.id)) ids.push(opt.id);
        } else missed.push(a);
      }
      if (!ids.length) {
        return drop(
          `none of (${truncateText(missed.join(", "), 60)}) are existing options (allowed: ${options.map((o) => o.name).join(", ")})`,
        );
      }
      const allowed = options.map((o) => o.name).join(", ");
      const note = missed.length
        ? `"${truncateText(missed.join(", "), 60)}" is not an existing option (allowed: ${allowed}) — skipped`
        : undefined;
      return { ok: true, value: ids as PropertyValueInput, note };
    }

    case "relation": {
      const rows = Array.isArray(value)
        ? value.map(String)
        : isRecord(value) && Array.isArray((value as { rows?: unknown[] }).rows)
          ? ((value as { rows: unknown[] }).rows as unknown[]).map(String)
          : typeof value === "string"
            ? [value]
            : null;
      if (!rows) return drop(`expected linked rows, got ${shapeOf(value)}`);
      const clean = rows.filter((r) => r.trim());
      if (!clean.length) return drop("no rows to link");
      return { ok: true, value: { rows: clean } };
    }

    case "files": {
      const ids = Array.isArray(value)
        ? value.map(String)
        : isRecord(value) && Array.isArray((value as { mediaIds?: unknown[] }).mediaIds)
          ? ((value as { mediaIds: unknown[] }).mediaIds as unknown[]).map(String)
          : null;
      if (!ids) return drop(`expected media ids, got ${shapeOf(value)}`);
      const clean = ids.filter((m) => m.trim());
      if (!clean.length) return drop("no files to attach");
      return { ok: true, value: { mediaIds: clean } };
    }

    default:
      return drop(`${prop.type} properties are not editable by autofill`);
  }
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

function shapeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "an object";
  return typeof value;
}

function truncateText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** "1,200", "$ 1 200.50", "42 kg", "3" → numbers. Words that are not → null. */
export function coerceNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "string") return null;

  const words = value.trim().toLowerCase();
  const wordNumbers: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  if (wordNumbers[words] !== undefined) return wordNumbers[words] ?? null;

  // keep digits, signs, separators; drop currency and unit words
  const cleaned = value.replace(/[^\d.,\-+eE]/g, "").trim();
  if (!cleaned) return null;

  // "1.200,50" (European) → 1200.5; "1,200.50" → 1200.5; "1,200" → 1200
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized = cleaned;
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      normalized = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = cleaned.replace(/,/g, "");
    }
  } else if (lastComma > -1) {
    const decimals = cleaned.length - lastComma - 1;
    normalized = decimals > 0 && decimals <= 2 && !/,\d{3}(?!\d)/.test(cleaned)
      ? cleaned.replace(",", ".")
      : cleaned.replace(/,/g, "");
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export function coerceBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 0 ? false : value === 1 ? true : null;
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase().replace(/[.'’]$/, "");
  if (["true", "yes", "y", "1", "on", "checked", "done", "complete", "completed", "x"].includes(s)) {
    return true;
  }
  if (["false", "no", "n", "0", "off", "unchecked", "not checked", "open", "todo", "to-do"].includes(s)) {
    return false;
  }
  return null;
}

export interface DateValue {
  start: number | null;
  end: number | null;
  allDay: boolean;
}

const DAY_MS = 86_400_000;
const RELATIVE_DAYS: Record<string, number> = {
  today: 0,
  tomorrow: 1,
  yesterday: -1,
  now: 0,
};

/**
 * Parse a date into the `{start, end, allDay}` shape, in epoch ms.
 * Accepts an existing date object, epoch ms, ISO date, ISO date-time, ISO
 * interval, `YYYY-MM-DD -> YYYY-MM-DD`, `MM/DD/YYYY`, `DD.MM.YYYY`,
 * "March 5, 2024", and today/tomorrow/yesterday.
 */
export function parseDateValue(value: unknown, now: number = Date.now()): DateValue | null {
  if (isRecord(value)) {
    const start = parseOneDate(value.start ?? value.date ?? value.from, now);
    if (!start) return null;
    const endRaw = value.end ?? value.to;
    const end = endRaw == null ? null : parseOneDate(endRaw, now);
    const allDay =
      typeof value.allDay === "boolean" ? value.allDay : start.allDay && (!end || end.allDay);
    return { start: start.ms, end: end?.ms ?? null, allDay };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // a bare number is epoch seconds below 1e11 (year 5138 in ms), else ms
    const ms = Math.abs(value) < 1e11 ? value * 1000 : value;
    return { start: ms, end: null, allDay: false };
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;

  // ISO 8601 interval: 2024-03-05/2024-03-08
  const interval = /^(\d{4}-\d{1,2}-\d{1,2}(?:[T ][^\s/]+)?)\s*\/\s*(\d{4}-\d{1,2}-\d{1,2}(?:[T ][^\s/]+)?)$/.exec(text);
  if (interval) {
    const a = parseOneDate(interval[1] ?? "", now);
    const b = parseOneDate(interval[2] ?? "", now);
    if (a && b) return { start: a.ms, end: b.ms, allDay: a.allDay && b.allDay };
    return null;
  }

  const parts = text.split(/\s*(?:→|->|⇒|--|–|—|\.\.\.|\bto\b|~)\s*/i);
  if (parts.length >= 2 && parts.every((p) => p.trim())) {
    const a = parseOneDate(parts[0] ?? "", now);
    const b = parseOneDate(parts[parts.length - 1] ?? "", now);
    if (a && b) return { start: a.ms, end: b.ms, allDay: a.allDay && b.allDay };
  }

  const single = parseOneDate(text, now);
  if (!single) return null;
  return { start: single.ms, end: null, allDay: single.allDay };
}

interface ParsedDate {
  ms: number;
  allDay: boolean;
}

function parseOneDate(raw: unknown, now: number): ParsedDate | null {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = Math.abs(raw) < 1e11 ? raw * 1000 : raw;
    return { ms, allDay: false };
  }
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!s) return null;

  if (RELATIVE_DAYS[s] !== undefined) {
    const d = new Date(now + (RELATIVE_DAYS[s] ?? 0) * DAY_MS);
    return { ms: startOfDay(d), allDay: true };
  }
  if (s === "next week") {
    const d = new Date(now + 7 * DAY_MS);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 1); // next Monday
    return { ms: startOfDay(d), allDay: true };
  }

  const iso =
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[Tt ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(z|[+-]\d{2}:?\d{2})?)?/.exec(s);
  if (iso) {
    const y = Number(iso[1]);
    const mo = Number(iso[2]);
    const d = Number(iso[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    if (iso[4] == null) return { ms: new Date(y, mo - 1, d).getTime(), allDay: true };
    const h = Number(iso[4]);
    const mi = Number(iso[5]);
    const sec = Number(iso[6] ?? 0);
    if (h > 23 || mi > 59 || sec > 60) return null;
    const zone = iso[7];
    if (!zone) return { ms: new Date(y, mo - 1, d, h, mi, sec).getTime(), allDay: false };
    const offset = zone === "z" ? 0 : zoneOffsetMinutes(zone);
    return { ms: Date.UTC(y, mo - 1, d, h, mi, sec) - offset * 60_000, allDay: false };
  }

  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); // MM/DD/YYYY
  if (slash) {
    const mo = Number(slash[1]);
    const d = Number(slash[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { ms: new Date(Number(slash[3]), mo - 1, d).getTime(), allDay: true };
  }
  const dot = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s); // DD.MM.YYYY
  if (dot) {
    const mo = Number(dot[2]);
    const d = Number(dot[1]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { ms: new Date(Number(dot[3]), mo - 1, d).getTime(), allDay: true };
  }

  const parsed = Date.parse(s);
  if (Number.isFinite(parsed)) {
    const hasTime = /\d{1,2}:\d{2}/.test(s);
    return { ms: parsed, allDay: !hasTime };
  }
  return null;
}

function startOfDay(d: Date): number {
  const local = new Date(d.getTime());
  local.setHours(0, 0, 0, 0);
  return local.getTime();
}

function zoneOffsetMinutes(zone: string): number {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

// ─────────────────────────────────────────────────────────────────────────────
// select / status options
// ─────────────────────────────────────────────────────────────────────────────

export function selectOptions(prop: PropertyDef): SelectOption[] {
  const config = prop.config as {
    options?: SelectOption[];
    groups?: { options?: SelectOption[] }[];
  };
  if (Array.isArray(config.options)) return config.options.filter((o) => o?.id && o?.name);
  if (Array.isArray(config.groups)) {
    return config.groups.flatMap((g) => (Array.isArray(g?.options) ? g.options : []));
  }
  return [];
}

/**
 * Map a model's words onto a real option. Exact id, exact name, name ignoring
 * case, then name ignoring punctuation — in that order, so "in progress" finds
 * "In-Progress" and a made-up name finds nothing.
 */
export function matchOption(ref: string, options: SelectOption[]): SelectOption | null {
  const raw = (ref ?? "").trim();
  if (!raw) return null;
  const byId = options.find((o) => o.id === raw);
  if (byId) return byId;
  const byName = options.find((o) => o.name === raw);
  if (byName) return byName;
  const lower = raw.toLowerCase();
  const byLower = options.find((o) => o.name.trim().toLowerCase() === lower);
  if (byLower) return byLower;
  const loose = normalizeWord(raw);
  if (!loose) return null;
  const byLoose = options.find((o) => normalizeWord(o.name) === loose);
  return byLoose ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// askWorkspace
// ─────────────────────────────────────────────────────────────────────────────

async function askWorkspaceAction(
  req: AiRequest,
  deps: ActionDeps,
  base: Base,
): Promise<Omit<AiResult, keyof Base | "ms">> {
  if (!deps.retrieve) return { ok: false, error: "no embedding index" };

  const question = (req.question ?? req.text ?? "").trim();
  if (!question) return { ok: false, error: "askWorkspace needs a question" };

  const k = Math.max(1, Math.min(MAX_SOURCES, deps.k ?? DEFAULT_RETRIEVAL_K));
  const hits = normalizeHits(await deps.retrieve(question, k));
  if (!hits.length) {
    return { ok: false, error: "nothing in the index matches that question", sources: [] };
  }
  const sources: PromptSource[] = hits.slice(0, MAX_SOURCES);

  const messages = promptFor("askWorkspace", { question, sources });
  const answer = cleanAnswer(await chat(deps, req, messages, "askWorkspace"));
  if (!answer) return { ok: false, error: "the model returned no text" };

  const cited = citedSources(answer, sources);
  return { ok: true, text: answer, sources: cited };
}

/** `[2]`, `[1, 3]`, `[1][2]` → source entries, in source order, deduped. */
export function extractCitations(text: string): number[] {
  const found = new Set<number>();
  const groups = /\[\s*(\d{1,2}(?:\s*[,;]\s*\d{1,2})*)\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = groups.exec(text))) {
    for (const part of (m[1] ?? "").split(/[,;\s]+/)) {
      const n = Number(part);
      if (Number.isInteger(n) && n >= 1) found.add(n);
    }
  }
  return [...found].sort((a, b) => a - b);
}

export function citedSources(
  text: string,
  sources: PromptSource[],
): { node_id: string; title: string; snippet: string }[] {
  const cited = extractCitations(text);
  return cited
    .map((n) => sources[n - 1])
    .filter((s): s is PromptSource => Boolean(s))
    .map((s) => ({
      node_id: s.node_id,
      title: s.title || "Untitled",
      snippet: truncateText(s.text.trim(), SNIPPET_CHARS),
    }));
}

function preview(raw: string): string {
  const flat = (raw ?? "").replace(/\s+/g, " ").trim();
  return flat.length > 240 ? `${flat.slice(0, 240)}…` : flat;
}
