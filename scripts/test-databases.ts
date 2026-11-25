/**
 * Database + query-engine tests. Run with: npm run test:databases
 *
 * The query engine is what every view reads through, so this suite is the
 * contract for Table/Board/List/Gallery/Calendar behaviour.
 */

import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openWorkspace, type Db } from "../server/db.ts";
import { createNode, updateNode, trashNode, restoreNode } from "../server/ops.ts";
import {
  createDatabase,
  addProperty,
  createRow,
  getRow,
  listRows,
  listProperties,
  listViews,
  getDatabase,
  setPropertyValue,
  queryRows,
  aggregate,
  groupRows,
  createRelation,
  addSelectOption,
  renameSelectOption,
  removeSelectOption,
  deleteProperty,
  renameProperty,
  changePropertyType,
  optionsOf,
  databaseHostNode,
  databaseForNode,
  trashRow,
  restoreRow,
  type SeedProperty,
} from "../server/databases.ts";
import {
  plainTextToBody,
  defaultViewSpec,
  type PropertyDef,
  type ViewSpec,
  type PropertyValueInput,
} from "../shared/types.ts";

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

const TEST_ROOT = join(import.meta.dirname!, "..", ".data", "test-db");
if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });

const openDbs: Db[] = [];
let seq = 0;

function freshDb(): { db: Db; ws: string; page: string } {
  const { db } = openWorkspace(join(TEST_ROOT, `s${seq++}`));
  openDbs.push(db);
  const ws = "ws-dbtest";
  db.run("INSERT INTO workspace (id, name, created_at) VALUES (?, ?, ?)", ws, "T", Date.now());
  const page = createNode(db, {
    ws, kind: "page", type: "page", parent_id: null, parent_kind: "workspace",
    body: plainTextToBody("Tasks"),
  });
  return { db, ws, page };
}

const DAY = 86_400_000;
const d = (n: number): number => Date.UTC(2026, 0, n) ;

function makeTasks(db: Db, ws: string, page: string) {
  const seeds: SeedProperty[] = [
    { name: "Name", type: "title" },
    { name: "Priority", type: "number" },
    { name: "Done", type: "checkbox" },
    { name: "Tag", type: "select" },
    { name: "Tags", type: "multi_select" },
    { name: "State", type: "status" },
    { name: "Due", type: "date" },
    { name: "Notes", type: "text" },
    { name: "Link", type: "url" },
  ];
  const created = createDatabase(db, {
    ws, parent_id: page, parent_kind: "node", title: "Tasks", properties: seeds,
    views: [
      { name: "Table", type: "table" },
      { name: "Board", type: "board" },
      { name: "Calendar", type: "calendar" },
    ],
  });
  const P: Record<string, PropertyDef> = {};
  for (const p of created.properties) P[p.name] = p;
  return { ...created, P };
}

// ── creation ─────────────────────────────────────────────────────────────────

section("Database creation");
{
  const { db, ws, page } = freshDb();
  const t = makeTasks(db, ws, page);

  ok("database id is returned", t.databaseId.length > 0);
  ok("host node is a child_database block", db.get<{ type: string }>(
    "SELECT type FROM node WHERE id = ?", t.node,
  )?.type === "child_database");
  eq("properties created in order", t.properties.map((p) => p.name), [
    "Name", "Priority", "Done", "Tag", "Tags", "State", "Due", "Notes", "Link",
  ]);
  eq("three views created", t.views.map((v) => v.type), ["table", "board", "calendar"]);
  eq("host lookup round-trips", databaseForNode(db, t.node), t.databaseId);
  eq("database → host node", databaseHostNode(db, t.databaseId), t.node);

  const status = t.P["State"]!;
  const groups = (status.config as { groups: { id: string; options: { name: string }[] }[] }).groups;
  eq("status has the three canonical groups", groups.map((g) => g.id), [
    "to_do", "in_progress", "complete",
  ]);
  eq("status default option names", groups.map((g) => g.options[0]?.name), [
    "To-do", "In Progress", "Complete",
  ]);

  const loaded = getDatabase(db, t.databaseId);
  eq("getDatabase returns the same property count", loaded?.properties.length, 9);
  eq("getDatabase returns views", loaded?.views.length, 3);

  let threw = false;
  try {
    addProperty(db, t.databaseId, "Priority", "number");
  } catch {
    threw = true;
  }
  ok("duplicate property name is rejected", threw);
}

// ── rows & values ────────────────────────────────────────────────────────────

section("Rows and property values");
{
  const { db, ws, page } = freshDb();
  const t = makeTasks(db, ws, page);

  const tagA = addSelectOption(db, t.P["Tag"]!.id, "Urgent", "red");
  const tagB = addSelectOption(db, t.P["Tag"]!.id, "Backlog", "gray");
  const m1 = addSelectOption(db, t.P["Tags"]!.id, "frontend");
  const m2 = addSelectOption(db, t.P["Tags"]!.id, "backend");

  const row = createRow(db, t.databaseId, {
    [t.P["Name"]!.id]: "Ship the editor",
    [t.P["Priority"]!.id]: 3,
    [t.P["Done"]!.id]: true,
    [t.P["Tag"]!.id]: [tagA.id],
    [t.P["Tags"]!.id]: [m1.id, m2.id],
    [t.P["Due"]!.id]: { start: d(15), end: null, allDay: true },
    [t.P["Notes"]!.id]: "nested notes",
    [t.P["Link"]!.id]: "https://example.com",
  });

  const view = getRow(db, row)!;
  eq("title reads back", view.values[t.P["Name"]!.id], "Ship the editor");
  eq("title mirrors node.body (drives titles + FTS)", db.get<{ body: string }>(
    "SELECT body FROM node WHERE id = ?", row,
  )!.body.includes("Ship the editor"), true);
  eq("number", view.values[t.P["Priority"]!.id], 3);
  eq("checkbox", view.values[t.P["Done"]!.id], true);
  eq("select is a 1-tuple", view.values[t.P["Tag"]!.id], [tagA.id]);
  eq("multi_select keeps order", view.values[t.P["Tags"]!.id], [m1.id, m2.id]);
  eq("date range", view.values[t.P["Due"]!.id], { start: d(15), end: null, allDay: true });
  eq("text", view.values[t.P["Notes"]!.id], "nested notes");
  eq("url", view.values[t.P["Link"]!.id], "https://example.com");

  // typed columns: the whole point of spreading values across columns
  const cols = db.get<{ num_v: number; bool_v: number; date_v: number; text_v: string }>(
    "SELECT num_v, bool_v, date_v, text_v FROM property_value WHERE row_id = ? AND prop_id = ?",
    row, t.P["Priority"]!.id,
  );
  eq("number lands in num_v", cols?.num_v, 3);
  const dateCols = db.get<{ date_v: number }>(
    "SELECT date_v FROM property_value WHERE row_id = ? AND prop_id = ?",
    row, t.P["Due"]!.id,
  );
  eq("date lands in date_v", dateCols?.date_v, d(15));

  // empty values
  const emptyRow = createRow(db, t.databaseId, {});
  eq("untitled row gets a placeholder title", getRow(db, emptyRow)!.title, "Untitled");
  eq("unset number reads null", getRow(db, emptyRow)!.values[t.P["Priority"]!.id], null);
  eq("unset checkbox reads false", getRow(db, emptyRow)!.values[t.P["Done"]!.id], false);
  eq("unset select reads empty", getRow(db, emptyRow)!.values[t.P["Tag"]!.id], []);
  eq("unset date has null start", (getRow(db, emptyRow)!.values[t.P["Due"]!.id] as { start: number | null }).start, null);

  // clear a value
  setPropertyValue(db, row, t.P["Priority"]!.id, null);
  eq("clearing a number yields null", getRow(db, row)!.values[t.P["Priority"]!.id], null);

  // rows are pages: nested content works
  const block = createNode(db, {
    ws, kind: "block", type: "paragraph", parent_id: row, parent_kind: "node",
    body: plainTextToBody("detail inside the row page"),
  });
  eq("a row holds nested blocks", db.scalar<number>(
    "SELECT count(*) c FROM node WHERE parent_id = ?", row,
  ), 1);
  ok("the nested block is readable", getRow(db, block) === null);

  eq("listRows sees both rows", listRows(db, t.databaseId).length, 2);
}

section("Auto-metadata and unique_id");
{
  const { db, ws, page } = freshDb();
  const created = createDatabase(db, {
    ws, parent_id: page, parent_kind: "node", title: "Bugs",
    properties: [
      { name: "Name", type: "title" },
      { name: "ID", type: "unique_id", config: { prefix: "BUG", next: 1 } },
      { name: "Created", type: "created_time" },
      { name: "Edited", type: "last_edited_time" },
      { name: "By", type: "created_by" },
      { name: "Editor", type: "last_edited_by" },
    ],
  });
  const P: Record<string, PropertyDef> = {};
  for (const p of created.properties) P[p.name] = p;

  const r1 = createRow(db, created.databaseId, { [P["Name"]!.id]: "one" });
  const r2 = createRow(db, created.databaseId, { [P["Name"]!.id]: "two" });
  const r3 = createRow(db, created.databaseId, { [P["Name"]!.id]: "three" });

  eq("unique ids increment", [r1, r2, r3].map((r) => getRow(db, r)!.values[P["ID"]!.id]), [1, 2, 3]);
  const cfg = db.get<{ config: string }>("SELECT config FROM property_def WHERE id = ?", P["ID"]!.id)!;
  eq("counter advanced past the last issued id", JSON.parse(cfg.config).next, 4);

  const created_v = getRow(db, r1)!.values[P["Created"]!.id] as { start: number };
  ok("created_time is populated", typeof created_v.start === "number" && created_v.start > 0);

  const before = created_v.start;
  setPropertyValue(db, r1, P["Name"]!.id, "one edited");
  const edited = getRow(db, r1)!.values[P["Edited"]!.id] as { start: number };
  ok("last_edited_time advances", edited.start >= before);
  eq("created_by reads the actor", getRow(db, r1)!.values[P["By"]!.id], "local");
  eq("last_edited_by reads the actor", getRow(db, r1)!.values[P["Editor"]!.id], "local");
}

// ── query engine ─────────────────────────────────────────────────────────────

section("Query engine — filtering");
{
  const { db, ws, page } = freshDb();
  const t = makeTasks(db, ws, page);
  const urgent = addSelectOption(db, t.P["Tag"]!.id, "Urgent", "red");
  const backlog = addSelectOption(db, t.P["Tag"]!.id, "Backlog", "gray");
  const fe = addSelectOption(db, t.P["Tags"]!.id, "frontend");
  const be = addSelectOption(db, t.P["Tags"]!.id, "backend");

  const rows = [
    { name: "Alpha", pri: 1, done: true, tag: urgent, tags: [fe], due: d(10) },
    { name: "Bravo", pri: 5, done: false, tag: backlog, tags: [be], due: d(20) },
    { name: "Charlie", pri: 3, done: true, tag: urgent, tags: [fe, be], due: d(30) },
    { name: "Delta", pri: 9, done: false, tag: null, tags: [], due: null },
  ].map((r) =>
    createRow(db, t.databaseId, {
      [t.P["Name"]!.id]: r.name,
      [t.P["Priority"]!.id]: r.pri,
      [t.P["Done"]!.id]: r.done,
      [t.P["Tag"]!.id]: r.tag ? [r.tag.id] : [],
      [t.P["Tags"]!.id]: r.tags.map((x) => x.id),
      [t.P["Due"]!.id]: { start: r.due, end: null, allDay: true },
    }),
  );

  const titles = (spec: Partial<ViewSpec>) =>
    queryRows(db, t.databaseId, { ...defaultViewSpec(), ...spec }).rows.map((r) => r.title);

  eq("no filter returns all", titles(defaultViewSpec()), ["Alpha", "Bravo", "Charlie", "Delta"]);

  eq("number greaterThan", titles({
    filter: { and: true, rules: [{ prop: t.P["Priority"]!.id, operator: "greaterThan", value: 3 }] },
  }), ["Bravo", "Delta"]);

  // unsorted queries return insertion order (n.pos), so expectations are by pos
  eq("number greaterThanOrEqualTo", titles({
    filter: { and: true, rules: [{ prop: t.P["Priority"]!.id, operator: "greaterThanOrEqualTo", value: 3 }] },
  }), ["Bravo", "Charlie", "Delta"]);

  eq("checkbox checked", titles({
    filter: { and: true, rules: [{ prop: t.P["Done"]!.id, operator: "checked" }] },
  }), ["Alpha", "Charlie"]);

  eq("select is", titles({
    filter: { and: true, rules: [{ prop: t.P["Tag"]!.id, operator: "is", value: [urgent.id] }] },
  }), ["Alpha", "Charlie"]);

  eq("select isNot (includes unset rows)", titles({
    filter: { and: true, rules: [{ prop: t.P["Tag"]!.id, operator: "isNot", value: [urgent.id] }] },
  }), ["Bravo", "Delta"]);

  eq("multi_select contains one", titles({
    filter: { and: true, rules: [{ prop: t.P["Tags"]!.id, operator: "contains", value: [fe.id] }] },
  }), ["Alpha", "Charlie"]);

  eq("multi_select contains two (AND of two rules)", titles({
    filter: {
      and: true,
      rules: [
        { prop: t.P["Tags"]!.id, operator: "contains", value: [fe.id] },
        { prop: t.P["Tags"]!.id, operator: "contains", value: [be.id] },
      ],
    },
  }), ["Charlie"]);

  eq("title contains is case-insensitive", titles({
    filter: { and: true, rules: [{ prop: t.P["Name"]!.id, operator: "contains", value: "ALP" }] },
  }), ["Alpha"]);

  eq("title is", titles({
    filter: { and: true, rules: [{ prop: t.P["Name"]!.id, operator: "is", value: "bravo" }] },
  }), ["Bravo"]);

  eq("date before", titles({
    filter: { and: true, rules: [{ prop: t.P["Due"]!.id, operator: "before", value: { start: d(20), end: d(20), allDay: true } }] },
  }), ["Alpha"]);

  eq("date on (range)", titles({
    filter: { and: true, rules: [{ prop: t.P["Due"]!.id, operator: "on", value: { start: d(20), end: d(20), allDay: true } }] },
  }), ["Bravo"]);

  eq("isEmpty on a number", titles({
    filter: { and: true, rules: [{ prop: t.P["Priority"]!.id, operator: "isEmpty" }] },
  }), []);

  eq("isNotEmpty on a select", titles({
    filter: { and: true, rules: [{ prop: t.P["Tag"]!.id, operator: "isNotEmpty" }] },
  }), ["Alpha", "Bravo", "Charlie"]);

  // emptiness is type-aware: number checks num_v, select checks the option array
  const noPri = createRow(db, t.databaseId, { [t.P["Name"]!.id]: "NoPri" });
  const noTag = createRow(db, t.databaseId, { [t.P["Name"]!.id]: "NoTag" });
  eq("isEmpty on a number", titles({
    filter: { and: true, rules: [{ prop: t.P["Priority"]!.id, operator: "isEmpty" }] },
  }), ["NoPri", "NoTag"]);
  eq("isNotEmpty on a number", titles({
    filter: { and: true, rules: [{ prop: t.P["Priority"]!.id, operator: "isNotEmpty" }] },
  }), ["Alpha", "Bravo", "Charlie", "Delta"]);
  eq("isEmpty on a select", titles({
    filter: { and: true, rules: [{ prop: t.P["Tag"]!.id, operator: "isEmpty" }] },
  }), ["Delta", "NoPri", "NoTag"]);
  eq("isEmpty on a date", titles({
    filter: { and: true, rules: [{ prop: t.P["Due"]!.id, operator: "isEmpty" }] },
  }), ["Delta", "NoPri", "NoTag"]);
  eq("isEmpty on a multi_select", titles({
    filter: { and: true, rules: [{ prop: t.P["Tags"]!.id, operator: "isEmpty" }] },
  }), ["Delta", "NoPri", "NoTag"]);
  void noPri; void noTag;

  // multi-rule AND
  eq("two rules AND", titles({
    filter: {
      and: true,
      rules: [
        { prop: t.P["Priority"]!.id, operator: "greaterThan", value: 2 },
        { prop: t.P["Done"]!.id, operator: "unchecked" },
      ],
    },
  }), ["Bravo", "Delta"]);

  // multi-rule OR
  eq("two rules OR", titles({
    filter: {
      and: false,
      rules: [
        { prop: t.P["Priority"]!.id, operator: "greaterThan", value: 8 },
        { prop: t.P["Name"]!.id, operator: "is", value: "Alpha" },
      ],
    },
  }), ["Alpha", "Delta"]);

  // nested group: (pri > 2) AND (tag = urgent OR name = Bravo)
  eq("nested filter groups", titles({
    filter: {
      and: true,
      rules: [{ prop: t.P["Priority"]!.id, operator: "greaterThan", value: 2 }],
      groups: [
        {
          and: false,
          rules: [
            { prop: t.P["Tag"]!.id, operator: "is", value: [urgent.id] },
            { prop: t.P["Name"]!.id, operator: "is", value: "Bravo" },
          ],
        },
      ],
    },
  }), ["Bravo", "Charlie"]);

  eq("total counts filtered rows", queryRows(db, t.databaseId, {
    ...defaultViewSpec(),
    filter: { and: true, rules: [{ prop: t.P["Done"]!.id, operator: "checked" }] },
  }).total, 2);

  // trashed rows are excluded (relative assertions: this dataset grows above)
  const totalBefore = queryRows(db, t.databaseId, defaultViewSpec()).total;
  trashRow(db, rows[3]!);
  const afterTrash = titles(defaultViewSpec());
  ok("trashed row drops out of queries", !afterTrash.includes("Delta"), JSON.stringify(afterTrash));
  eq("trashing removes exactly one row", afterTrash.length, totalBefore - 1);
  restoreRow(db, rows[3]!);
  eq("restored row returns", titles(defaultViewSpec()).length, totalBefore);
}

section("Query engine — sorting, paging");
{
  const { db, ws, page } = freshDb();
  const t = makeTasks(db, ws, page);
  const hi = addSelectOption(db, t.P["Tag"]!.id, "High", "red");
  const lo = addSelectOption(db, t.P["Tag"]!.id, "Low", "gray");

  const mk = (name: string, pri: number | null, tag: string | null, due: number | null) =>
    createRow(db, t.databaseId, {
      [t.P["Name"]!.id]: name,
      [t.P["Priority"]!.id]: pri,
      [t.P["Tag"]!.id]: tag ? [tag] : [],
      [t.P["Due"]!.id]: { start: due, end: null, allDay: true },
    });

  mk("a", 2, hi.id, d(20));
  mk("b", 10, lo.id, d(5));
  mk("c", null, hi.id, null);
  mk("d", 5, null, d(15));

  const titles = (spec: Partial<ViewSpec>) =>
    queryRows(db, t.databaseId, { ...defaultViewSpec(), ...spec }).rows.map((r) => r.title);

  eq("number ascending, nulls last", titles({
    sort: [{ prop: t.P["Priority"]!.id, direction: "ascending" }],
  }), ["a", "d", "b", "c"]);

  eq("number descending, nulls last", titles({
    sort: [{ prop: t.P["Priority"]!.id, direction: "descending" }],
  }), ["b", "d", "a", "c"]);

  eq("date ascending, nulls last", titles({
    sort: [{ prop: t.P["Due"]!.id, direction: "ascending" }],
  }), ["b", "d", "a", "c"]);

  eq("title ascending", titles({
    sort: [{ prop: t.P["Name"]!.id, direction: "ascending" }],
  }), ["a", "b", "c", "d"]);

  eq("select sorts by option id consistently", titles({
    sort: [{ prop: t.P["Tag"]!.id, direction: "ascending" }],
  }).length, 4);

  // two-level sort
  mk("e", 5, hi.id, d(1));
  const twoLevel = titles({
    sort: [
      { prop: t.P["Priority"]!.id, direction: "ascending" },
      { prop: t.P["Name"]!.id, direction: "descending" },
    ],
  });
  eq("two-level sort is stable and ordered", twoLevel.filter((x) => x === "d" || x === "e"), ["e", "d"]);

  // paging
  const all = titles(defaultViewSpec());
  const page1 = queryRows(db, t.databaseId, { ...defaultViewSpec() }, { limit: 2, offset: 0 });
  const page2 = queryRows(db, t.databaseId, { ...defaultViewSpec() }, { limit: 2, offset: 2 });
  eq("limit respected", page1.rows.length, 2);
  eq("pages do not overlap", [...page1.rows.map((r) => r.title), ...page2.rows.map((r) => r.title)].length, 4);
  eq("total is unaffected by limit", page1.total, all.length);
}

section("Aggregations (column footers)");
{
  const { db, ws, page } = freshDb();
  const t = makeTasks(db, ws, page);
  const P = t.P;

  createRow(db, t.databaseId, { [P["Priority"]!.id]: 10, [P["Done"]!.id]: true });
  createRow(db, t.databaseId, { [P["Priority"]!.id]: 20, [P["Done"]!.id]: false });
  createRow(db, t.databaseId, { [P["Priority"]!.id]: 30, [P["Done"]!.id]: true });
  createRow(db, t.databaseId, { [P["Priority"]!.id]: 40, [P["Done"]!.id]: true });

  eq("sum", aggregate(db, t.databaseId, P["Priority"]!.id, "sum"), 100);
  eq("avg", aggregate(db, t.databaseId, P["Priority"]!.id, "avg"), 25);
  eq("min", aggregate(db, t.databaseId, P["Priority"]!.id, "min"), 10);
  eq("max", aggregate(db, t.databaseId, P["Priority"]!.id, "max"), 40);
  eq("range", aggregate(db, t.databaseId, P["Priority"]!.id, "range"), 30);
  eq("median (even count)", aggregate(db, t.databaseId, P["Priority"]!.id, "median"), 25);
  eq("count", aggregate(db, t.databaseId, P["Priority"]!.id, "count"), 4);
  eq("countAll", aggregate(db, t.databaseId, P["Done"]!.id, "countAll"), 4);
  eq("countChecked", aggregate(db, t.databaseId, P["Done"]!.id, "countChecked"), 3);
  eq("percentChecked", aggregate(db, t.databaseId, P["Done"]!.id, "percentChecked"), 75);

  // aggregation honours the active filter
  const filtered: ViewSpec = {
    ...defaultViewSpec(),
    filter: { and: true, rules: [{ prop: P["Done"]!.id, operator: "checked" }] },
  };
  eq("sum under a filter", aggregate(db, t.databaseId, P["Priority"]!.id, "sum", filtered), 80);
  eq("countAll under a filter", aggregate(db, t.databaseId, P["Priority"]!.id, "countAll", filtered), 3);

  createRow(db, t.databaseId, { [P["Priority"]!.id]: 10 });
  eq("countUnique", aggregate(db, t.databaseId, P["Priority"]!.id, "countUnique"), 4);
}

section("Grouping (board + calendar)");
{
  const { db, ws, page } = freshDb();
  const t = makeTasks(db, ws, page);
  const P = t.P;

  const urgent = addSelectOption(db, P["Tag"]!.id, "Urgent", "red");
  const done = addSelectOption(db, P["Tag"]!.id, "Done", "green");

  createRow(db, t.databaseId, { [P["Name"]!.id]: "a", [P["Tag"]!.id]: [urgent.id] });
  createRow(db, t.databaseId, { [P["Name"]!.id]: "b", [P["Tag"]!.id]: [urgent.id] });
  createRow(db, t.databaseId, { [P["Name"]!.id]: "c", [P["Tag"]!.id]: [done.id] });
  createRow(db, t.databaseId, { [P["Name"]!.id]: "d" });

  const buckets = groupRows(db, t.databaseId, listRows(db, t.databaseId), P["Tag"]!.id);
  eq("three buckets", buckets.length, 3);
  const byLabel = Object.fromEntries(buckets.map((b) => [b.label, b.rows.map((r) => r.title).sort()]));
  eq("Urgent bucket", byLabel["Urgent"], ["a", "b"]);
  eq("Done bucket", byLabel["Done"], ["c"]);
  eq("Empty bucket", byLabel["Empty"], ["d"]);
  eq("bucket carries the option colour", buckets.find((b) => b.label === "Urgent")?.color, "red");

  // status buckets follow Notion's canonical group order, not insertion order
  const statusGroups = (P["State"]!.config as { groups: { id: string; options: { id: string }[] }[] }).groups;
  createRow(db, t.databaseId, { [P["Name"]!.id]: "s1", [P["State"]!.id]: [statusGroups[2]!.options[0]!.id] });
  createRow(db, t.databaseId, { [P["Name"]!.id]: "s2", [P["State"]!.id]: [statusGroups[0]!.options[0]!.id] });
  createRow(db, t.databaseId, { [P["Name"]!.id]: "s3", [P["State"]!.id]: [statusGroups[1]!.options[0]!.id] });
  const statusBuckets = groupRows(db, t.databaseId, listRows(db, t.databaseId), P["State"]!.id);
  eq("status groups ordered to-do → in_progress → complete, ungrouped last",
    statusBuckets.map((b) => b.label), ["To-do", "In Progress", "Complete", "Empty"]);

  // calendar buckets by month
  createRow(db, t.databaseId, { [P["Name"]!.id]: "jan", [P["Due"]!.id]: { start: Date.UTC(2026, 0, 5), end: null, allDay: true } });
  createRow(db, t.databaseId, { [P["Name"]!.id]: "feb", [P["Due"]!.id]: { start: Date.UTC(2026, 1, 9), end: null, allDay: true } });
  const monthBuckets = groupRows(db, t.databaseId, listRows(db, t.databaseId), P["Due"]!.id);
  ok("calendar groups by month", monthBuckets.some((b) => b.key === "2026-01"));
  ok("calendar has a No-date bucket", monthBuckets.some((b) => b.key === "__empty"));

  // sub-grouping (board sub-group)
  const sub = groupRows(db, t.databaseId, listRows(db, t.databaseId), P["Tag"]!.id, P["State"]!.id);
  ok("sub-group argument does not break top-level grouping", sub.length >= 3);
}

section("Relations");
{
  const { db, ws, page } = freshDb();
  const projects = createDatabase(db, {
    ws, parent_id: page, parent_kind: "node", title: "Projects",
    properties: [{ name: "Name", type: "title" }],
  });
  const tasks = makeTasks(db, ws, page);

  const rel = createRelation(db, tasks.databaseId, projects.databaseId, "Project", "Tasks", {
    bidirectional: true,
  });

  const proj = createRow(db, projects.databaseId, { [projects.properties[0]!.id]: "Aurora" });
  const task1 = createRow(db, tasks.databaseId, { [tasks.P["Name"]!.id]: "t1" });
  const task2 = createRow(db, tasks.databaseId, { [tasks.P["Name"]!.id]: "t2" });

  setPropertyValue(db, task1, rel.source.id, { rows: [proj] });
  setPropertyValue(db, task2, rel.source.id, { rows: [proj] });

  eq("forward relation reads back", (getRow(db, task1)!.values[rel.source.id] as { rows: string[] }).rows, [proj]);

  const mirrored = getRow(db, proj)!.values[rel.mirror.id] as { rows: string[] };
  eq("mirrored relation shows both tasks", mirrored.rows.sort(), [task1, task2].sort());

  eq("relation_edge rows exist", db.scalar<number>(
    "SELECT count(*) c FROM relation_edge WHERE prop_id = ?", rel.source.id,
  ), 2);

  const bl = db.all<{ src: string }>(
    "SELECT src FROM backlink WHERE dst = ? AND kind = 'relation'", proj,
  );
  eq("relations create backlinks on the target", bl.map((b) => b.src).sort(), [task1, task2].sort());

  // clearing the relation removes edges
  setPropertyValue(db, task1, rel.source.id, { rows: [] });
  eq("cleared relation has no rows", (getRow(db, task1)!.values[rel.source.id] as { rows: string[] }).rows, []);
  eq("cleared relation removes edges", db.scalar<number>(
    "SELECT count(*) c FROM relation_edge WHERE prop_id = ? AND from_row = ?", rel.source.id, task1,
  ), 0);
  eq("mirror drops the cleared task",
    (getRow(db, proj)!.values[rel.mirror.id] as { rows: string[] }).rows, [task2]);

  // filtering by relation
  const filtered = queryRows(db, tasks.databaseId, {
    ...defaultViewSpec(),
    filter: { and: true, rules: [{ prop: rel.source.id, operator: "contains", value: { rows: [proj] } }] },
  }).rows.map((r) => r.title);
  eq("filter by relation", filtered, ["t2"]);

  // self relation
  const selfRel = createRelation(db, tasks.databaseId, tasks.databaseId, "Blocks", "Blocked by");
  setPropertyValue(db, task2, selfRel.source.id, { rows: [task1] });
  eq("self relation works", (getRow(db, task2)!.values[selfRel.source.id] as { rows: string[] }).rows, [task1]);

  // deleting a target row must not leave dangling edges
  db.run("DELETE FROM node WHERE id = ?", proj);
  eq("edges cascade with the target row", db.scalar<number>(
    "SELECT count(*) c FROM relation_edge WHERE to_row = ?", proj,
  ), 0);
}

section("Select option lifecycle");
{
  const { db, ws, page } = freshDb();
  const t = makeTasks(db, ws, page);
  const P = t.P;

  const a = addSelectOption(db, P["Tag"]!.id, "Urgent", "red");
  const b = addSelectOption(db, P["Tag"]!.id, "Low", "blue");
  eq("options are stored on the property", optionsOf(getPropertyById(db, P["Tag"]!.id)).map((o) => o.name), ["Urgent", "Low"]);

  const row = createRow(db, t.databaseId, { [P["Tag"]!.id]: [a.id] });
  eq("row references the option id", (getRow(db, row)!.values[P["Tag"]!.id] as string[]), [a.id]);

  renameSelectOption(db, P["Tag"]!.id, a.id, { name: "Critical", color: "orange" });
  eq("rename keeps the id stable", (getRow(db, row)!.values[P["Tag"]!.id] as string[]), [a.id]);
  eq("rename updates the label", optionsOf(getPropertyById(db, P["Tag"]!.id)).find((o) => o.id === a.id)?.name, "Critical");

  removeSelectOption(db, P["Tag"]!.id, a.id);
  eq("removed option is gone from the schema", optionsOf(getPropertyById(db, P["Tag"]!.id)).map((o) => o.id), [b.id]);
  eq("removed option is cleared from rows", (getRow(db, row)!.values[P["Tag"]!.id] as string[]), []);
}

section("Property lifecycle");
{
  const { db, ws, page } = freshDb();
  const t = makeTasks(db, ws, page);

  renameProperty(db, t.P["Notes"]!.id, "Description");
  eq("rename", listProperties(db, t.databaseId).find((p) => p.id === t.P["Notes"]!.id)?.name, "Description");

  changePropertyType(db, t.P["Notes"]!.id, "number");
  eq("type change", listProperties(db, t.databaseId).find((p) => p.id === t.P["Notes"]!.id)?.type, "number");

  const extra = addProperty(db, t.databaseId, "Extra", "text");
  deleteProperty(db, extra.id);
  eq("delete removes the definition", db.scalar<number>(
    "SELECT count(*) c FROM property_def WHERE id = ?", extra.id,
  ), 0);

  let threw = false;
  try {
    deleteProperty(db, t.P["Name"]!.id);
  } catch {
    threw = true;
  }
  ok("the only Title property cannot be deleted", threw);
}

function getPropertyById(db: Db, id: string): PropertyDef {
  const r = db.get<Record<string, unknown>>(
    "SELECT id, db_id, name, type, pos, config FROM property_def WHERE id = ?", id,
  )!;
  return {
    id: r["id"] as string,
    db_id: r["db_id"] as string,
    name: r["name"] as string,
    type: r["type"] as PropertyDef["type"],
    pos: r["pos"] as string,
    config: JSON.parse(r["config"] as string),
  };
}

section("View specs persist");
{
  const { db, ws, page } = freshDb();
  const t = makeTasks(db, ws, page);
  const view = t.views[0]!;

  const spec: ViewSpec = {
    ...defaultViewSpec(),
    filter: { and: true, rules: [{ prop: t.P["Priority"]!.id, operator: "greaterThan", value: 2 }] },
    sort: [{ prop: t.P["Priority"]!.id, direction: "descending" }],
    hidden: [t.P["Notes"]!.id],
    aggregates: { [t.P["Priority"]!.id]: "sum" },
  };
  db.run("UPDATE view SET spec = ? WHERE id = ?", JSON.stringify(spec), view.id);

  const reloaded = listViews(db, t.databaseId)[0]!;
  eq("spec survives a round-trip", reloaded.spec.sort, spec.sort);
  eq("filter survives", reloaded.spec.filter.rules.length, 1);
  eq("hidden survives", reloaded.spec.hidden, [t.P["Notes"]!.id]);
  eq("aggregates survive", reloaded.spec.aggregates, { [t.P["Priority"]!.id]: "sum" });

  // the same filter definition drives every view identically
  createRow(db, t.databaseId, { [t.P["Name"]!.id]: "hi", [t.P["Priority"]!.id]: 9 });
  createRow(db, t.databaseId, { [t.P["Name"]!.id]: "lo", [t.P["Priority"]!.id]: 1 });
  for (const v of listViews(db, t.databaseId)) {
    const result = queryRows(db, t.databaseId, reloaded.spec);
    eq(`view '${v.type}' sees the same filtered rows`, result.rows.map((r) => r.title), ["hi"]);
  }
}

section("Applying a template clones its database");
{
  const { saveTemplate, applyTemplate } = await import("../server/library.ts");
  const { db, ws, page } = freshDb();
  const t = makeTasks(db, ws, page);
  createRow(db, t.databaseId, { [t.P["Name"]!.id]: "Alpha", [t.P["Priority"]!.id]: 3 });
  createRow(db, t.databaseId, { [t.P["Name"]!.id]: "Beta", [t.P["Priority"]!.id]: 1 });

  const tpl = saveTemplate(db, ws, "Tasks template", page, "page");
  const tplId = (tpl as { id: string }).id;
  ok("template saved", !!tplId);

  const a = applyTemplate(db, tplId, ws, null, "Tracker A");
  const b = applyTemplate(db, tplId, ws, null, "Tracker B");
  ok("both applies returned a page", !!a && !!b);

  const dbIdsUnder = (root: string): string[] =>
    db
      .all<{ props: string }>(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM node WHERE id = ?
           UNION ALL
           SELECT n.id FROM node n JOIN tree tr ON n.parent_id = tr.id
         )
         SELECT props FROM node WHERE type = 'child_database' AND id IN (SELECT id FROM tree)`,
        root,
      )
      .map((r) => (JSON.parse(r.props) as { databaseId?: string }).databaseId)
      .filter((x): x is string => !!x);

  const aDbs = dbIdsUnder(a!);
  const bDbs = dbIdsUnder(b!);

  eq("page A carries one database", aDbs.length, 1);
  eq("page B carries one database", bDbs.length, 1);
  ok("A and B are different databases", aDbs[0] !== bDbs[0]);
  ok("the template's own database is not reused", aDbs[0] !== t.databaseId);

  eq("clone keeps the property count", listProperties(db, aDbs[0]!).length, listProperties(db, t.databaseId).length);
  eq("clone keeps the view count", listViews(db, aDbs[0]!).length, listViews(db, t.databaseId).length);
  eq("clone keeps the rows", listRows(db, aDbs[0]!).length, listRows(db, t.databaseId).length);

  // independence: writing to A must not move B
  const namePropA = listProperties(db, aDbs[0]!).find((p) => p.type === "title")!;
  const rowsA = listRows(db, aDbs[0]!);
  setPropertyValue(db, rowsA[0]!.node.id, namePropA.id, "Renamed in A");
  const rowsB = listRows(db, bDbs[0]!);
  ok(
    "editing A leaves B untouched",
    listRows(db, aDbs[0]!).some((r) => r.title === "Renamed in A") &&
      !listRows(db, bDbs[0]!).some((r) => r.title === "Renamed in A"),
  );
  void rowsB;

  // refs inside computed properties are rewritten to the clone's own ids
  const origFormula = listProperties(db, t.databaseId).find((p) => p.type === "formula");
  if (origFormula) {
    const cloneFormula = listProperties(db, aDbs[0]!).find((p) => p.name === origFormula.name);
    const serialized = JSON.stringify(cloneFormula?.config ?? {});
    const origIds = listProperties(db, t.databaseId).map((p) => p.id);
    ok(
      "formula refs point at cloned properties, not the template's",
      !origIds.some((id) => serialized.includes(id)),
      serialized.slice(0, 120),
    );
  }

  // view specs are rewritten too
  const cloneView = listViews(db, aDbs[0]!)[0]!;
  const origView = listViews(db, t.databaseId)[0]!;
  const origPropIds = listProperties(db, t.databaseId).map((p) => p.id);
  const specJson = JSON.stringify(cloneView.spec);
  ok(
    "view spec references cloned properties",
    !origPropIds.some((id) => specJson.includes(id)),
    specJson.slice(0, 120),
  );
  void origView;
}

// ─────────────────────────────────────────────────────────────────────────────

for (const db of openDbs) db.close();
console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
