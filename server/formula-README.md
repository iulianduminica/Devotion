# Strata formula language

A Notion-flavoured expression language for `formula` properties. Implemented in
`server/formula.ts` as a hand-written lexer + recursive-descent parser +
tree-walking evaluator over the shared `FormulaNode` AST.

**Formula source is untrusted text.** It is never compiled, imported, or fed to
`eval` / `new Function`. Parsing yields data; evaluation interprets the data.

```ts
import { parseFormula, evaluateFormula, evalSource, extractRefs, inferResultType } from "../server/formula.ts";

const ast = parseFormula('if(prop("Done"), "done", prop("Name"))'); // store this in FormulaConfig.ast
const value = evaluateFormula(ast, ctx);                            // ctx: { prop(name), today() }
```

---

## Grammar (EBNF-ish)

```
expr      := or
or        := and ( "||" and )*
and       := equality ( "&&" equality )*
equality  := comparison ( ("==" | "!=") comparison )*
comparison:= additive ( ("<" | "<=" | ">" | ">=") additive )*
additive  := term ( ("+" | "-") term )*
term      := unary ( ("*" | "/" | "%") unary )*
unary     := ("!" | "-") unary | primary
primary   := number | string | "true" | "false" | "null"
           | name "(" [expr {"," expr}] ")"      // function call
           | name                                // bare property reference
           | "(" expr ")"
```

All binary operators are left-associative. Whitespace is insignificant.
`//` starts a comment that runs to the end of the line.

## Literals

| Literal | Type | Notes |
| --- | --- | --- |
| `42`, `3.5`, `.5` | number | no exponent form (`1e3` is a parse error) |
| `-7` | number | unary minus applied to `7` |
| `"text"` | text | double quotes only; escapes `\"` `\\` `\n` `\r` `\t` |
| `"2024-02-29"`, `"2024-06-15 09:30"` | date | see [Dates](#dates) |
| `true` / `false` | checkbox | |
| `null` | empty | stored as `{k:"call",name:"null",args:[]}` |

`1,234` is **not** supported: `1,234` lexes as `1`, `,`, `234` and the parser
rejects it with `TRAILING_INPUT`. Thousands separators belong to `format()`,
never to source text. `=` is not an operator — use `==`.

## Operators

From the table above, lowest precedence first: `||`, `&&`, `==` `!=`,
`<` `<=` `>` `>=`, `+` `-`, `*` `/` `%`, then unary `!` and `-`.

`1 + 2 * 3 == 7` → `true`. `true || false && false` → `true`.

## Types and coercion

Four value types (number, text, checkbox, date) plus `null` and lists.

**Truthiness** — false: `null`, `""`, `0`, `false`, `[]`, a date with no start.
Everything else is true. `"0"` is true (it is not empty).

**Numeric coercion** (used by `- * / %`, unary `-`, `add`/`subtract`/`multiply`/
`divide`/`mod`, `abs`/`ceil`/`floor`/`round`, `min`/`max`/`sum`, `length`…):

| Value | Becomes |
| --- | --- |
| number | itself |
| `true` / `false` | `1` / `0` |
| `null` | `0` |
| `""` | `0` |
| `"42"`, `"-3.5"`, `"+2"` | parsed; **fully** numeric only |
| `"abc"`, `"1,234"`, `"12px"` | `TYPE_MISMATCH` |
| date | `TYPE_MISMATCH` — use `dateDiff`, `addDays`, `toNumber` |
| list | `TYPE_MISMATCH` |

**`+` is the one overloaded operator:**

- number `+` number → numeric add
- **any** text operand (or date) → concatenation, stringifying the other side.
  So `1 + "a"` → `"1a"` and `Due + ""` → `"2024-02-29"`. Date arithmetic is
  `addDays(d, n)`, never `d + n`.
- `null + 1` → `1`; `null + "x"` → `"x"` (null stringifies to `""`)

**Stringification** (`toString`, `concat`, `+` on text): number → plain digits,
no grouping separators, and float noise is trimmed to 12 significant digits
(`0.1 + 0.2` prints as `0.3`); `true`/`false` → `"true"`/`"false"`;
`null` → `""`; list → items joined with `", "`; date → `YYYY-MM-DD`, plus
` HH:mm` when it is not all-day.

**Comparison** (`==`, `!=`, `<`, `<=`, `>`, `>=`, `greaterOrEqual`,
`lessOrEqual`): numbers numerically; text by code-unit order; **dates by
`.start`** (a date-shaped string on the other side joins the date order, and an
empty date sorts first); mixed number/text coerces the text; `true == 1` is
`true`; `null` equals only `null`; lists compare element-wise with `==` and
cannot be ordered (`TYPE_MISMATCH`).

**Errors never leak values:** division/modulo by zero raises `DIV_BY_ZERO`, and
any non-finite numeric result raises `NOT_FINITE`. `Infinity` and `NaN` are not
reachable from a formula.

## Values, properties, context

```ts
interface EvalContext {
  prop(name: string): FormulaValue; // by NAME, not id
  today(): number;                  // epoch ms; injected so tests are deterministic
  row?: Record<string, unknown>;
}
```

Two ways to read a property: `prop("Price")` and the bare identifier `Price`
(identifiers are `[A-Za-z_][A-Za-z0-9_]*`, so names with spaces need `prop()`).
A missing property evaluates to `null` — including when `ctx.prop` throws.

`normalizeValue` accepts what the storage layer hands back: `string[]`
(multi_select), `{ rows: string[] }` (relation), `{ mediaIds: string[] }`
(files), `{ start, end, allDay }` (date), `Date`, `undefined`. Relations arrive
as lists, so `length(prop("Tasks"))` and `contains(prop("Tasks"), id)` work.

## Dates

Date literals are read as **UTC**, and every date function is UTC-based, so a
formula returns the same result on every machine and across DST changes. A date
is `{ start, end, allDay }`; arithmetic reads `start` and preserves `allDay`.

`now()` and `today()` read `ctx.today()`, never the wall clock — the host
decides what "today" means, and formulas stay deterministic.

`dateStart`/`dateEnd` accept `day | week | month | quarter | year` (week starts
Monday). `dateEnd` returns the **last millisecond** of the period, so a range
end stays inclusive. `addMonths` clamps the day-of-month: Jan 31 + 1 month →
Feb 29 (2024) / Feb 28 (2023). `dateDiff(a, b, unit)` returns `a − b`;
`days | weeks | hours | minutes | seconds` are exact quotients (fractional
allowed), `months | years` count **whole** calendar units.

## Functions

`if`, `and`, `or` are **special forms**: arguments are evaluated lazily, so the
untaken branch never runs (`if(false, 1/0, 2)` → `2`). Every other function
evaluates its arguments first.

### Core

| Function | Result | Notes |
| --- | --- | --- |
| `prop(name)` | any | read a property by name |
| `if(cond, a, b?)` | a/b | truthiness test; `b` defaults to `null` |
| `and(a, b, …)` | checkbox | short-circuits left to right |
| `or(a, b, …)` | checkbox | short-circuits left to right |
| `not(x)` | checkbox | negated truthiness |

### Numbers

| Function | Result | Notes |
| --- | --- | --- |
| `add(a,b)` `subtract(a,b)` `multiply(a,b)` | number | numeric; coercing per the rule above |
| `divide(a,b)` `mod(a,b)` | number | `b = 0` → `DIV_BY_ZERO`; `mod` follows JS signs |
| `abs(n)` `ceil(n)` `floor(n)` | number | |
| `round(n, places?)` | number | `places` 0–15; halves round away from zero |
| `min(…)` `max(…)` `sum(…)` | number | variadic; lists are flattened, `null` skipped |
| `toNumber(x)` | number | a date → its timestamp; `"abc"` → `TYPE_MISMATCH` |
| `greaterOrEqual(a,b)` `lessOrEqual(a,b)` | checkbox | same comparison rules as `>=` / `<=` |

### Text & lists

| Function | Result | Notes |
| --- | --- | --- |
| `toString(x)` | text | |
| `concat(a, b, …)` | text | stringifies every argument |
| `list(a, b, …)` | list | `list()` is the empty list |
| `join(list, sep)` | text | `sep` defaults to `", "`; a non-list joins as one item |
| `length(x)` | number | chars in text, items in a list, `0` for `null`/`""`/`[]` |
| `slice(x, start, end?)` | same | JS slice semantics, works on text and lists |
| `contains(haystack, needle)` | checkbox | substring for text, membership for a list; case-sensitive |
| `matches(str, pattern)` | checkbox | **literal** substring, case-insensitive — not a regex |
| `empty(x)` `notEmpty(x)` | checkbox | true for `null`, `""`, `[]`, a date with no start |

### Formatting

| Function | Result | Notes |
| --- | --- | --- |
| `format(value, pattern)` | text | see below |
| `toDateString(d, format?)` | text | default `YYYY-MM-DD` |

`format` patterns mix two token sets:

- **dates**: `YYYY MM DD HH mm` → zero-padded UTC parts. `format(Due, "YYYY-MM-DD")` → `2024-02-29`.
- **numbers**: `{d}` the magnitude, `{sign}` `+` / `-` / empty, `{percent}` value × 100 with `%`. `format(-5, "{sign}{d}")` → `-5`, `format(0.5, "{percent}")` → `50%`.
- text value: `{d}` is replaced by the value; everything else passes through.

### Dates

| Function | Result |
| --- | --- |
| `year(d)` `month(d)` `day(d)` | number (month 1–12) |
| `dateStart(d, unit)` `dateEnd(d, unit)` | date |
| `addDays(d, n)` `subtractDays(d, n)` `addMonths(d, n)` | date |
| `dateDiff(a, b, unit)` | number (`a − b`) |
| `now()` `today()` | date from `ctx.today()` |

`d` arguments also accept a numeric timestamp or a date-shaped string.

## Errors

Every failure is a `FormulaError` with a `code` and, for anything the parser
detects, a `position` (character offset) the editor can underline.

| Code | Raised when |
| --- | --- |
| `UNEXPECTED_CHAR`, `BAD_ESCAPE`, `UNTERMINATED_STRING` | lexer |
| `EXPECTED_VALUE`, `EXPECTED_TOKEN`, `TRAILING_INPUT` | syntax, including garbage after a complete formula |
| `TOO_DEEP` | nesting over `MAX_DEPTH` (200) at parse, eval, or `inferResultType` |
| `UNKNOWN_FUNCTION`, `ARITY` | rejected at **parse** time, with the call's position |
| `DIV_BY_ZERO` | `/` or `%` with a zero divisor, `divide`, `mod` |
| `TYPE_MISMATCH` | a value the operator cannot use (e.g. `"x" - 1`, `Due - 1`) |
| `NOT_FINITE` | an arithmetic result that overflowed to `Infinity`/`NaN` |
| `BAD_ARGS` | an unknown unit, bad `round` places, an empty aggregate |
| `DATE_RANGE` | a date shifted past the representable range |
| `BAD_NODE`, `BAD_OP`, `BAD_SOURCE`, `INTERNAL` | a malformed stored AST |

## Depth limits

`MAX_DEPTH = 200` bounds AST nesting. The parser counts `(` and each call
argument, and `parseFormula` then measures the finished tree iteratively, so
`((((…1…))))` at 1000 levels fails fast with `TOO_DEEP` instead of overflowing
the stack. `evaluateFormula`, `inferResultType` and `extractRefs` re-check the
depth, because a stored AST can predate the parser. A 1000-term chain like
`1+1+…+1` is rejected by the same check (its tree is 1001 deep).

## Static analysis

```ts
extractRefs(ast);      // ["Price", "Qty"] — props in calls, binops, ifs, parens; deduped, source order
inferResultType(ast);  // "number" | "text" | "date" | "checkbox" | "unknown"
FORMULA_FUNCTIONS;     // FunctionSpec[] for autocomplete: name, signature, description, argCount
```

`inferResultType` is best-effort: reading a property is `unknown` (its type
lives in the schema), and `if` unifies its two branches. `format()` and
`toDateString()` return text.

## Deliberate limits

No ternary `? :`, no assignment, no user-defined functions, no regex
(`matches` is a literal substring test), no exponent literals, no `1,234`
number grouping, no local-time date math, no `eval` of anything.
