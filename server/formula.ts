/**
 * Formula property engine: hand-written lexer + recursive-descent parser +
 * tree-walking evaluator for the Strata formula language.
 *
 * Formula source is untrusted user text. It is parsed into the shared
 * `FormulaNode` AST and interpreted. There is no `eval`, no `new Function`,
 * no dynamic import, no code generation of any kind in this file.
 *
 * The AST union in `shared/types.ts` is frozen, so every construct has to be
 * expressible with `num | str | bool | prop | call | bin | un | paren`:
 *   - a `null` literal is `{ k: "call", name: "null", args: [] }`
 *   - a `null`ary call to an unknown name is rejected at parse time
 *
 * See `server/formula-README.md` for the language reference.
 */

import type { FormulaNode } from "../shared/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** A Strata date value: a millisecond range, optionally all-day. */
export interface DateValue {
  start: number | null;
  end: number | null;
  allDay: boolean;
}

/**
 * A list. Not part of the spec's `FormulaValue` union, but the language needs
 * them: `list(...)`, `join(list, sep)`, `empty([])`, and `length()` of a
 * relation all have to flow through the evaluator. `FormulaValue` is extended
 * with it, so every value the app hands in (`string[]`, `{ rows: string[] }`,
 * `{ mediaIds: string[] }`) has a home.
 */
export interface ListValue {
  items: FormulaValue[];
}

export type FormulaValue =
  | number
  | string
  | boolean
  | null
  | DateValue
  | ListValue;

export interface EvalContext {
  /** Property value by NAME. Missing property → return null (or throw). */
  prop(name: string): FormulaValue;
  /** Current time in epoch ms. Injected so formulas are testable. */
  today(): number;
  /** The raw row, for hosts that want to inspect it. Not used by the engine. */
  row?: Record<string, unknown>;
}

export interface FunctionSpec {
  name: string;
  signature: string;
  description: string;
  /** [minArgs, maxArgs]. 99 is the variadic ceiling. */
  argCount: [number, number];
}

/** Every error the engine raises is a FormulaError. */
export class FormulaError extends Error {
  code: string;
  position?: number;

  constructor(message: string, code: string, position?: number) {
    super(message);
    this.name = "FormulaError";
    this.code = code;
    if (position !== undefined) this.position = position;
    // Restore the prototype chain: tsx/esbuild targets ES2022, but subclassing
    // Error is still the kind of thing that breaks under downlevel transforms.
    Object.setPrototypeOf(this, FormulaError.prototype);
  }
}

/** Nesting cap. Enforced at parse time and again at eval time. */
export const MAX_DEPTH = 200;
/** Ceiling for variadic functions (`list`, `concat`, `sum`, `and`, …). */
export const MAX_ARGS = 99;

const MS_DAY = 86_400_000;
const MS_HOUR = 3_600_000;
const MS_MIN = 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// Value helpers (exported: the UI layer needs the same coercions)
// ─────────────────────────────────────────────────────────────────────────────

export function isDateValue(v: unknown): v is DateValue {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    "allDay" in v &&
    "start" in v &&
    "end" in v
  );
}

export function isListValue(v: unknown): v is ListValue {
  return (
    typeof v === "object" && v !== null && !Array.isArray(v) && "items" in v &&
    Array.isArray((v as { items: unknown }).items) && !("allDay" in v)
  );
}

export function listValue(items: FormulaValue[]): ListValue {
  return { items };
}

export function dateValue(start: number | null, end: number | null, allDay: boolean): DateValue {
  return { start, end, allDay };
}

/**
 * Accept anything the storage layer hands back and turn it into a
 * `FormulaValue`. Tolerated shapes: `Date`, `{start,end,allDay}`,
 * `{rows:[...]}` (relation), `{mediaIds:[...]}` (files), plain arrays
 * (multi_select), `undefined`.
 */
export function normalizeValue(v: unknown): FormulaValue {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "number") return Number.isFinite(v as number) ? (v as number) : null;
  if (t === "string" || t === "boolean") return v as string | boolean;
  if (Array.isArray(v)) return listValue(v.map((x) => normalizeValue(x)));
  if (v instanceof Date) {
    const ms = v.getTime();
    return dateValue(Number.isNaN(ms) ? null : ms, null, false);
  }
  if (t === "object") {
    const o = v as Record<string, unknown>;
    if (isDateValue(o)) return dateValue(numOrNull(o.start), numOrNull(o.end), o.allDay === true);
    if (Array.isArray(o.rows)) return listValue((o.rows as unknown[]).map((x) => normalizeValue(x)));
    if (Array.isArray(o.mediaIds)) {
      return listValue((o.mediaIds as unknown[]).map((x) => normalizeValue(x)));
    }
    if (isListValue(o)) return listValue(o.items.map((x) => normalizeValue(x)));
    return JSON.stringify(o);
  }
  return null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Truthiness: `null`, `""`, `0`, `false`, `[]` and an empty date are false. */
export function truthy(v: FormulaValue): boolean {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "";
  if (isListValue(v)) return v.items.length > 0;
  if (isDateValue(v)) return v.start !== null;
  return false;
}

/** `empty()`'s rule, shared by `empty`, `notEmpty` and the coercion layer. */
export function isEmpty(v: FormulaValue): boolean {
  if (v === null) return true;
  if (typeof v === "string") return v === "";
  if (isListValue(v)) return v.items.length === 0;
  if (isDateValue(v)) return v.start === null && v.end === null;
  return false;
}

/** Number → text without thousands separators, and without float noise. */
export function numToString(n: number): string {
  if (!Number.isFinite(n)) throw new FormulaError(`Result is not a finite number (${n})`, "NOT_FINITE");
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(12)));
}

/** Text form of any value, used by `+` on strings, `toString`, `concat`. */
export function valueToString(v: FormulaValue): string {
  if (v === null) return "";
  if (typeof v === "number") return numToString(v);
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (isListValue(v)) return v.items.map(valueToString).join(", ");
  if (isDateValue(v)) return formatMs(v.start, v.allDay ? "YYYY-MM-DD" : "YYYY-MM-DD HH:mm");
  return "";
}

const STRICT_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Numeric coercion, the one documented rule:
 * number → itself, boolean → 1/0, null → 0, `""` → 0,
 * string → parsed only if it is fully numeric, else `TYPE_MISMATCH`.
 * Dates → their `start` (an empty date is a `TYPE_MISMATCH`).
 */
export function toNumber(v: FormulaValue, where = "numeric context"): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null) return 0;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return 0;
    if (!STRICT_NUMBER.test(s)) {
      throw new FormulaError(`Cannot use ${json(s)} as a number in ${where}`, "TYPE_MISMATCH");
    }
    const n = Number(s);
    if (!Number.isFinite(n)) throw new FormulaError(`Number out of range in ${where}`, "NOT_FINITE");
    return n;
  }
  if (isDateValue(v)) {
    throw new FormulaError(
      "A date is not a number; use dateDiff(), addDays() or toNumber() in " + where,
      "TYPE_MISMATCH",
    );
  }
  if (isListValue(v)) throw new FormulaError("A list has no numeric value", "TYPE_MISMATCH");
  throw new FormulaError(`Unsupported value in ${where}`, "TYPE_MISMATCH");
}

/** `toNumber()`'s rule: a date converts to its `.start` timestamp. */
function toNumberLoose(v: FormulaValue, where: string): number {
  if (isDateValue(v)) {
    if (v.start === null) throw new FormulaError("Empty date has no numeric value in " + where, "TYPE_MISMATCH");
    return v.start;
  }
  return toNumber(v, where);
}

function json(s: string): string {
  return JSON.stringify(s);
}

function checked(n: number, where: string): number {
  if (!Number.isFinite(n)) throw new FormulaError(`Result is not a finite number in ${where}`, "NOT_FINITE");
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers — all date math is UTC, so a formula returns the same thing
// on every machine and across DST changes.
// ─────────────────────────────────────────────────────────────────────────────

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/;

/**
 * Parse `"YYYY-MM-DD"` → all-day, `"YYYY-MM-DD HH:mm"` (or ISO `T`) → timed.
 * Both are read as UTC. Returns null when the string is not a date.
 */
export function parseDateLiteral(s: string): DateValue | null {
  const d = DATE_ONLY.exec(s);
  if (d) {
    const y = Number(d[1]), mo = Number(d[2]), day = Number(d[3]);
    if (mo < 1 || mo > 12 || day < 1 || day > daysInMonthUtc(y, mo - 1)) return null;
    const ms = Date.UTC(y, mo - 1, day);
    if (Number.isNaN(ms)) return null;
    return dateValue(ms, null, true);
  }
  const t = DATE_TIME.exec(s);
  if (t) {
    const y = Number(t[1]), mo = Number(t[2]), day = Number(t[3]);
    const h = Number(t[4]), mi = Number(t[5]);
    const sec = t[6] !== undefined ? Number(t[6]) : 0;
    const msPart = t[7] !== undefined ? Number(t[7]) : 0;
    if (mo < 1 || mo > 12 || day < 1 || day > daysInMonthUtc(y, mo - 1)) return null;
    if (h > 24 || mi > 59 || sec > 59) return null;
    const ms = Date.UTC(y, mo - 1, day, h, mi, sec, msPart);
    if (Number.isNaN(ms)) return null;
    return dateValue(ms, null, false);
  }
  return null;
}

function daysInMonthUtc(year: number, month0: number): number {
  // Date.UTC(year, month0+1, 0) = last day of month `month0`.
  const d = new Date(Date.UTC(year, month0 + 1, 0));
  return d.getUTCDate();
}

function parts(ms: number): {
  y: number; mo: number; d: number; h: number; mi: number; s: number; ms2: number;
} {
  const dt = new Date(ms);
  return {
    y: dt.getUTCFullYear(),
    mo: dt.getUTCMonth(),
    d: dt.getUTCDate(),
    h: dt.getUTCHours(),
    mi: dt.getUTCMinutes(),
    s: dt.getUTCSeconds(),
    ms2: dt.getUTCMilliseconds(),
  };
}

/** Shift by whole months, clamping the day-of-month (Jan 31 + 1mo → Feb 28). */
function addMonthsUtc(ms: number, months: number): number {
  const p = parts(ms);
  const total = p.mo + months;
  const yearShift = Math.floor(total / 12);
  const mo = ((total % 12) + 12) % 12;
  const year = p.y + yearShift;
  const day = Math.min(p.d, daysInMonthUtc(year, mo));
  const out = Date.UTC(year, mo, day, p.h, p.mi, p.s, p.ms2);
  if (!Number.isFinite(out)) throw new FormulaError("Date is out of range", "DATE_RANGE");
  return out;
}

const DATE_START_UNITS = ["day", "week", "month", "quarter", "year"] as const;
type DateStartUnit = (typeof DATE_START_UNITS)[number];

function startOfUtc(ms: number, unit: DateStartUnit): number {
  const p = parts(ms);
  switch (unit) {
    case "day":
      return Date.UTC(p.y, p.mo, p.d);
    case "week": {
      const dow = new Date(ms).getUTCDay(); // 0 = Sunday
      const monday = (dow + 6) % 7;
      return Date.UTC(p.y, p.mo, p.d - monday);
    }
    case "month":
      return Date.UTC(p.y, p.mo, 1);
    case "quarter":
      return Date.UTC(p.y, Math.floor(p.mo / 3) * 3, 1);
    case "year":
      return Date.UTC(p.y, 0, 1);
  }
}

function endOfUtc(ms: number, unit: DateStartUnit): number {
  // End = the last millisecond of the period, so a range's end stays inclusive.
  const q = parts(startOfUtc(ms, unit));
  switch (unit) {
    case "day":
      return Date.UTC(q.y, q.mo, q.d, 23, 59, 59, 999);
    case "week":
      return Date.UTC(q.y, q.mo, q.d + 6, 23, 59, 59, 999);
    case "month":
      return Date.UTC(q.y, q.mo, daysInMonthUtc(q.y, q.mo), 23, 59, 59, 999);
    case "quarter": {
      const lastMonth = q.mo + 2;
      return Date.UTC(q.y, lastMonth, daysInMonthUtc(q.y, lastMonth), 23, 59, 59, 999);
    }
    case "year":
      return Date.UTC(q.y, 11, 31, 23, 59, 59, 999);
  }
}

const DATE_DIFF_UNITS: Record<string, number> = {
  days: MS_DAY, day: MS_DAY,
  hours: MS_HOUR, hour: MS_HOUR,
  minutes: MS_MIN, minute: MS_MIN,
  seconds: 1000, second: 1000,
  weeks: 7 * MS_DAY, week: 7 * MS_DAY,
};

function asDate(v: FormulaValue, where: string): DateValue {
  if (isDateValue(v)) return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new FormulaError("Number is not a valid timestamp", "TYPE_MISMATCH");
    return dateValue(v, null, false);
  }
  if (typeof v === "string") {
    const d = parseDateLiteral(v);
    if (d) return d;
    throw new FormulaError(`${json(v)} is not a date in ${where}`, "TYPE_MISMATCH");
  }
  throw new FormulaError(`Expected a date in ${where}`, "TYPE_MISMATCH");
}

function dateStartMs(v: FormulaValue, where: string): number {
  const d = asDate(v, where);
  if (d.start === null) throw new FormulaError("Empty date has no start in " + where, "TYPE_MISMATCH");
  return d.start;
}

function unitOf(v: FormulaValue, allowed: readonly string[], where: string): string {
  if (typeof v !== "string") throw new FormulaError(`Expected a unit string in ${where}`, "TYPE_MISMATCH");
  const u = v.toLowerCase();
  if (!allowed.includes(u)) {
    throw new FormulaError(`Unknown unit ${json(v)} in ${where}; expected ${allowed.join(" | ")}`, "BAD_ARGS");
  }
  return u;
}

/** `YYYY MM DD HH mm` token substitution over a UTC timestamp. */
function formatMs(ms: number | null, pattern: string): string {
  if (ms === null) return "";
  const p = parts(ms);
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
  return pattern
    .replace(/YYYY/g, pad(p.y, 4))
    .replace(/MM/g, pad(p.mo + 1))
    .replace(/DD/g, pad(p.d))
    .replace(/HH/g, pad(p.h))
    .replace(/mm/g, pad(p.mi));
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparison & equality
// ─────────────────────────────────────────────────────────────────────────────

/** Compare two values; returns -1 | 0 | 1. Dates compare on `.start`. */
function compareValues(a: FormulaValue, b: FormulaValue): number {
  if (isDateValue(a) || isDateValue(b)) {
    const x = dateSortKey(a);
    const y = dateSortKey(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0; // code-unit order
  }
  if (isListValue(a) || isListValue(b)) {
    throw new FormulaError("Lists cannot be ordered; use length() or contains()", "TYPE_MISMATCH");
  }
  const x = toNumber(a, "comparison");
  const y = toNumber(b, "comparison");
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Empty dates sort first; a string that parses as a date joins the date order. */
function dateSortKey(v: FormulaValue): number {
  if (isDateValue(v)) return v.start === null ? -Infinity : v.start;
  if (typeof v === "string") {
    const d = parseDateLiteral(v);
    if (d) return d.start === null ? -Infinity : d.start;
  }
  return toNumber(v, "comparison");
}

function looseEqual(a: FormulaValue, b: FormulaValue): boolean {
  if (a === null || b === null) return a === b;
  if (isListValue(a) && isListValue(b)) {
    if (a.items.length !== b.items.length) return false;
    return a.items.every((x, i) => looseEqual(x, b.items[i]!));
  }
  if (isDateValue(a) || isDateValue(b)) return dateSortKey(a) === dateSortKey(b);
  if (isListValue(a) || isListValue(b)) return false;
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b;
  // number vs string, number vs bool, null-free mixed pair
  return toNumber(a, "equality") === toNumber(b, "equality");
}

/**
 * `+`:
 *  - any string-ish operand (string or date) → concatenation
 *  - otherwise numeric add, with the documented coercion rule
 */
function addValues(a: FormulaValue, b: FormulaValue): FormulaValue {
  const stringish = (v: FormulaValue) => typeof v === "string" || isDateValue(v);
  if (stringish(a) || stringish(b)) return valueToString(a) + valueToString(b);
  return checked(toNumber(a, "`+`") + toNumber(b, "`+`"), "`+`");
}

// ─────────────────────────────────────────────────────────────────────────────
// Function registry
// ─────────────────────────────────────────────────────────────────────────────

type FnImpl = (argv: FormulaValue[], ctx: EvalContext) => FormulaValue;

interface FunctionDef {
  spec: FunctionSpec;
  fn: FnImpl;
}

const DEFS: FunctionDef[] = [];
const REGISTRY: Map<string, FunctionDef> = new Map();

// `def` calls below run at module init, so REGISTRY is complete before any
// parse/eval can happen (the exports that read DEFS are declared after them).
function def(
  name: string,
  signature: string,
  description: string,
  argCount: [number, number],
  fn: FnImpl,
): void {
  const d: FunctionDef = { spec: { name, signature, description, argCount }, fn };
  DEFS.push(d);
  REGISTRY.set(name, d);
}

const VARIADIC: [number, number] = [1, MAX_ARGS];

// ── core ────────────────────────────────────────────────────────────────────

def("prop", 'prop("Name")', "Read a property value by name.", [1, 1], (argv, ctx) => {
  const name = argv[0];
  if (typeof name !== "string") throw new FormulaError("prop() needs a property name", "TYPE_MISMATCH");
  return normalizeValue(ctx.prop(name));
});

def("if", "if(cond, a, b)", "Return a when cond is true, else b. The untaken branch is never evaluated.", [2, 3],
  // placeholder: `if` is a special form and is handled in evalCall.
  () => {
    throw new FormulaError("if() is a special form", "INTERNAL");
  });

def("and", "and(a, b, ...)", "True when every argument is truthy. Short-circuits left to right.", [2, MAX_ARGS],
  () => {
    throw new FormulaError("and() is a special form", "INTERNAL");
  });

def("or", "or(a, b, ...)", "True when any argument is truthy. Short-circuits left to right.", [2, MAX_ARGS],
  () => {
    throw new FormulaError("or() is a special form", "INTERNAL");
  });

def("not", "not(x)", "Logical negation of a value's truthiness.", [1, 1], (argv) => !truthy(argv[0]!));

// ── arithmetic ──────────────────────────────────────────────────────────────

def("add", "add(a, b)", "Numeric add (coercing strings). Use `+` for text.", [2, 2], (argv) =>
  checked(toNumber(argv[0]!, "`add`") + toNumber(argv[1]!, "`add`"), "`add`"));

def("subtract", "subtract(a, b)", "a minus b.", [2, 2], (argv) =>
  checked(toNumber(argv[0]!, "`subtract`") - toNumber(argv[1]!, "`subtract`"), "`subtract`"));

def("multiply", "multiply(a, b)", "a times b.", [2, 2], (argv) =>
  checked(toNumber(argv[0]!, "`multiply`") * toNumber(argv[1]!, "`multiply`"), "`multiply`"));

def("divide", "divide(a, b)", "a divided by b. Division by zero is an error.", [2, 2], (argv) => {
  const d = toNumber(argv[1]!, "`divide`");
  if (d === 0) throw new FormulaError("Division by zero", "DIV_BY_ZERO");
  return checked(toNumber(argv[0]!, "`divide`") / d, "`divide`");
});

def("mod", "mod(a, b)", "Remainder of a / b (JS sign rules). b = 0 is an error.", [2, 2], (argv) => {
  const d = toNumber(argv[1]!, "`mod`");
  if (d === 0) throw new FormulaError("Modulo by zero", "DIV_BY_ZERO");
  return checked(toNumber(argv[0]!, "`mod`") % d, "`mod`");
});

def("abs", "abs(n)", "Absolute value.", [1, 1], (argv) => checked(Math.abs(toNumber(argv[0]!, "`abs`")), "`abs`"));
def("ceil", "ceil(n)", "Round up to the next integer.", [1, 1], (argv) =>
  checked(Math.ceil(toNumber(argv[0]!, "`ceil`")), "`ceil`"));
def("floor", "floor(n)", "Round down to the previous integer.", [1, 1], (argv) =>
  checked(Math.floor(toNumber(argv[0]!, "`floor`")), "`floor`"));
def("round", "round(n, places?)", "Round to `places` decimals (default 0). Half rounds away from zero.", [1, 2],
  (argv) => {
    const n = toNumber(argv[0]!, "`round`");
    const places = argv.length > 1 ? toNumber(argv[1]!, "`round`") : 0;
    if (!Number.isInteger(places) || places < 0 || places > 15) {
      throw new FormulaError("round() places must be an integer 0-15", "BAD_ARGS");
    }
    const f = Math.pow(10, places);
    return checked((n < 0 ? -1 : 1) * Math.round(Math.abs(n) * f) / f, "`round`");
  });

function numbersIn(argv: FormulaValue[], where: string): number[] {
  const out: number[] = [];
  const walk = (v: FormulaValue): void => {
    if (isListValue(v)) {
      for (const x of v.items) walk(x);
      return;
    }
    if (v === null) return; // aggregates skip empties
    out.push(toNumber(v, where));
  };
  for (const v of argv) walk(v);
  if (out.length === 0) throw new FormulaError(`${where} needs at least one number`, "BAD_ARGS");
  return out;
}

def("min", "min(a, b, ...)", "Smallest number; lists are flattened, empties skipped.", VARIADIC, (argv) =>
  checked(Math.min(...numbersIn(argv, "`min`")), "`min`"));
def("max", "max(a, b, ...)", "Largest number; lists are flattened, empties skipped.", VARIADIC, (argv) =>
  checked(Math.max(...numbersIn(argv, "`max`")), "`max`"));
def("sum", "sum(a, b, ...)", "Sum of the numbers; lists are flattened, empties skipped.", VARIADIC, (argv) =>
  checked(numbersIn(argv, "`sum`").reduce((a, b) => a + b, 0), "`sum`"));

def("toNumber", "toNumber(x)", "Value as a number; a date becomes its timestamp. A non-numeric string is an error.", [1, 1], (argv) =>
  checked(toNumberLoose(argv[0]!, "`toNumber`"), "`toNumber`"));
def("toString", "toString(x)", "Value as text.", [1, 1], (argv) => valueToString(argv[0]!));

def("concat", "concat(a, b, ...)", "Join the string form of every argument.", VARIADIC, (argv) =>
  argv.map(valueToString).join(""));

// ── lists & text ────────────────────────────────────────────────────────────

def("list", "list(a, b, ...)", "Build a list from the arguments (no arguments gives the empty list).", [0, MAX_ARGS], (argv) => listValue([...argv]));

def("join", "join(list, sep)", "Join a list's items as text (`sep` defaults to \", \").", [1, 2], (argv) => {
  const sep = argv.length > 1 ? valueToString(argv[1]!) : ", ";
  const v = argv[0]!;
  if (isListValue(v)) return v.items.map(valueToString).join(sep);
  return valueToString(v);
});

def("length", "length(x)", "Character count of text, item count of a list, 0 for empty.", [1, 1], (argv) => {
  const v = argv[0]!;
  if (v === null) return 0;
  if (typeof v === "string") return [...v].length;
  if (isListValue(v)) return v.items.length;
  throw new FormulaError("length() works on text, lists and empty values", "TYPE_MISMATCH");
});

def("slice", "slice(x, start, end?)", "Substring / sublist from `start` up to `end` (JS semantics).", [2, 3],
  (argv) => {
    const v = argv[0]!;
    const start = toNumber(argv[1]!, "`slice`");
    const end = argv.length > 2 ? toNumber(argv[2]!, "`slice`") : undefined;
    if (typeof v === "string") return v.slice(start, end);
    if (isListValue(v)) return listValue(v.items.slice(start, end));
    throw new FormulaError("slice() works on text and lists", "TYPE_MISMATCH");
  });

def("contains", "contains(haystack, needle)", "Substring test for text, membership test for a list.", [2, 2],
  (argv) => {
    const [hay, needle] = [argv[0]!, argv[1]!];
    if (hay === null) return false;
    if (isListValue(hay)) return hay.items.some((x) => looseEqual(x, needle));
    return valueToString(hay).includes(valueToString(needle));
  });

def("matches", "matches(str, pattern)", "Case-insensitive literal substring test — not a regex.", [2, 2],
  (argv) => {
    const hay = valueToString(argv[0]!).toLowerCase();
    const needle = valueToString(argv[1]!).toLowerCase();
    return hay.includes(needle);
  });

def("empty", "empty(x)", "True for null, \"\", an empty list, or a date with no start.", [1, 1], (argv) =>
  isEmpty(argv[0]!));
def("notEmpty", "notEmpty(x)", "The inverse of empty().", [1, 1], (argv) => !isEmpty(argv[0]!));

// ── formatting ──────────────────────────────────────────────────────────────

def("format", "format(value, pattern)", "Format a value. Date tokens: YYYY MM DD HH mm. Number tokens: {d} {sign} {percent}.", [2, 2],
  (argv) => {
    const v = argv[0]!;
    const pattern = valueToString(argv[1]!);
    if (isDateValue(v)) return formatMs(v.start, pattern);
    if (typeof v === "number") {
      // `{d}` is the magnitude, `{sign}` the sign, `{percent}` value×100 + "%".
      const sign = v > 0 ? "+" : v < 0 ? "-" : "";
      return pattern
        .replaceAll("{percent}", `${numToString(checked(v * 100, "`format`"))}%`)
        .replaceAll("{sign}", sign)
        .replaceAll("{d}", numToString(Math.abs(v)));
    }
    return pattern.replaceAll("{d}", valueToString(v));
  });

// ── dates ───────────────────────────────────────────────────────────────────

def("year", "year(d)", "Calendar year of a date.", [1, 1], (argv) =>
  parts(dateStartMs(argv[0]!, "`year`")).y);
def("month", "month(d)", "Month of a date, 1-12.", [1, 1], (argv) =>
  parts(dateStartMs(argv[0]!, "`month`")).mo + 1);
def("day", "day(d)", "Day of the month, 1-31.", [1, 1], (argv) =>
  parts(dateStartMs(argv[0]!, "`day`")).d);

def("dateStart", 'dateStart(d, "day"|"week"|"month"|"quarter"|"year")', "Start of the period containing d (UTC).", [2, 2],
  (argv) => {
    const unit = unitOf(argv[1]!, DATE_START_UNITS, "`dateStart`") as DateStartUnit;
    return dateValue(startOfUtc(dateStartMs(argv[0]!, "`dateStart`"), unit), null, true);
  });

def("dateEnd", 'dateEnd(d, "day"|"week"|"month"|"quarter"|"year")', "Last millisecond of the period containing d (UTC).", [2, 2],
  (argv) => {
    const unit = unitOf(argv[1]!, DATE_START_UNITS, "`dateEnd`") as DateStartUnit;
    return dateValue(endOfUtc(dateStartMs(argv[0]!, "`dateEnd`"), unit), null, true);
  });

def("addDays", "addDays(d, n)", "Add n days (UTC calendar days).", [2, 2], (argv) => {
  const ms = dateStartMs(argv[0]!, "`addDays`");
  const n = toNumber(argv[1]!, "`addDays`");
  return dateValue(checked(ms + n * MS_DAY, "`addDays`"), null, isDateValue(argv[0]!) ? argv[0]!.allDay : false);
});

def("subtractDays", "subtractDays(d, n)", "Subtract n days (UTC calendar days).", [2, 2], (argv) => {
  const ms = dateStartMs(argv[0]!, "`subtractDays`");
  const n = toNumber(argv[1]!, "`subtractDays`");
  return dateValue(checked(ms - n * MS_DAY, "`subtractDays`"), null, isDateValue(argv[0]!) ? argv[0]!.allDay : false);
});

def("addMonths", "addMonths(d, n)", "Add n months, clamping the day (Jan 31 + 1mo → Feb 28).", [2, 2], (argv) => {
  const ms = dateStartMs(argv[0]!, "`addMonths`");
  const n = toNumber(argv[1]!, "`addMonths`");
  if (!Number.isInteger(n)) throw new FormulaError("addMonths() needs a whole number of months", "BAD_ARGS");
  return dateValue(addMonthsUtc(ms, n), null, isDateValue(argv[0]!) ? argv[0]!.allDay : false);
});

def("dateDiff", 'dateDiff(a, b, "days"|"weeks"|"hours"|"minutes"|"seconds"|"months"|"years")', "a minus b in the given unit. months/years count whole calendar units.", [3, 3],
  (argv) => {
    const unit = unitOf(
      argv[2]!,
      ["days", "day", "weeks", "week", "hours", "hour", "minutes", "minute", "seconds", "second", "months", "month", "years", "year"],
      "`dateDiff`",
    );
    const a = dateStartMs(argv[0]!, "`dateDiff`");
    const b = dateStartMs(argv[1]!, "`dateDiff`");
    const fixed = DATE_DIFF_UNITS[unit];
    if (fixed !== undefined) return checked((a - b) / fixed, "`dateDiff`");
    return wholeUnits(a, b, unit.startsWith("year") ? "year" : "month");
  });

/** Whole calendar months/years from b to a (signed). */
function wholeUnits(a: number, b: number, unit: "month" | "year"): number {
  if (a === b) return 0;
  const sign = a > b ? 1 : -1;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const step = unit === "year" ? 12 : 1;
  let count = 0;
  // Bounded loop is fine: a year of months is 12 iterations, and realistic
  // ranges stay far below the cap.
  while (addMonthsUtc(lo, (count + 1) * step) <= hi) {
    count++;
    if (count > 100_000) break;
  }
  return sign * count;
}

def("toDateString", "toDateString(d, format?)", "Date as text. Default \"YYYY-MM-DD\"; tokens YYYY MM DD HH mm.", [1, 2],
  (argv) => {
    const d = asDate(argv[0]!, "`toDateString`");
    const pattern = argv.length > 1 ? valueToString(argv[1]!) : "YYYY-MM-DD";
    return formatMs(d.start, pattern);
  });

def("now", "now()", "Current date and time. Uses ctx.today() so formulas stay deterministic.", [0, 0], (_argv, ctx) =>
  dateValue(ctx.today(), null, false));

def("today", "today()", "Today at 00:00 UTC. Uses ctx.today() so formulas stay deterministic.", [0, 0], (_argv, ctx) =>
  dateValue(startOfUtc(ctx.today(), "day"), null, true));

// ── comparisons as functions ────────────────────────────────────────────────

def("greaterOrEqual", "greaterOrEqual(a, b)", "a >= b, comparing numbers, text, dates and coercible pairs.", [2, 2],
  (argv) => compareValues(argv[0]!, argv[1]!) >= 0);
def("lessOrEqual", "lessOrEqual(a, b)", "a <= b, comparing numbers, text, dates and coercible pairs.", [2, 2],
  (argv) => compareValues(argv[0]!, argv[1]!) <= 0);

// Names that parse as literals, not user functions.
const LITERAL_CALLS = new Set(["null"]);

/** Known function names — the parser rejects anything else, with a position. */
export const FUNCTION_NAMES: string[] = [...REGISTRY.keys(), ...LITERAL_CALLS].sort();

/**
 * For the autocomplete UI: every built-in, in the order the reference
 * documents them. Declared here, after the `def` calls have populated DEFS.
 */
export const FORMULA_FUNCTIONS: FunctionSpec[] = DEFS.map((d) => d.spec);

// ─────────────────────────────────────────────────────────────────────────────
// Lexer
// ─────────────────────────────────────────────────────────────────────────────

type TokKind = "num" | "str" | "ident" | "op" | "eof";

interface Token {
  kind: TokKind;
  text: string;
  num?: number;
  pos: number;
}

const TWO_CHAR_OPS = ["==", "!=", "<=", ">=", "&&", "||"];
const ONE_CHAR_OPS = ["+", "-", "*", "/", "%", "(", ")", ",", "<", ">", "!", "&", "|"];

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}
function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}
function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

function lex(source: string): Token[] {
  const out: Token[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i] as string;

    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }
    // `//` runs to end of line
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }

    const pos = i;

    if (c === '"') {
      i++;
      let buf = "";
      let closed = false;
      while (i < n) {
        const ch = source[i] as string;
        if (ch === "\n") break; // strings do not span lines
        if (ch === "\\") {
          const esc = source[i + 1];
          if (esc === undefined) {
            throw new FormulaError("String ends with a dangling backslash", "UNTERMINATED_STRING", pos);
          }
          if (esc === "n") buf += "\n";
          else if (esc === "t") buf += "\t";
          else if (esc === "r") buf += "\r";
          else if (esc === '"') buf += '"';
          else if (esc === "\\") buf += "\\";
          else throw new FormulaError(`Unknown escape sequence \\${esc}`, "BAD_ESCAPE", i);
          i += 2;
          continue;
        }
        if (ch === '"') {
          closed = true;
          i++;
          break;
        }
        buf += ch;
        i++;
      }
      if (!closed) throw new FormulaError("Unterminated string literal", "UNTERMINATED_STRING", pos);
      out.push({ kind: "str", text: buf, pos });
      continue;
    }

    if (isDigit(c) || (c === "." && isDigit(source[i + 1]))) {
      let j = i;
      while (j < n && isDigit(source[j])) j++;
      if (source[j] === ".") {
        j++;
        while (j < n && isDigit(source[j])) j++;
      }
      const text = source.slice(i, j);
      out.push({ kind: "num", text, num: Number(text), pos });
      i = j;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentPart(source[j] as string)) j++;
      out.push({ kind: "ident", text: source.slice(i, j), pos });
      i = j;
      continue;
    }

    const two = source.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      out.push({ kind: "op", text: two, pos });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.includes(c)) {
      out.push({ kind: "op", text: c, pos });
      i++;
      continue;
    }
    if (c === "=") {
      throw new FormulaError("Use == to compare, not =", "UNEXPECTED_CHAR", i);
    }
    throw new FormulaError(`Unexpected character ${json(c)}`, "UNEXPECTED_CHAR", i);
  }
  out.push({ kind: "eof", text: "", pos: n });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────────────

class Parser {
  private toks: Token[];
  private p = 0;
  private depth = 0;

  constructor(source: string) {
    this.toks = lex(source);
  }

  private cur(): Token {
    return this.toks[this.p] as Token;
  }

  private bump(): Token {
    const t = this.toks[this.p] as Token;
    if (t.kind !== "eof") this.p++;
    return t;
  }

  private isOp(text: string): boolean {
    const t = this.cur();
    return t.kind === "op" && t.text === text;
  }

  private expectOp(text: string, what: string): Token {
    if (!this.isOp(text)) {
      const t = this.cur();
      throw new FormulaError(`Expected ${what}, found ${json(t.text || "end of formula")}`, "EXPECTED_TOKEN", t.pos);
    }
    return this.bump();
  }

  private enter(pos: number): void {
    this.depth++;
    if (this.depth > MAX_DEPTH) {
      throw new FormulaError(`Expression nests more than ${MAX_DEPTH} levels deep`, "TOO_DEEP", pos);
    }
  }

  parse(): FormulaNode {
    const node = this.parseOr();
    const t = this.cur();
    if (t.kind !== "eof") {
      throw new FormulaError(
        `Unexpected ${json(t.text)} after the end of the formula`,
        "TRAILING_INPUT",
        t.pos,
      );
    }
    return node;
  }

  // The precedence chain below is deliberately uncounted: a 1000-term chain
  // like `1+1+1+…` is left-associative and parses iteratively, so it costs no
  // extra JS frames. Nesting is counted where the tree actually nests —
  // `(` in parsePrimary and each argument in parseArgs.
  private parseOr(): FormulaNode {
    let left = this.parseAnd();
    while (this.isOp("||")) {
      this.bump();
      left = { k: "bin", op: "||", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): FormulaNode {
    let left = this.parseEquality();
    while (this.isOp("&&")) {
      this.bump();
      left = { k: "bin", op: "&&", left, right: this.parseEquality() };
    }
    return left;
  }

  private parseEquality(): FormulaNode {
    let left = this.parseComparison();
    for (;;) {
      const op = this.isOp("==") ? "==" : this.isOp("!=") ? "!=" : null;
      if (!op) break;
      this.bump();
      left = { k: "bin", op, left, right: this.parseComparison() };
    }
    return left;
  }

  private parseComparison(): FormulaNode {
    let left = this.parseAdditive();
    for (;;) {
      const op =
        this.isOp("<") ? "<" :
        this.isOp("<=") ? "<=" :
        this.isOp(">") ? ">" :
        this.isOp(">=") ? ">=" : null;
      if (!op) break;
      this.bump();
      left = { k: "bin", op, left, right: this.parseAdditive() };
    }
    return left;
  }

  private parseAdditive(): FormulaNode {
    let left = this.parseTerm();
    for (;;) {
      const op = this.isOp("+") ? "+" : this.isOp("-") ? "-" : null;
      if (!op) break;
      this.bump();
      left = { k: "bin", op, left, right: this.parseTerm() };
    }
    return left;
  }

  private parseTerm(): FormulaNode {
    let left = this.parseUnary();
    for (;;) {
      const op =
        this.isOp("*") ? "*" :
        this.isOp("/") ? "/" :
        this.isOp("%") ? "%" : null;
      if (!op) break;
      this.bump();
      left = { k: "bin", op, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): FormulaNode {
    if (this.isOp("!") || this.isOp("-")) {
      const op = (this.bump() as Token).text;
      return { k: "un", op, operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FormulaNode {
    const t = this.cur();

    if (t.kind === "num") {
      this.bump();
      return { k: "num", v: t.num as number };
    }
    if (t.kind === "str") {
      this.bump();
      return { k: "str", v: t.text };
    }
    if (t.kind === "ident") {
      this.bump();
      const next = this.cur();
      if (next.kind === "op" && next.text === "(") {
        if (t.text === "null") {
          this.bump(); // (
          this.expectOp(")", ")");
          return { k: "call", name: "null", args: [] };
        }
        const d = REGISTRY.get(t.text);
        if (!d) {
          throw new FormulaError(`Unknown function ${json(t.text)}`, "UNKNOWN_FUNCTION", t.pos);
        }
        const args = this.parseArgs(t.pos, d.spec);
        return { k: "call", name: t.text, args };
      }
      if (t.text === "true") return { k: "bool", v: true };
      if (t.text === "false") return { k: "bool", v: false };
      if (t.text === "null") return { k: "call", name: "null", args: [] };
      // A bare identifier is a property reference; evaluation resolves it
      // through ctx.prop and yields null when the property is missing.
      return { k: "prop", name: t.text };
    }
    if (t.kind === "op" && t.text === "(") {
      this.enter(t.pos);
      this.bump();
      const expr = this.parseOr();
      this.expectOp(")", ")");
      this.depth--;
      return { k: "paren", expr };
    }
    throw new FormulaError(
      `Expected a value, found ${json(t.text || "end of formula")}`,
      "EXPECTED_VALUE",
      t.pos,
    );
  }

  private parseArgs(callPos: number, spec: FunctionSpec): FormulaNode[] {
    this.expectOp("(", "an argument list");
    const args: FormulaNode[] = [];
    if (this.isOp(")")) {
      this.bump();
    } else {
      for (;;) {
        this.enter(this.cur().pos);
        args.push(this.parseOr());
        this.depth--;
        if (this.isOp(",")) {
          this.bump();
          if (args.length >= MAX_ARGS) {
            throw new FormulaError(`${spec.name}() takes at most ${MAX_ARGS} arguments`, "ARITY", callPos);
          }
          continue;
        }
        this.expectOp(")", `) to close ${spec.name}()`);
        break;
      }
    }
    const [min, max] = spec.argCount;
    if (args.length < min || args.length > max) {
      throw new FormulaError(
        `${spec.name}() takes ${min === max ? min : `${min}-${max}`} arguments, got ${args.length}`,
        "ARITY",
        callPos,
      );
    }
    return args;
  }
}

/** Iterative AST depth: the tree can be far deeper than the JS stack allows. */
export function astDepth(node: FormulaNode): number {
  let max = 0;
  const stack: { node: FormulaNode; depth: number }[] = [{ node, depth: 1 }];
  while (stack.length) {
    const frame = stack.pop() as { node: FormulaNode; depth: number };
    if (frame.depth > max) max = frame.depth;
    if (max > MAX_DEPTH) return max;
    const n = frame.node;
    const d = frame.depth + 1;
    if (n.k === "bin") {
      stack.push({ node: n.left, depth: d }, { node: n.right, depth: d });
    } else if (n.k === "un" || n.k === "paren") {
      stack.push({ node: n.k === "un" ? n.operand : n.expr, depth: d });
    } else if (n.k === "call") {
      for (const a of n.args) stack.push({ node: a, depth: d });
    }
  }
  return max;
}

/** Parse formula source into the shared AST. Throws FormulaError. */
export function parseFormula(source: string): FormulaNode {
  if (typeof source !== "string") throw new FormulaError("Formula source must be a string", "BAD_SOURCE");
  const node = new Parser(source).parse();
  const depth = astDepth(node);
  if (depth > MAX_DEPTH) {
    throw new FormulaError(`Expression nests more than ${MAX_DEPTH} levels deep (${depth})`, "TOO_DEEP");
  }
  return node;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluator
// ─────────────────────────────────────────────────────────────────────────────

function evalNode(node: FormulaNode, ctx: EvalContext, depth: number): FormulaValue {
  if (depth > MAX_DEPTH) {
    throw new FormulaError(`Expression nests more than ${MAX_DEPTH} levels deep`, "TOO_DEEP");
  }
  if (typeof node !== "object" || node === null || typeof (node as { k?: unknown }).k !== "string") {
    throw new FormulaError("Not a formula node", "BAD_NODE");
  }

  switch (node.k) {
    case "num":
      if (!Number.isFinite(node.v)) throw new FormulaError("Number literal is not finite", "NOT_FINITE");
      return node.v;
    case "str": {
      // A date-shaped string literal is a date, per the language spec.
      const d = parseDateLiteral(node.v);
      return d ?? node.v;
    }
    case "bool":
      return node.v;
    case "paren":
      return evalNode(node.expr, ctx, depth + 1);
    case "prop": {
      let v: unknown = null;
      try {
        v = ctx.prop(node.name);
      } catch {
        v = null; // a missing property is empty, not a crash
      }
      return normalizeValue(v);
    }
    case "un": {
      const v = evalNode(node.operand, ctx, depth + 1);
      if (node.op === "!") return !truthy(v);
      if (node.op === "-") return checked(-toNumber(v, "unary -"), "unary -");
      throw new FormulaError(`Unknown unary operator ${json(node.op)}`, "BAD_OP");
    }
    case "bin":
      return evalBin(node, ctx, depth);
    case "call":
      return evalCall(node, ctx, depth);
    default: {
      const k = (node as { k: string }).k;
      throw new FormulaError(`Unknown node kind ${json(k)}`, "BAD_NODE");
    }
  }
}

function evalBin(node: Extract<FormulaNode, { k: "bin" }>, ctx: EvalContext, depth: number): FormulaValue {
  const { op } = node;
  // Short-circuiting logical operators: the right side is evaluated at most once.
  if (op === "&&") {
    if (!truthy(evalNode(node.left, ctx, depth + 1))) return false;
    return truthy(evalNode(node.right, ctx, depth + 1));
  }
  if (op === "||") {
    if (truthy(evalNode(node.left, ctx, depth + 1))) return true;
    return truthy(evalNode(node.right, ctx, depth + 1));
  }

  const l = evalNode(node.left, ctx, depth + 1);
  const r = evalNode(node.right, ctx, depth + 1);

  switch (op) {
    case "+":
      return addValues(l, r);
    case "-":
      return checked(toNumber(l, "`-`") - toNumber(r, "`-`"), "`-`");
    case "*":
      return checked(toNumber(l, "`*`") * toNumber(r, "`*`"), "`*`");
    case "/": {
      const d = toNumber(r, "`/`");
      if (d === 0) throw new FormulaError("Division by zero", "DIV_BY_ZERO");
      return checked(toNumber(l, "`/`") / d, "`/`");
    }
    case "%": {
      const d = toNumber(r, "`%`");
      if (d === 0) throw new FormulaError("Modulo by zero", "DIV_BY_ZERO");
      return checked(toNumber(l, "`%`") % d, "`%`");
    }
    case "==":
      return looseEqual(l, r);
    case "!=":
      return !looseEqual(l, r);
    case "<":
      return compareValues(l, r) < 0;
    case "<=":
      return compareValues(l, r) <= 0;
    case ">":
      return compareValues(l, r) > 0;
    case ">=":
      return compareValues(l, r) >= 0;
    default:
      throw new FormulaError(`Unknown operator ${json(op)}`, "BAD_OP");
  }
}

function evalCall(node: Extract<FormulaNode, { k: "call" }>, ctx: EvalContext, depth: number): FormulaValue {
  const name = node.name;
  if (name === "null") {
    if (node.args.length !== 0) throw new FormulaError("null takes no arguments", "ARITY");
    return null;
  }
  const d = REGISTRY.get(name);
  if (!d) throw new FormulaError(`Unknown function ${json(name)}`, "UNKNOWN_FUNCTION");
  const [min, max] = d.spec.argCount;
  if (node.args.length < min || node.args.length > max) {
    throw new FormulaError(`${name}() takes ${min === max ? min : `${min}-${max}`} arguments, got ${node.args.length}`, "ARITY");
  }

  // Special forms evaluate their arguments lazily.
  if (name === "if") {
    const cond = evalNode(node.args[0] as FormulaNode, ctx, depth + 1);
    if (truthy(cond)) return evalNode(node.args[1] as FormulaNode, ctx, depth + 1);
    const other = node.args[2];
    return other ? evalNode(other, ctx, depth + 1) : null;
  }
  if (name === "and") {
    for (const a of node.args) if (!truthy(evalNode(a, ctx, depth + 1))) return false;
    return true;
  }
  if (name === "or") {
    for (const a of node.args) if (truthy(evalNode(a, ctx, depth + 1))) return true;
    return false;
  }

  const argv = node.args.map((a) => evalNode(a, ctx, depth + 1));
  return d.fn(argv, ctx);
}

/** Interpret a parsed formula. Throws FormulaError on any failure. */
export function evaluateFormula(node: FormulaNode, ctx: EvalContext): FormulaValue {
  const v = evalNode(node, ctx, 0);
  if (typeof v === "number" && !Number.isFinite(v)) {
    throw new FormulaError("Result is not a finite number", "NOT_FINITE");
  }
  return v;
}

/** Parse and evaluate in one step. */
export function evalSource(source: string, ctx: EvalContext): FormulaValue {
  return evaluateFormula(parseFormula(source), ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Static analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Property names referenced by a formula, in first-appearance order, deduped.
 * Finds `{k:"prop"}` nodes and `prop("Name")` calls nested anywhere: inside
 * calls, binary operators, unary operators and parens.
 */
export function extractRefs(node: FormulaNode): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  };
  const stack: FormulaNode[] = [node];
  while (stack.length) {
    const n = stack.shift() as FormulaNode; // breadth-first → source order
    if (n.k === "prop") {
      add(n.name);
    } else if (n.k === "call") {
      if (n.name === "prop" && n.args.length === 1 && n.args[0]!.k === "str") add(n.args[0]!.v);
      for (const a of n.args) stack.push(a);
    } else if (n.k === "bin") {
      stack.push(n.left, n.right);
    } else if (n.k === "un") {
      stack.push(n.operand);
    } else if (n.k === "paren") {
      stack.push(n.expr);
    }
  }
  return out;
}

const NUMBER_FNS = new Set([
  "add", "subtract", "multiply", "divide", "mod", "abs", "ceil", "floor", "round",
  "min", "max", "sum", "toNumber", "year", "month", "day", "length", "dateDiff",
]);
const TEXT_FNS = new Set(["toString", "concat", "join", "format", "toDateString"]);
const BOOL_FNS = new Set(["not", "and", "or", "empty", "notEmpty", "contains", "matches", "greaterOrEqual", "lessOrEqual"]);
const DATE_FNS = new Set(["now", "today", "dateStart", "dateEnd", "addDays", "subtractDays", "addMonths"]);

/**
 * Best-effort result type. `unknown` means "the engine cannot tell" — most
 * often because the formula reads a property, whose type lives in the schema.
 */
export function inferResultType(node: FormulaNode): "number" | "text" | "date" | "checkbox" | "unknown" {
  return infer(node, 0);
}

type Inferred = "number" | "text" | "date" | "checkbox" | "unknown";

function infer(node: FormulaNode, depth: number): Inferred {
  if (depth > MAX_DEPTH) {
    throw new FormulaError(`Expression nests more than ${MAX_DEPTH} levels deep`, "TOO_DEEP");
  }
  if (typeof node !== "object" || node === null) return "unknown";
  switch (node.k) {
    case "num":
      return "number";
    case "str":
      return parseDateLiteral(node.v) ? "date" : "text";
    case "bool":
      return "checkbox";
    case "prop":
      return "unknown";
    case "paren":
      return infer(node.expr, depth + 1);
    case "un":
      return node.op === "!" ? "checkbox" : "number";
    case "bin": {
      const l = infer(node.left, depth + 1);
      const r = infer(node.right, depth + 1);
      switch (node.op) {
        case "+":
          if (l === "text" || r === "text") return "text";
          if (l === "date" || r === "date") return "text";
          if (l === "number" && r === "number") return "number";
          return "unknown";
        case "-":
        case "*":
        case "/":
        case "%":
          return "number";
        default:
          return "checkbox"; // == != < <= > >= && ||
      }
    }
    case "call": {
      const name = node.name;
      if (name === "null") return "unknown";
      if (name === "if") {
        const a = node.args.length > 1 ? infer(node.args[1] as FormulaNode, depth + 1) : "unknown";
        const b = node.args.length > 2 ? infer(node.args[2] as FormulaNode, depth + 1) : "unknown";
        return unify(a, b);
      }
      if (name === "prop" || name === "list") return "unknown";
      if (NUMBER_FNS.has(name)) return "number";
      if (TEXT_FNS.has(name)) return "text";
      if (BOOL_FNS.has(name)) return "checkbox";
      if (DATE_FNS.has(name)) return "date";
      return "unknown";
    }
    default:
      return "unknown";
  }
}

function unify(a: Inferred, b: Inferred): Inferred {
  if (a === b) return a;
  if (a === "unknown") return b;
  if (b === "unknown") return a;
  return "unknown";
}
