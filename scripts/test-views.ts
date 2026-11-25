/**
 * View-logic tests: the pure helpers behind Timeline, Chart and Form.
 *
 * Run with: & .\node_modules\.bin\tsx.cmd scripts/test-views.ts
 *
 * Nothing here touches the database, the API, React or the DOM — every
 * assertion is a function call on plain objects. All expected dates are built
 * with Date.UTC so the suite is timezone-independent.
 */

import type {
  AggregateFunction,
  PropertyDef,
  PropertyValueInput,
  RowView,
  SelectOption,
  StatusGroup,
} from "../shared/types.ts";
import {
  CHART_OTHER_LABEL,
  DAY_MS,
  addMonths,
  aggregateValues,
  buildChartData,
  buildTimeline,
  chartAxis,
  coerceFormValues,
  dayStart,
  dayTicks,
  dayIndex,
  dateValue,
  formFields,
  formTitle,
  formatChartNumber,
  groupBars,
  initialFormValues,
  isEmptyValue,
  isFieldRequired,
  isFormEditable,
  isFormReadonly,
  isoDate,
  issuesByProp,
  linePoints,
  monthOf,
  monthStart,
  monthTicks,
  numberBins,
  numericValue,
  optionName,
  optionsOf,
  packLanes,
  pieSlices,
  positionBar,
  pxToDayOffset,
  quarterStart,
  quarterTicks,
  resizeSpanEnd,
  rowSpan,
  seriesColor,
  shiftSpan,
  shortDate,
  slotCenterX,
  ticksForZoom,
  todayOffsetPct,
  validateForm,
  valueToY,
  weekStart,
  weekTicks,
} from "../src/db/viewLogic.ts";

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

function near(label: string, actual: number, expected: number, eps = 1e-6): void {
  ok(label, Math.abs(actual - expected) <= eps, `got ${actual}, want ~${expected}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const opt = (id: string, name: string, color = "default"): SelectOption => ({ id, name, color } as SelectOption);

function prop(id: string, name: string, type: PropertyDef["type"], config: Record<string, unknown> = {}): PropertyDef {
  return { id, db_id: "db1", name, type, pos: "a", config: config as PropertyDef["config"] };
}

const TITLE = prop("p_title", "Name", "title");
const START = prop("p_start", "Start", "date");
const END = prop("p_end", "End", "date");
const NUM = prop("p_num", "Cost", "number");
const DONE = prop("p_done", "Done", "checkbox");
const TAG = prop("p_tag", "Tag", "select", {
  options: [opt("o_urgent", "Urgent", "red"), opt("o_normal", "Normal", "blue"), opt("o_later", "Later", "gray")],
});
const TAGS = prop("p_tags", "Tags", "multi_select", {
  options: [opt("m_a", "Alpha"), opt("m_b", "Beta")],
});
const STATE = prop("p_state", "State", "status", {
  groups: [
    { id: "to_do", name: "To-do", color: "gray", options: [opt("s_todo", "To-do")] },
    { id: "in_progress", name: "In Progress", color: "blue", options: [opt("s_prog", "In Progress")] },
    { id: "complete", name: "Complete", color: "green", options: [opt("s_done", "Done")] },
  ] satisfies StatusGroup[],
});
const NOTES = prop("p_notes", "Notes", "text");
const MAIL = prop("p_mail", "Email", "email");
const SITE = prop("p_site", "Site", "url");
const PHONE = prop("p_phone", "Phone", "phone");
const CREATED = prop("p_created", "Created", "created_time");
const FORMULA = prop("p_formula", "Total", "formula", { source: "1", ast: { k: "num", v: 1 } });

const PROPS: PropertyDef[] = [TITLE, START, END, NUM, DONE, TAG, TAGS, STATE, NOTES, MAIL, SITE, PHONE, CREATED, FORMULA];

function row(title: string, values: Record<string, PropertyValueInput>): RowView {
  return {
    node: {
      id: `row_${title}`,
      ws: "ws",
      kind: "row",
      type: "page",
      parent_id: null,
      parent_kind: "database",
      pos: "a",
      props: {},
      body: null,
      meta: {},
      created_at: 0,
      created_by: "u",
      updated_at: 0,
      updated_by: "u",
      deleted_at: null,
      template_ref: null,
    },
    values,
    title,
  };
}

const d = (y: number, m: number, day: number): number => {
  const t = Date.UTC(y, m, day);
  if (!Number.isFinite(t)) throw new Error(`bad fixture date ${y}-${m}-${day}`);
  return t;
};
const dateVal = (start: number | null, end: number | null = null): PropertyValueInput => ({
  start,
  end,
  allDay: true,
});

// ─────────────────────────────────────────────────────────────────────────────

section("Date primitives (UTC)");
{
  eq("DAY_MS is 86400000", DAY_MS, 86_400_000);
  eq("dayStart floors to midnight UTC", dayStart(d(2026, 2, 7) + 13 * 3_600_000), d(2026, 2, 7));
  eq("dayStart of exact midnight is a no-op", dayStart(d(2026, 2, 7)), d(2026, 2, 7));
  eq("dayStart of a pre-epoch ms stays on a day boundary", dayStart(-1), -DAY_MS);
  eq("dayIndex of epoch 0", dayIndex(0), 0);
  eq("dayIndex of 1970-01-02", dayIndex(DAY_MS), 1);
  eq("dayIndex of 1969-12-31", dayIndex(-DAY_MS), -1);

  eq("monthOf January", monthOf(d(2026, 0, 31)), { y: 2026, m: 0 });
  eq("monthOf December", monthOf(d(2026, 11, 1)), { y: 2026, m: 11 });
  eq("monthStart of mid-March", monthStart(d(2026, 2, 17)), d(2026, 2, 1));
  eq("addMonths rolls the year forward", addMonths(d(2026, 11, 30), 1), d(2027, 0, 1));
  eq("addMonths rolls the year back", addMonths(d(2026, 0, 3), -1), d(2025, 11, 1));
  eq("addMonths(0) is the month start", addMonths(d(2026, 4, 9), 0), d(2026, 4, 1));

  eq("quarterStart of February", quarterStart(d(2026, 1, 11)), d(2026, 0, 1));
  eq("quarterStart of May", quarterStart(d(2026, 4, 2)), d(2026, 3, 1));
  eq("quarterStart of August", quarterStart(d(2026, 7, 31)), d(2026, 6, 1));
  eq("quarterStart of November", quarterStart(d(2026, 10, 1)), d(2026, 9, 1));

  eq("weekStart of a Sunday is the Monday before", weekStart(d(2026, 2, 8)), d(2026, 2, 2));
  eq("weekStart of a Monday is itself", weekStart(d(2026, 2, 2)), d(2026, 2, 2));
  eq("weekStart of a Saturday is the Monday before", weekStart(d(2026, 2, 7)), d(2026, 2, 2));

  eq("isoDate is UTC", isoDate(d(2026, 2, 7) + 23 * 3_600_000), "2026-03-07");
  eq("shortDate is day-month-year", shortDate(d(2026, 2, 7)), "7 Mar 2026");
  eq("shortDate of December", shortDate(d(2026, 11, 25)), "25 Dec 2026");
}

section("Value helpers");
{
  eq("dateValue reads a date object", dateValue(dateVal(d(2026, 2, 7))), { start: d(2026, 2, 7), end: null, allDay: true });
  eq("dateValue of null", dateValue(null), null);
  eq("dateValue of a string", dateValue("nope"), null);
  eq("dateValue of an array", dateValue(["a"]), null);
  eq("dateValue of a relation", dateValue({ rows: ["x"] }), null);
  eq("dateValue of a startless date", dateValue(dateVal(null)), null);

  ok("isEmptyValue: null", isEmptyValue(null));
  ok("isEmptyValue: undefined", isEmptyValue(undefined));
  ok("isEmptyValue: blank string", isEmptyValue("   "));
  ok("isEmptyValue: empty array", isEmptyValue([]));
  ok("isEmptyValue: empty relation", isEmptyValue({ rows: [] }));
  ok("isEmptyValue: empty files", isEmptyValue({ mediaIds: [] }));
  ok("isEmptyValue: dateless date", isEmptyValue(dateVal(null)));
  ok("isEmptyValue: 0 is not empty", !isEmptyValue(0));
  ok("isEmptyValue: false is not empty", !isEmptyValue(false));
  ok("isEmptyValue: text is not empty", !isEmptyValue("x"));

  eq("numericValue passes numbers", numericValue(42), 42);
  eq("numericValue keeps negatives", numericValue(-3.5), -3.5);
  eq("numericValue maps true→1", numericValue(true), 1);
  eq("numericValue maps false→0", numericValue(false), 0);
  eq("numericValue parses numeric strings", numericValue("17"), 17);
  eq("numericValue rejects text", numericValue("abc"), null);
  eq("numericValue rejects blank", numericValue(""), null);
  eq("numericValue reads a date's ms", numericValue(dateVal(d(2026, 2, 7))), d(2026, 2, 7));
  eq("numericValue of null", numericValue(null), null);
  eq("numericValue of NaN", numericValue(Number.NaN), null);
}

section("Aggregates — every function");
{
  const nums: (PropertyValueInput | undefined)[] = [10, 20, 30, 40];
  eq("sum", aggregateValues(nums, "sum"), 100);
  eq("avg", aggregateValues(nums, "avg"), 25);
  eq("median of an even count", aggregateValues(nums, "median"), 25);
  eq("median of an odd count", aggregateValues([5, 1, 9], "median"), 5);
  eq("min", aggregateValues(nums, "min"), 10);
  eq("max", aggregateValues(nums, "max"), 40);
  eq("range", aggregateValues(nums, "range"), 30);
  eq("countAll counts rows", aggregateValues(nums, "countAll"), 4);
  eq("count skips empties", aggregateValues([1, null, "", "x"], "count"), 2);
  eq("countValues matches count", aggregateValues([1, null, "", "x"], "countValues"), 2);
  eq("countUnique dedupes", aggregateValues(["a", "a", "b", null], "countUnique"), 3);
  eq("countChecked", aggregateValues([true, false, true, null], "countChecked"), 2);
  eq("percentChecked rounds", aggregateValues([true, true, false, false], "percentChecked"), 50);
  eq("percentChecked of 1 of 3", aggregateValues([true, false, false], "percentChecked"), 33);
  eq("showOriginal takes the first value's number", aggregateValues(["hello", "x"], "showOriginal"), null);
  eq("showOriginal of a number", aggregateValues([7, 9], "showOriginal"), 7);

  // negatives and mixed types
  eq("sum with negatives", aggregateValues([-5, 10, -15], "sum"), -10);
  eq("min with negatives", aggregateValues([-5, 10, -15], "min"), -15);
  eq("range with negatives", aggregateValues([-5, 10, -15], "range"), 25);
  eq("avg ignores non-numbers", aggregateValues([10, "abc", 20], "avg"), 15);
  eq("sum ignores non-numbers", aggregateValues([10, "abc", null], "sum"), 10);
  eq("checkboxes count as 1/0", aggregateValues([true, false, true], "sum"), 2);

  // empty buckets
  eq("sum of nothing", aggregateValues([], "sum"), 0);
  eq("avg of nothing", aggregateValues([], "avg"), 0);
  eq("median of nothing", aggregateValues([], "median"), 0);
  eq("min of nothing is null", aggregateValues([], "min"), null);
  eq("max of nothing is null", aggregateValues([], "max"), null);
  eq("range of nothing is null", aggregateValues([], "range"), null);
  eq("percentChecked of nothing", aggregateValues([], "percentChecked"), 0);
  eq("count of nothing", aggregateValues([], "count"), 0);
  eq("countAll of nothing", aggregateValues([], "countAll"), 0);
  eq("countUnique of nothing", aggregateValues([], "countUnique"), 0);
  eq("showOriginal of nothing", aggregateValues([], "showOriginal"), null);

  // dates aggregate on their ms
  eq("sum of dates is a ms span", aggregateValues([dateVal(0), dateVal(DAY_MS)], "sum"), DAY_MS);
  eq("min of dates", aggregateValues([dateVal(d(2026, 2, 7)), dateVal(d(2026, 0, 1))], "min"), d(2026, 0, 1));
}

section("Timeline — spans and positioning");
{
  const r1 = row("A", { p_start: dateVal(d(2026, 2, 10)) });
  const s1 = rowSpan(r1, "p_start");
  eq("single-day span start", s1?.start, d(2026, 2, 10));
  eq("single-day span end", s1?.end, d(2026, 2, 10));
  eq("single-day span days", s1?.days, 1);

  const r2 = row("B", { p_start: dateVal(d(2026, 2, 10), d(2026, 2, 19)) });
  eq("span from the date's own end", rowSpan(r2, "p_start")?.days, 10);

  const r3 = row("C", { p_start: dateVal(d(2026, 2, 10)), p_end: dateVal(d(2026, 3, 11)) });
  eq("span from a separate end property", rowSpan(r3, "p_start", "p_end")?.days, 33);
  eq("span end property lands on Mar 11", rowSpan(r3, "p_start", "p_end")?.end, d(2026, 3, 11));

  const r4 = row("D", { p_start: dateVal(d(2026, 2, 10)), p_end: dateVal(d(2026, 1, 1)) });
  eq("an end before the start collapses to one day", rowSpan(r4, "p_start", "p_end")?.days, 1);

  eq("rowSpan of a missing date", rowSpan(row("E", {}), "p_start"), null);
  eq("rowSpan of a null date", rowSpan(row("F", { p_start: dateVal(null) }), "p_start"), null);

  const r5 = row("G", { p_start: dateVal(d(2026, 2, 10) + 22 * 3_600_000) });
  eq("a time-of-day is floored to the day", rowSpan(r5, "p_start")?.start, d(2026, 2, 10));

  // positioning inside a 30-day window starting Mar 1
  const rs = d(2026, 2, 1);
  const pos = positionBar(d(2026, 2, 10), d(2026, 2, 12), rs, 30);
  near("bar x offset %", pos.xPct, (9 / 30) * 100);
  near("bar width %", pos.widthPct, (3 / 30) * 100);
  ok("bar is onscreen", !pos.offscreen);

  const clip = positionBar(d(2026, 1, 1), d(2026, 2, 4), rs, 30);
  near("a bar starting before the window clips to 0", clip.xPct, 0);
  near("clipped width stops at the window edge", clip.widthPct, (4 / 30) * 100);

  const wide = positionBar(d(2026, 1, 1), d(2026, 5, 1), rs, 30);
  near("a bar spanning the whole window is 100%", wide.widthPct, 100);
  ok("a spanning bar is onscreen", !wide.offscreen);

  const before = positionBar(d(2026, 0, 5), d(2026, 0, 9), rs, 30);
  ok("a bar entirely before the window is offscreen", before.offscreen);
  eq("an offscreen bar reports no width", before.widthPct, 0);
  eq("an offscreen bar pins to the left edge", before.xPct, 0);

  const after = positionBar(d(2026, 4, 5), d(2026, 4, 9), rs, 30);
  ok("a bar entirely after the window is offscreen", after.offscreen);
  eq("an offscreen bar to the right reports no width", after.widthPct, 0);

  const edge = positionBar(d(2026, 3, 1), d(2026, 3, 1), rs, 30);
  ok("a bar on the first day past the window is offscreen", edge.offscreen);

  const last = positionBar(d(2026, 2, 30), d(2026, 2, 30), rs, 30);
  near("the last day of the window sits at day 29", last.xPct, (29 / 30) * 100);
  ok("the last day is onscreen", !last.offscreen);

  eq("a one-day bar never gets a zero width", positionBar(rs, rs, rs, 1000).widthPct, 0.1);
}

section("Timeline — lane packing");
{
  const a = packLanes([
    { start: d(2026, 2, 1), end: d(2026, 2, 5) },
    { start: d(2026, 2, 6), end: d(2026, 2, 9) },
  ]);
  eq("non-overlapping bars share a lane", a.lanes, [0, 0]);
  eq("non-overlapping bars need one lane", a.lanesCount, 1);

  const b = packLanes([
    { start: d(2026, 2, 1), end: d(2026, 2, 5) },
    { start: d(2026, 2, 5), end: d(2026, 2, 9) },
  ]);
  eq("bars touching on the same day overlap", b.lanes, [0, 1]);
  eq("touching bars need two lanes", b.lanesCount, 2);

  const c = packLanes([
    { start: d(2026, 2, 1), end: d(2026, 2, 20) },
    { start: d(2026, 2, 2), end: d(2026, 2, 3) },
    { start: d(2026, 2, 21), end: d(2026, 2, 22) },
  ]);
  eq("a bar reuses the first free lane", c.lanes, [0, 1, 0]);
  eq("packing uses the minimum lanes", c.lanesCount, 2);

  const dd = packLanes([
    { start: d(2026, 2, 1), end: d(2026, 2, 2) },
    { start: d(2026, 2, 1), end: d(2026, 2, 2) },
    { start: d(2026, 2, 1), end: d(2026, 2, 2) },
  ]);
  eq("three identical bars stack into three lanes", dd.lanes, [0, 1, 2]);
  eq("three identical bars need three lanes", dd.lanesCount, 3);

  eq("packing an empty list uses no lanes", packLanes([]).lanesCount, 0);
  eq("packing an empty list returns no lanes", packLanes([]).lanes, []);

  const many = packLanes(
    Array.from({ length: 50 }, (_, i) => ({ start: d(2026, 2, 1), end: d(2026, 2, 10 + i) })),
  );
  eq("50 overlapping bars make 50 lanes", many.lanesCount, 50);
  eq("50 overlapping bars get 50 distinct lanes", new Set(many.lanes).size, 50);
}

section("Timeline — model");
{
  const rows = [
    row("Alpha", { p_start: dateVal(d(2026, 2, 5)), p_end: dateVal(d(2026, 2, 9)) }),
    row("Beta", { p_start: dateVal(d(2026, 2, 8)) }),
    row("Gamma", { p_start: dateVal(d(2026, 4, 20)) }),
    row("Delta", {}),
  ];
  const m = buildTimeline({
    rows,
    startProp: "p_start",
    endProp: "p_end",
    rangeStart: d(2026, 2, 1),
    rangeDays: 60,
    now: d(2026, 2, 15) + 9 * 3_600_000,
  });

  eq("the model places the dated rows", m.bars.length, 3);
  eq("the model counts the undated row", m.undated, 1);
  ok("the model reports data", m.hasData);
  eq("the model keeps the range", m.rangeDays, 60);
  eq("the model's range start is day-floored", m.rangeStart, d(2026, 2, 1));
  eq("the model's range end is start + days", m.rangeEnd, d(2026, 2, 1) + 60 * DAY_MS);

  eq("bars are sorted by start", m.bars.map((b) => b.title), ["Alpha", "Beta", "Gamma"]);
  near("the first bar sits at day 4", m.bars[0]!.xPct, (4 / 60) * 100);
  eq("the first bar spans 5 days", m.bars[0]!.days, 5);
  eq("Alpha and Beta collide, so Beta takes lane 1", m.bars[1]!.lane, 1);
  eq("the group needs 2 lanes", m.groups[0]!.lanes, 2);
  eq("Gamma reuses lane 0", m.bars[2]!.lane, 0);
  eq("a single-day bar label is one date", m.bars[1]!.label, "8 Mar 2026");
  ok("a multi-day label carries the span", m.bars[0]!.label.includes("→"), m.bars[0]!.label);
  ok("a multi-day label carries the day count", m.bars[0]!.label.includes("5d"), m.bars[0]!.label);

  near("today is the middle of day 14", m.todayPct!, ((14 + 0.5) / 60) * 100);
  eq("the model exposes one default group", m.groups.length, 1);

  const empty = buildTimeline({ rows: [], startProp: "p_start", rangeStart: d(2026, 2, 1), rangeDays: 30 });
  ok("an empty model has no bars", !empty.hasData);
  eq("an empty model has no undated rows", empty.undated, 0);
  eq("an empty model still has month ticks", empty.monthTicks.length, 1);

  const noRange = buildTimeline({ rows, startProp: "p_start", rangeStart: d(2026, 2, 1), rangeDays: 0 });
  ok("a zero-day range is clamped to 1", noRange.rangeDays >= 1);
}

section("Timeline — ticks and today");
{
  const mt = monthTicks(d(2026, 1, 15), 90);
  eq("a 90-day window touches 4 months", mt.length, 4);
  eq("the first month tick is February", mt[0]!.label, "February 2026");
  near("the first month tick is offset by the 15-day clip", mt[0]!.xPct, 0);
  ok("a clipped month is not full", !mt[0]!.full);
  ok("a whole month is full", mt[1]!.full);
  eq("the second month tick is March", mt[1]!.label, "March 2026");
  eq("the last month tick is the one that spills past the window", mt[3]!.label, "May 2026");
  near("month ticks land on their month's first day", mt[1]!.xPct, (14 / 90) * 100);

  const jan = monthTicks(d(2026, 0, 1), 31);
  eq("a whole January is one tick", jan.length, 1);
  near("a whole month starts at 0", jan[0]!.xPct, 0);

  const dt = dayTicks(d(2026, 2, 1), 10);
  eq("10 days make 10 ticks", dt.length, 10);
  eq("day ticks are labelled by day-of-month", dt.map((t) => t.label), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  near("day ticks are evenly spaced", dt[9]!.xPct, 90);

  const wt = weekTicks(d(2026, 2, 2), 28);
  eq("28 days make 4 week ticks", wt.length, 4);
  eq("a week tick is labelled by its MM-DD", wt[0]!.label, "03-02");
  near("week ticks are 7 days apart", wt[1]!.xPct - wt[0]!.xPct, (7 / 28) * 100);

  const qt = quarterTicks(d(2026, 0, 1), 365);
  eq("a year makes 4 quarter ticks", qt.length, 4);
  eq("quarter labels carry the quarter and year", qt.map((t) => t.label), ["Q1 2026", "Q2 2026", "Q3 2026", "Q4 2026"]);
  near("quarters are 90 days apart in 2026", qt[1]!.xPct, (90 / 365) * 100);

  eq("ticksForZoom(day) is day ticks", ticksForZoom(d(2026, 2, 1), 10, "day").length, 10);
  eq("ticksForZoom(week) is week ticks", ticksForZoom(d(2026, 2, 2), 28, "week").length, 4);
  eq("ticksForZoom(month) is month ticks", ticksForZoom(d(2026, 2, 1), 90, "month").length, 3);
  eq("ticksForZoom(quarter) is quarter ticks", ticksForZoom(d(2026, 0, 1), 365, "quarter").length, 4);

  near("today at the window start", todayOffsetPct(d(2026, 2, 1), 30, d(2026, 2, 1))!, (0.5 / 30) * 100);
  eq("today before the window is null", todayOffsetPct(d(2026, 2, 10), 5, d(2026, 2, 1)), null);
  eq("today after the window is null", todayOffsetPct(d(2026, 2, 1), 5, d(2026, 3, 1)), null);
  near("today on the last day is inside", todayOffsetPct(d(2026, 2, 1), 5, d(2026, 2, 5))!, ((4 + 0.5) / 5) * 100);
  eq("a zero-day window is clamped, not divided by", todayOffsetPct(d(2026, 2, 1), 0, d(2026, 2, 1)) !== null, true);
}

section("Timeline — drag math");
{
  eq("10px at 48px/day is 0 days", pxToDayOffset(10, 48), 0);
  eq("25px at 48px/day is 1 day", pxToDayOffset(25, 48), 1);
  eq("a leftward drag is negative", pxToDayOffset(-25, 48), -1);
  eq("a zero scale never moves a bar", pxToDayOffset(500, 0), 0);
  eq("a negative scale never moves a bar", pxToDayOffset(500, -5), 0);
  eq("a non-finite scale never moves a bar", pxToDayOffset(500, Number.NaN), 0);

  const s = shiftSpan(d(2026, 2, 10), d(2026, 2, 12), 3);
  eq("shifting moves the start", s.start, d(2026, 2, 13));
  eq("shifting moves the end", s.end, d(2026, 2, 15));
  const back = shiftSpan(d(2026, 2, 10), d(2026, 2, 12), -30);
  eq("shifting back across a month boundary", back.start, d(2026, 1, 8));
  eq("shifting back preserves the duration", back.end - back.start, 2 * DAY_MS);
  eq("shifting back lands on the right day", isoDate(back.start), "2026-02-08");
  const inv = shiftSpan(d(2026, 2, 10), d(2026, 2, 10), -1);
  ok("a shift never inverts the span", inv.end >= inv.start);

  eq("growing the end by 4 days", resizeSpanEnd(d(2026, 2, 12), d(2026, 2, 10), 4), d(2026, 2, 16));
  eq("shrinking the end stops at the start", resizeSpanEnd(d(2026, 2, 12), d(2026, 2, 10), -10), d(2026, 2, 10));
  eq("a bar is always at least one day", resizeSpanEnd(d(2026, 2, 10), d(2026, 2, 10), -50), d(2026, 2, 10));
}

section("Timeline — grouping");
{
  const rows = [
    row("A", { p_start: dateVal(d(2026, 2, 1)), p_tag: ["o_urgent"] }),
    row("B", { p_start: dateVal(d(2026, 2, 2)), p_tag: ["o_normal"] }),
    row("C", { p_start: dateVal(d(2026, 2, 3)), p_tag: ["o_urgent"] }),
    row("D", { p_start: dateVal(d(2026, 2, 4)), p_tag: [] }),
  ];
  const m = buildTimeline({ rows, startProp: "p_start", rangeStart: d(2026, 2, 1), rangeDays: 30 });
  const sections = groupBars(m, (id) => {
    const r = rows.find((x) => x.node.id === id)!;
    const ids = (r.values.p_tag as string[]) ?? [];
    return { key: ids[0] ?? "__empty", label: ids[0] ? optionName(TAG, ids[0]) : "Empty" };
  });
  eq("three group sections", sections.length, 3);
  eq("sections appear in bar order", sections.map((s) => s.label), ["Urgent", "Normal", "Empty"]);
  eq("the Urgent section has 2 bars", sections[0]!.bars.length, 2);
  eq("the Urgent section needs 1 lane", sections[0]!.lanes, 1);
  eq("the Empty section has 1 bar", sections[2]!.bars.length, 1);
  eq("grouping rewrites the per-group lane count", m.bars[0]!.lanes, 1);
}

section("Chart — select bucketing");
{
  const rows = [
    row("a", { p_tag: ["o_urgent"], p_num: 10 }),
    row("b", { p_tag: ["o_urgent"], p_num: 20 }),
    row("c", { p_tag: ["o_normal"], p_num: 5 }),
    row("d", { p_tag: [], p_num: 1 }),
  ];
  const data = buildChartData({ rows, properties: PROPS, xProp: "p_tag", yProp: "p_num", agg: "sum" });
  eq("select buckets follow option order", data.labels, ["Urgent", "Normal", "Empty"]);
  eq("select buckets aggregate the y", data.values, [30, 5, 1]);
  eq("the total is the sum of buckets", data.total, 36);
  eq("bucket count", data.bucketCount, 3);
  eq("empty count", data.emptyCount, 1);
  eq("a multi-bucket chart is a series", data.kind, "series");
  eq("min value", data.minValue, 1);
  eq("max value", data.maxValue, 30);

  const counts = buildChartData({ rows, properties: PROPS, xProp: "p_tag", yProp: "p_num", agg: "countAll" });
  eq("countAll per select bucket", counts.values, [2, 1, 1]);
  eq("countAll total", counts.total, 4);

  const avg = buildChartData({ rows, properties: PROPS, xProp: "p_tag", yProp: "p_num", agg: "avg" });
  eq("avg per select bucket", avg.values, [15, 5, 1]);
  ok("an avg total is not a meaningful sum, but is finite", Number.isFinite(avg.total));
}

section("Chart — status bucketing");
{
  const rows = [
    row("s1", { p_state: ["s_done"], p_num: 3 }),
    row("s2", { p_state: ["s_todo"], p_num: 4 }),
    row("s3", { p_state: ["s_prog"], p_num: 5 }),
    row("s4", { p_state: ["s_todo"], p_num: 6 }),
  ];
  const data = buildChartData({ rows, properties: PROPS, xProp: "p_state", yProp: "p_num", agg: "sum" });
  eq("status buckets use option names", data.labels, ["To-do", "In Progress", "Done"]);
  eq("status buckets aggregate", data.values, [10, 5, 3]);
  eq("status total", data.total, 18);

  const unknown = buildChartData({
    rows: [row("x", { p_state: ["ghost"] })],
    properties: PROPS,
    xProp: "p_state",
    yProp: "p_num",
    agg: "countAll",
  });
  eq("an unknown status id falls back to the id", unknown.labels, ["ghost"]);
}

section("Chart — date bucketing (by month)");
{
  const rows = [
    row("jan", { p_start: dateVal(d(2026, 0, 5)), p_num: 1 }),
    row("jan2", { p_start: dateVal(d(2026, 0, 28)), p_num: 2 }),
    row("feb", { p_start: dateVal(d(2026, 1, 9)), p_num: 4 }),
    row("dec25", { p_start: dateVal(d(2025, 11, 31)), p_num: 8 }),
    row("none", { p_start: dateVal(null), p_num: 16 }),
  ];
  const data = buildChartData({ rows, properties: PROPS, xProp: "p_start", yProp: "p_num", agg: "sum" });
  eq("date buckets sort chronologically", data.labels, ["Dec 2025", "Jan 2026", "Feb 2026", "Empty"]);
  eq("date buckets aggregate per month", data.values, [8, 3, 4, 16]);
  eq("date total", data.total, 31);
  eq("a dateless row counts as empty", data.emptyCount, 1);

  const created = buildChartData({
    rows: [row("c", { p_created: dateVal(d(2026, 4, 2)) })],
    properties: PROPS,
    xProp: "p_created",
    yProp: "p_created",
    agg: "countAll",
  });
  eq("created_time buckets by month too", created.labels, ["May 2026"]);
}

section("Chart — number bucketing (auto bins)");
{
  const rows = Array.from({ length: 20 }, (_, i) => row(`n${i}`, { p_num: i }));
  const data = buildChartData({ rows, properties: PROPS, xProp: "p_num", yProp: "p_num", agg: "countAll", bins: 4 });
  eq("4 bins produce 4 buckets", data.labels.length, 4);
  eq("bin labels show the range", data.labels, ["0 – 4.75", "4.75 – 9.5", "9.5 – 14.25", "14.25 – 19"]);
  eq("bins partition the rows", data.values.reduce((a, b) => a + b, 0), 20);
  eq("bins are contiguous", data.total, 20);

  const single = buildChartData({
    rows: [row("a", { p_num: 7 }), row("b", { p_num: 7 })],
    properties: PROPS,
    xProp: "p_num",
    yProp: "p_num",
    agg: "countAll",
    bins: 3,
  });
  eq("one distinct value still bins", single.values.reduce((a, b) => a + b, 0), 2);
  eq("one distinct value gives one bucket", single.labels.length, 1);

  const bins = numberBins([0, 10], 5);
  eq("numberBins returns bins+1 edges", bins.edges.length, 6);
  eq("the first edge is the minimum", bins.edges[0], 0);
  eq("the last edge is the maximum", bins.edges[5], 10);
  eq("the lowest value is in the first bin", bins.labelOf(0), "0 – 2");
  eq("a mid value lands in the middle bin", bins.labelOf(5), "4 – 6");
  eq("the highest value lands in the last bin", bins.labelOf(10), "8 – 10");

  const neg = numberBins([-10, 10], 2);
  eq("negative ranges bin symmetrically", neg.labelOf(-10), "-10 – 0");
  eq("negative ranges include the top", neg.labelOf(10), "0 – 10");

  const none = numberBins([], 4);
  eq("an empty value set yields a fallback bin", none.edges, [0, 1]);
}

section("Chart — checkbox, text and multi_select bucketing");
{
  const cb = buildChartData({
    rows: [row("a", { p_done: true, p_num: 1 }), row("b", { p_done: false, p_num: 2 }), row("c", { p_done: true, p_num: 4 })],
    properties: PROPS,
    xProp: "p_done",
    yProp: "p_num",
    agg: "sum",
  });
  eq("checkbox buckets", cb.labels, ["Checked", "Unchecked"]);
  eq("checkbox sums", cb.values, [5, 2]);

  const pc = buildChartData({
    rows: [row("a", { p_done: true }), row("b", { p_done: false }), row("c", { p_done: true })],
    properties: PROPS,
    xProp: "p_done",
    yProp: "p_done",
    agg: "percentChecked",
  });
  eq("percentChecked per checkbox bucket", pc.values, [100, 0]);

  const ms = buildChartData({
    rows: [
      row("a", { p_tags: ["m_a"], p_num: 1 }),
      row("b", { p_tags: ["m_a", "m_b"], p_num: 2 }),
      row("c", { p_tags: [], p_num: 3 }),
    ],
    properties: PROPS,
    xProp: "p_tags",
    yProp: "p_num",
    agg: "sum",
  });
  eq("multi_select buckets by the selected set", ms.labels, ["Alpha", "Alpha, Beta", "Empty"]);
  eq("multi_select sums", ms.values, [1, 2, 3]);

  const txt = buildChartData({
    rows: [row("a", { p_notes: "one" }), row("b", { p_notes: "one" }), row("c", { p_notes: "two" })],
    properties: PROPS,
    xProp: "p_notes",
    yProp: "p_notes",
    agg: "countAll",
  });
  eq("text buckets by the string", txt.labels, ["one", "two"]);
  eq("text counts", txt.values, [2, 1]);
}

section("Chart — top 12 + Other");
{
  const options = Array.from({ length: 20 }, (_, i) => opt(`x${i}`, `Opt${String(i).padStart(2, "0")}`));
  const wide = prop("p_wide", "Wide", "select", { options });
  const rows = options.map((o, i) => row(`r${i}`, { p_wide: [o.id], p_num: i + 1 }));
  const data = buildChartData({ rows, properties: [...PROPS, wide], xProp: "p_wide", yProp: "p_num", agg: "sum" });

  eq("only 12 buckets are kept", data.labels.length, 13);
  eq("the 13th bucket is Other", data.labels[12], CHART_OTHER_LABEL);
  eq("the first 12 are the first 12 options", data.labels.slice(0, 12), options.slice(0, 12).map((o) => o.name));
  eq("Other folds the remaining sums", data.values[12], 132);
  eq("the total covers every row", data.total, 210);
  eq("the real bucket count is reported", data.bucketCount, 20);

  const under = buildChartData({
    rows: rows.slice(0, 5),
    properties: [...PROPS, wide],
    xProp: "p_wide",
    yProp: "p_num",
    agg: "sum",
  });
  eq("5 buckets get no Other", under.labels.length, 5);
  ok("no Other label when under the cap", !under.labels.includes(CHART_OTHER_LABEL));

  const custom = buildChartData({
    rows,
    properties: [...PROPS, wide],
    xProp: "p_wide",
    yProp: "p_num",
    agg: "sum",
    topN: 3,
  });
  eq("topN is honoured", custom.labels.length, 4);
  eq("topN keeps the first 3", custom.labels.slice(0, 3), ["Opt00", "Opt01", "Opt02"]);
  eq("topN folds the rest", custom.values[3], 204);
  eq("topN total is unchanged", custom.total, 210);
}

section("Chart — empty, single, negatives, zero totals");
{
  const noRows = buildChartData({ rows: [], properties: PROPS, xProp: "p_tag", yProp: "p_num", agg: "sum" });
  eq("no rows is an empty chart", noRows.kind, "empty");
  eq("no rows has no labels", noRows.labels, []);
  eq("no rows has a zero total", noRows.total, 0);
  eq("no rows has no min", noRows.minValue, 0);
  eq("no rows has no max", noRows.maxValue, 0);

  const noProps = buildChartData({ rows: [row("a", {})], properties: [], xProp: "p_tag", yProp: "p_num", agg: "sum" });
  eq("an unknown x property is an empty chart", noProps.kind, "empty");
  eq("an unknown y property is an empty chart", buildChartData({ rows: [row("a", {})], properties: PROPS, xProp: "p_tag", yProp: "nope", agg: "sum" }).kind, "empty");

  const single = buildChartData({
    rows: [row("a", { p_tag: ["o_urgent"], p_num: 5 })],
    properties: PROPS,
    xProp: "p_tag",
    yProp: "p_num",
    agg: "sum",
  });
  eq("one bucket is a single series", single.kind, "single");
  eq("one bucket has one label", single.labels, ["Urgent"]);
  eq("one bucket has one value", single.values, [5]);

  const zeros = buildChartData({
    rows: [row("a", { p_tag: ["o_urgent"], p_num: 0 }), row("b", { p_tag: ["o_normal"], p_num: 0 })],
    properties: PROPS,
    xProp: "p_tag",
    yProp: "p_num",
    agg: "sum",
  });
  eq("a zero total is reported", zeros.total, 0);
  eq("a zero-total chart still has buckets", zeros.kind, "series");
  eq("a zero-total pie gets no slices", pieSlices(zeros.labels, zeros.values, 100).length, 0);
  eq("a zero-total pie axis is not degenerate", chartAxis(zeros.minValue, zeros.maxValue).hi > chartAxis(zeros.minValue, zeros.maxValue).lo, true);

  const neg = buildChartData({
    rows: [
      row("a", { p_tag: ["o_urgent"], p_num: -10 }),
      row("b", { p_tag: ["o_normal"], p_num: 20 }),
      row("c", { p_tag: ["o_later"], p_num: -5 }),
    ],
    properties: PROPS,
    xProp: "p_tag",
    yProp: "p_num",
    agg: "sum",
  });
  eq("negative buckets survive", neg.values, [-10, 20, -5]);
  eq("a negative total is the signed sum", neg.total, 5);
  eq("minValue sees the negative", neg.minValue, -10);
  eq("maxValue sees the positive", neg.maxValue, 20);

  const allNeg = buildChartData({
    rows: [row("a", { p_tag: ["o_urgent"], p_num: -3 }), row("b", { p_tag: ["o_normal"], p_num: -4 })],
    properties: PROPS,
    xProp: "p_tag",
    yProp: "p_num",
    agg: "sum",
  });
  eq("an all-negative total", allNeg.total, -7);
  const negPie = pieSlices(allNeg.labels, allNeg.values, 100);
  eq("a negative pie still slices by magnitude", negPie.length, 2);
  near("a negative pie's percentages sum to 100", negPie.reduce((a, s) => a + s.pct, 0), 100);

  const nonNum = buildChartData({
    rows: [row("a", { p_tag: ["o_urgent"], p_notes: "text" })],
    properties: PROPS,
    xProp: "p_tag",
    yProp: "p_notes",
    agg: "sum",
  });
  eq("a non-numeric y sums to 0", nonNum.values, [0]);
  eq("a non-numeric y is counted", nonNum.nonNumeric, 1);

  const minMax = buildChartData({
    rows: [
      row("a", { p_tag: ["o_urgent"], p_num: 3 }),
      row("b", { p_tag: ["o_urgent"], p_num: 9 }),
    ],
    properties: PROPS,
    xProp: "p_tag",
    yProp: "p_num",
    agg: "min",
  });
  eq("min per bucket", minMax.values, [3]);
  const range = buildChartData({
    rows: [
      row("a", { p_tag: ["o_urgent"], p_num: 3 }),
      row("b", { p_tag: ["o_urgent"], p_num: 9 }),
    ],
    properties: PROPS,
    xProp: "p_tag",
    yProp: "p_num",
    agg: "range",
  });
  eq("range per bucket", range.values, [6]);
  const nullMin = buildChartData({
    rows: [row("a", { p_tag: ["o_urgent"], p_notes: "text" })],
    properties: PROPS,
    xProp: "p_tag",
    yProp: "p_notes",
    agg: "min",
  });
  eq("a null min drops the bucket", nullMin.labels, []);
  eq("a null min leaves no values", nullMin.values, []);
  eq("a null min makes an empty chart", nullMin.kind, "empty");
}

section("Chart — geometry");
{
  const ax = chartAxis(0, 100);
  eq("axis starts at 0", ax.lo, 0);
  ok("axis top covers the max", ax.hi >= 100);
  eq("axis step is round", ax.step % 10, 0);
  eq("axis ticks are evenly spaced", ax.ticks[1]! - ax.ticks[0]!, ax.step);
  ok("axis ticks reach the top", ax.ticks[ax.ticks.length - 1]! >= ax.hi);

  const negAx = chartAxis(-40, 60);
  ok("a negative axis starts below 0", negAx.lo <= -40);
  ok("a negative axis ends above the max", negAx.hi >= 60);
  ok("a negative axis includes 0", negAx.ticks.includes(0));

  const flat = chartAxis(0, 0);
  ok("a flat axis has a positive span", flat.hi > flat.lo);
  eq("a flat axis is not degenerate", valueToY(0, flat.lo, flat.hi, 10, 200) > 0, true);

  eq("the max value maps to the plot top", valueToY(100, 0, 100, 10, 210), 10);
  eq("the min value maps to the plot bottom", valueToY(0, 0, 100, 10, 210), 210);
  eq("the midpoint maps to the middle", valueToY(50, 0, 100, 10, 210), 110);
  eq("a degenerate axis maps to the bottom", valueToY(5, 5, 5, 10, 210), 210);

  eq("the first slot centre", slotCenterX(0, 4, 0, 100), 12.5);
  eq("the last slot centre", slotCenterX(3, 4, 0, 100), 87.5);
  eq("slots are 25 wide", slotCenterX(1, 4, 0, 100) - slotCenterX(0, 4, 0, 100), 25);
  eq("no slots sit at the left edge", slotCenterX(0, 0, 10, 100), 10);

  const pts = linePoints([0, 100], 0, 100, 10, 210, 0, 100);
  eq("a 2-point line has 2 vertices", pts.split(" ").length, 2);
  eq("the line starts at the bottom", pts.split(" ")[0], "25.00,210.00");
  eq("the line ends at the top", pts.split(" ")[1], "75.00,10.00");

  const slices = pieSlices(["a", "b"], [30, 70], 100);
  eq("a pie has one slice per bucket", slices.length, 2);
  near("slice percentages", slices[1]!.pct, 70);
  eq("slices sweep clockwise from 12", slices[0]!.startDeg, 0);
  eq("the first slice sweeps 108°", slices[0]!.sweep, 108);
  eq("slices tile the circle", Math.round(slices.reduce((a, s) => a + s.sweep, 0)), 360);
  ok("a slice path is closed", slices[0]!.path.endsWith("Z"));
  ok("a slice path starts at the centre", slices[0]!.path.startsWith("M 100.00 100.00"), slices[0]!.path);
  ok("a slice path carries an arc", slices[0]!.path.includes(" A "));
  ok("a 108° slice is not a large arc", !slices[0]!.path.includes(" 1 1 "));

  const one = pieSlices(["only"], [42], 50);
  eq("a single slice is a full circle", one[0]!.full, true);
  eq("a full circle sweeps 360", Math.round(one[0]!.sweep), 360);
  ok("a full circle path has two arcs", one[0]!.path.split(" A ").length === 3, one[0]!.path);

  eq("a zero-radius pie has no slices", pieSlices(["a"], [1], 0).length, 0);
  eq("a negative radius pie has no slices", pieSlices(["a"], [1], -10).length, 0);
  eq("an empty pie has no slices", pieSlices([], [], 100).length, 0);

  ok("series colours cycle", seriesColor(0) === seriesColor(12));
  ok("series colours differ", seriesColor(0) !== seriesColor(1));
  ok("series colours are always defined", seriesColor(999).startsWith("#"));

  eq("formatChartNumber of 0", formatChartNumber(0), "0");
  eq("formatChartNumber of an integer", formatChartNumber(42), "42");
  eq("formatChartNumber of thousands", formatChartNumber(1500), "1.5k");
  eq("formatChartNumber of millions", formatChartNumber(2_400_000), "2.4M");
  eq("formatChartNumber of a negative", formatChartNumber(-1500), "-1.5k");
  eq("formatChartNumber of a fraction", formatChartNumber(0.25), "0.25");
  eq("formatChartNumber of NaN", formatChartNumber(Number.NaN), "—");
  eq("formatChartNumber of Infinity", formatChartNumber(Number.POSITIVE_INFINITY), "—");
}

section("Form — field ordering and filtering");
{
  const fields = formFields(PROPS);
  eq("the title is first", fields[0]!.id, "p_title");
  ok("computed properties are excluded", !fields.some((f) => f.type === "formula"));
  ok("created_time is excluded", !fields.some((f) => f.type === "created_time"));
  eq("the remaining fields keep property order", fields.map((f) => f.id), [
    "p_title", "p_start", "p_end", "p_num", "p_done", "p_tag", "p_tags", "p_state", "p_notes", "p_mail", "p_site", "p_phone",
  ]);

  const picked = formFields(PROPS, ["p_num", "p_notes"]);
  eq("an explicit field list still leads with the title", picked.map((f) => f.id), ["p_title", "p_num", "p_notes"]);

  const reordered = formFields(PROPS, ["p_notes", "p_num"]);
  eq("an explicit list keeps its own order", reordered.map((f) => f.id), ["p_title", "p_notes", "p_num"]);

  const junk = formFields(PROPS, ["ghost", "p_formula"]);
  eq("unknown and read-only ids are dropped", junk.map((f) => f.id).includes("ghost"), false);
  eq("dropping everything falls back to all editable fields", junk.length, fields.length);

  const dupes = formFields(PROPS, ["p_num", "p_num", "p_notes"]);
  eq("duplicate ids collapse", dupes.filter((f) => f.id === "p_num").length, 1);

  const noTitle = formFields([NUM, NOTES]);
  eq("a database with no title property still renders", noTitle.map((f) => f.id), ["p_num", "p_notes"]);

  ok("isFormEditable: text", isFormEditable(NOTES));
  ok("isFormEditable: title", isFormEditable(TITLE));
  ok("isFormEditable: files", isFormEditable(prop("p_files", "Files", "files")));
  ok("isFormEditable: relation", isFormEditable(prop("p_rel", "Rel", "relation")));
  ok("isFormEditable: not formula", !isFormEditable(FORMULA));
  ok("isFormEditable: not rollup", !isFormEditable(prop("p_roll", "Roll", "rollup")));
  ok("isFormEditable: not last_edited_by", !isFormEditable(prop("p_leb", "Editor", "last_edited_by")));
  ok("isFormReadonly: formula", isFormReadonly(FORMULA));
  ok("isFormReadonly: created_by", isFormReadonly(prop("p_cb", "Owner", "created_by")));
  ok("isFormReadonly: not text", !isFormReadonly(NOTES));

  eq("formTitle uses the spec title", formTitle("Sprint intake", "Tasks"), "Sprint intake");
  eq("formTitle falls back to the db title", formTitle("", "Tasks"), "Tasks");
  eq("formTitle falls back on undefined", formTitle(undefined, "Tasks"), "Tasks");
  eq("formTitle falls back on whitespace", formTitle("   ", "Tasks"), "Tasks");
  eq("formTitle with nothing at all", formTitle(undefined, ""), "New entry");
}

section("Form — required-ness");
{
  ok("the title is required", isFieldRequired(TITLE));
  ok("a status is required", isFieldRequired(STATE));
  ok("text is not required", !isFieldRequired(NOTES));
  ok("a number is not required", !isFieldRequired(NUM));
  ok("the timeline start date is required", isFieldRequired(START, { timelineStartProp: "p_start" }));
  ok("an unrelated date is not required", !isFieldRequired(END, { timelineStartProp: "p_start" }));
  ok("a config-required property is required", isFieldRequired(prop("p_x", "X", "text", { required: true })));
  ok("config required:false is not required", !isFieldRequired(prop("p_x", "X", "text", { required: false })));
  ok("an explicit ctx flag forces required", isFieldRequired(NOTES, { configRequired: true }));
}

section("Form — initial values");
{
  const init = initialFormValues([TITLE, NUM, DONE, TAG, TAGS, START, SITE]);
  eq("a title starts blank", init.p_title, "");
  eq("a number starts blank", init.p_num, "");
  eq("a checkbox starts unchecked", init.p_done, false);
  eq("a select starts with no ids", init.p_tag, []);
  eq("a multi_select starts with no ids", init.p_tags, []);
  eq("a date starts as the empty date-input string", init.p_start, "");
  eq("a url starts blank", init.p_site, "");
  eq("every field gets an entry", Object.keys(init).length, 7);
  eq("no fields means no state", initialFormValues([]), {});
}

/** A raw form value that is not a plain string/number/bool/list. */
type RawExtra = PropertyValueInput;

section("Form — coercion");
{
  const out = coerceFormValues(
    [TITLE, NUM, DONE, TAG, TAGS, START, SITE, MAIL, PHONE, NOTES],
    {
      p_title: "  Ship it  ",
      p_num: "42",
      p_done: true,
      p_tag: ["o_urgent"],
      p_tags: ["m_a", "m_b"],
      p_start: { start: d(2026, 2, 7), end: null, allDay: true } as unknown as RawExtra as string[],
      p_site: "https://example.com",
      p_mail: "a@b.co",
      p_phone: "+40 700 111 222",
      p_notes: "  ",
    },
  );
  eq("a title is trimmed", out.p_title, "Ship it");
  eq("a numeric string becomes a number", out.p_num, 42);
  eq("a checkbox stays a boolean", out.p_done, true);
  eq("a select stays an id array", out.p_tag, ["o_urgent"]);
  eq("a multi_select stays an id array", out.p_tags, ["m_a", "m_b"]);
  eq("a date fills its null end from its start", out.p_start, { start: d(2026, 2, 7), end: d(2026, 2, 7), allDay: true });
  eq("a url passes through", out.p_site, "https://example.com");
  eq("a blank text field is omitted", "p_notes" in out, false);

  const blanks = coerceFormValues([TITLE, NUM, TAG, TAGS, START, DONE], {
    p_title: "",
    p_num: "",
    p_tag: [],
    p_tags: [],
    p_start: { start: null, end: null, allDay: true } as unknown as RawExtra as string[],
    p_done: false,
  });
  eq("a blank title is omitted", "p_title" in blanks, false);
  eq("a blank number is omitted, not 0", "p_num" in blanks, false);
  eq("a blank select is omitted, not []", "p_tag" in blanks, false);
  eq("a blank multi_select is omitted", "p_tags" in blanks, false);
  eq("a blank date is omitted", "p_start" in blanks, false);
  eq("a checkbox is always written", blanks.p_done, false);

  eq("a non-numeric string is dropped", coerceFormValues([NUM], { p_num: "abc" }), {});
  eq("a negative number coerces", coerceFormValues([NUM], { p_num: "-3.5" }).p_num, -3.5);
  eq("a zero coerces", coerceFormValues([NUM], { p_num: "0" }).p_num, 0);
  eq("a number value coerces directly", coerceFormValues([NUM], { p_num: 12 }).p_num, 12);
  eq("a select coerces a bare string to one id", coerceFormValues([TAG], { p_tag: "o_urgent" }).p_tag, ["o_urgent"]);
  eq("a select keeps only the first id", coerceFormValues([TAG], { p_tag: ["o_urgent", "o_normal"] }).p_tag, ["o_urgent"]);
  eq("a multi_select drops empty ids", coerceFormValues([TAGS], { p_tags: ["m_a", ""] }).p_tags, ["m_a"]);
  eq("a date string coerces to a date value", coerceFormValues([START], { p_start: "2026-03-07" }).p_start, {
    start: Date.parse("2026-03-07"),
    end: Date.parse("2026-03-07"),
    allDay: true,
  });
  eq("a blank date string is dropped", "p_start" in coerceFormValues([START], { p_start: "" }), false);
  eq("a relation coerces to rows", coerceFormValues([prop("p_rel", "Rel", "relation")], { p_rel: ["r1", "r2"] }).p_rel, { rows: ["r1", "r2"] });
  eq("an empty relation is dropped", "p_rel" in coerceFormValues([prop("p_rel", "Rel", "relation")], { p_rel: [] }), false);
  eq("files coerce to mediaIds", coerceFormValues([prop("p_files", "Files", "files")], { p_files: ["m1"] }).p_files, { mediaIds: ["m1"] });
  eq("files accept the wrapped shape too", coerceFormValues([prop("p_files", "Files", "files")], { p_files: { mediaIds: ["m1"] } as unknown as RawExtra as string[] }).p_files, { mediaIds: ["m1"] });
  eq("a relation accepts the wrapped shape too", coerceFormValues([prop("p_rel", "Rel", "relation")], { p_rel: { rows: ["r9"] } as unknown as RawExtra as string[] }).p_rel, { rows: ["r9"] });
  eq("a date object coerces", coerceFormValues([START], { p_start: { start: d(2026, 2, 7), end: null, allDay: true } as unknown as RawExtra as string[] }).p_start, {
    start: d(2026, 2, 7),
    end: d(2026, 2, 7),
    allDay: true,
  });
  eq("coercing no fields yields no values", coerceFormValues([], { p_title: "x" }), {});
  eq("a null value is dropped", coerceFormValues([TITLE], { p_title: null }), {});
}

section("Form — validation");
{
  const fields = [TITLE, NUM, MAIL, SITE, PHONE, TAG, START, STATE, NOTES];

  eq("a blank title fails", validateForm(fields, { p_title: "" }).map((i) => i.propId), ["p_title", "p_state"]);
  eq("a whitespace title is required", validateForm(fields, { p_title: "   ", p_state: ["s_todo"] }).map((i) => i.propId), ["p_title"]);
  eq("a filled title passes", validateForm(fields, { p_title: "x", p_state: ["s_todo"] }).map((i) => i.propId), []);
  eq("a filled form passes", validateForm(fields, { p_title: "x", p_state: ["s_todo"] }), []);

  eq("a non-numeric number fails", validateForm(fields, { p_title: "x", p_state: ["s_todo"], p_num: "abc" }).map((i) => i.propId), ["p_num"]);
  eq("a numeric string passes", validateForm(fields, { p_title: "x", p_state: ["s_todo"], p_num: "12" }), []);
  eq("a negative number passes", validateForm(fields, { p_title: "x", p_state: ["s_todo"], p_num: "-12" }), []);
  eq("a blank number passes when optional", validateForm(fields, { p_title: "x", p_state: ["s_todo"], p_num: "" }), []);

  eq("a bad email fails", validateForm(fields, { p_title: "x", p_state: ["s_todo"], p_mail: "nope" }).map((i) => i.propId), ["p_mail"]);
  eq("a good email passes", validateForm(fields, { p_title: "x", p_state: ["s_todo"], p_mail: "a.b+c@sub.example.com" }), []);
  eq("an email missing a TLD fails", validateForm(fields, { p_title: "x", p_state: ["s_todo"], p_mail: "a@b" }).map((i) => i.propId), ["p_mail"]);
  eq("a blank email passes when optional", validateForm(fields, { p_title: "x", p_state: ["s_todo"], p_mail: "" }), []);

  eq("a schemeless url fails", validateForm(fields, { p_title: "x", p_state: ["s_todo"], p_site: "example.com" }).map((i) => i.propId), ["p_site"]);
  eq("an https url passes", validateForm(fields, { p_title: "x", p_state: ["s_todo"], p_site: "https://example.com/a" }), []);
  eq("a www url passes", validateForm(fields, { p_title: "x", p_state: ["s_todo"], p_site: "www.example.com" }), []);

  eq("a short phone fails", validateForm(fields, { p_title: "x", p_state: ["s_todo"], p_phone: "12" }).map((i) => i.propId), ["p_phone"]);
  eq("a letters-only phone fails", validateForm(fields, { p_title: "x", p_state: ["s_todo"], p_phone: "abcdefg" }).map((i) => i.propId), ["p_phone"]);
  eq("a normal phone passes", validateForm(fields, { p_title: "x", p_state: ["s_todo"], p_phone: "+40 700 111 222" }), []);

  eq("an unknown select option fails", validateForm(fields, { p_title: "x", p_state: ["s_todo"], p_tag: ["ghost"] }).map((i) => i.propId), ["p_tag"]);
  eq("a known select option passes", validateForm(fields, { p_title: "x", p_state: ["s_todo"], p_tag: ["o_urgent"] }), []);
  eq("a blank select passes when optional", validateForm(fields, { p_title: "x", p_state: ["s_todo"], p_tag: [] }), []);

  eq("a missing required status is reported", validateForm(fields, { p_title: "x" }).map((i) => i.propId), ["p_state"]);
  eq("a blank required status is reported", validateForm(fields, { p_title: "x", p_state: [] }).map((i) => i.propId), ["p_state"]);

  const rating = prop("p_rating", "Rating", "number");
  const ratingCtx = { ratingPropIds: ["p_rating"] };
  eq("a rating above the max fails", validateForm([rating], { p_rating: "6" }, ratingCtx).length, 1);
  eq("a rating in range passes", validateForm([rating], { p_rating: "4" }, ratingCtx), []);
  eq("a rating of 0 passes", validateForm([rating], { p_rating: "0" }, ratingCtx), []);
  eq("a non-numeric rating fails", validateForm([rating], { p_rating: "abc" }, ratingCtx).length, 1);
  eq("a negative rating fails", validateForm([rating], { p_rating: "-1" }, ratingCtx).length, 1);
  eq("a custom rating max is honoured", validateForm([rating], { p_rating: "8" }, { ...ratingCtx, maxRating: 10 }), []);

  const req = validateForm(fields, { p_title: "", p_num: "abc", p_mail: "nope", p_state: ["s_todo"] });
  eq("issues come back in field order", req.map((i) => i.propId), ["p_title", "p_num", "p_mail"]);
  eq("issues carry a message each", req.every((i) => i.message.length > 4), true);
  eq("the required message names the field", req[0]!.message, "Name is required");

  const byProp = issuesByProp(req);
  eq("issues key by property", Object.keys(byProp), ["p_title", "p_num", "p_mail"]);
  eq("issuesByProp of no issues", issuesByProp([]), {});

  const forced = validateForm([NOTES], {}, { required: () => true });
  eq("a forced-required blank field fails", forced.length, 1);
  eq("a forced-required filled field passes", validateForm([NOTES], { p_notes: "x" }, { required: () => true }), []);

  eq("validating no fields passes", validateForm([], { p_title: "x" }), []);
}

section("Form — options helpers");
{
  eq("optionsOf a select", optionsOf(TAG).map((o) => o.name), ["Urgent", "Normal", "Later"]);
  eq("optionsOf a status flattens groups", optionsOf(STATE).map((o) => o.name), ["To-do", "In Progress", "Done"]);
  eq("optionsOf a property with no options", optionsOf(NOTES), []);
  eq("optionName resolves an id", optionName(TAG, "o_urgent"), "Urgent");
  eq("optionName falls back to the id", optionName(TAG, "ghost"), "ghost");
}

section("Table column layout fits the available width");
{
  const { fitColumns, tableWidth, tableScrolls, columnWidthForType, MIN_COLUMN_WIDTH, TABLE_CHROME_WIDTH } =
    await import("../src/db/tableLayout.ts");

  const few = ["title", "select", "number"];
  const many = [
    "title",
    "relation",
    "formula",
    "formula",
    "number",
    "checkbox",
    "status",
    "multi_select",
    "date",
    "number",
    "text",
    "unique_id",
  ];

  // measured space: fill it, leaving no dead whitespace column
  const avail = 1200;
  const w = fitColumns(few, avail);
  eq("one column per property", w.length, 3);
  eq("fills the width exactly", tableWidth(w), avail);
  ok("title is wider than a number", w[0]! > w[2]!, JSON.stringify(w));

  // an unmeasured container keeps the preferences rather than collapsing
  const unmeasured = fitColumns(few, 0);
  eq(
    "no measurement keeps preferences",
    unmeasured,
    few.map((t) => Math.max(MIN_COLUMN_WIDTH, columnWidthForType(t))),
  );
  ok("nothing collapses to zero", unmeasured.every((x) => x > 0));

  // a wide database shrinks toward the floor before anything scrolls
  const floorTotal = tableWidth(fitColumns(many, 100));
  const tight = fitColumns(many, floorTotal + 220);
  eq("wide database keeps every column", tight.length, many.length);
  ok("no column under the floor", tight.every((x) => x >= MIN_COLUMN_WIDTH), JSON.stringify(tight));
  ok("fits the width it was given", tableWidth(tight) <= floorTotal + 221, `${tableWidth(tight)}`);
  ok("the widest columns give up the most", tight[10]! < columnWidthForType("text"), JSON.stringify(tight));
  ok("it reports no scrolling when it fits", !tableScrolls(tight, floorTotal + 220));

  // an absurd column count: floors, and the caller is told to scroll
  const huge = fitColumns(Array.from({ length: 30 }, () => "text"), 800);
  eq("all 30 columns survive", huge.length, 30);
  ok("all at the floor", huge.every((x) => x === MIN_COLUMN_WIDTH), JSON.stringify(huge.slice(0, 3)));
  ok("it reports scrolling", tableScrolls(huge, 800));
  ok("a fitting table reports no scrolling", !tableScrolls(w, avail));

  // degenerate inputs
  eq("no columns", fitColumns([], 500), []);
  eq("negative space keeps preferences", fitColumns(["title"], -50), [columnWidthForType("title")]);
  ok("chrome is accounted for", tableWidth([100, 100]) === 200 + TABLE_CHROME_WIDTH, `${tableWidth([100, 100])}`);

  // 12 columns cannot go below the floor: below that total, scrolling is the
  // honest answer — squeezing a date cell to 60px is not a table, it is a smear
  for (const space of [600, 800, 1000, floorTotal - 1]) {
    const cols = fitColumns(many, space);
    ok(`12 columns at ${space}px stay at the floor`, cols.every((x) => x >= MIN_COLUMN_WIDTH));
    ok(`12 columns at ${space}px report scrolling`, tableScrolls(cols, space), `${floorTotal} > ${space}`);
  }
  for (const space of [floorTotal, floorTotal + 220, 1920]) {
    const cols = fitColumns(many, space);
    ok(`12 columns fit ${space}px`, tableWidth(cols) <= space + 1, `${tableWidth(cols)} <= ${space}`);
    ok(`${space}px: nothing below the floor`, cols.every((x) => x >= MIN_COLUMN_WIDTH));
    ok(`${space}px: no scrolling needed`, !tableScrolls(cols, space));
  }
  ok(
    "the floor keeps a header readable",
    MIN_COLUMN_WIDTH >= 120,
    `${MIN_COLUMN_WIDTH}px — below this, names ellipsize to the same prefix`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
