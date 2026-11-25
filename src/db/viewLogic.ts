/**
 * View math: the pure half of Timeline, Chart and Form.
 *
 * Nothing here imports React, the DOM, the API, or date-fns. Every function
 * takes plain values and returns plain values, so `scripts/test-views.ts` can
 * exercise all of it. The three view components are thin renderers over these.
 *
 * All date arithmetic is in UTC milliseconds. A row's date property is stored
 * as `{ start, end, allDay }` where `start`/`end` are epoch ms; a day is always
 * 86_400_000 ms, so a viewport is described by its first day and a day count.
 */

import type {
  AggregateFunction,
  PropertyDef,
  PropertyValueInput,
  RowView,
  SelectOption,
  StatusGroup,
} from "../../shared/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Shared primitives
// ─────────────────────────────────────────────────────────────────────────────

export const DAY_MS = 86_400_000;

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Epoch ms → ms at 00:00:00Z of that day. */
export function dayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** ms → whole days since 1970-01-01 (negative for pre-epoch dates). */
export function dayIndex(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

export function monthOf(ms: number): { y: number; m: number } {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
}

/** First instant of the UTC month that `ms` falls in. */
export function monthStart(ms: number): number {
  const { y, m } = monthOf(ms);
  return Date.UTC(y, m, 1);
}

/** First instant of the month `n` months after the month containing `ms`. */
export function addMonths(ms: number, n: number): number {
  const { y, m } = monthOf(ms);
  return Date.UTC(y, m + n, 1);
}

/** First instant of the UTC quarter (Jan/Apr/Jul/Oct) containing `ms`. */
export function quarterStart(ms: number): number {
  const { y, m } = monthOf(ms);
  return Date.UTC(y, Math.floor(m / 3) * 3, 1);
}

/** Monday-first week start, matching the Calendar view's grid. */
export function weekStart(ms: number): number {
  const d = dayStart(ms);
  const dow = new Date(d).getUTCDay(); // 0 = Sunday
  return d - ((dow + 6) % 7) * DAY_MS;
}

/** `2026-03-07` from epoch ms, always UTC. */
export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `7 Mar 2026` from epoch ms, always UTC. */
export function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** `March 2026` from epoch ms, always UTC. */
export function monthLabel(ms: number): string {
  const d = new Date(ms);
  const long = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${long[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Options of a select / multi_select / status property, flattened in group order. */
export function optionsOf(prop: PropertyDef): SelectOption[] {
  if (prop.type === "status") {
    const groups = (prop.config as { groups?: StatusGroup[] }).groups ?? [];
    return groups.flatMap((g) => g.options);
  }
  return (prop.config as { options?: SelectOption[] }).options ?? [];
}

/** Option name for an id, falling back to the id itself (matches the Table view). */
export function optionName(prop: PropertyDef, id: string): string {
  return optionsOf(prop).find((o) => o.id === id)?.name ?? id;
}

/** The `{start,end,allDay}` shape of a date / created_time / last_edited_time value. */
export interface DateValue {
  start: number | null;
  end: number | null;
  allDay: boolean;
}

export function dateValue(v: PropertyValueInput | undefined): DateValue | null {
  if (v === null || v === undefined || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as { start?: unknown; end?: unknown; allDay?: unknown };
  if (typeof o.start !== "number" && typeof o.end !== "number") return null;
  return {
    start: typeof o.start === "number" ? o.start : null,
    end: typeof o.end === "number" ? o.end : null,
    allDay: o.allDay !== false,
  };
}

/** A value that carries no information: null, blank string, empty list, dateless. */
export function isEmptyValue(v: PropertyValueInput | undefined): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (typeof v === "number") return false;
  if (typeof v === "boolean") return false;
  if (Array.isArray(v)) return v.length === 0;
  const o = v as { rows?: string[]; mediaIds?: string[]; start?: number | null };
  if ("rows" in o) return (o.rows ?? []).length === 0;
  if ("mediaIds" in o) return (o.mediaIds ?? []).length === 0;
  return o.start == null;
}

/** Numeric reading of a value: numbers pass through, booleans are 1/0, dates are their ms. */
export function numericValue(v: PropertyValueInput | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  const d = dateValue(v);
  if (d?.start != null) return d.start;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation — the same semantics as server/databases.ts `aggregate()`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reduce a bucket's values to a number.
 *
 * `count` / `countValues` count non-empty values, `countAll` counts rows,
 * `countUnique` counts distinct values, `countChecked` / `percentChecked` read
 * booleans, the rest reduce the numeric reading of each value. `min` / `max` /
 * `range` return null when the bucket holds no numbers, exactly like the server.
 */
export function aggregateValues(
  values: (PropertyValueInput | undefined)[],
  fn: AggregateFunction,
): number | null {
  const nums = values
    .map((v) => numericValue(v))
    .filter((n): n is number => n !== null);

  switch (fn) {
    case "count":
    case "countValues":
      return values.filter((v) => !isEmptyValue(v)).length;
    case "countAll":
      return values.length;
    case "countUnique":
      return new Set(values.map((v) => JSON.stringify(v ?? null))).size;
    case "countChecked":
      return values.filter((v) => v === true).length;
    case "percentChecked":
      return values.length
        ? Math.round((values.filter((v) => v === true).length / values.length) * 100)
        : 0;
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    case "median": {
      if (!nums.length) return 0;
      const s = [...nums].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
    }
    case "min":
      return nums.length ? Math.min(...nums) : null;
    case "max":
      return nums.length ? Math.max(...nums) : null;
    case "range":
      return nums.length ? Math.max(...nums) - Math.min(...nums) : null;
    case "showOriginal": {
      const first = values.find((v) => !isEmptyValue(v));
      const n = numericValue(first);
      return n ?? null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline
// ─────────────────────────────────────────────────────────────────────────────

export type TimelineZoom = "day" | "week" | "month" | "quarter";

/** Pixels per day at each zoom. Zoom changes the scale, never the data. */
export const ZOOM_PX_PER_DAY: Record<TimelineZoom, number> = {
  day: 48,
  week: 16,
  month: 5,
  quarter: 2,
};

export const TIMELINE_ZOOMS: TimelineZoom[] = ["day", "week", "month", "quarter"];

/** Row-label gutter, in px, shared by the header and the lanes. */
export const TIMELINE_LABEL_W = 176;

/** Height of one lane, in px. */
export const TIMELINE_LANE_H = 26;

export interface TimelineInput {
  rows: RowView[];
  /** start date property id */
  startProp: string;
  /** optional end date property id */
  endProp?: string | null;
  /** first day of the viewport, epoch ms */
  rangeStart: number;
  /** viewport width in days */
  rangeDays: number;
  /** "now" in epoch ms, for the today marker */
  now?: number;
}

export interface TimelineBar {
  rowId: string;
  title: string;
  /** start of the bar, epoch ms (UTC day start) */
  start: number;
  /** end of the bar, epoch ms (inclusive day) */
  end: number;
  /** whole days the bar spans, at least 1 */
  days: number;
  /** left edge as a % of the viewport */
  xPct: number;
  /** width as a % of the viewport */
  widthPct: number;
  /** lane index within the group, 0-based */
  lane: number;
  /** lane count of the group this bar sits in */
  lanes: number;
  /** true when the bar lies entirely outside the viewport */
  offscreen: boolean;
  /** `7 Mar – 12 Apr 2026 (37d)` */
  label: string;
}

export interface TimelineTick {
  /** epoch ms of the tick's first day */
  at: number;
  xPct: number;
  label: string;
  /** true when the tick's period is fully inside the viewport */
  full: boolean;
}

export interface TimelineGroup {
  key: string;
  label: string;
  bars: TimelineBar[];
  lanes: number;
}

export interface TimelineModel {
  rangeStart: number;
  rangeEnd: number;
  rangeDays: number;
  /** viewport width in px at the given zoom */
  widthPx: number;
  bars: TimelineBar[];
  groups: TimelineGroup[];
  monthTicks: TimelineTick[];
  dayTicks: TimelineTick[];
  todayPct: number | null;
  /** bars with no usable start date */
  undated: number;
  hasData: boolean;
}

/** The span a row occupies on the timeline, from its start (and end) property. */
export function rowSpan(
  row: RowView,
  startProp: string,
  endProp?: string | null,
): { start: number; end: number; days: number } | null {
  const s = dateValue(row.values[startProp]);
  if (!s?.start) return null;
  const start = dayStart(s.start);
  let end = start;
  if (endProp) {
    const e = dateValue(row.values[endProp]);
    if (e?.start != null && e.start > end) end = dayStart(e.start);
  }
  if (s.end != null && dayStart(s.end) > end) end = dayStart(s.end);
  const days = Math.max(1, dayIndex(end) - dayIndex(start) + 1);
  return { start, end, days };
}

/**
 * Position a bar inside a viewport.
 *
 * A bar that starts before the viewport is clipped to x 0 and keeps its full
 * width, so a long-running task reads as "started earlier, still going".
 */
export function positionBar(
  start: number,
  end: number,
  rangeStart: number,
  rangeDays: number,
): { xPct: number; widthPct: number; offscreen: boolean } {
  const first = dayIndex(rangeStart);
  const s = dayIndex(start);
  const e = dayIndex(end);
  const offscreen = e < first || s >= first + rangeDays;
  // a bar starting before the window pins to the left edge, so its visible
  // span is measured from there, not from its own start
  const left = Math.max(0, s - first);
  const span = Math.max(1, e - Math.max(s, first) + 1);
  const visible = Math.min(left + span, rangeDays) - left;
  return {
    xPct: (left / rangeDays) * 100,
    // a fully outside bar reports a 0 width; the caller uses `offscreen`
    widthPct: offscreen ? 0 : (Math.max(1, visible) / rangeDays) * 100,
    offscreen,
  };
}

/**
 * Greedy interval packing: place each bar in the first lane it fits, in input
 * order. Returns the lane per bar and the lane count.
 */
export function packLanes(spans: { start: number; end: number }[]): { lanes: number[]; lanesCount: number } {
  const lanes: number[] = new Array(spans.length).fill(0);
  const freeAt: number[] = []; // epoch ms at which each lane is next available
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    let placed = -1;
    for (let l = 0; l < freeAt.length; l++) {
      if ((freeAt[l] ?? 0) <= span.start) {
        placed = l;
        break;
      }
    }
    if (placed === -1) placed = freeAt.length;
    lanes[i] = placed;
    freeAt[placed] = span.end + DAY_MS;
  }
  return { lanes, lanesCount: Math.max(0, freeAt.length) };
}

function barLabel(start: number, end: number, days: number): string {
  if (days <= 1) return shortDate(start);
  return `${shortDate(start)} → ${shortDate(end)} · ${days}d`;
}

/**
 * Build the whole timeline model: bars, lanes, ticks, today marker, groups.
 *
 * Bars are sorted by start date, then packed per group. `groups` is the
 * section-header input: pass the view's first group property, and the rows
 * arrive already bucketed.
 */
export function buildTimeline(input: TimelineInput): TimelineModel {
  const rangeStart = dayStart(input.rangeStart);
  const rangeDays = Math.max(1, Math.trunc(input.rangeDays));
  const rangeEnd = rangeStart + rangeDays * DAY_MS;
  const now = input.now ?? Date.now();

  const placed: TimelineBar[] = [];
  let undated = 0;
  for (const row of input.rows) {
    const span = rowSpan(row, input.startProp, input.endProp);
    if (!span) {
      undated++;
      continue;
    }
    const pos = positionBar(span.start, span.end, rangeStart, rangeDays);
    placed.push({
      rowId: row.node.id,
      title: row.title,
      start: span.start,
      end: span.end,
      days: span.days,
      xPct: pos.xPct,
      widthPct: pos.widthPct,
      lane: 0,
      lanes: 1,
      offscreen: pos.offscreen,
      label: barLabel(span.start, span.end, span.days),
    });
  }
  placed.sort((a, b) => (a.start - b.start) || (b.end - a.end) || a.title.localeCompare(b.title));

  const packed = packLanes(placed.map((b) => ({ start: b.start, end: b.end })));
  for (let i = 0; i < placed.length; i++) {
    const bar = placed[i]!;
    bar.lane = packed.lanes[i] ?? 0;
    bar.lanes = packed.lanesCount;
  }

  const groups: TimelineGroup[] = [
    { key: "__all", label: "", bars: placed, lanes: packed.lanesCount },
  ];

  return {
    rangeStart,
    rangeEnd,
    rangeDays,
    widthPx: rangeDays * ZOOM_PX_PER_DAY.month,
    bars: placed,
    groups,
    monthTicks: monthTicks(rangeStart, rangeDays),
    dayTicks: dayTicks(rangeStart, rangeDays),
    todayPct: todayOffsetPct(rangeStart, rangeDays, now),
    undated,
    hasData: placed.length > 0,
  };
}

/**
 * Group the bars into sections by a group property's bucket key.
 *
 * `keyOf` maps a row to its bucket (the caller reads the property value and
 * resolves the option name), so this stays free of option-lookup policy.
 */
export function groupBars(
  model: TimelineModel,
  keyOf: (rowId: string) => { key: string; label: string },
): TimelineGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, TimelineGroup>();
  for (const bar of model.bars) {
    const { key, label } = keyOf(bar.rowId);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, label, bars: [], lanes: 0 };
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.bars.push(bar);
  }
  for (const key of order) {
    const bucket = buckets.get(key)!;
    const packed = packLanes(bucket.bars.map((b) => ({ start: b.start, end: b.end })));
    bucket.bars.forEach((b, i) => {
      b.lane = packed.lanes[i] ?? 0;
      b.lanes = packed.lanesCount;
    });
    bucket.lanes = packed.lanesCount;
  }
  return order.map((k) => buckets.get(k)!);
}

/** Month boundaries inside the viewport, one per month touched. */
export function monthTicks(rangeStart: number, rangeDays: number): TimelineTick[] {
  const start = dayStart(rangeStart);
  const end = start + Math.max(1, Math.trunc(rangeDays)) * DAY_MS;
  const ticks: TimelineTick[] = [];
  let cursor = monthStart(start);
  let guard = 0;
  while (cursor < end && guard++ < 1200) {
    const next = addMonths(cursor, 1);
    const from = Math.max(cursor, start);
    const to = Math.min(next, end);
    ticks.push({
      at: cursor,
      xPct: ((dayIndex(from) - dayIndex(start)) / Math.max(1, Math.trunc(rangeDays))) * 100,
      label: monthLabel(cursor),
      full: cursor >= start && next <= end,
    });
    cursor = next;
  }
  return ticks;
}

/** Day boundaries inside the viewport. */
export function dayTicks(rangeStart: number, rangeDays: number): TimelineTick[] {
  const start = dayStart(rangeStart);
  const days = Math.max(1, Math.trunc(rangeDays));
  const ticks: TimelineTick[] = [];
  for (let i = 0; i < days; i++) {
    const at = start + i * DAY_MS;
    const d = new Date(at);
    ticks.push({
      at,
      xPct: (i / days) * 100,
      label: String(d.getUTCDate()),
      full: true,
    });
  }
  return ticks;
}

/** Week boundaries (Monday-first) inside the viewport. */
export function weekTicks(rangeStart: number, rangeDays: number): TimelineTick[] {
  const start = dayStart(rangeStart);
  const days = Math.max(1, Math.trunc(rangeDays));
  const ticks: TimelineTick[] = [];
  let cursor = weekStart(start);
  let guard = 0;
  while (cursor < start + days * DAY_MS && guard++ < 1200) {
    const from = Math.max(cursor, start);
    const x = ((dayIndex(from) - dayIndex(start)) / days) * 100;
    ticks.push({ at: cursor, xPct: x, label: isoDate(cursor).slice(5), full: cursor >= start });
    cursor += 7 * DAY_MS;
  }
  return ticks;
}

/** Quarter boundaries inside the viewport. */
export function quarterTicks(rangeStart: number, rangeDays: number): TimelineTick[] {
  const start = dayStart(rangeStart);
  const days = Math.max(1, Math.trunc(rangeDays));
  const ticks: TimelineTick[] = [];
  let cursor = quarterStart(start);
  let guard = 0;
  while (cursor < start + days * DAY_MS && guard++ < 400) {
    const next = addMonths(cursor, 3);
    const from = Math.max(cursor, start);
    const q = Math.floor(monthOf(cursor).m / 3) + 1;
    ticks.push({
      at: cursor,
      xPct: ((dayIndex(from) - dayIndex(start)) / days) * 100,
      label: `Q${q} ${monthOf(cursor).y}`,
      full: cursor >= start && next <= start + days * DAY_MS,
    });
    cursor = next;
  }
  return ticks;
}

/** The tick set a zoom level wants for its upper header row. */
export function ticksForZoom(rangeStart: number, rangeDays: number, zoom: TimelineZoom): TimelineTick[] {
  switch (zoom) {
    case "day":
      return dayTicks(rangeStart, rangeDays);
    case "week":
      return weekTicks(rangeStart, rangeDays);
    case "month":
      return monthTicks(rangeStart, rangeDays);
    case "quarter":
      return quarterTicks(rangeStart, rangeDays);
  }
}

/** Where "today" sits in the viewport, as a %, or null when outside it. */
export function todayOffsetPct(rangeStart: number, rangeDays: number, now: number): number | null {
  const start = dayStart(rangeStart);
  const days = Math.max(1, Math.trunc(rangeDays));
  const today = dayStart(now);
  const d = dayIndex(today) - dayIndex(start);
  if (d < 0 || d >= days) return null;
  return ((d + 0.5) / days) * 100;
}

/**
 * Convert a pointer's x offset inside the scale into a day offset from the
 * viewport start — the drag math for moving a bar.
 */
export function pxToDayOffset(deltaPx: number, pxPerDay: number): number {
  if (!(pxPerDay > 0)) return 0;
  return Math.round(deltaPx / pxPerDay);
}

/** Shift a span by whole days, clamped so a bar never inverts. */
export function shiftSpan(
  start: number,
  end: number,
  days: number,
): { start: number; end: number } {
  const s = dayStart(start) + days * DAY_MS;
  const e = dayStart(end) + days * DAY_MS;
  return { start: s, end: Math.max(s, e) };
}

/** Grow / shrink a span from its right edge, keeping at least one day. */
export function resizeSpanEnd(end: number, start: number, days: number): number {
  const e = dayStart(end) + days * DAY_MS;
  return Math.max(dayStart(start), e);
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart
// ─────────────────────────────────────────────────────────────────────────────

export const CHART_TOP_N = 12;
export const CHART_OTHER_LABEL = "Other";

export interface ChartInput {
  rows: RowView[];
  properties: PropertyDef[];
  xProp: string;
  yProp: string;
  agg: AggregateFunction;
  /** number bins: how many buckets to cut the range into */
  bins?: number;
  /** fold buckets past this rank into "Other" (default 12) */
  topN?: number;
}

export interface ChartData {
  labels: string[];
  values: number[];
  total: number;
  /** buckets that carry a real value, before "Other" folding */
  bucketCount: number;
  /** rows with no x value, counted in the "Empty" bucket */
  emptyCount: number;
  /** rows whose y value was not a number, for the numeric aggregates */
  nonNumeric: number;
  kind: "empty" | "single" | "series";
  /** min/max of the values, for the axis */
  minValue: number;
  maxValue: number;
}

const EMPTY_KEY = "__empty";

function propById(properties: PropertyDef[], id: string): PropertyDef | undefined {
  return properties.find((p) => p.id === id);
}

/**
 * The bucket key + label a row's x value falls into.
 *
 * select / status / multi_select → option name (in option order);
 * date → UTC month; number → auto bin; checkbox → Checked / Unchecked;
 * text-ish → the string itself.
 */
export function bucketKeyOf(
  value: PropertyValueInput | undefined,
  prop: PropertyDef,
): { key: string; label: string } {
  if (isEmptyValue(value)) return { key: EMPTY_KEY, label: "Empty" };

  switch (prop.type) {
    case "select":
    case "status": {
      const ids = Array.isArray(value) ? value : [String(value)];
      const id = ids[0];
      if (!id) return { key: EMPTY_KEY, label: "Empty" };
      return { key: id, label: optionName(prop, id) };
    }
    case "multi_select": {
      const ids = Array.isArray(value) ? value : [String(value)];
      if (!ids.length) return { key: EMPTY_KEY, label: "Empty" };
      const names = ids.map((id) => optionName(prop, id));
      return { key: ids.join(","), label: names.join(", ") };
    }
    case "checkbox":
      return value === true
        ? { key: "checked", label: "Checked" }
        : { key: "unchecked", label: "Unchecked" };
    case "date":
    case "created_time":
    case "last_edited_time": {
      const d = dateValue(value);
      if (d?.start == null) return { key: EMPTY_KEY, label: "No date" };
      const { y, m } = monthOf(d.start);
      return {
        key: `${y}-${String(m + 1).padStart(2, "0")}`,
        label: `${MONTH_NAMES[m]} ${y}`,
      };
    }
    case "relation": {
      const rows = (value as { rows?: string[] })?.rows ?? [];
      if (!rows.length) return { key: EMPTY_KEY, label: "Empty" };
      return { key: rows.join(","), label: `${rows.length} linked` };
    }
    case "number":
    case "unique_id": {
      const n = numericValue(value);
      if (n === null) return { key: EMPTY_KEY, label: "Empty" };
      return { key: `n:${n}`, label: String(n) };
    }
    default: {
      const s = typeof value === "string" ? value.trim() : String(value ?? "");
      return { key: s || EMPTY_KEY, label: s || "Empty" };
    }
  }
}

/** Stable ordering key so buckets read left-to-right in a sensible order. */
function bucketSortKey(key: string, prop: PropertyDef, options: SelectOption[]): string {
  if (key === EMPTY_KEY) return "zzz-empty";
  if (prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time") {
    return `d:${key}`; // `2026-03` sorts chronologically
  }
  if (prop.type === "number" || prop.type === "unique_id") {
    const n = Number(key.slice(2));
    return `n:${String(1e15 + (Number.isFinite(n) ? n : 0))}`;
  }
  const rank = options.findIndex((o) => o.id === key);
  if (rank >= 0) return `o:${String(1000 + rank)}`;
  return `t:${key}`;
}

/**
 * Cut the numeric x range into `bins` equal bins and return the bin a value
 * falls into. Bins are inclusive-low / exclusive-high, and the last bin
 * includes the maximum.
 */
export function numberBins(
  values: number[],
  bins: number,
): { edges: number[]; labelOf: (n: number) => string } {
  const nums = values.filter((n) => Number.isFinite(n));
  const count = Math.max(1, Math.trunc(bins));
  if (!nums.length) {
    return { edges: [0, 1], labelOf: () => "0 – 1" };
  }
  let lo = Math.min(...nums);
  let hi = Math.max(...nums);
  if (hi === lo) {
    // a single distinct value: centre a bin on it
    lo = lo - 0.5;
    hi = hi + 0.5;
  }
  const step = (hi - lo) / count;
  const edges: number[] = [];
  for (let i = 0; i <= count; i++) edges.push(lo + step * i);
  edges[count] = hi;
  const round = (n: number): string => {
    const r = Math.round(n * 100) / 100;
    return String(r);
  };
  const labelOf = (n: number): string => {
    let i = count - 1;
    for (let k = 0; k < count; k++) {
      if (n < (edges[k + 1] ?? Infinity)) {
        i = k;
        break;
      }
    }
    return `${round(edges[i] ?? 0)} – ${round(edges[i + 1] ?? 0)}`;
  };
  return { edges, labelOf };
}

/**
 * Bucket rows by the x property and aggregate the y property per bucket.
 *
 * Handles: no data, a single bucket, negative values, a zero total (pie),
 * more buckets than `topN` (folded into "Other"), dates (by month) and
 * numbers (auto bins).
 */
export function buildChartData(input: ChartInput): ChartData {
  const empty: ChartData = {
    labels: [],
    values: [],
    total: 0,
    bucketCount: 0,
    emptyCount: 0,
    nonNumeric: 0,
    kind: "empty",
    minValue: 0,
    maxValue: 0,
  };

  const xProp = propById(input.properties, input.xProp);
  const yProp = propById(input.properties, input.yProp);
  if (!xProp || !yProp || !input.rows.length) return empty;

  const numericAgg: AggregateFunction[] = [
    "sum", "avg", "median", "min", "max", "range", "showOriginal",
  ];
  const wantsNumbers = numericAgg.includes(input.agg);

  const groups = new Map<string, { label: string; values: (PropertyValueInput | undefined)[] }>();
  let emptyCount = 0;
  let nonNumeric = 0;

  const isNumericX = xProp.type === "number" || xProp.type === "unique_id";
  const allX: number[] = [];
  if (isNumericX) {
    for (const row of input.rows) {
      const n = numericValue(row.values[xProp.id]);
      if (n !== null) allX.push(n);
    }
  }
  const bins = isNumericX ? numberBins(allX, input.bins ?? 8) : null;

  for (const row of input.rows) {
    const raw = row.values[xProp.id];
    let key: string;
    let label: string;
    if (bins) {
      const n = numericValue(raw);
      if (n === null) {
        key = EMPTY_KEY;
        label = "Empty";
        emptyCount++;
      } else {
        label = bins.labelOf(n);
        key = `bin:${label}`;
      }
    } else {
      const b = bucketKeyOf(raw, xProp);
      key = b.key;
      label = b.label;
      if (key === EMPTY_KEY) emptyCount++;
    }

    const y = row.values[yProp.id];
    if (wantsNumbers && numericValue(y) === null && !isEmptyValue(y)) nonNumeric++;

    const g = groups.get(key) ?? { label, values: [] };
    g.values.push(y);
    groups.set(key, g);
  }

  const options = optionsOf(xProp);
  const ranked = [...groups.entries()]
    .map(([key, g]) => {
      const v = aggregateValues(g.values, input.agg);
      return {
        key,
        label: g.label,
        sort: bucketSortKey(key, xProp, options),
        value: v === null ? 0 : v,
        nullValue: v === null,
      };
    })
    .sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));

  const topN = Math.max(1, Math.trunc(input.topN ?? CHART_TOP_N));
  const buckets = ranked.filter((b) => !b.nullValue);
  const kept = buckets.slice(0, topN);
  const folded = buckets.slice(topN);

  const labels = kept.map((b) => b.label);
  const values = kept.map((b) => b.value);
  if (folded.length) {
    labels.push(CHART_OTHER_LABEL);
    // "Other" is the sum of the buckets it folds, except for row-counting
    // aggregates, where the honest fold is the count itself.
    const foldAgg: AggregateFunction =
      input.agg === "count" || input.agg === "countValues" || input.agg === "countAll" || input.agg === "countUnique"
        ? input.agg
        : "sum";
    const foldValues = folded.flatMap((b) => {
      const g = groups.get(b.key);
      return g ? g.values : [];
    });
    values.push(aggregateValues(foldValues, foldAgg) ?? 0);
  }

  const total = values.reduce((a, b) => a + b, 0);
  const minValue = values.length ? Math.min(...values) : 0;
  const maxValue = values.length ? Math.max(...values) : 0;

  return {
    labels,
    values,
    total,
    bucketCount: buckets.length,
    emptyCount,
    nonNumeric,
    kind: values.length === 0 ? "empty" : values.length === 1 ? "single" : "series",
    minValue,
    maxValue,
  };
}

/** A number for an axis: short, and never more than 2 decimals. */
export function formatChartNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${round(n / 1_000_000)}M`;
  if (abs >= 1_000) return `${round(n / 1_000)}k`;
  if (Number.isInteger(n)) return String(n);
  if (abs < 1) return (Math.round(n * 100) / 100).toFixed(2);
  return round(n).toFixed(1);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Pie slice geometry in SVG. Angles in degrees, 0 at 12 o'clock, clockwise.
 *
 * A zero total yields no slices; a single 100% slice gets a full circle, since
 * an arc from a point back to the same point draws nothing.
 */
export interface PieSlice {
  index: number;
  label: string;
  value: number;
  /** signed sweep: negative values point counter-clockwise */
  sweep: number;
  startDeg: number;
  endDeg: number;
  pct: number;
  path: string;
  full: boolean;
}

export function pieSlices(labels: string[], values: number[], radius: number, cx = radius, cy = radius): PieSlice[] {
  const totalAbs = values.reduce((a, b) => a + Math.abs(b), 0);
  if (!totalAbs || !(radius > 0)) return [];
  const slices: PieSlice[] = [];
  let angle = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0;
    const sweep = (Math.abs(v) / totalAbs) * 360;
    const startDeg = angle;
    const endDeg = angle + sweep;
    angle = endDeg;
    const full = sweep >= 359.999;
    slices.push({
      index: i,
      label: labels[i] ?? "",
      value: v,
      sweep,
      startDeg,
      endDeg,
      pct: (Math.abs(v) / totalAbs) * 100,
      full,
      path: full ? fullCirclePath(cx, cy, radius) : arcPath(cx, cy, radius, startDeg, endDeg),
    });
  }
  return slices;
}

function polar(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const a = polar(cx, cy, r, startDeg);
  const b = polar(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${f(cx)} ${f(cy)} L ${f(a.x)} ${f(a.y)} A ${f(r)} ${f(r)} 0 ${large} 1 ${f(b.x)} ${f(b.y)} Z`;
}

function fullCirclePath(cx: number, cy: number, r: number): string {
  return `M ${f(cx)} ${f(cy - r)} A ${f(r)} ${f(r)} 0 1 1 ${f(cx)} ${f(cy + r)} A ${f(r)} ${f(r)} 0 1 1 ${f(cx)} ${f(cy - r)} Z`;
}

function f(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** A stable, palette-consistent stroke colour per pie slice index. */
export const CHART_SERIES_COLORS = [
  "#0070f3", "#50a55a", "#d2823c", "#8c5ac8", "#c85a91", "#3c7dcd",
  "#c8a53c", "#d75050", "#8c6450", "#6796e6", "#cd9731", "#585858",
];

export function seriesColor(i: number): string {
  return CHART_SERIES_COLORS[i % CHART_SERIES_COLORS.length]!;
}

/**
 * A "nice" axis: rounded step, and the top gridline at or above the max.
 * Negative values get a baseline above the bottom of the plot.
 */
export function chartAxis(minValue: number, maxValue: number, steps = 4): {
  lo: number;
  hi: number;
  step: number;
  ticks: number[];
} {
  let lo = Math.min(0, minValue);
  let hi = Math.max(0, maxValue);
  if (hi === lo) hi = lo + 1;
  const raw = (hi - lo) / Math.max(1, steps);
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const step = nice * mag;
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo, hi, step, ticks };
}

/** Map a value to a y pixel, given the axis and the plot box. */
export function valueToY(v: number, lo: number, hi: number, top: number, bottom: number): number {
  if (hi === lo) return bottom;
  const t = (v - lo) / (hi - lo);
  return bottom - t * (bottom - top);
}

/** Map a bucket index to the centre x of its slot. */
export function slotCenterX(i: number, count: number, left: number, right: number): number {
  if (count <= 0) return left;
  const w = (right - left) / count;
  return left + w * (i + 0.5);
}

/** A polyline `points` string from values and the axis. */
export function linePoints(
  values: number[],
  lo: number,
  hi: number,
  top: number,
  bottom: number,
  left: number,
  right: number,
): string {
  return values
    .map((v, i) => `${f(slotCenterX(i, values.length, left, right))},${f(valueToY(v, lo, hi, top, bottom))}`)
    .join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Form
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Types a form can render as an input.
 *
 * `PropertyType` has no "rating" member, so a rating property is matched by id
 * (`ratingPropId`) rather than by type.
 */
export const FORM_INPUT_TYPES: PropertyDef["type"][] = [
  "title",
  "text",
  "number",
  "date",
  "checkbox",
  "select",
  "multi_select",
  "status",
  "url",
  "email",
  "phone",
  "files",
  "relation",
];

/** Computed / auto-filled types: read-only, so a form leaves them out. */
export const FORM_READONLY_TYPES: PropertyDef["type"][] = [
  "formula",
  "rollup",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
  "unique_id",
  "button",
];

export function isFormEditable(prop: PropertyDef, ctx: { ratingPropIds?: string[] } = {}): boolean {
  if (ctx.ratingPropIds?.includes(prop.id)) return true;
  return FORM_INPUT_TYPES.includes(prop.type);
}

export function isFormReadonly(prop: PropertyDef): boolean {
  return FORM_READONLY_TYPES.includes(prop.type);
}

/**
 * The fields a form shows, in order.
 *
 * `spec.form.fields` is honoured when it names real, editable properties;
 * otherwise every non-computed property appears. The title property is always
 * first, and read-only properties never appear.
 */
export function formFields(
  properties: PropertyDef[],
  fields?: string[],
  ctx: { ratingPropIds?: string[] } = {},
): PropertyDef[] {
  const editable = properties.filter((p) => isFormEditable(p, ctx));
  const title = editable.find((p) => p.type === "title") ?? null;
  const rest = editable.filter((p) => p.type !== "title");

  const wanted = fields?.filter((id) => editable.some((p) => p.id === id)) ?? [];
  const chosen = wanted.length ? wanted.map((id) => editable.find((p) => p.id === id)!) : rest;

  const seen = new Set<string>();
  const out: PropertyDef[] = [];
  for (const p of [title, ...chosen].filter((p): p is PropertyDef => p !== null)) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/**
 * Required-ness. The title is always required; a property is required when its
 * config says so, when it is a status (a row without a status has no board
 * column), and when it is the timeline's start date.
 */
export function isFieldRequired(
  prop: PropertyDef,
  ctx: { timelineStartProp?: string; configRequired?: boolean } = {},
): boolean {
  if (prop.type === "title") return true;
  if (prop.type === "status") return true;
  if (ctx.timelineStartProp && prop.id === ctx.timelineStartProp) return true;
  const cfg = prop.config as { required?: boolean };
  return cfg.required === true || ctx.configRequired === true;
}

export interface FieldIssue {
  propId: string;
  message: string;
}

export const EMPTY_FORM_VALUES: Record<string, PropertyValueInput> = {};

/**
 * The initial, blank form state for a set of fields.
 *
 * This is the *raw* state the inputs hold, not `PropertyValueInput`: a date is
 * the `YYYY-MM-DD` string an `<input type="date">` wants, and a relation /
 * files field is a plain id list. `coerceFormValues` turns it into
 * `PropertyValueInput` on submit.
 */
export function initialFormValues(fields: PropertyDef[]): Record<string, string | boolean | number | string[] | null> {
  const out: Record<string, string | boolean | number | string[] | null> = {};
  for (const p of fields) {
    switch (p.type) {
      case "checkbox":
        out[p.id] = false;
        break;
      case "select":
      case "status":
      case "multi_select":
      case "relation":
      case "files":
        out[p.id] = [];
        break;
      case "number":
      case "date":
      default:
        out[p.id] = "";
    }
  }
  return out;
}

/**
 * Turn raw form state into `PropertyValueInput` values, coercing per type.
 *
 * Blank inputs become `null` so the server stores an empty cell rather than a
 * stray `0` / `[]`. Nothing is invented: a field that is blank in the form is
 * absent from the result.
 */
export function coerceFormValues(
  fields: PropertyDef[],
  raw: Record<string, string | boolean | number | string[] | null | undefined>,
): Record<string, PropertyValueInput> {
  const out: Record<string, PropertyValueInput> = {};
  for (const p of fields) {
    const v = raw[p.id];
    switch (p.type) {
      case "title":
      case "text":
      case "url":
      case "email":
      case "phone": {
        const s = typeof v === "string" ? v.trim() : "";
        if (s) out[p.id] = s;
        break;
      }
      case "number": {
        const s = typeof v === "string" ? v.trim() : v;
        if (s === "" || s === null || s === undefined) break;
        const n = typeof s === "number" ? s : Number(s);
        if (Number.isFinite(n)) out[p.id] = n;
        break;
      }
      case "checkbox":
        out[p.id] = v === true;
        break;
      case "select":
      case "status": {
        const ids = Array.isArray(v) ? v.slice(0, 1) : v ? [String(v)] : [];
        if (ids.length && ids[0]) out[p.id] = ids;
        break;
      }
      case "multi_select": {
        const ids = Array.isArray(v) ? v.filter((x) => x) : v ? [String(v)] : [];
        if (ids.length) out[p.id] = ids;
        break;
      }
      case "date": {
        const d = v as { start?: number | null; end?: number | null; allDay?: boolean } | string | null;
        if (typeof d === "string") {
          const t = d ? Date.parse(d) : NaN;
          if (Number.isFinite(t)) out[p.id] = { start: t, end: t, allDay: true };
          break;
        }
        if (d && typeof d.start === "number") {
          out[p.id] = { start: d.start, end: typeof d.end === "number" ? d.end : d.start, allDay: d.allDay !== false };
        }
        break;
      }
      case "relation": {
        const ids = Array.isArray(v) ? v : (v as { rows?: string[] } | null)?.rows ?? [];
        if (ids.length) out[p.id] = { rows: ids };
        break;
      }
      case "files": {
        const ids = Array.isArray(v) ? v : (v as { mediaIds?: string[] } | null)?.mediaIds ?? [];
        if (ids.length) out[p.id] = { mediaIds: ids };
        break;
      }
      default: {
        const s = typeof v === "string" ? v.trim() : "";
        if (s) out[p.id] = s;
      }
    }
  }
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+()\-.\s\d]{6,20}$/;
const URL_RE = /^(https?:\/\/|www\.)[^\s]+\.[^\s]{2,}/i;

/**
 * Validate a submission.
 *
 * Returns the issues, in field order. An empty array means the coerced values
 * are safe to hand to `api.createRow`.
 */
export function validateForm(
  fields: PropertyDef[],
  raw: Record<string, string | boolean | number | string[] | null | undefined>,
  ctx: {
    required?: (prop: PropertyDef) => boolean;
    maxRating?: number;
    ratingPropIds?: string[];
  } = {},
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const required = ctx.required ?? ((p: PropertyDef) => isFieldRequired(p));

  for (const p of fields) {
    const v = raw[p.id];
    const name = p.name;

    if (required(p)) {
      const blank =
        v === null ||
        v === undefined ||
        (typeof v === "string" && v.trim() === "") ||
        (Array.isArray(v) && v.length === 0) ||
        (typeof v === "object" && !Array.isArray(v) && isEmptyValue(v as PropertyValueInput));
      if (blank) {
        issues.push({ propId: p.id, message: `${name} is required` });
        continue;
      }
    }

    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;

    // A rating is not a PropertyType in shared/types.ts, so it is identified by
    // id (the caller passes `ratingPropIds`) and validated as a 0..max number.
    if (ctx.ratingPropIds?.includes(p.id)) {
      const n = typeof v === "number" ? v : Number(v);
      const max = ctx.maxRating ?? 5;
      if (!Number.isFinite(n) || n < 0 || n > max) {
        issues.push({ propId: p.id, message: `${name} must be between 0 and ${max}` });
      }
      continue;
    }

    switch (p.type) {
      case "number": {
        const s = typeof v === "string" ? v.trim() : v;
        const n = typeof s === "number" ? s : Number(s);
        if (!Number.isFinite(n)) issues.push({ propId: p.id, message: `${name} must be a number` });
        break;
      }
      case "email": {
        const s = String(v).trim();
        if (s && !EMAIL_RE.test(s)) issues.push({ propId: p.id, message: `${name} is not a valid email` });
        break;
      }
      case "url": {
        const s = String(v).trim();
        if (s && !URL_RE.test(s)) issues.push({ propId: p.id, message: `${name} must start with http:// or https://` });
        break;
      }
      case "phone": {
        const s = String(v).trim();
        if (s && !PHONE_RE.test(s)) issues.push({ propId: p.id, message: `${name} is not a valid phone number` });
        break;
      }
      case "date": {
        const d = v as { start?: number | null } | string;
        const t = typeof d === "string" ? (d ? Date.parse(d) : NaN) : d?.start;
        if (typeof t === "number" && !Number.isFinite(t)) {
          issues.push({ propId: p.id, message: `${name} is not a valid date` });
        }
        break;
      }
      case "select":
      case "status":
      case "multi_select": {
        const ids = Array.isArray(v) ? v : v ? [String(v)] : [];
        const valid = new Set(optionsOf(p).map((o) => o.id));
        const bad = ids.filter((id) => id && !valid.has(id));
        if (bad.length) issues.push({ propId: p.id, message: `${name} uses an unknown option` });
        break;
      }
      default:
        break;
    }
  }
  return issues;
}

/** Issues keyed by property id, for inline rendering. */
export function issuesByProp(issues: FieldIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) if (!out[i.propId]) out[i.propId] = i.message;
  return out;
}

/** The form's heading: `spec.form.title`, falling back to the database title. */
export function formTitle(specTitle: string | undefined, dbTitle: string): string {
  const t = specTitle?.trim();
  return t || dbTitle || "New entry";
}
