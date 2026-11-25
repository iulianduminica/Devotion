/**
 * Prompt templates for the AI actions.
 *
 * Two rules run through all of them, because local models are the target and
 * they are the models that love preambles:
 *   - answer text only, never "Here is the summary:";
 *   - for structured actions, JSON only, keyed by the exact property names the
 *     caller supplies, with the option names spelled out so a select value
 *     cannot be invented.
 *
 * Every builder returns `ChatMessage[]` so the caller can pass it straight to
 * `adapter.chat()` / `adapter.stream()`.
 */

import type { PropertyDef } from "../../shared/types.ts";
import type { ChatMessage } from "./providers.ts";
import type { AiAction } from "../../shared/types.ts";

/** The line that keeps preamble out. Repeated in the user turn on purpose. */
const ANSWER_ONLY =
  "Return ONLY the transformed text. No preamble, no explanation, no quotes around it, no markdown fence, no headings, no closing remarks.";

const FIDELITY =
  "Keep every fact, name, number, date, code identifier and URL exactly as written. Do not add information that is not in the text.";

export const DEFAULT_SUMMARY_BULLETS = 5;
export const MAX_SOURCE_CHARS = 1200;

const system = (content: string): ChatMessage => ({ role: "system", content });
const user = (content: string): ChatMessage => ({ role: "user", content });

// ─────────────────────────────────────────────────────────────────────────────
// Text actions
// ─────────────────────────────────────────────────────────────────────────────

export function summarizePrompt(
  text: string,
  opts: { bullets?: number; language?: string } = {},
): ChatMessage[] {
  const bullets = opts.bullets ?? DEFAULT_SUMMARY_BULLETS;
  const language = opts.language ? ` Write in ${opts.language}.` : "";
  return [
    system(
      [
        "You summarize notes inside a personal knowledge base.",
        `Produce at most ${bullets} short bullet points that capture the substance of the text: what happened, what was decided, what is owed by whom.${language}`,
        FIDELITY,
        ANSWER_ONLY,
        "Format each bullet as '- ' followed by the point.",
      ].join(" "),
    ),
    user(`Summarize this:\n\n${text}`),
  ];
}

export function translatePrompt(text: string, targetLang: string): ChatMessage[] {
  return [
    system(
      [
        `Translate the user's text into ${targetLang}.`,
        "Preserve the original structure: paragraph breaks, list items, headings and indentation stay where they are.",
        "Leave code blocks, URLs, file names, @-mentions, numbers and proper nouns untranslated.",
        FIDELITY,
        ANSWER_ONLY,
        `Output must contain only the ${targetLang} translation.`,
      ].join(" "),
    ),
    user(`Translate to ${targetLang}:\n\n${text}`),
  ];
}

export function fixGrammarPrompt(text: string): ChatMessage[] {
  return [
    system(
      [
        "Correct the grammar, spelling and punctuation of the user's text.",
        "Change as little as possible: keep the author's voice, word choice, tense and sentence length. Never rewrite style.",
        "Keep all formatting, line breaks, lists, code and URLs intact.",
        ANSWER_ONLY,
      ].join(" "),
    ),
    user(`Fix the grammar:\n\n${text}`),
  ];
}

export function changeTonePrompt(text: string, tone: string): ChatMessage[] {
  return [
    system(
      [
        `Rewrite the user's text in a ${tone} tone.`,
        "Keep the meaning, the facts and the length in the same ballpark. Keep lists as lists and code as code.",
        FIDELITY,
        ANSWER_ONLY,
      ].join(" "),
    ),
    user(`Rewrite in a ${tone} tone:\n\n${text}`),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Autofill
// ─────────────────────────────────────────────────────────────────────────────

export interface AutofillPromptInput {
  title: string;
  values: Record<string, unknown>;
  properties: PropertyDef[];
  contextText?: string;
  maxContextChars?: number;
}

/** One line per property: what it is called, what type it is, what it accepts. */
export function describeProperty(prop: PropertyDef, current: unknown): string {
  const bits: string[] = [`- "${prop.name}" (type: ${prop.type})`];
  const options = optionNames(prop);
  if (options.length) bits.push(`allowed values: ${JSON.stringify(options)}`);
  const currentText = formatCurrent(current);
  if (currentText) bits.push(`current: ${currentText}`);
  return bits.join(" — ");
}

export function optionNames(prop: PropertyDef): string[] {
  const config = prop.config as { options?: { name?: string }[]; groups?: { options?: { name?: string }[] }[] };
  if (Array.isArray(config.options)) {
    return config.options.map((o) => String(o?.name ?? "")).filter(Boolean);
  }
  if (Array.isArray(config.groups)) {
    return config.groups.flatMap((g) => (g?.options ?? []).map((o) => String(o?.name ?? "")).filter(Boolean));
  }
  return [];
}

function formatCurrent(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value ? JSON.stringify(truncate(value, 120)) : "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length ? JSON.stringify(value).slice(0, 120) : "";
  if (typeof value === "object") {
    const o = value as { start?: number | null; rows?: string[]; mediaIds?: string[] };
    if (o.start != null) return String(o.start);
    if (Array.isArray(o.rows)) return o.rows.length ? `${o.rows.length} linked` : "";
    if (Array.isArray(o.mediaIds)) return o.mediaIds.length ? `${o.mediaIds.length} files` : "";
  }
  return "";
}

export function autofillPrompt(input: AutofillPromptInput): ChatMessage[] {
  const max = input.maxContextChars ?? 6000;
  const lines = input.properties.map((p) => describeProperty(p, input.values[p.id]));
  const context = input.contextText ? `\n\nPage content:\n"""\n${truncate(input.contextText, max)}\n"""` : "";

  return [
    system(
      [
        "You fill in database properties for one row of a personal knowledge base.",
        "Reply with ONLY a JSON object. No prose, no markdown fence, no trailing commas.",
        "Keys must be property names from the list, spelled exactly as given.",
        "Value formats by type:",
        '  number -> a JSON number, no quotes, no unit ("12.5", not "12.5 kg");',
        "  checkbox -> true or false;",
        '  date -> "YYYY-MM-DD", or "YYYY-MM-DD -> YYYY-MM-DD" for a range, or "today";',
        "  select / status -> exactly one of the allowed values, copied verbatim;",
        "  multi_select -> an array of allowed values copied verbatim;",
        '  title / text / url / email / phone -> a plain string.',
        "Never invent a value for select, status or multi_select. If nothing in the page supports a property, leave that key out — an omitted key is better than a guess.",
        "Fill at most the properties the evidence supports.",
      ].join("\n"),
    ),
    user(
      [
        `Row title: ${input.title || "(untitled)"}`,
        "",
        "Properties:",
        ...lines,
        context,
        "",
        "Return the JSON object now. Keys are property names, values follow the type rules above.",
      ].join("\n"),
    ),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Q&A
// ─────────────────────────────────────────────────────────────────────────────

export interface PromptSource {
  node_id: string;
  title: string;
  text: string;
  score: number;
}

export function formatSources(sources: PromptSource[]): string {
  return sources
    .map((s, i) => {
      const body = truncate(s.text.trim(), MAX_SOURCE_CHARS);
      const head = `[${i + 1}] ${s.title || "Untitled"}`;
      return body ? `${head}\n${body}` : head;
    })
    .join("\n\n");
}

export function askWorkspacePrompt(question: string, sources: PromptSource[]): ChatMessage[] {
  return [
    system(
      [
        "You answer questions about the user's own notes, using only the numbered sources provided.",
        "Cite every statement with the source number in square brackets, e.g. [2]. Cite at least one source in every factual sentence.",
        "If the sources do not contain the answer, say exactly what is missing instead of guessing. Never cite a number that was not given.",
        "Answer in plain prose, 2-6 sentences, no preamble.",
      ].join(" "),
    ),
    user(
      [
        "Sources:",
        formatSources(sources),
        "",
        `Question: ${question}`,
        "",
        "Answer with citations [n].",
      ].join("\n"),
    ),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

export interface PromptInput {
  text?: string;
  targetLang?: string;
  tone?: string;
  question?: string;
  sources?: PromptSource[];
  autofill?: AutofillPromptInput;
}

/** Sampling knobs per action: rewriting wants determinism, tone wants range. */
export function actionTemperature(action: AiAction): number {
  switch (action) {
    case "summarize":
      return 0.2;
    case "translate":
    case "fixGrammar":
      return 0.1;
    case "changeTone":
      return 0.5;
    case "autofill":
      return 0;
    case "askWorkspace":
      return 0.2;
  }
}

export function promptFor(action: AiAction, input: PromptInput): ChatMessage[] {
  switch (action) {
    case "summarize":
      return summarizePrompt(input.text ?? "");
    case "translate":
      return translatePrompt(input.text ?? "", input.targetLang || "English");
    case "fixGrammar":
      return fixGrammarPrompt(input.text ?? "");
    case "changeTone":
      return changeTonePrompt(input.text ?? "", input.tone || "friendly");
    case "autofill":
      if (!input.autofill) throw new Error("promptFor: autofill input missing");
      return autofillPrompt(input.autofill);
    case "askWorkspace":
      return askWorkspacePrompt(input.question ?? "", input.sources ?? []);
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…truncated…`;
}

/** Values that autofill must not touch: computed, audit, or user-driven. */
export const NON_AUTOFILL_TYPES: readonly string[] = [
  "formula",
  "rollup",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
  "button",
  "unique_id",
];

export function isAutofillable(prop: PropertyDef): boolean {
  return !NON_AUTOFILL_TYPES.includes(prop.type);
}
