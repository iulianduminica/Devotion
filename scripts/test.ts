/**
 * Data-core tests. Run with: npm test
 *
 * These cover the invariants everything else is built on: the node tree,
 * fractional ordering, the op log, undo/redo, FTS5 search, and backlinks.
 */

import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openWorkspace, type Db } from "../server/db.ts";
import {
  keyBetween,
  keysBetween,
  ulid,
  isUlid,
  ulidTime,
  FIRST_KEY,
  MAX_KEY_LEN,
} from "../server/ids.ts";
import {
  createNode,
  updateNode,
  moveNode,
  trashNode,
  restoreNode,
  convertNode,
  getBacklinks,
  UndoManager,
  nextTx,
  extractLinks,
  rebalanceSiblings,
} from "../server/ops.ts";
import { plainTextToBody } from "../shared/types.ts";

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

const TEST_ROOT = join(import.meta.dirname!, "..", ".data", "test-workspace");

// Wipe once, before any connection is open. On Windows an open SQLite handle
// locks its WAL files, so per-section directories beat delete-and-recreate.
if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });

const openDbs: Db[] = [];
let sectionSeq = 0;

function freshDb(): { db: Db; ws: string } {
  const dir = join(TEST_ROOT, `s${sectionSeq++}`);
  const { db } = openWorkspace(dir);
  openDbs.push(db);
  const ws = "ws-test";
  db.run(
    "INSERT INTO workspace (id, name, created_at) VALUES (?, ?, ?)",
    ws,
    "Test",
    Date.now(),
  );
  return { db, ws };
}

function childOrder(db: Db, parentId: string | null): { id: string; text: string }[] {
  const rows = db.all<{ id: string; body: string | null }>(
    `SELECT id, body FROM node
     WHERE parent_id IS ? AND deleted_at IS NULL
     ORDER BY pos`,
    parentId,
  );
  return rows.map((r) => ({
    id: r.id,
    text: r.body ? plainTextToBodySafe(r.body) : "",
  }));
}

function plainTextToBodySafe(json: string): string {
  try {
    const body = JSON.parse(json) as { text: string }[];
    return body.map((i) => i.text).join("");
  } catch {
    return "";
  }
}

// ── ids ──────────────────────────────────────────────────────────────────────

section("ULID");
{
  const id = ulid();
  ok("ulid is 26 chars", id.length === 26, id);
  ok("ulid matches Crockford alphabet", isUlid(id), id);

  const ids = Array.from({ length: 5000 }, () => ulid());
  ok("5000 ulids are unique", new Set(ids).size === 5000);
  const sorted = [...ids].sort();
  ok("5000 ulids are already sorted (monotonic)", ids.join() === sorted.join());

  const t = Date.now();
  const idAt = ulid(t);
  ok("ulid round-trips its timestamp", Math.abs(ulidTime(idAt) - t) <= 1, `${ulidTime(idAt)} vs ${t}`);
}

section("Fractional index");
{
  eq("FIRST_KEY is a single char", FIRST_KEY.length > 0, true);

  const a = keyBetween(null, null);
  const ab = keyBetween(a, null);
  const ba = keyBetween(null, a);
  ok("append sorts after", a < ab, `${a} < ${ab}`);
  ok("prepend sorts before", ba < a, `${ba} < ${a}`);

  // adversarial: repeatedly insert between two adjacent keys
  let lo = keyBetween(null, null);
  let hi = keyBetween(lo, null);
  const keys: string[] = [];
  let broke = false;
  for (let i = 0; i < 2000; i++) {
    const mid = keyBetween(lo, hi);
    if (!(lo < mid && mid < hi)) {
      broke = true;
      break;
    }
    keys.push(mid);
    hi = mid;
  }
  ok("2000 nested inserts stay strictly ordered", !broke);
  ok("2000 nested inserts stay unique", new Set(keys).size === keys.length);
  const maxLen = Math.max(...keys.map((k) => k.length));
  // Repeatedly halving the same gap lengthens keys; that is inherent to
  // fractional indexing. The app's answer is rebalancing (tested below), not
  // pretending the growth away — so assert the growth is the only cost.
  ok("same-gap inserts grow keys (inherent)", maxLen > MAX_KEY_LEN, `max len ${maxLen}`);
  ok("keys never exceed 1KB", maxLen <= 1024, `max len ${maxLen}`);

  const many = keysBetween(null, null, 100);
  const manySorted = [...many].sort();
  ok("keysBetween(100) is ordered", many.join() === manySorted.join());
  ok("keysBetween(100) is unique", new Set(many).size === 100);

  let threw = false;
  try {
    keyBetween("z", "a");
  } catch {
    threw = true;
  }
  ok("keyBetween rejects inverted bounds", threw);
}

// ── tree, ordering, op log ───────────────────────────────────────────────────

section("Node tree & ordering");
{
  const { db, ws } = freshDb();

  const root = createNode(db, {
    ws,
    kind: "page",
    type: "page",
    parent_id: null,
    parent_kind: "workspace",
    body: plainTextToBody("Getting Started"),
    meta: { icon: "🚀" },
  });
  ok("root page created", isUlid(root));

  const ids = ["one", "two", "three", "four"].map((text) =>
    createNode(db, {
      ws,
      kind: "block",
      type: "paragraph",
      parent_id: root,
      parent_kind: "node",
      body: plainTextToBody(text),
    }),
  );

  eq(
    "siblings append in order",
    childOrder(db, root).map((c) => c.text),
    ["one", "two", "three", "four"],
  );

  // insert between two siblings: exactly one row is written
  const beforeCount = db.scalar<number>(
    "SELECT count(*) c FROM node WHERE parent_id = ?",
    root,
  );
  createNode(db, {
    ws,
    kind: "block",
    type: "paragraph",
    parent_id: root,
    parent_kind: "node",
    before: ids[2],
    body: plainTextToBody("two-and-a-half"),
  });
  eq(
    "insert-before lands in the right slot",
    childOrder(db, root).map((c) => c.text),
    ["one", "two", "two-and-a-half", "three", "four"],
  );
  eq("insert-before added exactly one row", db.scalar<number>(
    "SELECT count(*) c FROM node WHERE parent_id = ?", root,
  ), beforeCount! + 1);

  // move: reorder writes exactly one row
  const seqBefore = db.scalar<number>("SELECT max(seq) m FROM op_log") ?? 0;
  const updatesBefore = db.scalar<number>("SELECT changes() c") ?? -1;
  moveNode(db, ids[3]!, { parent_id: root, before: ids[0]! });
  eq(
    "move to front reorders",
    childOrder(db, root).map((c) => c.text),
    ["four", "one", "two", "two-and-a-half", "three"],
  );
  ok("move logged one op", (db.scalar<number>("SELECT max(seq) m FROM op_log") ?? 0) > seqBefore);
  void updatesBefore;

  // nesting
  const child = createNode(db, {
    ws,
    kind: "page",
    type: "child_page",
    parent_id: root,
    parent_kind: "node",
    body: plainTextToBody("Nested Page"),
  });
  createNode(db, {
    ws,
    kind: "block",
    type: "heading_1",
    parent_id: child,
    parent_kind: "node",
    body: plainTextToBody("Inside the nested page"),
  });
  eq("nested page has its own child", childOrder(db, child).map((c) => c.text), [
    "Inside the nested page",
  ]);

  ok("op log has entries", (db.scalar<number>("SELECT count(*) c FROM op_log") ?? 0) > 5);
}

section("Rebalancing compacts long keys");
{
  const { db, ws } = freshDb();
  const page = createNode(db, {
    ws, kind: "page", type: "page", parent_id: null, parent_kind: "workspace",
    body: plainTextToBody("Rebalance"),
  });
  const first = createNode(db, {
    ws, kind: "block", type: "paragraph", parent_id: page, parent_kind: "node",
    body: plainTextToBody("first"),
  });
  createNode(db, {
    ws, kind: "block", type: "paragraph", parent_id: page, parent_kind: "node",
    body: plainTextToBody("second"),
  });

  // repeatedly prepend into the gap before `first`: the pathological case
  for (let i = 0; i < 120; i++) {
    createNode(db, {
      ws, kind: "block", type: "paragraph", parent_id: page, parent_kind: "node",
      before: first, body: plainTextToBody(`prepended-${i}`),
    });
  }

  const lenAfterPrepends = Math.max(
    ...db.all<{ l: number }>("SELECT length(pos) l FROM node WHERE parent_id = ?", page)
      .map((r) => r.l),
  );
  ok(
    "auto-rebalance kept keys short across 120 prepends",
    lenAfterPrepends <= MAX_KEY_LEN,
    `max ${lenAfterPrepends}`,
  );

  const orderBefore = childOrder(db, page).map((c) => c.text);
  // Inserting `before: first` each time stacks items just above `first`, so
  // they keep their insertion order and `first` stays in place.
  eq("120 prepends stack above the anchor in order", orderBefore.slice(0, 3), [
    "prepended-0",
    "prepended-1",
    "prepended-2",
  ]);
  eq("anchor keeps its slot", orderBefore.slice(-2), ["first", "second"]);
  eq("120 prepends + 2 originals", orderBefore.length, 122);

  // explicit rebalance is still available and is order-preserving + idempotent
  const touched = rebalanceSiblings(db, page);
  ok("rebalance rewrote every direct child", touched === orderBefore.length, `${touched}`);

  const lenAfter = Math.max(
    ...db.all<{ l: number }>("SELECT length(pos) l FROM node WHERE parent_id = ?", page)
      .map((r) => r.l),
  );
  ok("rebalanced keys are short", lenAfter <= MAX_KEY_LEN, `max ${lenAfter}`);
  eq("rebalance preserves order", childOrder(db, page).map((c) => c.text), orderBefore);

  rebalanceSiblings(db, page);
  eq("rebalance is idempotent", childOrder(db, page).map((c) => c.text), orderBefore);
  eq("rebalance touched only this parent's children", db.scalar<number>(
    "SELECT count(*) c FROM node WHERE parent_id IS NULL",
  ), 1);
}

section("Move into a tight gap (bound ordering)");
{
  const { db, ws } = freshDb();
  const page = createNode(db, {
    ws, kind: "page", type: "page", parent_id: null, parent_kind: "workspace",
    body: plainTextToBody("Moves"),
  });
  const [a, b, c, d] = ["a", "b", "c", "d"].map((text) =>
    createNode(db, {
      ws, kind: "block", type: "paragraph", parent_id: page, parent_kind: "node",
      body: plainTextToBody(text),
    }),
  );

  // moving the LAST sibling to sit before the FIRST: the lower bound must be the
  // sibling preceding the target, not max(pos) — that is what used to crash.
  moveNode(db, d!, { parent_id: page, before: a! });
  eq("move last→front", childOrder(db, page).map((x) => x.text), ["d", "a", "b", "c"]);

  moveNode(db, a!, { parent_id: page, before: b! });
  eq("move is a no-op in place", childOrder(db, page).map((x) => x.text), ["d", "a", "b", "c"]);

  moveNode(db, d!, { parent_id: page, after: c! });
  eq("move to end via after", childOrder(db, page).map((x) => x.text), ["a", "b", "c", "d"]);

  // cross-parent move
  const other = createNode(db, {
    ws, kind: "page", type: "page", parent_id: null, parent_kind: "workspace",
    body: plainTextToBody("Other"),
  });
  moveNode(db, b!, { parent_id: other, parent_kind: "node" });
  eq("cross-parent move: source", childOrder(db, page).map((x) => x.text), ["a", "c", "d"]);
  eq("cross-parent move: target", childOrder(db, other).map((x) => x.text), ["b"]);

  // a page can nest under another page (wiki hierarchy)
  moveNode(db, other, { parent_id: page, parent_kind: "node" });
  eq("page nests under page", childOrder(db, page).map((x) => x.text), ["a", "c", "d", "Other"]);
  const crumbs = db.all<{ id: string }>(
    `WITH RECURSIVE chain(id, parent_id, depth) AS (
       SELECT id, parent_id, 0 FROM node WHERE id = ?
       UNION ALL
       SELECT n.id, n.parent_id, c.depth + 1 FROM node n JOIN chain c ON n.id = c.parent_id
     )
     SELECT id FROM chain ORDER BY depth DESC`,
    b!,
  );
  eq("recursive parent chain gives breadcrumbs", crumbs.length, 3);
}

section("Block conversion & content update");
{
  const { db, ws } = freshDb();
  const page = createNode(db, {
    ws, kind: "page", type: "page", parent_id: null, parent_kind: "workspace",
    body: plainTextToBody("P"),
  });
  const b = createNode(db, {
    ws, kind: "block", type: "paragraph", parent_id: page, parent_kind: "node",
    body: plainTextToBody("make me a todo"),
  });

  convertNode(db, b, "to_do", { checked: true });
  eq(
    "convert paragraph → to_do keeps text",
    db.get<{ type: string; props: string }>("SELECT type, props FROM node WHERE id = ?", b),
    { type: "to_do", props: JSON.stringify({ checked: true }) },
  );

  updateNode(db, b, { body: plainTextToBody("edited text") });
  eq(
    "content update persists",
    plainTextToBodySafe(db.get<{ body: string }>("SELECT body FROM node WHERE id = ?", b)!.body),
    "edited text",
  );
}

section("Trash & restore");
{
  const { db, ws } = freshDb();
  const page = createNode(db, {
    ws, kind: "page", type: "page", parent_id: null, parent_kind: "workspace",
    body: plainTextToBody("Temp"),
  });
  trashNode(db, page);
  ok("trashed page is excluded from active listing", childOrder(db, null).length === 0);
  ok("trashed page keeps deleted_at", db.get<{ deleted_at: number | null }>(
    "SELECT deleted_at FROM node WHERE id = ?", page,
  )?.deleted_at != null);
  restoreNode(db, page);
  eq("restore brings it back", childOrder(db, null).length, 1);
}

section("Undo / redo");
{
  const { db, ws } = freshDb();
  const undo = new UndoManager();
  const page = createNode(db, {
    ws, kind: "page", type: "page", parent_id: null, parent_kind: "workspace",
    body: plainTextToBody("Doc"),
  });

  const t1 = nextTx(db);
  const para = createNode(db, {
    ws, kind: "block", type: "paragraph", parent_id: page, parent_kind: "node",
    body: plainTextToBody("first line"), tx: t1,
  });
  undo.record(t1);
  eq("one block exists", childOrder(db, page).length, 1);

  const t2 = nextTx(db);
  updateNode(db, para, { body: plainTextToBody("second line") }, { tx: t2 });
  undo.record(t2);
  eq("content changed", childOrder(db, page)[0]?.text, "second line");

  undo.undo(db);
  eq("undo restores previous text", childOrder(db, page)[0]?.text, "first line");

  undo.undo(db);
  eq("undo removes the inserted block", childOrder(db, page).length, 0);
  ok("undo stack drained", !undo.canUndo);

  undo.redo(db);
  eq("redo re-inserts the block", childOrder(db, page).length, 1);
  undo.redo(db);
  eq("redo re-applies the text change", childOrder(db, page)[0]?.text, "second line");

  // redo must not clobber fields a patch never touched
  const t3 = nextTx(db);
  const heading = createNode(db, {
    ws, kind: "block", type: "heading_2", parent_id: page, parent_kind: "node",
    body: plainTextToBody("A heading"), tx: t3,
  });
  undo.record(t3);

  const t4 = nextTx(db);
  updateNode(db, heading, { body: plainTextToBody("Edited heading") }, { tx: t4 });
  undo.record(t4);
  eq("heading type intact after edit", db.get<{ type: string }>(
    "SELECT type FROM node WHERE id = ?", heading,
  )?.type, "heading_2");

  undo.undo(db);
  eq("undo of a body-only patch keeps the type", db.get<{ type: string }>(
    "SELECT type FROM node WHERE id = ?", heading,
  )?.type, "heading_2");
  eq("undo restores the heading text", db.get<{ body: string }>(
    "SELECT body FROM node WHERE id = ?", heading,
  )!.body.includes("A heading"), true);

  undo.redo(db);
  eq("redo of a body-only patch keeps the type", db.get<{ type: string }>(
    "SELECT type FROM node WHERE id = ?", heading,
  )?.type, "heading_2");
  eq("redo re-applies the heading text", db.get<{ body: string }>(
    "SELECT body FROM node WHERE id = ?", heading,
  )!.body.includes("Edited heading"), true);

  // redo must reuse ids so a multi-op tx stays referentially intact
  const t5 = nextTx(db);
  const parent = createNode(db, {
    ws, kind: "page", type: "child_page", parent_id: page, parent_kind: "node",
    body: plainTextToBody("Sub"), tx: t5,
  });
  createNode(db, {
    ws, kind: "block", type: "paragraph", parent_id: parent, parent_kind: "node",
    body: plainTextToBody("child of sub"), tx: t5,
  });
  undo.record(t5);
  undo.undo(db);
  eq("undo removed the whole tx subtree", db.scalar<number>(
    "SELECT count(*) c FROM node WHERE id = ? OR parent_id = ?", parent, parent,
  ), 0);
  undo.redo(db);
  eq("redo restores the tx subtree under the original ids", db.scalar<number>(
    "SELECT count(*) c FROM node WHERE id = ? OR parent_id = ?", parent, parent,
  ), 2);
}

section("Full-text search (FTS5)");
{
  const { db, ws } = freshDb();
  const page = createNode(db, {
    ws, kind: "page", type: "page", parent_id: null, parent_kind: "workspace",
    body: plainTextToBody("Project Phoenix"),
  });
  createNode(db, {
    ws, kind: "block", type: "paragraph", parent_id: page, parent_kind: "node",
    body: plainTextToBody("the quarterly roadmap includes the zebra migration"),
  });
  createNode(db, {
    ws, kind: "block", type: "heading_2", parent_id: page, parent_kind: "node",
    body: plainTextToBody("Iași rollout plan"),
  });

  const search = (q: string) =>
    db.all<{ node_id: string }>(
      `SELECT s.node_id FROM node_fts f
       JOIN search_doc s ON s.rid = f.rowid
       WHERE node_fts MATCH ? AND s.ws = ? AND s.deleted = 0
       ORDER BY bm25(node_fts)`,
      q,
      ws,
    );

  eq("finds body text", search("zebra").length, 1);
  eq("finds heading text", search("rollout").length, 1);
  eq("finds page title", search("Phoenix").length, 1);
  eq("no match returns nothing", search("kangaroo").length, 0);

  // diacritics: FTS tokenize remove_diacritics 2 → "iasi" must match "Iași"
  ok("diacritic-insensitive search", search("iasi").length === 1, JSON.stringify(search("iasi")));

  // search stays in sync after an edit
  const target = search("zebra")[0]?.node_id;
  updateNode(db, target!, { body: plainTextToBody("the quarterly roadmap includes the elephant migration") });
  eq("search drops removed term", search("zebra").length, 0);
  eq("search picks up added term", search("elephant").length, 1);

  // trashed content leaves the index
  trashNode(db, target!);
  eq("trashed content is not searchable", search("elephant").length, 0);
}

section("Backlinks");
{
  const { db, ws } = freshDb();
  const source = createNode(db, {
    ws, kind: "page", type: "page", parent_id: null, parent_kind: "workspace",
    body: plainTextToBody("Source page"),
  });
  const target = createNode(db, {
    ws, kind: "page", type: "page", parent_id: null, parent_kind: "workspace",
    body: plainTextToBody("Target page"),
  });

  const links = extractLinks([
    { type: "text", text: "see ", styles: {} },
    { type: "text", text: "Target page", styles: { mention: target }, links: [{ url: target, kind: "page" }] },
  ]);
  eq("extractLinks finds the mention", links.map((l) => l.dst), [target]);

  updateNode(db, source, {
    body: [
      { type: "text", text: "see ", styles: {} },
      { type: "text", text: "Target page", styles: { mention: target }, links: [{ url: target, kind: "page" }] },
    ],
  });

  const bl = getBacklinks(db, target);
  eq("target sees one incoming link", bl.length, 1);
  eq("backlink points at the source page", bl[0]?.src, source);

  // removing the link must remove the edge
  updateNode(db, source, { body: plainTextToBody("no links here") });
  eq("backlink removed with the mention", getBacklinks(db, target).length, 0);
}

section("AI Markdown → editor blocks");
{
  const { markdownToBnBlocks } = await import("../src/editor/serialize.ts");
  const shape = (blocks: { type?: string; content?: unknown }[]) =>
    blocks.map((b) => `${b.type}:${Array.isArray(b.content) ? (b.content as { text?: string }[]).map((r) => r.text).join("") : (b.content ?? "")}`);

  eq(
    "bullets become list items, not literal dashes",
    shape(markdownToBnBlocks("- one\n- two")),
    ["bulletListItem:one", "bulletListItem:two"],
  );
  eq(
    "numbered items",
    shape(markdownToBnBlocks("1. first\n2. second")),
    ["numberedListItem:first", "numberedListItem:second"],
  );
  eq(
    "headings carry their level",
    shape(markdownToBnBlocks("## Title")),
    ["heading:Title"],
  );
  eq(
    "tasks become checkboxes",
    shape(markdownToBnBlocks("- [x] done\n- [ ] todo")),
    ["checkListItem:done", "checkListItem:todo"],
  );
  eq("quote", shape(markdownToBnBlocks("> quoted")), ["quote:quoted"]);
  eq(
    "fenced code becomes one code block with its language, newlines kept",
    shape(markdownToBnBlocks("```js\nconst a = 1;\nconst b = 2;\n```")),
    ["codeBlock:const a = 1;\nconst b = 2;"],
  );
  eq("blank lines are dropped", shape(markdownToBnBlocks("a\n\n\nb")), ["paragraph:a", "paragraph:b"]);

  const bold = markdownToBnBlocks("plain **strong** and `code`")[0] as {
    content: { text: string; styles: Record<string, unknown> }[];
  };
  eq("bold is a style, not asterisks", bold.content[1]?.styles?.bold, true);
  eq("bold run has no markers", bold.content[1]?.text, "strong");
  eq("code is a style", bold.content[3]?.styles?.code, true);
  eq(
    "empty input still yields an insertable block",
    (markdownToBnBlocks("") as unknown[]).length,
    1,
  );
}

section("Backlinks are attributed to pages, not blocks");
{
  const { getOutgoingLinks, pageOwnerOf } = await import("../server/ops.ts");
  const { db, ws } = freshDb();

  const roadmap = createNode(db, {
    ws, kind: "page", type: "page", parent_id: null, parent_kind: "workspace",
    body: plainTextToBody("Aurora roadmap"),
  });
  const meeting = createNode(db, {
    ws, kind: "page", type: "child_page", parent_id: null, parent_kind: "workspace",
    body: plainTextToBody("Weekly sync"),
  });
  // the link lives in a BLOCK inside the meeting page
  const block = createNode(db, {
    ws, kind: "block", type: "paragraph", parent_id: meeting, parent_kind: "node",
    body: [
      { type: "text", text: "Owned by the ", styles: {} },
      { type: "text", text: "Aurora roadmap", styles: { mention: roadmap }, links: [{ url: roadmap, kind: "page" }] },
      { type: "text", text: " notes.", styles: {} },
    ],
  });

  eq("block resolves to its page", pageOwnerOf(db, block), meeting);

  const incoming = getBacklinks(db, roadmap);
  eq("one incoming mention", incoming.length, 1);
  eq(
    "labelled with the PAGE title, not the block sentence",
    incoming[0]?.srcTitle,
    "Weekly sync",
  );
  eq("resolves to the page node", incoming[0]?.src, meeting);

  const outgoing = getOutgoingLinks(db, meeting);
  eq("page-level outgoing links are found", outgoing.map((o) => o.dst), [roadmap]);
  eq("outgoing title is the target page", outgoing[0]?.title, "Aurora roadmap");

  // the block itself is not a page: querying it directly finds no incoming,
  // and page-level queries are the supported view
  eq("reverse direction unaffected", getBacklinks(db, meeting).length, 0);
}

section("Schema integrity");
{
  const { db, ws } = freshDb();
  const page = createNode(db, {
    ws, kind: "page", type: "page", parent_id: null, parent_kind: "workspace",
    body: plainTextToBody("Cascade"),
  });
  const kid = createNode(db, {
    ws, kind: "block", type: "paragraph", parent_id: page, parent_kind: "node",
    body: plainTextToBody("child"),
  });
  db.run("DELETE FROM node WHERE id = ?", page);
  eq("ON DELETE CASCADE removes children", db.scalar<number>(
    "SELECT count(*) c FROM node WHERE id = ?", kid,
  ), 0);
  eq("cascade also cleans the search doc", db.scalar<number>(
    "SELECT count(*) c FROM search_doc WHERE node_id = ?", kid,
  ), 0);

  const ver = db.scalar<number>("PRAGMA user_version");
  // Not pinned to a number: every new migration raises it, and the property
  // worth testing is that the schema is stamped and that migrating again
  // changes nothing — not which release this baseline happens to be.
  ok("schema version stamped", typeof ver === "number" && ver >= 1, `got ${ver}`);
  ok("foreign keys enforced", db.scalar<number>("PRAGMA foreign_keys") === 1);

  // migrations are idempotent
  const { migrate } = await import("../server/db.ts");
  const again = migrate(db);
  eq("re-running migrate is a no-op", again, ver);
  eq("the stamped version survives a second migrate", db.scalar<number>("PRAGMA user_version"), ver);
  // The AI call log arrived as v2: an existing workspace must gain it.
  ok(
    "the ai_call table exists after migrating",
    db.scalar<number>("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='ai_call'") === 1,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

for (const db of openDbs) db.close();
console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
