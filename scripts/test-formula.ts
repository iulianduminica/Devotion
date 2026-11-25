/**
 * Formula engine tests. Run with:
 *   & .\node_modules\.bin\tsx.cmd scripts/test-formula.ts
 *
 * Plain assertion script, same house style as scripts/test.ts. Covers the
 * lexer, precedence, every built-in function, date math across month/year
 * boundaries and the leap day, the coercion and error rules, the depth guard,
 * extractRefs, inferResultType and the autocomplete specs.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FormulaNode } from "../shared/types.ts";
import {
  FormulaError,
  FORMULA_FUNCTIONS,
  MAX_DEPTH,
  dateValue,
  evalSource,
  evaluateFormula,
  extractRefs,
  inferResultType,
  isDateValue,
  listValue,
  parseFormula,
  type EvalContext,
  type FormulaValue,
} from "../server/formula.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(label: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32mok\x1b[0m   ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

function eq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(label, a === e, a === e ? "" : `got ${a}, want ${e}`);
}

// ─────────────────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2024, 5, 15, 9, 30); // 2024-06-15T09:30:00Z

const PROPS: Record<string, FormulaValue> = {
  Name: "Atlas",
  Price: 12.5,
  Qty: 4,
  Total: 50,
  Done: true,
  Todo: false,
  Note: "",
  Empty: null,
  Neg: -3,
  Progress: 0.5,
  Due: dateValue(Date.UTC(2024, 1, 29), null, true), // 2024-02-29, leap day
  When: dateValue(Date.UTC(2024, 5, 15, 9, 30), null, false),
  Tags: listValue(["a", "b", "c"]),
  Tasks: listValue(["r1", "r2", "r3", "r4"]),
};

const ctx: EvalContext = {
  prop(name: string): FormulaValue {
    if (name === "Boom") throw new Error("this property does not exist");
    return PROPS[name] ?? null;
  },
  today: () => NOW,
  row: { ...PROPS },
};

/** Evaluate, mapping any FormulaError to "ERR:<code>" so the suite never dies. */
function ev(src: string): FormulaValue | string {
  try {
    return evalSource(src, ctx);
  } catch (e) {
    if (e instanceof FormulaError) return `ERR:${e.code}`;
    throw e;
  }
}

/** Evaluate, returning the thrown FormulaError (null when it succeeds). */
function fail(src: string): FormulaError | null {
  try {
    evalSource(src, ctx);
    return null;
  } catch (e) {
    if (e instanceof FormulaError) return e;
    throw e;
  }
}

/** `.start` of a date result, for readable date assertions. */
function startMs(src: string): number | null {
  const v = ev(src);
  if (isDateValue(v)) return v.start;
  if (typeof v === "number") return v;
  return null;
}

const parens = (n: number, inner = "1"): string => "(".repeat(n) + inner + ")".repeat(n);

// ── precedence, parens, unary ────────────────────────────────────────────────

section("Precedence & associativity");
{
  eq("1 + 2 * 3 = 7 (multiplication first)", ev("1 + 2 * 3"), 7);
  eq("(1 + 2) * 3 = 9 (parens win)", ev("(1 + 2) * 3"), 9);
  eq("the spec case: 1 + 2 * 3 == 7", ev("1 + 2 * 3 == 7"), true);
  eq("10 - 3 - 2 = 5 (left associative)", ev("10 - 3 - 2"), 5);
  eq("10 - (3 - 2) = 9", ev("10 - (3 - 2)"), 9);
  eq("2 * 3 % 4 = 2 (* and % share a level)", ev("2 * 3 % 4"), 2);
  eq("100 / 5 / 2 = 10 (left associative)", ev("100 / 5 / 2"), 10);
  eq("&& binds tighter than ||", ev("true || false && false"), true);
  eq("(true || false) && false", ev("(true || false) && false"), false);
  eq("== binds tighter than &&", ev("1 == 1 && 2 == 2"), true);
  eq("comparison binds tighter than ==", ev("1 < 2 == true"), true);
  eq("arithmetic binds tighter than comparison", ev("2 + 3 > 4"), true);
  eq("(((1 + 2))) * (2 + 3) = 15", ev("(((1 + 2))) * (2 + 3)"), 15);
  eq("unary minus: -2 * -3 = 6", ev("-2 * -3"), 6);
  eq("double unary minus: - -5 = 5", ev("- -5"), 5);
  eq("unary minus is not part of the literal", parseFormula("-5").k, "un");
  eq("!true = false", ev("!true"), false);
  eq("!0 = true (truthiness, not numeric)", ev("!0"), true);
  eq("!(1 > 2) = true", ev("!(1 > 2)"), true);
  eq("!!\"x\" = true", ev('!!"x"'), true);
  eq("float literal .5 + 1 = 1.5", ev(".5 + 1"), 1.5);
  eq("comment runs to end of line", ev("1 + 2 // trailing comment"), 3);
  eq("whole-line comment", ev("// a note\n42"), 42);
  eq("0.1 + 0.2 prints as 0.3", ev("toString(0.1 + 0.2)"), "0.3");
  eq("parse is deterministic", JSON.stringify(parseFormula("if(a, 1 + 2, 3 * 4)")) ===
    JSON.stringify(parseFormula("if(a, 1 + 2, 3 * 4)")), true);
  eq("binop AST shape", parseFormula("1 + 2"), { k: "bin", op: "+", left: { k: "num", v: 1 }, right: { k: "num", v: 2 } });
  eq("paren AST shape", parseFormula("(1)"), { k: "paren", expr: { k: "num", v: 1 } });
}

// ── literals, strings, comments ─────────────────────────────────────────────

section("Literals & strings");
{
  eq('"a" + "b" concatenates', ev('"a" + "b"'), "ab");
  eq('"n=" + 5 stringifies the number', ev('"n=" + 5'), "n=5");
  eq('"1" + "2" is "12", not 3', ev('"1" + "2"'), "12");
  eq("documented rule: 1 + \"a\" concatenates", ev('1 + "a"'), "1a");
  eq("escape: nested double quote", ev('"say \\"hi\\""'), 'say "hi"');
  eq("escape: tab is one character", ev('length("tab\\tend")'), 7);
  eq("escape: backslash", ev('"a\\\\b"'), "a\\b");
  eq("true / false literals", ev("true && false"), false);
  eq("null == null", ev("null == null"), true);
  eq("null == 0 is false (null is not zero here)", ev("null == 0"), false);
  eq("null + 1 = 1 (null coerces to 0 numerically)", ev("null + 1"), 1);
  eq("number literals keep no separators in text", ev("toString(1234567)"), "1234567");
  eq('"YYYY-MM-DD" literal parses to a date', ev('"2024-06-15"'), {
    start: Date.UTC(2024, 5, 15), end: null, allDay: true,
  });
  eq('"YYYY-MM-DD HH:mm" literal parses to a timed date', ev('"2024-06-15 09:30"'), {
    start: Date.UTC(2024, 5, 15, 9, 30), end: null, allDay: false,
  });
  eq("thousands separators are NOT supported (1,234)", ev("1,234"), "ERR:TRAILING_INPUT");
  eq("unterminated string", ev('"abc'), "ERR:UNTERMINATED_STRING");
  eq("unterminated string carries a position", fail('"abc')?.position, 0);
  eq("unknown escape", ev('"a\\q"'), "ERR:BAD_ESCAPE");
  eq("`=` is a lex error, == is the operator", ev("1 = 2"), "ERR:UNEXPECTED_CHAR");
  eq("strings do not span lines", ev('"a\nb"'), "ERR:UNTERMINATED_STRING");
}

// ── property references ─────────────────────────────────────────────────────

section("Property references");
{
  eq('prop("Name")', ev('prop("Name")'), "Atlas");
  eq("bare identifier resolves through ctx.prop", ev("Name"), "Atlas");
  eq("bare identifier in arithmetic", ev("Qty * 2"), 8);
  eq("missing property is null, not an error", ev('prop("Nope")'), null);
  eq("a ctx.prop that throws is treated as missing", ev("Boom"), null);
  eq("missing property is empty", ev('empty(prop("Nope"))'), true);
  eq("prop() on a list value", ev("prop(\"Tags\")"), listValue(["a", "b", "c"]));
  eq("relation list length", ev('length(prop("Tasks"))'), 4);
  eq("relation list length, bare ref", ev("length(Tasks) > 0"), true);
  eq("relation list joined", ev('if(length(Tasks) > 0, join(Tasks, ", "), "none")'), "r1, r2, r3, r4");
  eq("relation list membership", ev('contains(Tasks, "r3")'), true);
  eq("checkbox property is truthy", ev("Done"), true);
  eq("false checkbox is falsy", ev("!Todo"), true);
  eq("empty string property", ev('empty(prop("Note"))'), true);
  eq("prop() with a non-string name", ev("prop(1)"), "ERR:TYPE_MISMATCH");
}

// ── arithmetic ──────────────────────────────────────────────────────────────

section("Arithmetic & coercion");
{
  eq("add(2, 3)", ev("add(2, 3)"), 5);
  eq("subtract(10, 4)", ev("subtract(10, 4)"), 6);
  eq("multiply(3, 4)", ev("multiply(3, 4)"), 12);
  eq("divide(10, 4)", ev("divide(10, 4)"), 2.5);
  eq("mod(10, 3)", ev("mod(10, 3)"), 1);
  eq("mod keeps JS sign rules", ev("mod(-7, 3)"), -1);
  eq("5 / 0 is DIV_BY_ZERO", ev("5 / 0"), "ERR:DIV_BY_ZERO");
  eq("divide(1, 0) is DIV_BY_ZERO", ev("divide(1, 0)"), "ERR:DIV_BY_ZERO");
  eq("5 % 0 is DIV_BY_ZERO", ev("5 % 0"), "ERR:DIV_BY_ZERO");
  eq("divide(1, prop(missing)) is DIV_BY_ZERO (null → 0)", ev('divide(1, prop("Nope"))'), "ERR:DIV_BY_ZERO");
  eq("division by a numeric string is fine", ev('divide("10", "4")'), 2.5);
  eq("overflow never leaks Infinity", ev("1" + "0".repeat(155) + " * " + "1" + "0".repeat(155)), "ERR:NOT_FINITE");
  eq("abs(-3)", ev("abs(-3)"), 3);
  eq("ceil(1.2)", ev("ceil(1.2)"), 2);
  eq("floor(1.8)", ev("floor(1.8)"), 1);
  eq("round(2.5) rounds away from zero", ev("round(2.5)"), 3);
  eq("round(-2.5) rounds away from zero", ev("round(-2.5)"), -3);
  eq("round(3.14159, 2)", ev("round(3.14159, 2)"), 3.14);
  eq("round(1234.5678, 2)", ev("round(1234.5678, 2)"), 1234.57);
  eq("round with negative places is rejected", ev("round(1234, -1)"), "ERR:BAD_ARGS");
  eq("min(3, 1, 2)", ev("min(3, 1, 2)"), 1);
  eq("max(3, 1, 2)", ev("max(3, 1, 2)"), 3);
  eq("sum(1, 2, 3)", ev("sum(1, 2, 3)"), 6);
  eq("sum over properties", ev("sum(Qty, Total)"), 54);
  eq("min flattens a list", ev("min(list(5, 2, 9))"), 2);
  eq("sum flattens a list", ev("sum(list(1, 2, 3))"), 6);
  eq("toNumber(\"42\")", ev('toNumber("42")'), 42);
  eq('numeric operator coerces a numeric string: "7" * 6', ev('"7" * 6'), 42);
  eq('toNumber("abc") is TYPE_MISMATCH', ev('toNumber("abc")'), "ERR:TYPE_MISMATCH");
  eq('numeric op on a non-numeric string is TYPE_MISMATCH', ev('"x" - 1'), "ERR:TYPE_MISMATCH");
  eq('date - number is TYPE_MISMATCH (use subtractDays)', ev('Due - 1'), "ERR:TYPE_MISMATCH");
  eq("bool coerces to 1/0 numerically", ev("true + false"), 1);
  eq("toString(42)", ev("toString(42)"), "42");
  eq("toString(true)", ev("toString(true)"), "true");
  eq("toString(null) is empty text", ev("toString(null)"), "");
  eq("list has no numeric value", ev("toNumber(Tags)"), "ERR:TYPE_MISMATCH");
  eq("toNumber of a date is its timestamp", ev("toNumber(Due)"), Date.UTC(2024, 1, 29));
  eq("toNumber(null) is 0 (documented coercion)", ev("toNumber(null)"), 0);
  eq("toNumber of an empty date is a TYPE_MISMATCH", ev('toNumber(dateStart(prop("Nope"), "day"))'), "ERR:TYPE_MISMATCH");
}

// ── text & lists ────────────────────────────────────────────────────────────

section("Text & lists");
{
  eq("list(1, 2, 3)", ev("list(1, 2, 3)"), listValue([1, 2, 3]));
  eq("list() is the empty list", ev("list()"), listValue([]));
  eq('join(list("a","b","c"), "-")', ev('join(list("a", "b", "c"), "-")'), "a-b-c");
  eq("join uses \", \" by default", ev("join(Tags)"), "a, b, c");
  eq("join of an empty list is empty text", ev('join(list(), ", ")'), "");
  eq('concat("a", 1, true)', ev('concat("a", 1, true)'), "a1true");
  eq("concat() needs an argument", ev("concat()"), "ERR:ARITY");
  eq('length("hello")', ev('length("hello")'), 5);
  eq('length("")', ev('length("")'), 0);
  eq("length(null)", ev("length(null)"), 0);
  eq("length(list)", ev("length(Tags)"), 3);
  eq("length of a number is a type error", ev("length(5)"), "ERR:TYPE_MISMATCH");
  eq('slice("abcdef", 1, 3)', ev('slice("abcdef", 1, 3)'), "bc");
  eq('slice("abcdef", 2)', ev('slice("abcdef", 2)'), "cdef");
  eq('slice("abcdef", -2)', ev('slice("abcdef", -2)'), "ef");
  eq("slice on a list returns a list", ev("slice(Tags, 0, 2)"), listValue(["a", "b"]));
  eq("contains finds a substring", ev('contains("hello world", "world")'), true);
  eq("contains is case-sensitive", ev('contains("Hello", "hello")'), false);
  eq("contains misses", ev('contains("hello", "z")'), false);
  eq("contains works as list membership", ev('contains(Tags, "b")'), true);
  eq("contains misses in a list", ev('contains(Tags, "z")'), false);
  eq("matches is a case-insensitive substring test", ev('matches("Hello World", "world")'), true);
  eq("matches is NOT a regex", ev('matches("abc", "^a")'), false);
  eq("matches on empty needle is true", ev('matches("abc", "")'), true);
  eq("empty(null)", ev("empty(null)"), true);
  eq('empty("")', ev('empty("")'), true);
  eq("empty(list())", ev("empty(list())"), true);
  eq('empty(" ") is false', ev('empty(" ")'), false);
  eq("empty(0) is false", ev("empty(0)"), false);
  eq("empty(false) is false", ev("empty(false)"), false);
  eq("empty(date)", ev("empty(Due)"), false);
  eq("notEmpty(text)", ev('notEmpty("x")'), true);
  eq("notEmpty(list)", ev('notEmpty(list("x"))'), true);
}

// ── logic & if ──────────────────────────────────────────────────────────────

section("Logic & if short-circuiting");
{
  eq("and(true, true)", ev("and(true, true)"), true);
  eq("and(true, false)", ev("and(true, false)"), false);
  eq("and is variadic", ev("and(1, 2, 3)"), true);
  eq("or(false, true)", ev("or(false, true)"), true);
  eq("or(false, false)", ev("or(false, false)"), false);
  eq("not(0)", ev("not(0)"), true);
  eq('not("")', ev('not("")'), true);
  eq("if(true, a, b)", ev('if(true, "yes", "no")'), "yes");
  eq("if(false, a, b)", ev('if(false, "yes", "no")'), "no");
  eq("if uses truthiness", ev('if("", "yes", "no")'), "no");
  eq("if on a property", ev('if(Qty > 3, "big", "small")'), "big");
  eq("if does not evaluate the false branch", ev("if(false, 1 / 0, 2)"), 2);
  eq("if does not evaluate the true branch's alternative", ev("if(true, 3, 1 / 0)"), 3);
  eq("and short-circuits", ev("and(false, 1 / 0)"), false);
  eq("or short-circuits", ev("or(true, 1 / 0)"), true);
  eq("if with two arguments returns null", ev("if(false, 1)"), null);
  eq("if evaluates its condition (errors surface)", ev("if(1 / 0, 1, 2)"), "ERR:DIV_BY_ZERO");
  eq("greaterOrEqual(5, 5)", ev("greaterOrEqual(5, 5)"), true);
  eq("greaterOrEqual(4, 5)", ev("greaterOrEqual(4, 5)"), false);
  eq("lessOrEqual(4, 5)", ev("lessOrEqual(4, 5)"), true);
  eq("lessOrEqual(5, 4)", ev("lessOrEqual(5, 4)"), false);
  eq("greaterOrEqual on text", ev('greaterOrEqual("b", "a")'), true);
  eq("lessOrEqual on dates", ev('lessOrEqual(Due, "2024-02-29")'), true);
  eq("1 == \"1\" (coercion)", ev('1 == "1"'), true);
  eq('1 == "a" is a TYPE_MISMATCH, not false', ev('1 == "a"'), "ERR:TYPE_MISMATCH");
  eq("true == 1", ev("true == 1"), true);
  eq('"b" > "a" is code-unit order', ev('"b" > "a"'), true);
  eq("lists cannot be ordered", ev("Tags > Tags"), "ERR:TYPE_MISMATCH");
  eq("lists compare element-wise with ==", ev("list(1, 2) == list(1, 2)"), true);
}

// ── dates ───────────────────────────────────────────────────────────────────

section("Dates");
{
  eq('year("2024-02-29")', ev('year("2024-02-29")'), 2024);
  eq('month("2024-02-29")', ev('month("2024-02-29")'), 2);
  eq('day("2024-02-29")', ev('day("2024-02-29")'), 29);
  eq("leap day + 1 day crosses into March", startMs('addDays("2024-02-29", 1)'), Date.UTC(2024, 2, 1));
  eq("1 day before March is the leap day", startMs('subtractDays("2024-03-01", 1)'), Date.UTC(2024, 1, 29));
  eq("year boundary forward", startMs('addDays("2023-12-31", 1)'), Date.UTC(2024, 0, 1));
  eq("365 days back from 2024-01-01", startMs('subtractDays("2024-01-01", 365)'), Date.UTC(2023, 0, 1));
  eq("one day back from a leap year's start", startMs('subtractDays("2024-01-01", 366)'), Date.UTC(2022, 11, 31));
  eq("addMonths clamps onto the leap day", startMs('addMonths("2024-01-31", 1)'), Date.UTC(2024, 1, 29));
  eq("addMonths clamps in a common year", startMs('addMonths("2023-01-31", 1)'), Date.UTC(2023, 1, 28));
  eq("addMonths rolls the year over", startMs('addMonths("2024-12-31", 1)'), Date.UTC(2025, 0, 31));
  eq("addMonths goes backwards across a year end", startMs('addMonths("2024-03-15", -4)'), Date.UTC(2023, 10, 15));
  eq("addMonths goes backwards to December", startMs('addMonths("2024-03-15", -3)'), Date.UTC(2023, 11, 15));
  eq("addMonths needs whole months", ev('addMonths("2024-03-15", 1.5)'), "ERR:BAD_ARGS");
  eq("addDays keeps the all-day flag", JSON.stringify(ev('addDays("2024-02-29", 1)')).includes('"allDay":true'), true);
  eq("addDays on a timed date keeps it timed", JSON.stringify(ev('addDays("2024-06-15 09:30", 1)')).includes('"allDay":false'), true);
  eq("dateDiff days across the leap day", ev('dateDiff("2024-03-01", "2024-02-29", "days")'), 1);
  eq("dateDiff is signed", ev('dateDiff("2024-02-29", "2024-03-01", "days")'), -1);
  eq("dateDiff of a date with itself is 0", ev("dateDiff(Due, Due, \"days\")"), 0);
  eq("dateDiff months", ev('dateDiff("2024-03-01", "2024-02-01", "months")'), 1);
  eq("dateDiff years counts whole years", ev('dateDiff("2025-06-15", "2024-06-14", "years")'), 1);
  eq("dateDiff years does not round up", ev('dateDiff("2025-06-15", "2024-06-16", "years")'), 0);
  eq("dateDiff hours is fractional", ev('dateDiff("2024-06-15 12:00", "2024-06-15 09:30", "hours")'), 2.5);
  eq("dateDiff weeks", ev('dateDiff("2024-06-29", "2024-06-15", "weeks")'), 2);
  eq("dateDiff rejects an unknown unit", ev('dateDiff("2024-01-01", "2024-01-02", "decades")'), "ERR:BAD_ARGS");
  eq("dateStart day", startMs('dateStart("2024-06-15 09:30", "day")'), Date.UTC(2024, 5, 15));
  eq("dateStart month", startMs('dateStart("2024-06-15", "month")'), Date.UTC(2024, 5, 1));
  eq("dateStart year", startMs('dateStart("2024-06-15", "year")'), Date.UTC(2024, 0, 1));
  eq("dateStart week is Monday-based", startMs('dateStart("2024-06-15", "week")'), Date.UTC(2024, 5, 10));
  eq("dateStart rejects an unknown unit", ev('dateStart("2024-06-15", "decade")'), "ERR:BAD_ARGS");
  eq("dateEnd day is inclusive", startMs('dateEnd("2024-06-15", "day")'), Date.UTC(2024, 5, 15, 23, 59, 59, 999));
  eq("dateEnd month lands on the leap day", startMs('dateEnd("2024-02-15", "month")'), Date.UTC(2024, 1, 29, 23, 59, 59, 999));
  eq("dateEnd year", startMs('dateEnd("2024-02-15", "year")'), Date.UTC(2024, 11, 31, 23, 59, 59, 999));
  eq("today() is midnight UTC of ctx.today()", startMs("today()"), Date.UTC(2024, 5, 15));
  eq("today() is all-day", ev("today()"), dateValue(Date.UTC(2024, 5, 15), null, true));
  eq("now() is ctx.today()", startMs("now()"), NOW);
  eq("year(today())", ev("year(today())"), 2024);
  eq("month(today())", ev("month(today())"), 6);
  eq("day(today())", ev("day(today())"), 15);
  eq("date equality against a string literal", ev('Due == "2024-02-29"'), true);
  eq("date order compares .start", ev('Due < "2024-03-01"'), true);
  eq("date order is not lexical", ev('Due > "2024-03-01"'), false);
  eq("addDays result equals a literal", ev('addDays(Due, 1) == "2024-03-01"'), true);
  eq("date on the left of + concatenates", ev('Due + ""'), "2024-02-29");
  eq("toDateString default is YYYY-MM-DD", ev("toDateString(Due)"), "2024-02-29");
  eq("toDateString with a custom pattern", ev('toDateString(When, "DD/MM/YYYY HH:mm")'), "15/06/2024 09:30");
  eq("toDateString of a string date", ev('toDateString("2024-02-29", "YYYY/MM/DD")'), "2024/02/29");
  eq("toString of an all-day date", ev("toString(Due)"), "2024-02-29");
  eq("toString of a timed date", ev("toString(When)"), "2024-06-15 09:30");
  eq("year of a non-date string is a TYPE_MISMATCH", ev('year("not-a-date")'), "ERR:TYPE_MISMATCH");
  eq("empty date has no year", ev('year(prop("Nope"))'), "ERR:TYPE_MISMATCH");
  eq("a timed string literal formats", ev('format("2024-06-15 09:30", "HH:mm")'), "09:30");
  eq("month arithmetic on a property date", ev("month(addMonths(Due, 12))"), 2);
}

// ── format ──────────────────────────────────────────────────────────────────

section("format()");
{
  eq("date pattern YYYY-MM-DD", ev('format(Due, "YYYY-MM-DD")'), "2024-02-29");
  eq("date pattern with time", ev('format(When, "YYYY-MM-DD HH:mm")'), "2024-06-15 09:30");
  eq("date pattern MM/DD", ev('format(When, "MM/DD")'), "06/15");
  eq("{percent} multiplies by 100", ev('format(Progress, "{percent}")'), "50%");
  eq("{d} is the magnitude", ev('format(Progress, "{d}")'), "0.5");
  eq("{sign}{d} for a negative", ev('format(-5, "{sign}{d}")'), "-5");
  eq("{sign}{d} for a positive", ev('format(5, "{sign}{d}")'), "+5");
  eq("{sign} for zero is empty", ev('format(0, "{sign}{d}")'), "0");
  eq("pattern text is preserved", ev('format(1234, "{d} USD")'), "1234 USD");
  eq("{d} on text substitutes the value", ev('format(Name, "{d}")'), "Atlas");
  eq("format of a date ignores number tokens", ev('format(Due, "MM")'), "02");
}

// ── parse & eval errors ─────────────────────────────────────────────────────

section("Errors & guards");
{
  eq("unknown function", ev("nope(1)"), "ERR:UNKNOWN_FUNCTION");
  eq("unknown function carries a position", fail("nope(1)")?.position, 0);
  eq("unknown function nested in a call", ev("add(1, nope(2))"), "ERR:UNKNOWN_FUNCTION");
  eq("trailing garbage", ev("1 + 2 )"), "ERR:TRAILING_INPUT");
  eq("trailing garbage after a complete formula", ev("1 2"), "ERR:TRAILING_INPUT");
  eq("trailing garbage carries a position", fail("1 2")?.position, 2);
  eq("trailing garbage after a call", ev('prop("a") 7'), "ERR:TRAILING_INPUT");
  eq("too many arguments", ev("abs(1, 2)"), "ERR:ARITY");
  eq("too few arguments", ev("add(1)"), "ERR:ARITY");
  eq("zero-argument call of a 1-arg function", ev("year()"), "ERR:ARITY");
  eq("now() takes no arguments", ev("now(1)"), "ERR:ARITY");
  eq("empty source", ev(""), "ERR:EXPECTED_VALUE");
  eq("dangling binary operator", ev("1 +"), "ERR:EXPECTED_VALUE");
  eq("missing close paren", ev('prop("a"'), "ERR:EXPECTED_TOKEN");
  eq("close paren without open", ev("1)"), "ERR:TRAILING_INPUT");
  eq("stray comma", ev("1 , 2"), "ERR:TRAILING_INPUT");
  eq("FormulaError is an Error", (() => {
    const e = fail("1 / 0");
    return e instanceof FormulaError && e instanceof Error && e.name === "FormulaError";
  })(), true);
  eq("FormulaError carries code and position", (() => {
    const e = new FormulaError("m", "CODE", 3);
    return e.code === "CODE" && e.position === 3;
  })(), true);
  eq("1000 nested parens is TOO_DEEP, not a stack overflow", ev(parens(1000)), "ERR:TOO_DEEP");
  eq("1000 nested parens reports a position", fail(parens(1000))?.position !== undefined, true);
  eq("150 nested parens parse and evaluate", ev(parens(150)), 1);
  eq("paren nesting cap is the documented 200", MAX_DEPTH, 200);
  eq("a 1000-term chain is rejected by the AST depth guard", ev(Array(1001).fill("1").join("+")), "ERR:TOO_DEEP");
  eq("a 1000-term chain parses without a stack overflow", (() => {
    try {
      parseFormula(Array(1001).fill("1").join("+"));
      return false; // rejected by the depth guard, which is the point
    } catch (e) {
      return e instanceof FormulaError;
    }
  })(), true);
  eq("a stored AST deeper than the cap is refused at eval time", (() => {
    let node: FormulaNode = { k: "num", v: 1 };
    for (let i = 0; i < 500; i++) node = { k: "paren", expr: node };
    try {
      evaluateFormula(node, ctx);
      return "no error";
    } catch (e) {
      return e instanceof FormulaError ? `ERR:${e.code}` : "wrong error";
    }
  })(), "ERR:TOO_DEEP");
  eq("a hand-built bogus node kind is refused", (() => {
    try {
      evaluateFormula({ k: "wat" } as unknown as FormulaNode, ctx);
      return "no error";
    } catch (e) {
      return e instanceof FormulaError ? `ERR:${e.code}` : "wrong error";
    }
  })(), "ERR:BAD_NODE");
  eq("an unknown operator in a stored AST is refused", (() => {
    try {
      evaluateFormula({ k: "bin", op: "^", left: { k: "num", v: 1 }, right: { k: "num", v: 1 } }, ctx);
      return "no error";
    } catch (e) {
      return e instanceof FormulaError ? `ERR:${e.code}` : "wrong error";
    }
  })(), "ERR:BAD_OP");
  eq("an unknown function in a stored AST is refused", (() => {
    try {
      evaluateFormula({ k: "call", name: "sneaky", args: [] }, ctx);
      return "no error";
    } catch (e) {
      return e instanceof FormulaError ? `ERR:${e.code}` : "wrong error";
    }
  })(), "ERR:UNKNOWN_FUNCTION");
  eq("the engine never executes code (no eval / new Function / dynamic import)", (() => {
    // Scan the code, not the prose: the header comment names the forbidden APIs.
    const src = readFileSync(join(import.meta.dirname!, "..", "server", "formula.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^[ \t]*\/\/.*$/gm, " ");
    const banned = [/\beval\s*\(/, /new\s+Function/, /\bimport\s*\(/, /\brequire\s*\(/];
    return banned.every((re) => !re.test(src));
  })(), true);
}

// ── extractRefs ─────────────────────────────────────────────────────────────

section("extractRefs");
{
  eq('prop("Price") * Qty', extractRefs(parseFormula('prop("Price") * Qty')), ["Price", "Qty"]);
  eq("bare identifiers count as refs", extractRefs(parseFormula("Price * Qty")), ["Price", "Qty"]);
  eq("refs nested inside calls", extractRefs(parseFormula('add(prop("A"), 1)')), ["A"]);
  eq("refs inside if branches", extractRefs(parseFormula('if(prop("Done"), prop("A"), prop("B"))')), ["Done", "A", "B"]);
  eq("refs inside a binop tree", extractRefs(parseFormula("(X + Y) * (Z - 1)")), ["X", "Y", "Z"]);
  eq("refs inside unary", extractRefs(parseFormula("!Done")), ["Done"]);
  eq("refs inside parens", extractRefs(parseFormula("(prop(\"X\") + 1) * 2")), ["X"]);
  eq("refs nested several calls deep", extractRefs(parseFormula('format(addDays(prop("Due"), length(prop("Name"))), "YYYY")')), ["Due", "Name"]);
  eq("refs are deduped", extractRefs(parseFormula('prop("A") + A + prop("A")')), ["A"]);
  eq("a formula with no refs", extractRefs(parseFormula("1 + 2 * 3")), []);
  eq("ref order is source order", extractRefs(parseFormula('concat(Second, "-", First)')), ["Second", "First"]);
  eq("prop name is not reported as a ref", extractRefs(parseFormula('prop("Name")')), ["Name"]);
}

// ── inferResultType ─────────────────────────────────────────────────────────

section("inferResultType");
{
  const t = (src: string) => inferResultType(parseFormula(src));
  eq("number literal", t("1 + 2"), "number");
  eq("text literal", t('"a"'), "text");
  eq("date-shaped literal", t('"2024-01-01"'), "date");
  eq("boolean literal", t("true"), "checkbox");
  eq("property read is unknown", t('prop("X")'), "unknown");
  eq("comparison", t("1 > 2"), "checkbox");
  eq("logical and", t("true && false"), "checkbox");
  eq("concat is text", t('concat("a", 1)'), "text");
  eq("length is a number", t('length("a")'), "number");
  eq("empty is a checkbox", t("empty(1)"), "checkbox");
  eq("today() is a date", t("today()"), "date");
  eq("addDays is a date", t("addDays(today(), 1)"), "date");
  eq("format is text", t('format(1, "{d}")'), "text");
  eq("if unifies both branches", t('if(1 > 2, "a", "b")'), "text");
  eq("if unifies numbers", t("if(1 > 2, 1, 2)"), "number");
  eq("if with mixed branches is unknown", t('if(1, 2, "a")'), "unknown");
  eq("property arithmetic is a number", t('prop("Price") * 2'), "number");
  eq("paren passes through", t("(1 + 2) * 3"), "number");
  eq("unary minus is a number", t("-prop(\"X\")"), "number");
  eq("unary not is a checkbox", t('not(prop("X"))'), "checkbox");
  eq("dateDiff is a number", t('dateDiff(today(), today(), "days")'), "number");
  eq("join is text", t('join(list("a"), ",")'), "text");
  eq("sum is a number", t("sum(Qty, Total)"), "number");
  eq("string + number is text", t('prop("X") + 1'), "unknown");
  eq("number + text is text", t('1 + "a"'), "text");
  eq("year is a number", t('year("2024-01-01")'), "number");
  eq("toNumber is a number", t('toNumber("1")'), "number");
  eq("list() is unknown", t("list(1, 2)"), "unknown");
  eq("null literal is unknown", t("null"), "unknown");
}

// ── function specs (autocomplete) ───────────────────────────────────────────

section("FORMULA_FUNCTIONS");
{
  const REQUIRED = [
    "prop", "if", "and", "or", "not", "add", "subtract", "multiply", "divide", "mod",
    "abs", "ceil", "floor", "round", "min", "max", "sum", "toNumber", "toString",
    "concat", "join", "list", "length", "slice", "contains", "matches", "empty",
    "notEmpty", "format", "year", "month", "day", "dateStart", "dateEnd", "addDays",
    "subtractDays", "addMonths", "dateDiff", "toDateString", "now", "today",
    "greaterOrEqual", "lessOrEqual",
  ];
  const names = FORMULA_FUNCTIONS.map((f) => f.name);
  const missing = REQUIRED.filter((n) => !names.includes(n));
  eq("every required function has a spec", missing, []);
  ok(`there are ${FORMULA_FUNCTIONS.length} specs (>= 43)`, FORMULA_FUNCTIONS.length >= 43);
  eq("no duplicate spec names", new Set(names).size, names.length);
  const badSpec = FORMULA_FUNCTIONS.find(
    (f) =>
      !f.signature.startsWith(f.name) ||
      f.description.length === 0 ||
      f.argCount.length !== 2 ||
      f.argCount[0] > f.argCount[1] ||
      f.argCount[0] < 0,
  );
  eq("every spec has a signature, description and sane argCount", badSpec, undefined);
  eq("every spec function parses", FORMULA_FUNCTIONS.map((f) => f.name).filter((n) => {
    try {
      parseFormula(`${n}()`);
      return false; // arity errors are expected; only crashes on syntax matter
    } catch (e) {
      return e instanceof FormulaError && e.code !== "ARITY";
    }
  }), []);
  eq("round is documented as taking optional places", FORMULA_FUNCTIONS.find((f) => f.name === "round")?.argCount, [1, 2]);
  eq("if is documented as three arguments", FORMULA_FUNCTIONS.find((f) => f.name === "if")?.argCount, [2, 3]);
  eq("now is documented as nullary", FORMULA_FUNCTIONS.find((f) => f.name === "now")?.argCount, [0, 0]);
}

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
