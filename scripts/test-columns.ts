/**
 * Column-layout tests. Run with:
 *
 *   & .\node_modules\.bin\tsx.cmd scripts/test-columns.ts
 *
 * Pure functions only — no DOM, no editor, no BlockNote runtime. Everything
 * here is the arithmetic and tree mapping that `src/editor/columns.tsx` and
 * `src/editor/toc.tsx` factor out, so the invariants that are easy to get wrong
 * (widths summing to 100, the 15% floor, children surviving a column removal)
 * are checked where they can be checked cheaply.
 */

import {
  COLUMN_LIST_TYPE,
  COLUMN_TYPE,
  BN_COLUMN,
  BN_COLUMN_LIST,
  MIN_COLUMN_WIDTH,
  MIN_COLUMNS,
  MAX_COLUMNS,
  PRESETS,
  isValidColumnCount,
  normalizeColumnCount,
  equalWidths,
  normalizeWidths,
  minFor,
  resizePair,
  resizeAt,
  normalizeTo100,
  addColumn,
  removeColumn,
  setColumnCount,
  columnListNodeToBn,
  columnNodeToBn,
  bnToColumnTree,
  widthsFromColumns,
  columnListParentPairs,
  columnListDescendantIds,
  type ColumnNodeLike,
} from "../src/editor/columns.tsx";

import {
  TOC_BLOCK_TYPE,
  TOC_LEVELS,
  walkBlocks,
  inlineContentToText,
  headingLevelOf,
  collectHeadings,
  tocIndent,
  activeEntry,
  orderMap,
  scrollToBlock,
  cssEscape,
  type HeadingSource,
} from "../src/editor/toc.tsx";

// ─────────────────────────────────────────────────────────────────────────────

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

const sum = (w: readonly number[]): number => w.reduce((a, b) => a + b, 0);

// ─────────────────────────────────────────────────────────────────────────────

section("Column count normalisation");
{
  eq("2 is valid", isValidColumnCount(2), true);
  eq("4 is valid", isValidColumnCount(4), true);
  eq("1 is not valid", isValidColumnCount(1), false);
  eq("0 is not valid", isValidColumnCount(0), false);
  eq("negative is not valid", isValidColumnCount(-3), false);
  eq("6 is over the cap", isValidColumnCount(6), false);
  eq("2.5 is not an integer count", isValidColumnCount(2.5), false);
  eq("NaN is not valid", isValidColumnCount(Number.NaN), false);

  eq("normalize: 1 → 2", normalizeColumnCount(1), 2);
  eq("normalize: 0 → 2", normalizeColumnCount(0), 2);
  eq("normalize: -5 → 2", normalizeColumnCount(-5), 2);
  eq("normalize: 99 → cap", normalizeColumnCount(99), MAX_COLUMNS);
  eq("normalize: 3 stays", normalizeColumnCount(3), 3);
  eq("normalize: 2.4 rounds to 2", normalizeColumnCount(2.4), 2);
  eq("normalize: 3.6 rounds to 4", normalizeColumnCount(3.6), 4);
  eq("normalize: NaN → 2", normalizeColumnCount(Number.NaN), 2);
  eq("normalize: Infinity → cap", normalizeColumnCount(Number.POSITIVE_INFINITY), MAX_COLUMNS);
  ok("MIN_COLUMNS is 2", MIN_COLUMNS === 2);
  ok("MAX_COLUMNS is at least 4", MAX_COLUMNS >= 4, `${MAX_COLUMNS}`);
}

section("Equal width distribution");
{
  eq("2 columns are 50/50", equalWidths(2), [50, 50]);
  eq("3 columns sum to 100", sum(equalWidths(3)), 100);
  eq("3 columns are integers", equalWidths(3).every((w) => Number.isInteger(w)), true);
  eq("3 columns are as equal as integers allow", Math.max(...equalWidths(3)) - Math.min(...equalWidths(3)), 1);
  eq("4 columns are 25 each", equalWidths(4), [25, 25, 25, 25]);
  eq("5 columns sum to 100", sum(equalWidths(5)), 100);
  eq("count 1 is clamped up to 2", equalWidths(1), [50, 50]);
  eq("count 99 is clamped to the cap", equalWidths(99).length, MAX_COLUMNS);
  eq("cap columns sum to 100", sum(equalWidths(MAX_COLUMNS)), 100);

  for (const n of [2, 3, 4]) {
    eq(`presets[${n}] sums to 100`, sum([...PRESETS[n]!]), 100);
    eq(`presets[${n}] has ${n} entries`, PRESETS[n]!.length, n);
  }
  eq("presets cover 2, 3 and 4", Object.keys(PRESETS).sort(), ["2", "3", "4"]);
  eq("presets[2] is 50/50", [...PRESETS[2]!], [50, 50]);
  eq("presets[3] is as equal as integers allow", Math.max(...PRESETS[3]!) - Math.min(...PRESETS[3]!), 1);
  eq("presets[4] is 25 each", [...PRESETS[4]!], [25, 25, 25, 25]);

  // Every count in range: integers, positive, summing to 100, at the floor.
  for (let n = MIN_COLUMNS; n <= MAX_COLUMNS; n++) {
    const w = equalWidths(n);
    eq(`equalWidths(${n}) length`, w.length, n);
    eq(`equalWidths(${n}) sums to 100`, sum(w), 100);
    ok(`equalWidths(${n}) all integers`, w.every((x) => Number.isInteger(x)));
    ok(`equalWidths(${n}) all at the floor`, w.every((x) => x >= minFor(n)), JSON.stringify(w));
  }
}

section("The 15% floor");
{
  eq("floor for 2 columns", minFor(2), MIN_COLUMN_WIDTH);
  eq("floor for 3 columns", minFor(3), MIN_COLUMN_WIDTH);
  eq("floor for 4 columns", minFor(4), MIN_COLUMN_WIDTH);
  ok("the floor is 15", MIN_COLUMN_WIDTH === 15);
  ok("4 columns can all sit at the floor", 15 * 4 <= 100);
  ok("5 columns can all sit at the floor", 15 * 5 <= 100);
}

section("normalizeWidths repairs broken input");
{
  eq("good widths pass through", normalizeWidths([50, 50]), [50, 50]);
  eq("3 good widths pass through", normalizeWidths([34, 33, 33]), [34, 33, 33]);
  eq("sum 99 is repaired to equal", normalizeWidths([33, 33, 33]), equalWidths(3));
  eq("sum 101 is repaired to equal", normalizeWidths([34, 34, 33]), equalWidths(3));
  eq("a width under the floor is repaired", normalizeWidths([90, 10]), equalWidths(2));
  eq("empty input becomes 2 equal columns", normalizeWidths([]), [50, 50]);
  // Widths stay aligned to columns: dropping an entry would hand column 3 the
  // width of column 2, which is how a 3-column list ended up as [50,50,0].
  eq(
    "non-numeric entries are repaired, not dropped",
    normalizeWidths([50, Number.NaN, 50]),
    equalWidths(3),
  );
  eq("zero widths are dropped", normalizeWidths([0, 100]), [50, 50]);
  eq("floats are rounded", normalizeWidths([33.4, 33.3, 33.3]), [34, 33, 33]);
  eq("floats that round under the floor are repaired", normalizeWidths([14.6, 42.7, 42.7]), equalWidths(3));
  eq("negative widths are dropped", normalizeWidths([-10, 110]), [50, 50]);
  eq("a column under the floor is repaired", normalizeWidths([40, 30, 20, 10]), equalWidths(4));
  eq("4 widths under the floor are repaired", normalizeWidths([97, 1, 1, 1]), equalWidths(4));
  ok("output always sums to 100", normalizeWidths([1, 2, 3, 4, 90]).length >= MIN_COLUMNS);
  eq("repaired output sums to 100", sum(normalizeWidths([1, 2, 3, 4, 90])), 100);
}

section("resizePair: the pair trades, the total holds");
{
  eq("2 columns: +10 → 60/40", resizePair([50, 50], 0, 10), [60, 40]);
  eq("2 columns: -10 → 40/60", resizePair([50, 50], 0, -10), [40, 60]);
  eq("2 columns: total stays 100", sum(resizePair([50, 50], 0, 17)), 100);
  eq("2 columns: clamped at the left floor", resizePair([50, 50], 0, -100), [15, 85]);
  eq("2 columns: clamped at the right floor", resizePair([50, 50], 0, 100), [85, 15]);
  eq("2 columns: exactly at the floor", resizePair([50, 50], 0, -35), [15, 85]);
  eq("2 columns: one past the floor is clamped", resizePair([50, 50], 0, -36), [15, 85]);

  eq("3 columns: divider 0", resizePair([34, 33, 33], 0, 5), [39, 28, 33]);
  eq("3 columns: divider 0 keeps the total", sum(resizePair([34, 33, 33], 0, 5)), 100);
  eq("3 columns: divider 1", resizePair([34, 33, 33], 1, 5), [34, 38, 28]);
  eq("3 columns: divider 1 keeps the total", sum(resizePair([34, 33, 33], 1, -9)), 100);
  eq("3 columns: divider 0 clamped", resizePair([34, 33, 33], 0, -100), [15, 52, 33]);
  eq("3 columns: divider 1 clamped low", resizePair([34, 33, 33], 1, -100), [34, 15, 51]);
  eq("3 columns: divider 1 clamped high", resizePair([34, 33, 33], 1, 100), [34, 51, 15]);

  eq("4 columns: divider 1", resizePair([25, 25, 25, 25], 1, 7), [25, 32, 18, 25]);
  eq("4 columns: total holds", sum(resizePair([25, 25, 25, 25], 2, 11)), 100);
  eq("4 columns: divider 2 clamped high", resizePair([25, 25, 25, 25], 2, 100), [25, 25, 35, 15]);
  eq("4 columns: divider 0 clamped low", resizePair([25, 25, 25, 25], 0, -100), [15, 35, 25, 25]);

  // Out-of-range dividers change nothing.
  eq("divider index -1 is a no-op", resizePair([50, 50], -1, 10), [50, 50]);
  eq("divider index 1 of 2 is a no-op", resizePair([50, 50], 1, 10), [50, 50]);
  eq("divider index 99 is a no-op", resizePair([25, 25, 25, 25], 99, 10), [25, 25, 25, 25]);
  eq("non-integer divider is a no-op", resizePair([50, 50], 0.5, 10), [50, 50]);
  eq("NaN delta is a no-op", resizePair([50, 50], 0, Number.NaN), [50, 50]);
  eq("zero delta is a no-op", resizePair([50, 50], 0, 0), [50, 50]);
  eq("broken input is repaired, then resized", resizePair([50, 30], 0, 5), [55, 45]);

  // The invariant, hammered: no sequence of drags may break the sum or the floor.
  let widths = equalWidths(4);
  let broke = false;
  let belowFloor = false;
  for (let i = 0; i < 500; i++) {
    const divider = i % 3;
    const delta = ((i * 37) % 61) - 30;
    widths = resizePair(widths, divider, delta);
    if (sum(widths) !== 100) broke = true;
    if (widths.some((w) => w < minFor(widths.length))) belowFloor = true;
  }
  ok("500 random drags keep the sum at 100", !broke, JSON.stringify(widths));
  ok("500 random drags keep every column at the floor", !belowFloor, JSON.stringify(widths));
  eq("500 random drags keep 4 columns", widths.length, 4);
}

section("resizeAt: absolute pointer position");
{
  // Row 1000px wide starting at x=0: pointer at 600 puts divider 0 at 60%.
  eq("pointer at 600px → 60/40", resizeAt([50, 50], 0, 0, 1000, 600), [60, 40]);
  eq("pointer at 400px → 40/60", resizeAt([50, 50], 0, 0, 1000, 400), [40, 60]);
  eq("pointer at the far right clamps", resizeAt([50, 50], 0, 0, 1000, 999), [85, 15]);
  eq("pointer at the far left clamps", resizeAt([50, 50], 0, 0, 1000, 0), [15, 85]);
  eq("a scrolled row: offset is subtracted", resizeAt([50, 50], 0, 200, 1000, 800), [60, 40]);
  eq("second divider of 3 respects the first column", resizeAt([34, 33, 33], 1, 0, 100, 60), [34, 26, 40]);
  eq("resizeAt keeps the total", sum(resizeAt([25, 25, 25, 25], 1, 0, 800, 500)), 100);
  eq("zero-width row is repaired, not divided by", resizeAt([50, 50], 0, 0, 0, 10), [50, 50]);
  eq("negative-width row is repaired", resizeAt([50, 50], 0, 0, -5, 10), [50, 50]);
  eq("out-of-range divider is a no-op", resizeAt([50, 50], 5, 0, 1000, 600), [50, 50]);
  eq("NaN pointer is a no-op", resizeAt([50, 50], 0, 0, 1000, Number.NaN), [50, 50]);
}

section("normalizeTo100");
{
  eq("already 100 is untouched", normalizeTo100([50, 50]), [50, 50]);
  eq("99 is topped up", sum(normalizeTo100([33, 33, 33])), 100);
  eq("101 is trimmed", sum(normalizeTo100([34, 34, 33])), 100);
  eq("proportions survive", normalizeTo100([20, 80]), [20, 80]);
  eq("floats are rounded", normalizeTo100([33.3, 33.3, 33.4]), [33, 33, 34]);
  eq("all-zero input becomes equal", normalizeTo100([0, 0, 0]), equalWidths(3));
  eq("empty input stays empty", normalizeTo100([]), []);
  eq("drift lands in the widest column", normalizeTo100([10, 80, 10]), [10, 80, 10]);
  eq("scaling a 2:1 pair", normalizeTo100([2, 1]), [67, 33]);
  for (const n of [2, 3, 4, 5]) {
    eq(`normalizeTo100 of ${n} random widths sums to 100`, sum(normalizeTo100(equalWidths(n).map((w, i) => w + i))), 100);
  }
}

section("addColumn");
{
  const two = addColumn([50, 50], 0);
  eq("adding to 2 gives 3 columns", two.widths.length, 3);
  eq("adding keeps the sum at 100", sum(two.widths), 100);
  eq("the new column is at index 1", two.index, 1);
  ok("the new column is at the floor at least", two.widths[1]! >= minFor(3), JSON.stringify(two.widths));
  ok("no column is under the floor", two.widths.every((w) => w >= minFor(3)), JSON.stringify(two.widths));

  const three = addColumn([34, 33, 33], 2);
  eq("adding to 3 gives 4 columns", three.widths.length, 4);
  eq("3 → 4 keeps the sum", sum(three.widths), 100);
  eq("3 → 4 index", three.index, 3);
  ok("3 → 4 respects the floor", three.widths.every((w) => w >= minFor(4)), JSON.stringify(three.widths));

  const four = addColumn([25, 25, 25, 25], 1);
  eq("adding to 4 gives 5 columns", four.widths.length, 5);
  eq("4 → 5 keeps the sum", sum(four.widths), 100);
  eq("4 → 5 index", four.index, 2);

  const capped = addColumn(equalWidths(MAX_COLUMNS), 0);
  eq("at the cap, nothing is added", capped.widths.length, MAX_COLUMNS);
  eq("at the cap, the widths are unchanged", capped.widths, equalWidths(MAX_COLUMNS));

  const skewed = addColumn([70, 30], 1);
  eq("a skewed pair donates from the widest", skewed.widths[0], 70 - Math.round(70 / 2));
  eq("skewed add keeps the sum", sum(skewed.widths), 100);

  const broken = addColumn([50, 30], 0);
  eq("broken widths are repaired first", broken.widths.length, 3);
  eq("broken add sums to 100", sum(broken.widths), 100);

  const neg = addColumn([50, 50], -4);
  eq("a negative index is clamped", neg.index, 1);
  const big = addColumn([50, 50], 99);
  eq("an oversized index is clamped", big.index, 2);
}

section("removeColumn merges children, never orphans them");
{
  const kids = [["a1", "a2"], ["b1"], ["c1", "c2", "c3"]];
  const r = removeColumn([34, 33, 33], kids, 1);
  eq("removing 3 → 2 columns", r.widths.length, 2);
  eq("removing keeps the sum at 100", sum(r.widths), 100);
  eq("the removed column's children join the previous one", r.children, [["a1", "a2", "b1"], ["c1", "c2", "c3"]]);
  eq("the merge keeps every child", r.children.flat().length, 6);
  eq("the focus lands on the absorber", r.index, 0);

  const first = removeColumn([34, 33, 33], kids, 0);
  eq("removing the first merges into the next", first.children, [["a1", "a2", "b1"], ["c1", "c2", "c3"]]);
  eq("removing the first keeps the sum", sum(first.widths), 100);
  eq("removing the first focuses the absorber, now at 0", first.index, 0);

  const last = removeColumn([34, 33, 33], kids, 2);
  eq("removing the last merges into the previous", last.children, [["a1", "a2"], ["b1", "c1", "c2", "c3"]]);
  eq("removing the last keeps the sum", sum(last.widths), 100);

  const twoKids = [["x"], ["y"]];
  const refuse = removeColumn([50, 50], twoKids, 0);
  eq("removing below the minimum is refused", refuse.widths.length, 2);
  eq("a refused removal keeps every child", refuse.children, [["x"], ["y"]]);
  eq("a refused removal keeps the widths", refuse.widths, [50, 50]);

  const oob = removeColumn([34, 33, 33], kids, 9);
  eq("an out-of-range index removes nothing", oob.widths.length, 3);
  eq("an out-of-range index keeps the children", oob.children, kids);
  const negIdx = removeColumn([34, 33, 33], kids, -1);
  eq("a negative index removes nothing", negIdx.widths.length, 3);

  // Missing child arrays are padded, not crashed on.
  const sparse = removeColumn([34, 33, 33], [["a"]], 1);
  eq("sparse children are padded", sparse.children, [["a"], ["c1", "c2", "c3"].slice(0, 0)]);
  eq("sparse removal keeps the sum", sum(sparse.widths), 100);

  // Round trip: add then remove restores the count and the sum.
  const added = addColumn([50, 50], 0);
  const back = removeColumn(added.widths, [[], [], []], added.index);
  eq("add then remove restores 2 columns", back.widths.length, 2);
  eq("add then remove restores the sum", sum(back.widths), 100);
}

section("setColumnCount");
{
  const kids = [["a"], ["b"], ["c"]];
  const grow = setColumnCount([34, 33, 33], kids, 4);
  eq("growing to 4 columns", grow.widths.length, 4);
  eq("growing sums to 100", sum(grow.widths), 100);
  eq("growing appends an empty column", grow.children, [["a"], ["b"], ["c"], []]);

  const shrink = setColumnCount([34, 33, 33], kids, 2);
  eq("shrinking to 2 columns", shrink.widths.length, 2);
  eq("shrinking sums to 100", sum(shrink.widths), 100);
  eq("shrinking merges the tail, keeping every child", shrink.children, [["a"], ["b", "c"]]);
  eq("shrinking keeps all 3 children", shrink.children.flat().length, 3);

  const clampLow = setColumnCount([50, 50], [["a"], ["b"]], 1);
  eq("count 1 is clamped to 2", clampLow.widths.length, 2);
  eq("count 1 keeps both columns' children", clampLow.children, [["a"], ["b"]]);

  const clampHigh = setColumnCount([50, 50], [["a"], ["b"]], 99);
  eq("count 99 is clamped to the cap", clampHigh.widths.length, MAX_COLUMNS);
  eq("count 99 sums to 100", sum(clampHigh.widths), 100);
  eq("count 99 keeps the children", clampHigh.children, [["a"], ["b"], [], [], []]);

  const same = setColumnCount([50, 50], [["a"], ["b"]], 2);
  eq("setting the same count is a no-op on children", same.children, [["a"], ["b"]]);
  eq("setting the same count re-distributes equally", same.widths, [50, 50]);
}

section("column_list / column → node-tree mapping");
{
  const tree: ColumnNodeLike = {
    id: "list1",
    type: COLUMN_LIST_TYPE,
    props: {},
    children: [
      {
        id: "col1",
        type: COLUMN_TYPE,
        props: { ratio: 60 },
        children: [
          { id: "p1", type: "paragraph", props: {}, children: [] },
          { id: "h1", type: "heading_1", props: {}, children: [] },
        ],
      },
      {
        id: "col2",
        type: COLUMN_TYPE,
        props: { ratio: 40 },
        children: [{ id: "p2", type: "paragraph", props: {}, children: [] }],
      },
    ],
  };

  const bn = columnListNodeToBn(tree);
  eq("the list maps to BlockNote's camelCase name", bn.type, BN_COLUMN_LIST);
  eq("the list keeps its id", bn.id, "list1");
  eq("the list carries 2 columns", (bn.children as unknown[]).length, 2);
  const cols = bn.children as Record<string, unknown>[];
  eq("a column maps to BlockNote's camelCase name", cols[0]!.type, BN_COLUMN);
  eq("the column's ratio becomes its width prop", cols[0]!.props, { width: 60 });
  eq("the second column's width", (cols[1]!.props as Record<string, unknown>).width, 40);
  eq("the column's children are carried", (cols[0]!.children as unknown[]).length, 2);
  eq("a nested child keeps its id", (cols[0]!.children as Record<string, unknown>[])[0]!.id, "p1");
  eq("a nested child keeps its type", (cols[0]!.children as Record<string, unknown>[])[1]!.type, "heading_1");

  // Round trip: tree → BlockNote → tree.
  const back = bnToColumnTree(bn);
  eq("round trip keeps the list id", back.id, "list1");
  eq("round trip keeps our node type", back.type, COLUMN_LIST_TYPE);
  eq("round trip keeps 2 columns", back.children.length, 2);
  eq("round trip keeps the column ids", back.children.map((c) => c.id), ["col1", "col2"]);
  eq("round trip keeps the ratios", back.children.map((c) => c.props.ratio), [60, 40]);
  eq("round trip keeps our column type", back.children[0]!.type, COLUMN_TYPE);
  eq("round trip keeps the nested children", (back.children[0]!.children as ColumnNodeLike[]).map((c) => c.id), ["p1", "h1"]);
  eq("round trip is stable", bnToColumnTree(columnListNodeToBn(back as unknown as ColumnNodeLike)).children.map((c) => c.props.ratio), [60, 40]);

  // A list whose ratios are broken is repaired on the way in.
  const broken: ColumnNodeLike = {
    id: "list2",
    type: COLUMN_LIST_TYPE,
    props: {},
    children: [
      { id: "c1", type: COLUMN_TYPE, props: { ratio: 70 }, children: [] },
      { id: "c2", type: COLUMN_TYPE, props: { ratio: 20 }, children: [] },
    ],
  };
  const fixed = columnListNodeToBn(broken);
  const fixedCols = fixed.children as Record<string, unknown>[];
  eq("broken ratios are re-distributed", fixedCols.map((c) => (c.props as Record<string, unknown>).width), [50, 50]);
  eq("re-distributed ratios sum to 100", fixedCols.reduce((a, c) => a + Number((c.props as Record<string, unknown>).width), 0), 100);

  // A list with no ratios at all.
  const bare: ColumnNodeLike = {
    id: "list3",
    type: COLUMN_LIST_TYPE,
    props: {},
    children: [
      { id: "c1", type: COLUMN_TYPE, props: {}, children: [] },
      { id: "c2", type: COLUMN_TYPE, props: {}, children: [] },
      { id: "c3", type: COLUMN_TYPE, props: {}, children: [] },
    ],
  };
  const bareCols = columnListNodeToBn(bare).children as Record<string, unknown>[];
  eq("missing ratios fall back to equal widths", bareCols.map((c) => (c.props as Record<string, unknown>).width), equalWidths(3));

  eq("columnNodeToBn stamps the width", columnNodeToBn({ id: "c", type: COLUMN_TYPE, props: {}, children: [] }, 37.4).props, { width: 37 });
  eq("widthsFromColumns reads the ratios", widthsFromColumns(tree.children ?? []), [60, 40]);
  eq("widthsFromColumns repairs a bad sum", widthsFromColumns(broken.children ?? []), [50, 50]);
  eq("widthsFromColumns on no columns", widthsFromColumns([]), [50, 50]);
}

section("parent / pos rows for the node tree");
{
  const tree: ColumnNodeLike = {
    id: "list1",
    type: COLUMN_LIST_TYPE,
    props: {},
    children: [
      {
        id: "col1",
        type: COLUMN_TYPE,
        props: { ratio: 60 },
        children: [
          { id: "p1", type: "paragraph", props: {}, children: [] },
          { id: "t1", type: "toggle", props: {}, children: [{ id: "p2", type: "paragraph", props: {}, children: [] }] },
        ],
      },
      { id: "col2", type: COLUMN_TYPE, props: { ratio: 40 }, children: [{ id: "p3", type: "paragraph", props: {}, children: [] }] },
    ],
  };

  const pairs = columnListParentPairs(tree);
  eq("each column's parent is the list", pairs.find(([id]) => id === "col1"), ["col1", "list1"]);
  eq("a column child's parent is the column", pairs.find(([id]) => id === "p1"), ["p1", "col1"]);
  eq("a nested block's parent is its block, not the column", pairs.find(([id]) => id === "p2"), ["p2", "t1"]);
  eq("the second column hangs off the list", pairs.find(([id]) => id === "col2"), ["col2", "list1"]);
  eq("pairs are in document order", pairs.map(([id]) => id), ["col1", "p1", "t1", "p2", "col2", "p3"]);
  eq("no pair names the list itself", pairs.some(([id]) => id === "list1"), false);

  const ids = columnListDescendantIds(tree);
  ok("descendants include the columns", ids.has("col1") && ids.has("col2"));
  ok("descendants include the blocks", ids.has("p1") && ids.has("p3"));
  ok("descendants include deep nesting", ids.has("p2"));
  ok("descendants exclude the list itself", !ids.has("list1"));
  eq("descendant count", ids.size, 6);
  eq("an empty list has no descendants", columnListDescendantIds({ id: "x", type: COLUMN_LIST_TYPE, props: {}, children: [] }).size, 0);
}

section("TOC: content → text");
{
  eq("plain runs", inlineContentToText([{ type: "text", text: "Hello ", styles: {} }, { type: "text", text: "world", styles: { bold: true } }]), "Hello world");
  eq("link runs contribute their nested text", inlineContentToText([{ type: "link", href: "page:x", content: [{ type: "text", text: "Target", styles: {} }] }]), "Target");
  eq("mixed link and text", inlineContentToText([{ type: "text", text: "see ", styles: {} }, { type: "link", href: "u", content: [{ type: "text", text: "here", styles: {} }] }]), "see here");
  eq("null content", inlineContentToText(null), "");
  eq("undefined content", inlineContentToText(undefined), "");
  eq("string content", inlineContentToText("raw"), "raw");
  eq("non-array content", inlineContentToText({ nope: 1 }), "");
  eq("empty array", inlineContentToText([]), "");
  eq("garbage entries are skipped", inlineContentToText([null, 3, { type: "text", text: "ok", styles: {} }]), "ok");
  eq("a run with no text", inlineContentToText([{ type: "text", styles: {} }]), "");
}

section("TOC: heading detection");
{
  eq("heading level 1", headingLevelOf({ id: "a", type: "heading", props: { level: 1 } }), 1);
  eq("heading level 3", headingLevelOf({ id: "a", type: "heading", props: { level: 3 } }), 3);
  eq("heading level 6", headingLevelOf({ id: "a", type: "heading", props: { level: 6 } }), 6);
  eq("a missing level defaults to 1", headingLevelOf({ id: "a", type: "heading" }), 1);
  eq("a string level is coerced", headingLevelOf({ id: "a", type: "heading", props: { level: "2" } }), 2);
  eq("a nonsense level defaults to 1", headingLevelOf({ id: "a", type: "heading", props: { level: "nope" } }), 1);
  eq("level 0 is out of range → 1", headingLevelOf({ id: "a", type: "heading", props: { level: 0 } }), 1);
  eq("level 9 is out of range → 1", headingLevelOf({ id: "a", type: "heading", props: { level: 9 } }), 1);
  eq("a paragraph is not a heading", headingLevelOf({ id: "a", type: "paragraph" }), undefined);
  eq("a column is not a heading", headingLevelOf({ id: "a", type: BN_COLUMN }), undefined);
  eq("a toc block is not a heading", headingLevelOf({ id: "a", type: TOC_BLOCK_TYPE }), undefined);
}

section("TOC: outline collection");
{
  const blocks: HeadingSource[] = [
    { id: "h1", type: "heading", props: { level: 1 }, content: [{ type: "text", text: "Intro", styles: {} }] },
    { id: "p1", type: "paragraph", content: [{ type: "text", text: "noise", styles: {} }] },
    { id: "h2", type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Details", styles: {} }] },
    {
      id: "list",
      type: BN_COLUMN_LIST,
      props: {},
      children: [
        {
          id: "col1",
          type: BN_COLUMN,
          props: { width: 50 },
          children: [
            { id: "h3", type: "heading", props: { level: 3 }, content: [{ type: "text", text: "In a column", styles: {} }] },
          ],
        },
        {
          id: "col2",
          type: BN_COLUMN,
          props: { width: 50 },
          children: [
            { id: "h4", type: "heading", props: { level: 1 }, content: [{ type: "link", href: "page:x", content: [{ type: "text", text: "Linked", styles: {} }] }] },
          ],
        },
      ],
    },
    { id: "h5", type: "heading", props: { level: 2 }, content: [] },
    { id: "h6", type: "heading", props: { level: 4 }, content: [{ type: "text", text: "Deep", styles: {} }] },
  ];

  const entries = collectHeadings(blocks);
  eq("headings inside columns are found", entries.map((e) => e.id), ["h1", "h2", "h3", "h4"]);
  eq("levels are carried", entries.map((e) => e.level), [1, 2, 3, 1]);
  eq("document order is preserved", entries.map((e) => e.text), ["Intro", "Details", "In a column", "Linked"]);
  eq("an empty heading is skipped", entries.some((e) => e.id === "h5"), false);
  eq("level 4 is outside the default outline", entries.some((e) => e.id === "h6"), false);
  eq("level 4 shows when asked for", collectHeadings(blocks, [1, 2, 3, 4]).map((e) => e.id).includes("h6"), true);
  eq("a narrower level filter", collectHeadings(blocks, [1]).map((e) => e.id), ["h1", "h4"]);
  eq("no levels yields nothing", collectHeadings(blocks, []).length, 0);
  eq("an empty document yields nothing", collectHeadings([]).length, 0);
  eq("TOC_LEVELS is 1..3", TOC_LEVELS, [1, 2, 3]);
  eq("TOC_BLOCK_TYPE is toc", TOC_BLOCK_TYPE, "toc");

  const flat = walkBlocks(blocks);
  eq("walk is pre-order", flat.map((b) => b.id).slice(0, 6), ["h1", "p1", "h2", "list", "col1", "h3"]);
  eq("walk visits every block", flat.length, 10);
  eq("walk on empty", walkBlocks([]), []);
  const deep: HeadingSource = { id: "a", type: "x", children: [{ id: "b", type: "x", children: [{ id: "c", type: "x" }] }] };
  eq("walk recurses arbitrarily deep", walkBlocks([deep]).map((b) => b.id), ["a", "b", "c"]);

  const order = orderMap(blocks);
  eq("orderMap indexes the first block", order.get("h1"), 0);
  eq("orderMap indexes a nested block", order.get("h3"), 5);
  eq("orderMap has no entry for a stranger", order.get("nope"), undefined);
  eq("orderMap covers every id", order.size, 10);
}

section("TOC: indent and active entry");
{
  const entries = [
    { id: "a", level: 2, text: "A" },
    { id: "b", level: 3, text: "B" },
    { id: "c", level: 2, text: "C" },
  ];
  eq("the shallowest present level is flush", tocIndent(entries[0]!, entries), 0);
  eq("one level deeper indents once", tocIndent(entries[1]!, entries), 1);
  eq("back to the top level is flush again", tocIndent(entries[2]!, entries), 0);
  eq("indent on an empty outline", tocIndent({ id: "x", level: 3, text: "x" }, []), 0);
  const deep = [{ id: "a", level: 1, text: "A" }, { id: "b", level: 3, text: "B" }];
  eq("a skipped level indents twice", tocIndent(deep[1]!, deep), 2);

  const order = new Map<string, number>([["pre", 0], ["a", 1], ["mid", 2], ["b", 3], ["c", 4], ["post", 5]]);
  eq("the active entry is the last heading at or above the caret", activeEntry(entries, order, "mid")?.id, "a");
  eq("inside a heading, that heading is active", activeEntry(entries, order, "b")?.id, "b");
  eq("after the last heading, it stays active", activeEntry(entries, order, "post")?.id, "c");
  eq("above the first heading, nothing is active", activeEntry(entries, order, "pre"), undefined);
  eq("an unknown caret id yields nothing", activeEntry(entries, order, "nope"), undefined);
  eq("no caret yields nothing", activeEntry(entries, order, undefined), undefined);
  eq("an empty outline yields nothing", activeEntry([], order, "a"), undefined);
}

section("TOC: scrolling");
{
  const hits: string[] = [];
  const find = (id: string): Element | null => {
    if (id === "known") {
      hits.push(id);
      return { scrollIntoView: () => {} } as unknown as Element;
    }
    return null;
  };
  eq("scrolling to a known block succeeds", scrollToBlock("known", find), true);
  eq("the finder was called", hits, ["known"]);
  eq("scrolling to a missing block reports failure", scrollToBlock("gone", find), false);
  eq("the default finder is used when none is passed", scrollToBlock("x", () => null), false);
  eq("a throwing-free undefined finder fails cleanly", scrollToBlock("x", () => undefined), false);

  eq("cssEscape leaves a plain id alone", cssEscape("abc123"), "abc123");
  eq("cssEscape escapes a quote", cssEscape('a"b'), "a\\\"b");
  eq("cssEscape escapes a backslash", cssEscape("a\\b"), "a\\\\b");
}

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
