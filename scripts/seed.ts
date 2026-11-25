/**
 * Seed a demo workspace: nested pages, every block type, two related databases
 * (Tasks + Projects) with formula, rollup, status, dates, board and calendar
 * views, and cross-page links that light up backlinks.
 *
 * Run: npm run seed
 */

import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openWorkspace } from "../server/db.ts";
import { createNode, updateNode } from "../server/ops.ts";
import { createPage, setPageMeta } from "../server/library.ts";
import {
  addProperty,
  addSelectOption,
  createDatabase,
  createRelation,
  createRow,
  createView,
  listProperties,
  recomputeRow,
  updateViewSpec,
} from "../server/databases.ts";
import { plainTextToBody, type Body, type PropertyDef, type SelectOption } from "../shared/types.ts";

const ROOT = process.argv[2] ?? join(import.meta.dirname!, "..", ".data", "workspace");
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });

const { db } = openWorkspace(ROOT);
const ws = "ws-demo";
db.run("INSERT INTO workspace (id, name, created_at) VALUES (?, ?, ?)", ws, "Devotion", Date.now());

type StylePart = string | [string, Record<string, unknown>?] | Record<string, unknown>;

const rich = (parts: StylePart[]): Body =>
  parts.map((part) => {
    if (typeof part === "string") return { type: "text", text: part, styles: {} };
    if (Array.isArray(part)) return { type: "text", text: part[0], styles: part[1] ?? {} };
    return part as unknown as Body[number];
  });

const DAY = 86_400_000;
const day = (offset: number): number => Date.now() + offset * DAY;

// ── pages ────────────────────────────────────────────────────────────────────

const home = createPage(db, ws, null, "Getting started", "🚀");
setPageMeta(db, home, { pageWidth: "default" });

const block = (parentId: string, type: string, body: Body | null, props: Record<string, unknown> = {}): string =>
  createNode(db, {
    ws,
    kind: "block",
    type: type as never,
    parent_id: parentId,
    parent_kind: "node",
    body,
    props,
  });

block(home, "heading_1", plainTextToBody("Welcome to Devotion"));
block(
  home,
  "callout",
  rich([
    ["Everything here is a block. ", {}],
    ["Select text", { bold: true }],
    ", drag the handle on the left, or type ",
    ["/", { code: true }],
    [" for a new block type.", {}],
  ]),
  { icon: "👋", color: "blue_background" },
);
block(home, "paragraph", plainTextToBody("One page, one node tree: every block below is a row in SQLite, every row in the databases is a page you can write in, and the sidebar, breadcrumbs, undo history and search all read the same table."));

block(home, "heading_2", plainTextToBody("Text blocks"));
block(home, "paragraph", rich([["Inline styles: ", {}], ["bold", { bold: true }], [", ", {}], ["italic", { italic: true }], [", ", {}], ["underline", { underline: true }], [", ", {}], ["strike", { strike: true }], [", ", {}], ["code", { code: true }], [", ", {}], ["colored", { color: "red" }], [", ", {}], ["highlighted", { backgroundColor: "yellow_background" }], [".", {}]]));
block(home, "heading_3", plainTextToBody("Heading level 3"));
block(home, "bulleted_list_item", plainTextToBody("Bulleted list item"));
const nestedBullet = block(home, "bulleted_list_item", plainTextToBody("…with a nested child"));
block(nestedBullet, "bulleted_list_item", plainTextToBody("Nesting works to any depth"));
block(home, "numbered_list_item", plainTextToBody("Numbered lists compute their ordinal at render time, so inserting never renumbers siblings."));
block(home, "to_do", plainTextToBody("Ship the block editor"), { checked: true });
block(home, "to_do", plainTextToBody("Build the relational database layer"), { checked: true });
block(home, "to_do", plainTextToBody("Wire local AI through the provider adapter"), { checked: false });
const toggle = block(home, "toggle", plainTextToBody("Toggle — click to expand"));
block(toggle, "paragraph", plainTextToBody("Collapsed content lives in child blocks, not a special field."));
block(toggle, "quote", plainTextToBody("A quote inside a toggle, because it is just a block."));
block(home, "quote", plainTextToBody("A blockquote."));
block(home, "divider", null);

block(home, "heading_2", plainTextToBody("Technical blocks"));
block(home, "code", plainTextToBody(`-- one query per view, all views share the filter
SELECT n.id FROM node n
 WHERE n.parent_id = :host
   AND n.deleted_at IS NULL
 ORDER BY n.pos;`), { language: "sql" });
block(home, "latex", null, { latex: "V_{out} = V_{in} \\cdot \\frac{R_2}{R_1 + R_2}" });
block(home, "bookmark", null, { url: "https://blocknotejs.org/docs", caption: "BlockNote docs — the editor under this one" });

// ── layout: table of contents + columns ──────────────────────────────────────

block(home, "heading_2", plainTextToBody("Layout blocks"));
block(home, "toc", null, { levels: [1, 2, 3] });

const cols = block(home, "column_list", null, {});
const colA = block(cols, "column", null, { ratio: 55 });
const colB = block(cols, "column", null, { ratio: 45 });
block(colA, "heading_3", plainTextToBody("Two columns, side by side"));
block(
  colA,
  "paragraph",
  plainTextToBody("Drag the divider between them. Each width is stored on the column node, so the layout survives a reload, an undo, and an export."),
);
block(colB, "heading_3", plainTextToBody("Why it is cheap to support"));
block(colB, "bulleted_list_item", plainTextToBody("A column is a node with children."));
block(colB, "bulleted_list_item", plainTextToBody("So is a page. Same tree, same op log, same undo."));
block(home, "divider", null);

// ── databases ────────────────────────────────────────────────────────────────

const projects = createDatabase(db, {
  ws,
  parent_id: home,
  parent_kind: "node",
  title: "Projects",
  properties: [
    { name: "Name", type: "title" },
    { name: "Health", type: "select" },
    { name: "Owner", type: "text" },
  ],
});
const projProps = Object.fromEntries(listProperties(db, projects.databaseId).map((p) => [p.name, p]));
const healthy = addSelectOption(db, projProps["Health"]!.id, "Healthy", "green");
const atRisk = addSelectOption(db, projProps["Health"]!.id, "At risk", "orange");

const aurora = createRow(db, projects.databaseId, {
  [projProps["Name"]!.id]: "Aurora",
  [projProps["Health"]!.id]: [healthy.id],
  [projProps["Owner"]!.id]: "Ana",
});
const borealis = createRow(db, projects.databaseId, {
  [projProps["Name"]!.id]: "Borealis",
  [projProps["Health"]!.id]: [atRisk.id],
  [projProps["Owner"]!.id]: "Rui",
});

const tasks = createDatabase(db, {
  ws,
  parent_id: home,
  parent_kind: "node",
  title: "Tasks",
  properties: [
    { name: "Name", type: "title" },
    { name: "Priority", type: "number" },
    { name: "Done", type: "checkbox" },
    { name: "State", type: "status" },
    { name: "Tags", type: "multi_select" },
    { name: "Due", type: "date" },
    { name: "Estimate", type: "number", config: { format: "number", precision: 1 } },
    { name: "Notes", type: "text" },
    { name: "Ref", type: "unique_id", config: { prefix: "TSK", next: 1 } },
  ],
  views: [{ name: "Table", type: "table" }],
});

const P: Record<string, PropertyDef> = Object.fromEntries(
  listProperties(db, tasks.databaseId).map((p) => [p.name, p]),
);

const frontend = addSelectOption(db, P["Tags"]!.id, "frontend", "blue");
const backend = addSelectOption(db, P["Tags"]!.id, "backend", "purple");
const infra = addSelectOption(db, P["Tags"]!.id, "infra", "orange");

const statusGroups = (P["State"]!.config as { groups: { id: string; options: { id: string }[] }[] }).groups;
const sTodo = statusGroups[0]!.options[0]!.id;
const sDoing = statusGroups[1]!.options[0]!.id;
const sDone = statusGroups[2]!.options[0]!.id;

// relation Tasks → Projects, mirrored
const rel = createRelation(db, tasks.databaseId, projects.databaseId, "Project", "Tasks", {
  bidirectional: true,
});

const taskSeed: [
  string,
  number,
  boolean,
  string,
  SelectOption[],
  number,
  number,
  string,
  string,
][] = [
  ["Block drag-and-drop", 1, true, sDone, [frontend], 3, -2, "Fractional index writes one row", aurora],
  ["Nested page tree", 1, true, sDone, [frontend], 2, -5, "Recursive CTE for breadcrumbs", aurora],
  ["Property typed columns", 2, true, sDone, [backend], 5, -1, "filter/sort compile to SQL", aurora],
  ["Board view", 2, false, sDoing, [frontend], 4, 1, "Group by select/status", aurora],
  ["Formula engine", 3, false, sDoing, [backend], 8, 3, "Hand-written parser, no eval", aurora],
  ["Provider adapters", 3, false, sTodo, [backend, infra], 6, 5, "Ollama, LM Studio, Strata", aurora],
  ["Markdown import", 4, false, sTodo, [backend], 4, 8, "Round-trip against Notion export", borealis],
  ["Version history", 4, false, sTodo, [infra], 6, 12, "Snapshots from the op log", borealis],
  ["Offline PWA shell", 5, false, sTodo, [infra], 3, 15, "Service worker + local server", borealis],
];

const taskIds: string[] = [];
for (const [name, pri, done, state, tags, est, dueOffset, notes, project] of taskSeed) {
  const id = createRow(db, tasks.databaseId, {
    [P["Name"]!.id]: name,
    [P["Priority"]!.id]: pri,
    [P["Done"]!.id]: done,
    [P["State"]!.id]: [state],
    [P["Tags"]!.id]: tags.map((t) => t.id),
    [P["Due"]!.id]: { start: day(dueOffset), end: null, allDay: true },
    [P["Estimate"]!.id]: est,
    [P["Notes"]!.id]: notes,
    [rel.source.id]: { rows: [project] },
  });
  taskIds.push(id);
}

// each row is a page: give a couple of them nested content
block(taskIds[0]!, "heading_2", plainTextToBody("Implementation notes"));
block(taskIds[0]!, "paragraph", plainTextToBody("Drag writes a single row: the new position is a fractional index between its neighbours."));
block(taskIds[4]!, "paragraph", plainTextToBody("Formula source parses to an AST and is cached in property_value, so filters can sort on it."));

// computed properties
const progress = addProperty(db, tasks.databaseId, "Progress", "formula", {
  source: 'if(Done, 100, 0)',
});
const label = addProperty(db, tasks.databaseId, "Summary", "formula", {
  source: 'concat(Name, " · P", toNumber(Priority))',
});
void progress;
void label;

const rollupProp = addProperty(db, projects.databaseId, "Task count", "rollup", {
  relationProp: rel.mirror.id,
  targetProp: P["Done"]!.id,
  function: "countAll",
});
void rollupProp;

// views
const board = createView(db, tasks.databaseId, "Board", "board", 1);
updateViewSpec(db, board.id, {
  ...updateSpecBase(),
  group: [{ prop: P["State"]!.id }],
  sort: [{ prop: P["Priority"]!.id, direction: "ascending" }],
});

const calendar = createView(db, tasks.databaseId, "Calendar", "calendar", 2);
updateViewSpec(db, calendar.id, {
  ...updateSpecBase(),
  calendarBy: P["Due"]!.id,
  hidden: [P["Notes"]!.id],
});

const gallery = createView(db, tasks.databaseId, "Gallery", "gallery", 3);
updateViewSpec(db, gallery.id, {
  ...updateSpecBase(),
  card: { size: "medium", properties: [P["State"]!.id, P["Priority"]!.id] },
});

// Timeline and Chart ship configured, so a first-time reader sees the eight
// views working instead of two empty configuration prompts.
const timeline = createView(db, tasks.databaseId, "Timeline", "timeline", 4);
updateViewSpec(db, timeline.id, {
  ...updateSpecBase(),
  // `timelineBy` is a pair, not a single id: a task has a start and an end.
  timelineBy: { start: P["Due"]!.id, end: null },
  scale: "month",
});

const chart = createView(db, tasks.databaseId, "Chart", "chart", 5);
updateViewSpec(db, chart.id, {
  ...updateSpecBase(),
  chart: { kind: "bar", x: P["State"]!.id, y: P["Priority"]!.id, agg: "sum" },
});

function updateSpecBase() {
  return {
    filter: { and: true, rules: [] },
    sort: [],
    group: [],
    hidden: [],
    aggregates: { [P["Done"]!.id]: "percentChecked" as const, [P["Estimate"]!.id]: "sum" as const },
    rowColors: [],
    card: { size: "medium" as const, properties: [] },
  };
}

// evaluate the computed properties we just defined
for (const id of taskIds) recomputeRow(db, id);
for (const id of [aurora, borealis]) recomputeRow(db, id);

const counts = {
  nodes: db.scalar<number>("SELECT count(*) FROM node"),
  rows: db.scalar<number>("SELECT count(*) FROM node WHERE kind='row'"),
  dbs: db.scalar<number>("SELECT count(*) FROM database_obj"),
  backlinks: db.scalar<number>("SELECT count(*) FROM backlink"),
  searchDocs: db.scalar<number>("SELECT count(*) FROM search_doc"),
};

console.log(`\n  Seeded workspace at ${ROOT}`);
console.log(`  pages+blocks: ${counts.nodes} · rows: ${counts.rows} · databases: ${counts.dbs}`);
console.log(`  backlinks: ${counts.backlinks} · indexed docs: ${counts.searchDocs}\n`);

db.close();
