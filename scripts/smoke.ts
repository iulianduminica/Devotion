/**
 * API smoke test: boots the real Fastify app in-process (no network) and
 * exercises the endpoints the UI depends on.
 *
 * Run: tsx scripts/smoke.ts
 */

import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../server/api.ts";

const ROOT = join(import.meta.dirname!, "..", ".data", "smoke");
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(label: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32mok\x1b[0m   ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// port 8790 is only used to compute the allowed origins; inject() never binds.
const app = await createApp({ workspaceRoot: ROOT, port: 8790, serveStatic: false });
const token = app.token;
const H = { "x-strata-token": token, "content-type": "application/json" };

const get = (url: string, origin?: string) =>
  app.fastify.inject({ method: "GET", url, headers: { ...H, ...(origin ? { origin } : {}) } });
const post = (url: string, body: unknown, origin?: string) =>
  app.fastify.inject({
    method: "POST",
    url,
    headers: { ...H, ...(origin ? { origin } : {}) },
    payload: JSON.stringify(body),
  });
const patch = (url: string, body: unknown) =>
  app.fastify.inject({ method: "PATCH", url, headers: H, payload: JSON.stringify(body) });
const del = (url: string) =>
  app.fastify.inject({ method: "DELETE", url, headers: { "x-strata-token": token } });

const json = <T>(res: { statusCode: number; body: string }): { status: number; data: T } => ({
  status: res.statusCode,
  data: JSON.parse(res.body) as T,
});

console.log("\n\x1b[1mSecurity\x1b[0m");
{
  const res = await get("/api/health", "http://evil.example.com");
  ok("foreign Origin is rejected", res.statusCode === 403, `got ${res.statusCode}`);

  const noToken = await app.fastify.inject({ method: "GET", url: "/api/workspace" });
  ok("missing token is rejected", noToken.statusCode === 401, `got ${noToken.statusCode}`);

  const boot = await app.fastify.inject({
    method: "GET",
    url: "/api/bootstrap",
    headers: { origin: "http://127.0.0.1:8790" },
  });
  ok("bootstrap works for the app origin", boot.statusCode === 200);
  const { token: issued } = json<{ token: string }>(boot).data;
  ok("bootstrap issues a token", typeof issued === "string" && issued.length > 20);

  const bootEvil = await app.fastify.inject({
    method: "GET",
    url: "/api/bootstrap",
    headers: { origin: "http://evil.example.com" },
  });
  ok("bootstrap refuses a foreign origin", bootEvil.statusCode === 403);
}

console.log("\n\x1b[1mPages & blocks\x1b[0m");
let pageId = "";
{
  const r1 = await post("/api/pages", { parentId: null, title: "Smoke page", icon: "🧪" });
  ok("create page", r1.statusCode === 200);
  pageId = json<{ id: string }>(r1).data.id;
  ok("page id returned", !!pageId);

  const r2 = await post("/api/nodes", {
    parentId: pageId,
    type: "heading_1",
    body: [{ type: "text", text: "Heading", styles: {} }],
  });
  ok("create block", r2.statusCode === 200);
  const headingId = json<{ id: string }>(r2).data.id;

  const r3 = await post("/api/nodes", {
    parentId: pageId,
    type: "to_do",
    body: [{ type: "text", text: "Task", styles: {} }],
    props: { checked: false },
  });
  const todoId = json<{ id: string }>(r3).data.id;

  const r4 = await patch(`/api/nodes/${todoId}`, { props: { checked: true } });
  ok("patch block props", r4.statusCode === 200);
  ok(
    "prop persisted",
    JSON.parse(r4.body).node.props.checked === true,
    r4.body.slice(0, 120),
  );

  const r5 = await post(`/api/nodes/${headingId}/convert`, { type: "paragraph" });
  ok("convert block", JSON.parse(r5.body).node.type === "paragraph");

  const r6 = await post(`/api/nodes/${todoId}/move`, { parentId: pageId, before: headingId });
  ok("move block", r6.statusCode === 200);

  const tree = json<{ children: { id: string }[] }>(await get(`/api/nodes/${pageId}`)).data;
  ok("move reordered siblings", tree.children[0]?.id === todoId, JSON.stringify(tree.children.map((c) => c.id)));

  const child = await post("/api/pages", { parentId: pageId, title: "Child page" });
  const childId = json<{ id: string }>(child).data.id;
  const crumbs = json<{ id: string }[]>(await get(`/api/nodes/${childId}/breadcrumbs`)).data;
  ok("breadcrumbs resolve the chain", crumbs.length === 2, JSON.stringify(crumbs.map((c) => c.id)));

  const full = json<{ children: unknown[] }>(await get(`/api/nodes/${pageId}/tree?depth=5`)).data;
  ok("full tree endpoint", !!full);
}

console.log("\n\x1b[1mBatched tx, undo, redo\x1b[0m");
{
  const ops = [
    {
      op: "insert",
      id: "01SMOKE00000000000000000A1",
      parentId: pageId,
      type: "paragraph",
      body: [{ type: "text", text: "from batch", styles: {} }],
    },
    {
      op: "insert",
      id: "01SMOKE00000000000000000A2",
      parentId: pageId,
      type: "quote",
      body: [{ type: "text", text: "from batch 2", styles: {} }],
    },
  ];
  const r = await post("/api/tx", { ops });
  ok("batch tx accepted", r.statusCode === 200, r.body.slice(0, 200));
  const { tx, touched } = json<{ tx: number; touched: string[] }>(r).data;
  ok("batch touched both blocks", touched.length === 2);

  const present = await get(`/api/nodes/${pageId}`);
  const beforeCount = json<{ children: unknown[] }>(present).data.children.length;

  const u = await post("/api/undo", {});
  ok("undo returns the tx", json<{ tx: number }>(u).data.tx === tx);
  const afterUndo = json<{ children: unknown[] }>(await get(`/api/nodes/${pageId}`)).data;
  ok("undo removed both inserts", afterUndo.children.length === beforeCount - 2, `${beforeCount} → ${afterUndo.children.length}`);

  await post("/api/redo", {});
  const afterRedo = json<{ children: unknown[] }>(await get(`/api/nodes/${pageId}`)).data;
  ok("redo restored both inserts", afterRedo.children.length === beforeCount, `${afterRedo.children.length}`);
}

console.log("\n\x1b[1mSearch, backlinks, trash, history\x1b[0m");
{
  const s = json<{ node_id: string }[]>(await get("/api/search?q=Heading"));
  ok("search finds block text", s.data.length >= 1, JSON.stringify(s.data.slice(0, 2)));

  // a cross-page mention: the edge is recorded on the block, but the panel is
  // page-level, so it must be labelled with the source PAGE's title
  const mentioned = json<{ id: string }>(await post("/api/pages", { parentId: null, title: "Mentioned Page" })).data;
  const link = await post("/api/nodes", {
    parentId: pageId,
    type: "paragraph",
    body: [
      { type: "text", text: "see ", styles: {} },
      { type: "text", text: "Mentioned Page", styles: { mention: mentioned.id }, links: [{ url: mentioned.id, kind: "page" }] },
    ],
  });
  ok("create link block", link.statusCode === 200);

  const bl = json<{ backlinks: { src: string; srcTitle: string }[] }>(
    await get(`/api/nodes/${mentioned.id}/backlinks`),
  ).data;
  ok("backlink recorded", bl.backlinks.length >= 1, JSON.stringify(bl.backlinks));
  ok(
    "backlink labelled with the source page title",
    bl.backlinks[0]?.srcTitle === "Smoke page",
    bl.backlinks[0]?.srcTitle,
  );
  ok("backlink resolves to the source page id", bl.backlinks[0]?.src === pageId, bl.backlinks[0]?.src);

  // self-mentions collapse: a page linking itself is not a linked mention
  const selfLink = await post("/api/nodes", {
    parentId: pageId,
    type: "paragraph",
    body: [{ type: "text", text: "self", styles: { mention: pageId }, links: [{ url: pageId, kind: "page" }] }],
  });
  const selfBl = json<{ backlinks: unknown[] }>(await get(`/api/nodes/${pageId}/backlinks`)).data;
  ok("self-mention is not a linked mention", selfBl.backlinks.length === 0, JSON.stringify(selfBl.backlinks));
  void selfLink;

  const outgoing = json<{ outgoing: { dst: string }[] }>(await get(`/api/nodes/${pageId}/backlinks`)).data;
  ok(
    "outgoing links resolve at page level",
    outgoing.outgoing.some((o) => o.dst === mentioned.id),
    JSON.stringify(outgoing.outgoing.map((o) => o.dst)),
  );

  const t = await post("/api/pages", { parentId: null, title: "Temporary" });
  const tempId = json<{ id: string }>(t).data.id;
  const trashed = await del(`/api/nodes/${tempId}`);
  const trash = json<{ node_id: string }[]>(await get("/api/trash")).data;
  ok("trashed page listed", trash.some((x) => x.node_id === tempId), `del=${trashed.statusCode} ${trashed.body.slice(0, 120)} trash=${JSON.stringify(trash.map((x) => x.node_id))}`);

  await post(`/api/nodes/${tempId}/restore`, {});
  const trash2 = json<{ node_id: string }[]>(await get("/api/trash")).data;
  ok("restored page leaves trash", !trash2.some((x) => x.node_id === tempId));

  const snap = await post(`/api/history/${pageId}/snapshot`, { label: "smoke" });
  ok("snapshot created", snap.statusCode === 200);
  const hist = json<{ snapshots: { id: string }[] }>(await get(`/api/history/${pageId}`)).data;
  ok("history lists the snapshot", hist.snapshots.length >= 1);
  const restore = await post(`/api/history/restore/${hist.snapshots[0]!.id}`, {});
  ok("restore from snapshot", json<{ ok: boolean }>(restore).data.ok === true);
}

console.log("\n\x1b[1mTemplates & settings\x1b[0m");
{
  const tpl = await post("/api/templates", { name: "Smoke template", nodeId: pageId, scope: "page" });
  ok("save template", tpl.statusCode === 200);
  const tplId = json<{ id: string }>(tpl).data.id;

  const applied = await post(`/api/templates/${tplId}/apply`, { parentId: null, title: "From template" });
  const newId = json<{ id: string }>(applied).data.id;
  ok("apply template creates a page", !!newId);
  const copy = json<{ children: unknown[] }>(await get(`/api/nodes/${newId}`)).data;
  ok("template copied the blocks", copy.children.length > 0, `${copy.children.length} children`);

  // a bad id must fail loudly: a 200 with a null id is what made the panel's
  // "Use" button appear to do nothing
  const missing = await post("/api/templates/01M89KAARGTPD995CSRY67YMIK/apply", { parentId: null });
  ok("apply of a missing template is a 404", missing.statusCode === 404, `got ${missing.statusCode}`);

  const st = await patch("/api/settings", { theme: "dark", "ai.defaultProvider": "strata" });
  ok("settings save", st.statusCode === 200);
  const all = json<Record<string, unknown>>(await get("/api/settings")).data;
  ok("settings read back", all["theme"] === "dark");
}

console.log("\n\x1b[1mDatabases over HTTP\x1b[0m");
let dbId = "";
let viewId = "";
{
  const created = await post("/api/databases", {
    parentId: pageId,
    title: "Smoke tasks",
    properties: [
      { name: "Name", type: "title" },
      { name: "Priority", type: "number" },
      { name: "Done", type: "checkbox" },
      { name: "Tag", type: "select" },
      { name: "State", type: "status" },
      { name: "Due", type: "date" },
      { name: "ID", type: "unique_id", config: { prefix: "SM", next: 1 } },
    ],
    views: [
      { name: "Table", type: "table" },
      { name: "Board", type: "board" },
    ],
  });
  ok("create database", created.statusCode === 200, created.body.slice(0, 200));
  const c = json<{ databaseId: string; node: string; properties: { id: string; name: string }[] }>(created).data;
  dbId = c.databaseId;
  const P = Object.fromEntries(c.properties.map((p) => [p.name, p.id]));

  const opt = await post(`/api/properties/${P["Tag"]}/options`, { name: "Urgent", color: "red" });
  ok("add select option", opt.statusCode === 200);
  const optId = json<{ id: string }>(opt).data.id;

  const rows = [
    ["Alpha", 1, true, [optId], { start: Date.now() + 86400000, end: null, allDay: true }],
    ["Bravo", 5, false, [], { start: Date.now() - 86400000, end: null, allDay: true }],
    ["Charlie", 3, true, [optId], null],
  ] as const;

  const rowIds: string[] = [];
  for (const [name, pri, done, tag, due] of rows) {
    const r = await post(`/api/databases/${dbId}/rows`, {
      values: {
        [P["Name"]!]: name,
        [P["Priority"]!]: pri,
        [P["Done"]!]: done,
        [P["Tag"]!]: tag,
        ...(due ? { [P["Due"]!]: due } : {}),
      },
    });
    ok(`create row ${name}`, r.statusCode === 200, r.body.slice(0, 160));
    rowIds.push(json<{ id: string }>(r).data.id);
  }

  const views = json<{ id: string; type: string; spec: unknown }[]>(await get(`/api/databases/${dbId}/views`)).data;
  viewId = views[0]!.id;

  const q = json<{ rows: { title: string; values: Record<string, unknown> }[]; total: number; properties: unknown[] }>(
    await get(`/api/views/${viewId}/query`),
  ).data;
  ok("query returns all rows", q.rows.length === 3, `${q.rows.length}`);
  ok("rows carry values", q.rows[0]!.values[P["Name"]!] === "Alpha", JSON.stringify(q.rows[0]!.values[P["Name"]!]));
  ok("unique_id allocated", q.rows[0]!.values[P["ID"]!] === 1, JSON.stringify(q.rows[0]!.values[P["ID"]!]));

  const filtered = await post(`/api/views/${viewId}/query`, {
    spec: {
      filter: { and: true, rules: [{ prop: P["Priority"]!, operator: "greaterThan", value: 2 }] },
      sort: [{ prop: P["Priority"]!, direction: "descending" }],
      group: [],
      hidden: [],
      aggregates: {},
      rowColors: [],
      card: { size: "medium", properties: [] },
    },
  });
  const fq = json<{ rows: { title: string }[] }>(filtered).data;
  ok("filter + sort over HTTP", fq.rows.map((r) => r.title).join() === "Bravo,Charlie", fq.rows.map((r) => r.title).join());

  const agg = json<{ value: number }>(
    await get(`/api/databases/${dbId}/aggregate?prop=${P["Priority"]}&fn=sum`),
  ).data;
  ok("aggregation over HTTP", agg.value === 9, `${agg.value}`);

  const grouped = await post(`/api/views/${views[1]!.id}/grouped`, {
    group: P["Tag"]!,
    spec: {
      filter: { and: true, rules: [] },
      sort: [],
      group: [{ prop: P["Tag"]! }],
      hidden: [],
      aggregates: {},
      rowColors: [],
      card: { size: "medium", properties: [] },
    },
  });
  const gq = json<{ buckets: { label: string; rows: unknown[] }[] }>(grouped).data;
  ok("board grouping over HTTP", gq.buckets.length === 2, JSON.stringify(gq.buckets.map((b) => b.label)));

  const patched = await patch(`/api/rows/${rowIds[0]}`, { values: { [P["Priority"]!]: 42 } });
  ok("patch row value", patched.statusCode === 200);
  const after = json<{ row: { values: Record<string, unknown> } }>(patched).data;
  ok("row value persisted", after.row.values[P["Priority"]!] === 42);

  const specRes = await patch(`/api/views/${viewId}`, {
    name: "Table",
    spec: {
      filter: { and: true, rules: [] },
      sort: [{ prop: P["Priority"]!, direction: "ascending" }],
      group: [],
      hidden: [P["Due"]!],
      aggregates: { [P["Done"]!]: "percentChecked" },
      rowColors: [],
      card: { size: "medium", properties: [] },
    },
  });
  ok("view spec persists", specRes.statusCode === 200);
  const savedViews = json<{ spec: { hidden: string[] } }[]>(await get(`/api/databases/${dbId}/views`));
  ok(
    "hidden property saved",
    (savedViews.data[0]?.spec?.hidden?.length ?? 0) === 1,
    JSON.stringify(savedViews.data.map((v) => v.spec?.hidden)),
  );

  const f = await post("/api/formula/validate", { source: 'if(Done, "ship", "backlog")' });
  const fv = json<{ ok: boolean; refs?: string[]; resultType?: string }>(f).data;
  ok("formula validates", fv.ok === true, f.body.slice(0, 160));
  ok("formula refs extracted", JSON.stringify(fv.refs) === '["Done"]', JSON.stringify(fv.refs));

  const bad = await post("/api/formula/validate", { source: "if(Done," });
  ok("bad formula reports an error", json<{ ok: boolean }>(bad).data.ok === false);

  const rel = await post("/api/relations", {
    sourceDb: dbId,
    targetDb: dbId,
    name: "Blocks",
    mirrorName: "Blocked by",
  });
  ok("self relation", rel.statusCode === 200, rel.body.slice(0, 160));
}

console.log("\n\x1b[1mImport & export\x1b[0m");
{
  const md = [
    "# Imported notes",
    "",
    "A paragraph with **bold** and a [link](https://example.com).",
    "",
    "- [x] done thing",
    "- open thing",
    "",
    "> quoted line",
    "",
    "```js",
    "const x = 1;",
    "```",
    "",
    "| Name | Priority | Done |",
    "| --- | ---: | --- |",
    "| Alpha | 1 | true |",
    "| Bravo | 2 | false |",
  ].join("\n");

  const imp = await post("/api/import/markdown", { content: md, parentId: null });
  ok("markdown import", imp.statusCode === 200, imp.body.slice(0, 220));
  const stats = json<{ pages: number; blocks: number; databases: number; rows: number }>(imp).data;
  ok("import created a page", stats.pages === 1, JSON.stringify(stats));
  ok("import created blocks", stats.blocks >= 6, JSON.stringify(stats));
  ok("GFM table became a database", stats.databases === 1, JSON.stringify(stats));
  ok("table rows imported", stats.rows === 2, JSON.stringify(stats));

  const searchImported = json<unknown[]>(await get("/api/search?q=Imported"));
  ok("imported content is searchable", searchImported.data.length >= 1);

  const pages = json<{ id: string }[]>(await get("/api/tree"));
  const firstPage = pages.data[0]!.id;
  const exp = await get(`/api/export/markdown?nodeId=${firstPage}`);
  ok("markdown export", exp.statusCode === 200 && exp.body.length > 0, `${exp.body.length} bytes`);

  const html = await get(`/api/export/html?nodeId=${firstPage}`);
  ok("html export", html.statusCode === 200 && html.body.includes("<!doctype"), html.body.slice(0, 40));

  const csv = await get(`/api/export/csv?viewId=${viewId}`);
  ok("csv export", csv.statusCode === 200 && csv.body.split("\n").length >= 3, csv.body.slice(0, 80));

  const ws = json<{ files: { path: string }[] }>(await get("/api/export/workspace")).data;
  ok("workspace export lists files", ws.files.length >= 1, JSON.stringify(ws.files.slice(0, 3)));
}

console.log("\n\x1b[1mMedia\x1b[0m");
{
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const up = await app.fastify.inject({
    method: "POST",
    url: "/api/media?name=dot.png&mime=image/png",
    headers: { "x-strata-token": token, "content-type": "image/png" },
    payload: png,
  });
  ok("media upload", up.statusCode === 200, up.body.slice(0, 160));
  const media = json<{ id: string; bytes: number; width: number | null }>(up).data;
  ok("media stored with size", media.bytes === png.byteLength);
  ok("PNG dimensions read", media.width === 1, `${media.width}x?`);

  const served = await app.fastify.inject({ method: "GET", url: `/media/${media.id}` });
  ok("media served", served.statusCode === 200 && served.rawPayload.equals(png));
  ok("media content-type", served.headers["content-type"] === "image/png");

  const dup = await app.fastify.inject({
    method: "POST",
    url: "/api/media?name=dot.png&mime=image/png",
    headers: { "x-strata-token": token, "content-type": "image/png" },
    payload: png,
  });
  const dupData = json<{ reused: boolean; id: string }>(dup).data;
  ok("identical upload is deduped", dupData.reused === true && dupData.id === media.id);
}

console.log("\n\x1b[1mAI surface\x1b[0m");
{
  // This app instance is created without an AI bridge, so the routes are absent
  // by design (the server must boot with AI hidden, not broken, when the AI
  // module is unavailable). The bridge's own behaviour is covered by test-ai.ts.
  const providers = await get("/api/ai/providers");
  ok("providers route absent without a bridge", providers.statusCode === 404, `status ${providers.statusCode}`);

  const action = await post("/api/ai/action", { action: "summarize", providerId: "strata", text: "One two three." });
  ok("ai action route absent without a bridge", action.statusCode === 404, `status ${action.statusCode}`);
}

await app.fastify.close();
app.db.close();

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
