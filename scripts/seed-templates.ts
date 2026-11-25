/**
 * First-party template library.
 *
 * Builds 15 real, populated template structures (pages with blocks, databases
 * with properties, rows, views, formulas and rollups) and stores each one in
 * the `template` table exactly the way `saveTemplate` in server/library.ts
 * does: a gzipped `NodeTree` in the `payload` BLOB.
 *
 * The `template` table has no description column, so the description travels
 * inside the payload: the root node carries it in `meta.templateDescription`
 * (plus `meta.templateFirstParty` and `meta.templateDatabases`, which lists the
 * databases the subtree owns). `applyTemplate` copies `meta` onto the new page,
 * so the UI can read the description straight off the template record.
 *
 * Run:  & .\node_modules\.bin\tsx.cmd scripts/seed-templates.ts [workspaceDir]
 *
 * The CLI defaults to `.data/tpl-seed`, a throwaway directory. It never opens
 * `.data/workspace`, which the live app locks. Call `seedFirstPartyTemplates`
 * with your own `db` + `ws` from a script or an API route.
 */

import { gzipSync, gunzipSync } from "node:zlib";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { openWorkspace, type Db } from "../server/db.ts";
import { createNode, updateNode, DEFAULT_ACTOR, type ActorInfo } from "../server/ops.ts";
import { newId } from "../server/ids.ts";
import { createPage, setPageMeta, getTree } from "../server/library.ts";
import {
  addProperty,
  addSelectOption,
  createDatabase,
  createRelation,
  createRow,
  createView,
  getProperty,
  listProperties,
  readPropertyValue,
  recomputeRow,
  setPropertyValue,
  updateViewSpec,
  validateFormulaSource,
} from "../server/databases.ts";
import {
  evaluateFormula,
  normalizeValue,
  type EvalContext,
  type FormulaValue,
} from "../server/formula.ts";
import {
  plainTextToBody,
  defaultViewSpec,
  type Body,
  type FormulaNode,
  type Inline,
  type NodeTree,
  type PropertyDef,
  type StatusGroup,
  type ViewSpec,
  type ViewType,
} from "../shared/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** The `template` row, plus the description that travels inside the payload. */
export interface StoredTemplate {
  id: string;
  ws: string;
  name: string;
  scope: "page" | "database";
  icon: string | null;
  description: string;
  /** gzipped JSON of a `NodeTree` — the same encoding `saveTemplate` writes. */
  payload: Uint8Array;
  created_at: number;
}

export interface SeedTemplateOptions {
  actor?: ActorInfo;
  /** Print one summary line per template. Defaults to true. */
  verbose?: boolean;
}

export interface SeedTemplateResult {
  name: string;
  icon: string;
  description: string;
  scope: "page" | "database";
  templateId: string;
  /** the template's root page id in the workspace, for verification */
  rootId: string;
  blocks: number;
  rows: number;
  databases: number;
  views: number;
  formulas: number;
}

export interface SeedTemplatesReport {
  workspace: string;
  /** first-party templates deleted before the insert (idempotency) */
  removed: number;
  seeded: SeedTemplateResult[];
  totalBlocks: number;
  totalRows: number;
}

/**
 * Insert the 15 first-party templates into workspace `ws`.
 *
 * Idempotent: templates whose name matches a built-in are deleted first, so
 * running this twice leaves exactly 15.
 */
export function seedFirstPartyTemplates(
  db: Db,
  ws: string,
  opts: SeedTemplateOptions = {},
): SeedTemplatesReport {
  const actor = opts.actor ?? DEFAULT_ACTOR;
  const verbose = opts.verbose ?? true;

  const names = TEMPLATES.map((t) => t.name);
  const ph = names.map(() => "?").join(",");
  const removed = Number(
    db.run(`DELETE FROM template WHERE ws = ? AND name IN (${ph})`, ws, ...names).changes,
  );

  const seeded: SeedTemplateResult[] = [];
  // Drop the previous generation's scaffolding before building the new one.
  const dropped = dropScaffolding(db);
  for (const def of TEMPLATES) {
    const built = buildTemplate(db, ws, def, actor);
    insertTemplate(db, {
      id: built.id,
      ws,
      name: def.name,
      scope: def.scope,
      icon: def.icon,
      description: def.description,
      payload: built.payload,
      created_at: built.created_at,
    });
    // The page built above is scaffolding to produce a real subtree to store.
    // The template row now carries it, so the page is flagged as template-owned:
    // the workspace keeps ONE page, and the library lives in Templates.
    markScaffolding(db, built.rootId);
    const row: SeedTemplateResult = {
      name: def.name,
      icon: def.icon,
      description: def.description,
      scope: def.scope,
      templateId: built.id,
      rootId: built.rootId,
      blocks: built.blocks,
      rows: built.rows,
      databases: built.databases,
      views: built.views,
      formulas: built.formulas,
    };
    seeded.push(row);
    if (verbose) {
      console.log(
        `  ${row.icon}  ${pad(row.name, 17)} blocks ${String(row.blocks).padStart(3)} · ` +
          `rows ${String(row.rows).padStart(2)} · dbs ${row.databases} · ` +
          `views ${String(row.views).padStart(2)} · formulas ${row.formulas}`,
      );
    }
  }

  // The previous generation's scaffolding databases are now unreferenced.
  const swept = sweepOrphanDatabases(db);
  if (verbose && swept) console.log(`  swept ${swept} orphaned database(s) from a previous seed`);

  return {
    workspace: ws,
    removed,
    seeded,
    totalBlocks: seeded.reduce((a, s) => a + s.blocks, 0),
    totalRows: seeded.reduce((a, s) => a + s.rows, 0),
  };
}

/** Insert one template record. `payload` is gzipped JSON of a `NodeTree`. */
export function insertTemplate(db: Db, t: StoredTemplate): void {
  db.run(
    `INSERT INTO template (id, ws, name, scope, icon, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    t.id,
    t.ws,
    t.name,
    t.scope,
    t.icon,
    t.payload,
    t.created_at,
  );
}

/**
 * Flag a template's scaffolding page as template-owned.
 *
 * The subtree is NOT deleted: a database's rows are reached through its host
 * `child_database` node, so deleting it leaves `applyTemplate` with a database
 * that has properties and views but no rows to clone. The root carries
 * `meta.tpl` instead, and the sidebar tree, search and workspace counts exclude
 * it — the library lives in the Templates panel, and the workspace keeps one
 * presentation page.
 */
export function markScaffolding(db: Db, rootId: string): void {
  // Every node in the subtree is flagged, not just the root: search returns
  // individual blocks (a heading inside the scaffolding), and a root-only flag
  // would leave those hits in the results.
  db.run(
    `WITH RECURSIVE tree(id) AS (
       SELECT id FROM node WHERE id = ?
       UNION ALL
       SELECT n.id FROM node n JOIN tree t ON n.parent_id = t.id
     )
     UPDATE node SET meta = json_set(meta, '$.tpl', 1)
     WHERE id IN (SELECT id FROM tree) AND json_extract(meta, '$.tpl') IS NULL`,
    rootId,
  );
}

/**
 * Delete the scaffolding of a previous generation. Re-seeding replaces template
 * rows, so the pages that backed the old ones are unreachable; dropping them
 * first stops scaffolding piling up. Their databases go next via
 * `sweepOrphanDatabases`.
 */
export function dropScaffolding(db: Db): number {
  const roots = db
    .all<{ id: string }>("SELECT id FROM node WHERE json_extract(meta, '$.tpl') IS NOT NULL")
    .map((r) => r.id);
  for (const id of roots) db.run("DELETE FROM node WHERE id = ?", id);
  return roots.length;
}

/**
 * Delete databases that nothing references any more — no node, and no template
 * payload. Re-seeding replaces template rows, so the previous generation's
 * scaffolding databases become unreachable; this is what stops them piling up.
 */
export function sweepOrphanDatabases(db: Db): number {
  const live = new Set<string>(
    db
      .all<{ id: string }>(
        `SELECT json_extract(props, '$.databaseId') AS id
         FROM node WHERE type = 'child_database' AND json_extract(props, '$.databaseId') IS NOT NULL`,
      )
      .map((r) => r.id),
  );

  for (const row of db.all<{ payload: Uint8Array | string }>("SELECT payload FROM template")) {
    const tree = decodePayload(row.payload);
    if (!tree) continue;
    const walk = (n: NodeTree): void => {
      const props = n.props as Record<string, unknown> | null;
      if (n.type === "child_database" && typeof props?.databaseId === "string") live.add(props.databaseId);
      for (const c of n.children ?? []) walk(c);
    };
    walk(tree);
  }

  const all = db.all<{ id: string }>("SELECT id FROM database_obj").map((r) => r.id);
  const orphans = all.filter((id) => !live.has(id));
  for (const id of orphans) db.run("DELETE FROM database_obj WHERE id = ?", id);
  return orphans.length;
}

/** Gunzip a `template.payload` value (BLOB, TEXT, or a raw JSON tree). */
export function decodePayload(payload: Uint8Array | string | unknown): NodeTree | null {
  try {
    if (typeof payload === "string") {
      const trimmed = payload.trimStart();
      if (trimmed.startsWith("{")) return JSON.parse(trimmed) as NodeTree;
      return JSON.parse(gunzipSync(Buffer.from(payload, "latin1")).toString("utf8")) as NodeTree;
    }
    // node:sqlite hands a BLOB back as a Uint8Array; Buffer.from copies it.
    const buf = payload instanceof Uint8Array ? Buffer.from(payload) : Buffer.from(String(payload));
    return JSON.parse(gunzipSync(buf).toString("utf8")) as NodeTree;
  } catch {
    return null;
  }
}

/** Read a stored template record back, gunzipped. */
export function readTemplatePayload(db: Db, id: string): NodeTree | null {
  const row = db.get<{ payload: Uint8Array | string }>("SELECT payload FROM template WHERE id = ?", id);
  return row ? decodePayload(row.payload) : null;
}

/** The names of the first-party templates, in seed order. */
export function firstPartyTemplateNames(): string[] {
  return TEMPLATES.map((t) => t.name);
}

/** Every formula the library uses, so a UI can sanity-check them. */
export function listTemplateFormulas(): {
  template: string;
  database: string;
  property: string;
  source: string;
  ast: FormulaNode;
}[] {
  const out: { template: string; database: string; property: string; source: string; ast: FormulaNode }[] = [];
  for (const def of TEMPLATES) {
    for (const dbSpec of def.databases ?? []) {
      for (const p of dbSpec.properties) {
        if (p.type === "formula" && p.formula) {
          out.push({
            template: def.name,
            database: dbSpec.title,
            property: p.name,
            source: p.formula,
            ast: parseFormulaSource(p.formula),
          });
        }
      }
    }
  }
  return out;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// Authoring helpers — the same shapes scripts/seed.ts uses
// ─────────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
/**
 * Midnight UTC, `offset` days from today. Dates are stored at midnight so the
 * dateDiff formulas return whole days: seeding with `Date.now()` produced
 * fractional day counts like "in 2.49331103009d".
 */
const day = (offset: number): number => {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) + offset * DAY;
};

type StylePart = string | [string, Record<string, unknown>?] | Record<string, unknown>;

const rich = (parts: StylePart[]): Body =>
  parts.map((part) => {
    if (typeof part === "string") return { type: "text", text: part, styles: {} };
    if (Array.isArray(part)) return { type: "text", text: part[0], styles: part[1] ?? {} };
    return part as unknown as Inline;
  });

/** A real page mention: `styles.mention` + a `page` link, which is what the backlink extractor reads. */
function linkTo(targetId: string, label: string): Record<string, unknown> {
  return {
    type: "text",
    text: label,
    styles: { mention: targetId },
    links: [{ url: targetId, kind: "page" }],
  };
}

function urlLink(url: string, label: string): Record<string, unknown> {
  return { type: "text", text: label, styles: {}, links: [{ url, kind: "url" }] };
}

interface BuildCtx {
  db: Db;
  ws: string;
  actor: ActorInfo;
  rootId: string;
  /** last block created at the root level, so child pages land in document order */
  last: string | null;
  databases: string[];
  built: Record<string, BuiltDatabase>;
  formulas: number;
}

function blk(
  ctx: BuildCtx,
  parentId: string,
  type: string,
  body: Body | null,
  props: Record<string, unknown> = {},
): string {
  const id = createNode(ctx.db, {
    ws: ctx.ws,
    kind: "block",
    type: type as never,
    parent_id: parentId,
    parent_kind: "node",
    body,
    props,
    actor: ctx.actor,
  });
  if (parentId === ctx.rootId) ctx.last = id;
  return id;
}

const h1 = (ctx: BuildCtx, text: string): string => blk(ctx, ctx.rootId, "heading_1", plainTextToBody(text));
const h2 = (ctx: BuildCtx, text: string): string => blk(ctx, ctx.rootId, "heading_2", plainTextToBody(text));
const h3 = (ctx: BuildCtx, text: string): string => blk(ctx, ctx.rootId, "heading_3", plainTextToBody(text));
const para = (ctx: BuildCtx, body: Body | string): string =>
  blk(ctx, ctx.rootId, "paragraph", typeof body === "string" ? plainTextToBody(body) : body);
const bullet = (ctx: BuildCtx, body: Body | string): string =>
  blk(ctx, ctx.rootId, "bulleted_list_item", typeof body === "string" ? plainTextToBody(body) : body);
const numbered = (ctx: BuildCtx, body: Body | string): string =>
  blk(ctx, ctx.rootId, "numbered_list_item", typeof body === "string" ? plainTextToBody(body) : body);
const todo = (ctx: BuildCtx, text: string, checked = false): string =>
  blk(ctx, ctx.rootId, "to_do", plainTextToBody(text), { checked });
const quote = (ctx: BuildCtx, text: string): string => blk(ctx, ctx.rootId, "quote", plainTextToBody(text));
const divider = (ctx: BuildCtx): string => blk(ctx, ctx.rootId, "divider", null);
const callout = (
  ctx: BuildCtx,
  body: Body | string,
  icon: string,
  color = "blue_background",
  parentId?: string,
): string =>
  blk(ctx, parentId ?? ctx.rootId, "callout", typeof body === "string" ? plainTextToBody(body) : body, {
    icon,
    color,
  });
const toggle = (ctx: BuildCtx, text: string, open = false): string =>
  blk(ctx, ctx.rootId, "toggle", plainTextToBody(text), { open });
const codeBlock = (ctx: BuildCtx, text: string, language: string): string =>
  blk(ctx, ctx.rootId, "code", plainTextToBody(text), { language });
const bookmark = (ctx: BuildCtx, url: string): string => blk(ctx, ctx.rootId, "bookmark", null, { url });

/** A child page nested under the template root. */
function childPage(ctx: BuildCtx, title: string, icon?: string): string {
  const id = createPage(ctx.db, ctx.ws, ctx.rootId, title, icon, { actor: ctx.actor, after: ctx.last });
  ctx.last = id;
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Declarative template spec
// ─────────────────────────────────────────────────────────────────────────────

interface StatusGroupSpec {
  id: "to_do" | "in_progress" | "complete";
  name: string;
  color: string;
  options: { name: string; color: string }[];
}

interface PropSpec {
  name: string;
  type: string;
  /** select / multi_select options */
  options?: { name: string; color: string }[];
  /** status groups, replacing the default three */
  statusGroups?: StatusGroupSpec[];
  /** formula source, parsed + validated at seed time */
  formula?: string;
  /** rollup: relation property name, target property name, aggregate */
  rollup?: { relation: string; target: string; fn: string };
  /** relation: title of the database to point at */
  relationTo?: string;
  /** relation: name of the mirrored property on the target database */
  mirrorName?: string;
  /** unique_id prefix */
  prefix?: string;
  format?: string;
  precision?: number;
  showAsBar?: boolean;
  config?: Record<string, unknown>;
}

interface RowSpec {
  title: string;
  values?: Record<string, unknown>;
  /** blocks written inside the row page: [type, text, props] */
  blocks?: [string, string, Record<string, unknown>?][];
}

interface ViewSpecInput {
  name: string;
  type: ViewType;
  group?: string[];
  sort?: { prop: string; direction: "ascending" | "descending" }[];
  calendarBy?: string;
  timelineBy?: { start: string; end?: string };
  hidden?: string[];
  aggregates?: Record<string, string>;
  card?: { size: "small" | "medium" | "large"; properties: string[]; cover?: string };
  filterRules?: { prop: string; operator: string; value?: unknown }[];
}

interface DatabaseSpec {
  title: string;
  icon?: string;
  /** heading written above the database block */
  heading?: string;
  properties: PropSpec[];
  rows: RowSpec[];
  views: ViewSpecInput[];
}

interface TemplateDef {
  name: string;
  icon: string;
  description: string;
  scope: "page" | "database";
  build: (ctx: BuildCtx) => void;
  databases?: DatabaseSpec[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Building one template
// ─────────────────────────────────────────────────────────────────────────────

interface BuiltDatabase {
  databaseId: string;
  hostNode: string;
  title: string;
  props: Record<string, PropertyDef>;
  options: Record<string, string>;
  rows: Record<string, string>;
  /** relation property name → the database it points at */
  relationTarget: Record<string, BuiltDatabase>;
  /** relation properties, created after every database exists */
  relationSpecs: PropSpec[];
  /** rollup properties, created after the relations exist */
  rollupSpecs: PropSpec[];
  /** rows that set a relation value, created after the relations exist */
  deferredRows: RowSpec[];
  /** views whose spec references a relation property */
  deferredViews: { id: string; spec: ViewSpecInput }[];
  /** relation edges pointing at a row that did not exist when the row was made */
  pendingEdges: { rowId: string; propId: string; raw: unknown }[];
  /** property names created as a mirror by `createRelation`, not declared here */
  mirrorNames: Set<string>;
  spec: DatabaseSpec;
}

interface BuiltTemplate {
  id: string;
  /** the root page's node id in the live workspace, for verification */
  rootId: string;
  payload: Uint8Array;
  created_at: number;
  blocks: number;
  rows: number;
  databases: number;
  views: number;
  formulas: number;
}

function buildTemplate(db: Db, ws: string, def: TemplateDef, actor: ActorInfo): BuiltTemplate {
  const rootId = createPage(db, ws, null, def.name, def.icon, { actor });
  setPageMeta(db, rootId, { icon: def.icon }, { actor });

  const ctx: BuildCtx = {
    db,
    ws,
    actor,
    rootId,
    last: null,
    databases: [],
    built: {},
    formulas: 0,
  };

  def.build(ctx);
  for (const spec of def.databases ?? []) buildDatabase(ctx, spec);
  linkRelations(ctx);
  createDeferredRows(ctx);
  linkRollups(ctx);
  applyDeferredViews(ctx);
  flushPendingEdges(ctx);
  // Two passes: a rollup property is added after its rows exist, and a formula
  // that reads a rollup needs that rollup cached first.
  recomputeAllRows(ctx);
  recomputeAllRows(ctx);

  // The description rides inside the payload: the root node's meta.
  const row = db.get<{ meta: string }>("SELECT meta FROM node WHERE id = ?", rootId);
  const meta = (row ? JSON.parse(row.meta) : {}) as Record<string, unknown>;
  meta.icon = def.icon;
  meta.templateBadge = true;
  meta.templateFirstParty = true;
  meta.templateDescription = def.description;
  meta.templateDatabases = ctx.databases;
  updateNode(db, rootId, { meta }, { actor });

  const tree = getTree(db, rootId, 40) as NodeTree;
  const payload = gzipSync(Buffer.from(JSON.stringify(tree), "utf8"));
  const counts = subtreeCounts(db, rootId);

  return {
    id: newTemplateId(),
    rootId,
    payload,
    created_at: Date.now(),
    blocks: counts.blocks,
    rows: counts.rows,
    databases: ctx.databases.length,
    views: countViews(db, ctx.databases),
    formulas: ctx.formulas,
  };
}

function newTemplateId(): string {
  return newId();
}

function subtreeCounts(db: Db, rootId: string): { blocks: number; rows: number } {
  const kinds = db.all<{ kind: string }>(
    `WITH RECURSIVE tree(id, kind) AS (
       SELECT id, kind FROM node WHERE id = ?
       UNION ALL
       SELECT n.id, n.kind FROM node n JOIN tree t ON n.parent_id = t.id
     )
     SELECT kind FROM tree`,
    rootId,
  );
  let blocks = 0;
  let rows = 0;
  for (const k of kinds) {
    if (k.kind === "row") rows++;
    else blocks++;
  }
  return { blocks, rows };
}

function countViews(db: Db, databaseIds: string[]): number {
  if (!databaseIds.length) return 0;
  const ph = databaseIds.map(() => "?").join(",");
  return Number(db.scalar<number>(`SELECT count(*) FROM view WHERE db_id IN (${ph})`, ...databaseIds) ?? 0);
}

// ── databases ────────────────────────────────────────────────────────────────

function buildDatabase(ctx: BuildCtx, spec: DatabaseSpec): BuiltDatabase {
  if (spec.heading) h2(ctx, spec.heading);

  const created = createDatabase(ctx.db, {
    ws: ctx.ws,
    parent_id: ctx.rootId,
    parent_kind: "node",
    title: spec.title,
    icon: spec.icon,
    properties: [{ name: "Name", type: "title" }],
    views: [{ name: "Table", type: "table" }],
    actor: ctx.actor,
  });
  ctx.databases.push(created.databaseId);
  ctx.last = created.node;

  const built: BuiltDatabase = {
    databaseId: created.databaseId,
    hostNode: created.node,
    title: spec.title,
    props: { Name: created.properties[0]! },
    options: {},
    rows: {},
    relationTarget: {},
    relationSpecs: [],
    rollupSpecs: [],
    deferredRows: [],
    deferredViews: [],
    pendingEdges: [],
    mirrorNames: new Set(),
    spec,
  };
  ctx.built[spec.title] = built;

  let afterPos: string | null = created.properties[0]!.pos;

  // pass 1 — plain properties, in declaration order
  for (const p of spec.properties) {
    if (p.type === "relation" || p.type === "rollup" || p.type === "formula") continue;
    const prop = addProperty(ctx.db, built.databaseId, p.name, p.type as never, propConfig(p), {
      actor: ctx.actor,
      afterPos,
    });
    built.props[p.name] = prop;
    afterPos = prop.pos;

    for (const o of p.options ?? []) {
      const opt = addSelectOption(ctx.db, prop.id, o.name, o.color);
      built.options[`${p.name}:${o.name}`] = opt.id;
    }
    if (p.statusGroups) applyStatusGroups(ctx.db, prop, p.statusGroups, built.options, p.name);
  }

  // pass 2 — formula properties. Relations and rollups are deferred: a
  // bidirectional relation pair can be circular (OKR objectives ↔ key
  // results), so those need every database in the template to exist first.
  for (const p of spec.properties) {
    if (p.type === "relation") {
      built.relationSpecs.push(p);
      continue;
    }
    if (p.type === "rollup") {
      built.rollupSpecs.push(p);
      continue;
    }
    if (p.type !== "formula") continue;
    const source = p.formula ?? "";
    const v = validateFormulaSource(source);
    if (!v.ok || !v.ast) {
      throw new Error(
        `${spec.title}.${p.name}: formula does not parse — ${v.code ?? ""} ${v.error ?? ""} @${v.position ?? "?"}`,
      );
    }
    const prop = addProperty(
      ctx.db,
      built.databaseId,
      p.name,
      "formula",
      { source, ast: v.ast, resultType: v.resultType },
      { actor: ctx.actor, afterPos },
    );
    built.props[p.name] = prop;
    afterPos = prop.pos;
    ctx.formulas++;
  }

  // pass 3 — rows. A row that sets a relation value is deferred to
  // `createDeferredRows`, because the relation property does not exist yet.
  for (const r of spec.rows) {
    if (usesRelationValue(built, r)) {
      built.deferredRows.push(r);
      continue;
    }
    built.rows[r.title] = createRowFromSpec(ctx, built, r);
  }

  // pass 4 — views. Index 0 is the Table view `createDatabase` already made.
  // A view that groups, sorts, filters or aggregates on a relation property is
  // deferred to `applyDeferredViews`, because that property does not exist yet.
  for (let i = 0; i < spec.views.length; i++) {
    const v = spec.views[i]!;
    const target =
      i === 0 ? created.views[0]! : createView(ctx.db, built.databaseId, v.name, v.type, i, { actor: ctx.actor });
    if (usesDeferredProperty(built, v)) {
      built.deferredViews.push({ id: target.id, spec: v });
      continue;
    }
    updateViewSpec(ctx.db, target.id, buildSpec(built, ctx, v), v.name);
  }

  return built;
}

/** True when a view spec references a property that is created late. */
function usesDeferredProperty(built: BuiltDatabase, v: ViewSpecInput): boolean {
  const names: string[] = [
    ...(v.group ?? []),
    ...(v.sort ?? []).map((s) => s.prop),
    ...(v.hidden ?? []),
    ...(v.calendarBy ? [v.calendarBy] : []),
    ...(v.timelineBy ? [v.timelineBy.start, ...(v.timelineBy.end ? [v.timelineBy.end] : [])] : []),
    ...Object.keys(v.aggregates ?? {}),
    ...(v.card?.properties ?? []),
    ...(v.filterRules ?? []).map((r) => r.prop),
  ];
  return names.some((name) => {
    const kind = built.spec.properties.find((p) => p.name === name)?.type;
    return kind === "relation" || kind === "rollup";
  });
}

/** Write the view specs that needed a relation property, once it exists. */
function applyDeferredViews(ctx: BuildCtx): void {
  for (const built of Object.values(ctx.built)) {
    for (const v of built.deferredViews) {
      updateViewSpec(ctx.db, v.id, buildSpec(built, ctx, v.spec), v.spec.name);
    }
    built.deferredViews = [];
  }
}

/** Relations, once every database in the template exists. */
function linkRelations(ctx: BuildCtx): void {
  for (const built of Object.values(ctx.built)) {
    for (const p of built.relationSpecs) {
      const target = ctx.built[p.relationTo ?? ""];
      if (!target) {
        throw new Error(`${built.title}.${p.name}: relation target "${p.relationTo}" does not exist in this template`);
      }
      const mirrorName = p.mirrorName ?? built.title;
      // A bidirectional pair is declared on both sides (OKR objectives ↔ key
      // results). `createRelation` creates the mirror itself, so the second
      // declaration is the same pair and must not be created twice.
      const existing = target.props[mirrorName];
      if (existing && (existing.config as { targetDb?: string }).targetDb === built.databaseId) {
        built.props[p.name] = existing;
        built.relationTarget[p.name] = target;
        // registered as a mirror so rows on the target may reference it
        target.mirrorNames.add(mirrorName);
        continue;
      }
      const rel = createRelation(ctx.db, built.databaseId, target.databaseId, p.name, mirrorName, {
        bidirectional: true,
      });
      built.props[p.name] = rel.source;
      target.props[mirrorName] = rel.mirror;
      built.relationTarget[p.name] = target;
      // The mirror is a property of the target database pointing back here, so
      // register it on that side too. A rollup on the target database can then
      // aggregate through it (Objectives rolls up through "Key results").
      target.props[rel.mirror.name] = rel.mirror;
      target.relationTarget[rel.mirror.name] = built;
      // Rows are validated against declared properties plus mirrors; without
      // this a row setting the mirror ("Habits") is rejected as unknown.
      target.mirrorNames.add(rel.mirror.name);
    }
  }
}

/** Rows whose values point at another database, created once relations exist. */
function createDeferredRows(ctx: BuildCtx): void {
  for (const built of Object.values(ctx.built)) {
    for (const r of built.deferredRows) built.rows[r.title] = createRowFromSpec(ctx, built, r);
  }
}

/**
 * True when a row sets a relation property. Every such row is created in the
 * deferred pass: the relation property does not exist before `linkRelations`,
 * and a row created before the rollups exist would cache a rollup of 0.
 */
function usesRelationValue(built: BuiltDatabase, r: RowSpec): boolean {
  for (const name of Object.keys(r.values ?? {})) {
    const kind = built.spec.properties.find((p) => p.name === name)?.type;
    // Declared as a relation, or created as a mirror by `createRelation` (the
    // Objectives database's "Key results", the Habit summary's "Habits").
    if (kind === "relation") return true;
    if (!built.spec.properties.some((p) => p.name === name) && built.mirrorNames.has(name)) return true;
    // A "row:" reference is a relation value by construction. Mirrors are only
    // known after linkRelations runs, which is later than this check, so the
    // reference itself is what makes the deferral order-independent.
    const v = r.values?.[name];
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.startsWith("row:"))) return true;
    if (typeof v === "string" && v.startsWith("row:")) return true;
  }
  return false;
}

/** Rollups, once the relations exist: they aggregate a property on the far side. */
function linkRollups(ctx: BuildCtx): void {
  for (const built of Object.values(ctx.built)) {
    for (const p of built.rollupSpecs) {
      const relation = p.rollup ? built.props[p.rollup.relation] : undefined;
      const targetDb = p.rollup ? built.relationTarget[p.rollup.relation] : undefined;
      const target = targetDb?.props[p.rollup?.target ?? ""];
      if (!relation || !target) {
        throw new Error(
          `${built.title}.${p.name}: rollup needs a relation property and a target property on its target database`,
        );
      }
      const prop = addProperty(
        ctx.db,
        built.databaseId,
        p.name,
        "rollup",
        { relationProp: relation.id, targetProp: target.id, function: p.rollup?.fn ?? "count" },
        { actor: ctx.actor },
      );
      built.props[p.name] = prop;
    }
  }
}

/** Write the relation edges whose target row did not exist when the row was made. */
function flushPendingEdges(ctx: BuildCtx): void {
  for (const built of Object.values(ctx.built)) {
    for (const e of built.pendingEdges) {
      const name = (getProperty(ctx.db, e.propId)?.name ?? "") as string;
      const value = resolveValue(built, ctx, name, e.raw);
      const rows = (value as { rows?: string[] } | null)?.rows;
      if (value === PENDING || !Array.isArray(rows) || !rows.length) {
        throw new Error(`${built.title}.${name}: relation target "${JSON.stringify(e.raw)}" never resolved to a row`);
      }
      setPropertyValue(ctx.db, e.rowId, e.propId, value as never, { actor: ctx.actor });
    }
    built.pendingEdges = [];
  }
}

/** Cache every formula and rollup result, in every row of the template. */
function recomputeAllRows(ctx: BuildCtx): void {
  for (const built of Object.values(ctx.built)) {
    for (const rowId of Object.values(built.rows)) recomputeRow(ctx.db, rowId);
  }
}

function propConfig(p: PropSpec): Record<string, unknown> {
  const c: Record<string, unknown> = { ...(p.config ?? {}) };
  if (p.type === "number") {
    c.format = p.format ?? "number";
    c.precision = p.precision ?? 0;
    if (p.showAsBar) c.showAsBar = true;
  }
  if (p.type === "unique_id") c.prefix = p.prefix ?? "";
  if (p.type === "date") c.withTime = false;
  return c;
}

function applyStatusGroups(
  db: Db,
  prop: PropertyDef,
  groups: StatusGroupSpec[],
  options: Record<string, string>,
  propName: string,
): void {
  const built: StatusGroup[] = groups.map((g) => ({
    id: g.id,
    name: g.name,
    color: g.color as never,
    options: g.options.map((o) => {
      const id = newId();
      options[`${propName}:${o.name}`] = id;
      return { id, name: o.name, color: o.color as never };
    }),
  }));
  db.run("UPDATE property_def SET config = ? WHERE id = ?", JSON.stringify({ groups: built }), prop.id);
  prop.config = { groups: built } as never;
}

function buildSpec(built: BuiltDatabase, ctx: BuildCtx, v: ViewSpecInput): ViewSpec {
  const propId = (name: string): string => {
    const prop = built.props[name];
    if (!prop) throw new Error(`${built.title}: view "${v.name}" references unknown property "${name}"`);
    return prop.id;
  };

  const out: ViewSpec = {
    ...defaultViewSpec(),
    aggregates: {},
    card: { size: "medium", properties: [] },
  };

  if (v.group) out.group = v.group.map((name) => ({ prop: propId(name) }));
  if (v.sort) out.sort = v.sort.map((s) => ({ prop: propId(s.prop), direction: s.direction }));
  if (v.hidden) out.hidden = v.hidden.map(propId);
  if (v.calendarBy) out.calendarBy = propId(v.calendarBy);
  if (v.timelineBy) {
    out.timelineBy = {
      start: propId(v.timelineBy.start),
      ...(v.timelineBy.end ? { end: propId(v.timelineBy.end) } : {}),
    };
  }
  if (v.aggregates) {
    for (const [name, fn] of Object.entries(v.aggregates)) out.aggregates[propId(name)] = fn as never;
  }
  if (v.card) {
    out.card = {
      size: v.card.size,
      properties: v.card.properties.map(propId),
      ...(v.card.cover ? { cover: propId(v.card.cover) } : {}),
    };
  }
  if (v.filterRules) {
    out.filter = {
      and: true,
      rules: v.filterRules.map((r) => ({
        prop: propId(r.prop),
        operator: r.operator as never,
        value: resolveValue(built, ctx, r.prop, r.value) as never,
      })),
    };
  }
  return out;
}

// ── values ───────────────────────────────────────────────────────────────────

function createRowFromSpec(ctx: BuildCtx, built: BuiltDatabase, r: RowSpec): string {
  const values: Record<string, unknown> = { Name: r.title, ...(r.values ?? {}) };

  const payload: Record<string, unknown> = {};
  const deferred: { propId: string; raw: unknown }[] = [];
  for (const [name, raw] of Object.entries(values)) {
    const prop = built.props[name];
    if (!prop) throw new Error(`${built.title}: row "${r.title}" sets unknown property "${name}"`);
    const value = resolveValue(built, ctx, name, raw);
    if (value === PENDING) {
      deferred.push({ propId: prop.id, raw });
      continue;
    }
    payload[prop.id] = value;
  }

  const rowId = createRow(ctx.db, built.databaseId, payload as never, { actor: ctx.actor });

  // A relation may point at a row that does not exist yet — a self-relation
  // ("Related pages" linking "Fractional indexes" to "Op log", which is the
  // next row) is the common case. Those edges are written once every row of
  // every database exists.
  for (const d of deferred) built.pendingEdges.push({ rowId, ...d });

  for (const [type, text, props] of r.blocks ?? []) {
    createNode(ctx.db, {
      ws: ctx.ws,
      kind: "block",
      type: type as never,
      parent_id: rowId,
      parent_kind: "node",
      body: plainTextToBody(text),
      props: props ?? {},
      actor: ctx.actor,
    });
  }
  return rowId;
}

/**
 * Translate a readable value into the storage shape:
 *  - "opt:Label"      → select / multi_select / status option id
 *  - "row:Title"      → relation target row, in the property's target database
 *  - "db:Title:Row"   → relation target row, named by database title
 *  - { day: n }       → date at today + n days
 *  - { days: [a, b] } → date range
 */
const PENDING = Symbol("relation target not created yet");

function resolveValue(built: BuiltDatabase, ctx: BuildCtx, name: string, raw: unknown): unknown {
  const prop = built.props[name];
  const relationDb = prop?.type === "relation" ? built.relationTarget[name] : undefined;

  if (typeof raw === "string") {
    if (raw.startsWith("opt:")) return [optionId(built, name, raw.slice(4))];
    if (raw.startsWith("row:")) {
      // A relation's rows live in the target database; a self-relation targets
      // this one.
      const owner = relationDb ?? built;
      const id = owner.rows[raw.slice(4)];
      // Not created yet: the caller queues the edge and writes it later.
      if (!id) return PENDING;
      return { rows: [id] };
    }
    if (raw.startsWith("db:")) {
      const rest = raw.slice(3);
      const sep = rest.indexOf(":");
      const target = ctx.built[rest.slice(0, sep)];
      if (!target) throw new Error(`${built.title}.${name}: database "${rest.slice(0, sep)}" not built yet`);
      const id = target.rows[rest.slice(sep + 1)];
      if (!id) throw new Error(`${built.title}.${name}: no row "${rest.slice(sep + 1)}" in "${target.title}"`);
      return { rows: [id] };
    }
    return raw;
  }
  if (Array.isArray(raw)) {
    const parts = raw.map((x) => resolveValue(built, ctx, name, x));
    if (parts.some((v) => v === PENDING)) return PENDING;
    // A relation list is a list of { rows: [...] } — flatten the target ids into
    // one relation value. A multi_select list is a list of option ids.
    if (parts.every((v) => v && typeof v === "object" && !Array.isArray(v) && "rows" in (v as object))) {
      const rows: string[] = [];
      for (const v of parts) rows.push(...((v as { rows: string[] }).rows ?? []));
      return { rows };
    }
    return parts.map((v) => (Array.isArray(v) ? v[0] : v));
  }
  if (raw && typeof raw === "object") {
    const o = raw as { day?: number; days?: [number, number]; allDay?: boolean; withTime?: boolean };
    if (o.days) return { start: day(o.days[0]), end: day(o.days[1]), allDay: o.allDay ?? true };
    if (o.day !== undefined) return { start: day(o.day), end: null, allDay: o.allDay ?? true };
  }
  return raw;
}

function optionId(built: BuiltDatabase, name: string, label: string): string {
  const id = built.options[`${name}:${label}`];
  if (!id) throw new Error(`${built.title}.${name}: no option "${label}"`);
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// The library
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATES: TemplateDef[] = [
  // ── 1. Meeting notes ───────────────────────────────────────────────────────
  {
    name: "Meeting notes",
    icon: "📅",
    scope: "page",
    description: "Agenda, attendees, decisions and action items — with a Tasks database that relates back to this meeting.",
    build: (ctx) => {
      h1(ctx, "Meeting notes");
      callout(
        ctx,
        rich([
          "Fill the agenda before the call, capture decisions during it, and every action item becomes a row that ",
          ["links back to this meeting", { bold: true }],
          " through the Meeting relation.",
        ]),
        "🗓️",
      );
      h2(ctx, "Attendees");
      para(ctx, "Add each attendee as a bulleted line, or as a row in the Attendees database.");
      for (const name of ["Ana (facilitator)", "Rui (note-taker)", "Sam", "Priya"]) bullet(ctx, name);
      h2(ctx, "Agenda");
      for (const a of [
        "Review last meeting's action items",
        "Current status and blockers",
        "Decisions needed today",
        "Next steps and owners",
      ]) {
        numbered(ctx, a);
      }
      h2(ctx, "Decisions");
      para(ctx, "One decision per line. Write the decision, then the reason — future readers need the reason.");
      bullet(ctx, rich([["Decision: ", { bold: true }], "Ship the board view first, the timeline next quarter."]));
      bullet(ctx, rich([["Why: ", { bold: true }], "Board is the smallest change that unblocks the design review."]));
      h2(ctx, "Notes");
      para(ctx, "Free-form notes taken during the meeting.");
      divider(ctx);
      h2(ctx, "Parking lot");
      para(ctx, "Topics that came up but are out of scope today.");
      bullet(ctx, "Vendor pricing for the next cycle");
    },
    databases: [
      {
        title: "Action items",
        icon: "✅",
        heading: "Action items",
        properties: [
          { name: "Owner", type: "text" },
          { name: "Due", type: "date" },
          {
            name: "State",
            type: "status",
            statusGroups: [
              { id: "to_do", name: "To do", color: "gray", options: [{ name: "Not started", color: "gray" }] },
              { id: "in_progress", name: "In progress", color: "blue", options: [{ name: "In progress", color: "blue" }] },
              {
                id: "complete",
                name: "Done",
                color: "green",
                options: [
                  { name: "Done", color: "green" },
                  { name: "Cancelled", color: "red" },
                ],
              },
            ],
          },
          {
            name: "Priority",
            type: "select",
            options: [
              { name: "P0", color: "red" },
              { name: "P1", color: "orange" },
              { name: "P2", color: "blue" },
            ],
          },
          { name: "Notes", type: "text" },
          { name: "Ref", type: "unique_id", prefix: "AI" },
          { name: "Logged", type: "created_time" },
          {
            name: "Overdue",
            type: "formula",
            formula:
              'if(empty(Due), "no due date", if(Due < today(), concat("late ", toNumber(dateDiff(today(), Due, "days")), "d"), concat("in ", toNumber(dateDiff(Due, today(), "days")), "d")))',
          },
        ],
        rows: [
          {
            title: "Draft the board-view spec",
            values: { Owner: "Ana", Due: { day: 3 }, State: "opt:In progress", Priority: "opt:P0", Notes: "Include the group-by rules." },
            blocks: [["paragraph", "The spec needs the fractional-index reorder path written down before design review."]],
          },
          { title: "Book the design-review slot", values: { Owner: "Rui", Due: { day: 1 }, State: "opt:Not started", Priority: "opt:P1" } },
          { title: "Collect latency numbers", values: { Owner: "Priya", Due: { day: -2 }, State: "opt:In progress", Priority: "opt:P1", Notes: "p95 over the last 7 days." } },
          { title: "Retire the legacy import script", values: { Owner: "Sam", Due: { day: 10 }, State: "opt:Cancelled", Priority: "opt:P2" } },
        ],
        views: [
          { name: "Table", type: "table", sort: [{ prop: "Due", direction: "ascending" }], aggregates: { Ref: "countAll", Due: "countAll" } },
          { name: "Board", type: "board", group: ["State"], sort: [{ prop: "Priority", direction: "ascending" }] },
          { name: "Calendar", type: "calendar", calendarBy: "Due", hidden: ["Notes"] },
        ],
      },
      {
        title: "Attendees",
        icon: "👥",
        heading: "Attendees",
        properties: [
          { name: "Role", type: "text" },
          { name: "Email", type: "email" },
          { name: "Attended", type: "checkbox" },
        ],
        rows: [
          { title: "Ana", values: { Role: "Facilitator", Email: "ana@example.com", Attended: true } },
          { title: "Rui", values: { Role: "Note-taker", Email: "rui@example.com", Attended: true } },
          { title: "Priya", values: { Role: "Engineering", Email: "priya@example.com", Attended: true } },
          { title: "Sam", values: { Role: "Design", Email: "sam@example.com", Attended: false } },
        ],
        views: [{ name: "Table", type: "table", aggregates: { Attended: "countChecked" } }],
      },
    ],
  },

  // ── 2. Weekly review ───────────────────────────────────────────────────────
  {
    name: "Weekly review",
    icon: "🔄",
    scope: "page",
    description: "Shipped, in progress and blocked as one database, plus wins, blockers and next week's plan.",
    build: (ctx) => {
      h1(ctx, "Weekly review");
      callout(ctx, "Five minutes at the end of the week buys back the next one. Fill the database first, then write the three paragraphs.", "🔁", "purple_background");
      h2(ctx, "Wins");
      bullet(ctx, "Board view landed and the design review approved it.");
      bullet(ctx, "p95 query time down from 42 ms to 11 ms after the typed-column index.");
      h2(ctx, "Blockers");
      bullet(ctx, rich([["Blocked: ", { bold: true }], "the provider adapter needs a decision on streaming — nobody owns it."]));
      h2(ctx, "What I learned");
      para(ctx, "Fractional indexes mean a drag-reorder writes exactly one row. Every design that renumbered siblings was the wrong design.");
      h2(ctx, "Next week");
      for (const n of ["Streaming for the provider adapter", "Calendar view for the demo workspace", "Write the formula language reference"]) {
        todo(ctx, n);
      }
      divider(ctx);
      h2(ctx, "How to use this template");
      numbered(ctx, "Add every item you touched this week to the Weekly items database.");
      numbered(ctx, "Set State; the board columns are the three states.");
      numbered(ctx, "The Progress formula on each row shows how close the item is; the rollups below aggregate them.");
    },
    databases: [
      {
        title: "Weekly items",
        icon: "🧭",
        heading: "Shipped · in progress · blocked",
        properties: [
          { name: "Area", type: "select", options: [
            { name: "Product", color: "blue" },
            { name: "Engineering", color: "purple" },
            { name: "Ops", color: "orange" },
            { name: "Personal", color: "green" },
          ] },
          { name: "State", type: "status", statusGroups: [
            { id: "to_do", name: "Not started", color: "gray", options: [{ name: "Not started", color: "gray" }] },
            { id: "in_progress", name: "In progress", color: "blue", options: [
              { name: "In progress", color: "blue" },
              { name: "Blocked", color: "red" },
            ] },
            { id: "complete", name: "Shipped", color: "green", options: [{ name: "Shipped", color: "green" }] },
          ] },
          { name: "Done", type: "checkbox" },
          { name: "DaysSpent", type: "number", format: "number", precision: 1 },
          { name: "Notes", type: "text" },
          { name: "Reviewed", type: "date" },
          { name: "Progress", type: "formula", formula: "if(Done, 100, 0)" },
        ],
        rows: [
          { title: "Board view", values: { Area: "opt:Product", State: "opt:Shipped", Done: true, DaysSpent: 2.5, Reviewed: { day: 0 }, Notes: "Approved in the design review." } },
          { title: "Query performance pass", values: { Area: "opt:Engineering", State: "opt:Shipped", Done: true, DaysSpent: 1.5, Reviewed: { day: 0 } } },
          { title: "Provider adapter streaming", values: { Area: "opt:Engineering", State: "opt:Blocked", Done: false, DaysSpent: 3, Reviewed: { day: 0 }, Notes: "Needs an owner." } },
          { title: "Formula language reference", values: { Area: "opt:Ops", State: "opt:In progress", Done: false, DaysSpent: 0.5, Reviewed: { day: 0 } } },
          { title: "Inbox zero", values: { Area: "opt:Personal", State: "opt:Not started", Done: false, DaysSpent: 0, Reviewed: { day: 0 } } },
        ],
        views: [
          { name: "Table", type: "table", aggregates: { Done: "percentChecked", DaysSpent: "sum", Progress: "avg" } },
          { name: "Board", type: "board", group: ["State"], sort: [{ prop: "DaysSpent", direction: "descending" }] },
          { name: "By area", type: "board", group: ["Area"], hidden: ["Notes"] },
        ],
      },
    ],
  },

  // ── 3. Project brief ───────────────────────────────────────────────────────
  {
    name: "Project brief",
    icon: "🗺️",
    scope: "page",
    description: "Goal, scope, milestones (timeline-ready with start, end, status and owner) and a risk register.",
    build: (ctx) => {
      h1(ctx, "Project brief");
      callout(ctx, rich([["One sentence: ", { bold: true }], "what this project is, and who it is for. If this line is fuzzy, stop and fix it before writing the rest."]), "🎯", "green_background");
      h2(ctx, "Goal");
      para(ctx, "The outcome, stated so a reader can tell whether it happened.");
      h2(ctx, "Scope");
      h3(ctx, "In scope");
      bullet(ctx, "The block editor's drag-and-drop reorder path.");
      bullet(ctx, "Board and calendar views over the relational layer.");
      h3(ctx, "Out of scope");
      bullet(ctx, "Multi-device sync.");
      bullet(ctx, "Real-time collaboration.");
      h2(ctx, "Success metrics");
      bullet(ctx, rich([["Metric: ", { bold: true }], "median time to reorder a 200-block page under 16 ms."]));
      bullet(ctx, rich([["Metric: ", { bold: true }], "zero data-loss reports after the typed-column migration."]));
      h2(ctx, "Timeline");
      para(ctx, "The Milestones database below has Start and End dates, so the Timeline view renders it as a Gantt chart.");
      h2(ctx, "Risks");
      para(ctx, "Risk = likelihood × impact. Anything scoring 9 or more needs a named mitigation.");
    },
    databases: [
      {
        title: "Milestones",
        icon: "🏁",
        heading: "Milestones",
        properties: [
          { name: "Owner", type: "text" },
          { name: "Start", type: "date" },
          { name: "End", type: "date" },
          { name: "State", type: "status", statusGroups: [
            { id: "to_do", name: "Planned", color: "gray", options: [{ name: "Planned", color: "gray" }] },
            { id: "in_progress", name: "Active", color: "blue", options: [
              { name: "Active", color: "blue" },
              { name: "At risk", color: "orange" },
            ] },
            { id: "complete", name: "Shipped", color: "green", options: [{ name: "Shipped", color: "green" }] },
          ] },
          { name: "Done", type: "checkbox" },
          { name: "Days", type: "formula", formula: 'if(empty(Start) || empty(End), 0, dateDiff(End, Start, "days") + 1)' },
          { name: "Status", type: "formula", formula: 'if(Done, "shipped", if(empty(End), "unscheduled", if(End < today(), "late", "on track")))' },
        ],
        rows: [
          { title: "M1 — typed columns + query engine", values: { Owner: "Rui", Start: { day: -21 }, End: { day: -7 }, State: "opt:Shipped", Done: true } },
          { title: "M2 — board + calendar views", values: { Owner: "Ana", Start: { day: -7 }, End: { day: 7 }, State: "opt:Active", Done: false } },
          { title: "M3 — formula properties", values: { Owner: "Priya", Start: { day: 7 }, End: { day: 21 }, State: "opt:Planned", Done: false } },
          { title: "M4 — provider adapters", values: { Owner: "Sam", Start: { day: 21 }, End: { day: 35 }, State: "opt:At risk", Done: false } },
        ],
        views: [
          { name: "Table", type: "table", sort: [{ prop: "Start", direction: "ascending" }], aggregates: { Done: "percentChecked", Days: "sum" } },
          { name: "Timeline", type: "timeline", timelineBy: { start: "Start", end: "End" }, sort: [{ prop: "Start", direction: "ascending" }] },
          { name: "Board", type: "board", group: ["State"] },
        ],
      },
      {
        title: "Risks",
        icon: "⚠️",
        heading: "Risk register",
        properties: [
          { name: "Likelihood", type: "number", format: "number", precision: 0 },
          { name: "Impact", type: "number", format: "number", precision: 0 },
          { name: "Severity", type: "formula", formula: "Likelihood * Impact" },
          { name: "Mitigation", type: "text" },
          { name: "Owner", type: "text" },
          { name: "Open", type: "checkbox" },
        ],
        rows: [
          { title: "Streaming API changes under us", values: { Likelihood: 3, Impact: 4, Mitigation: "Wrap the provider behind one adapter interface.", Owner: "Sam", Open: true } },
          { title: "Fractional index key growth", values: { Likelihood: 2, Impact: 5, Mitigation: "Rebalance a parent when a key passes the length cap.", Owner: "Ana", Open: true } },
          { title: "SQLite build drift across machines", values: { Likelihood: 2, Impact: 3, Mitigation: "Pin Node 24; no native modules.", Owner: "Rui", Open: false } },
        ],
        views: [
          { name: "Table", type: "table", sort: [{ prop: "Severity", direction: "descending" }], aggregates: { Severity: "max", Open: "countChecked" } },
          { name: "Open only", type: "table", filterRules: [{ prop: "Open", operator: "checked" }], hidden: ["Mitigation"] },
        ],
      },
    ],
  },

  // ── 4. Product spec (PRD) ──────────────────────────────────────────────────
  {
    name: "Product spec (PRD)",
    icon: "📐",
    scope: "page",
    description: "Problem, goals, non-goals, a prioritised requirements table with MoSCoW status, and open questions.",
    build: (ctx) => {
      h1(ctx, "Product spec");
      callout(ctx, rich([["Status: ", { bold: true }], "Draft. ", ["Owner: ", { bold: true }], "product lead. ", ["Reviewers: ", { bold: true }], "eng lead, design lead."]), "📝");
      h2(ctx, "Problem");
      para(ctx, "Write the problem as something a specific person experiences, with evidence. If you cannot name the person, the problem is not real yet.");
      quote(ctx, "“I reorder my task list every morning and the app renumbers every row, so the drag stutters on a big page.”");
      h2(ctx, "Goals");
      bullet(ctx, "Reordering a 200-block page costs exactly one row write.");
      bullet(ctx, "The same filter definition drives every view, so a board and a table never disagree.");
      h2(ctx, "Non-goals");
      bullet(ctx, "Real-time multi-user editing.");
      bullet(ctx, "A mobile-native app.");
      h2(ctx, "Requirements");
      para(ctx, "MoSCoW status in the database below; the board view groups by it.");
      h2(ctx, "Design");
      para(ctx, "Link the mockups here. Describe the interaction, not the pixels.");
      h2(ctx, "Open questions");
      bullet(ctx, rich([["Q: ", { bold: true }], "Do we rebalance keys eagerly or lazily? Needs a benchmark first."]));
      bullet(ctx, rich([["Q: ", { bold: true }], "Does the board persist a card order per column?"]));
      h2(ctx, "Rollout");
      numbered(ctx, "Behind a flag for two weeks.");
      numbered(ctx, "Instrument the reorder write count.");
      numbered(ctx, "Remove the old path once the flag is on by default.");
    },
    databases: [
      {
        title: "Requirements",
        icon: "📋",
        heading: "Requirements",
        properties: [
          { name: "Priority", type: "number", format: "number", precision: 0 },
          { name: "MoSCoW", type: "status", statusGroups: [
            { id: "to_do", name: "Must / Should", color: "red", options: [
              { name: "Must", color: "red" },
              { name: "Should", color: "orange" },
            ] },
            { id: "in_progress", name: "Could", color: "blue", options: [{ name: "Could", color: "blue" }] },
            { id: "complete", name: "Won't", color: "gray", options: [{ name: "Won't (this release)", color: "gray" }] },
          ] },
          { name: "Component", type: "select", options: [
            { name: "Editor", color: "blue" },
            { name: "Database", color: "purple" },
            { name: "Views", color: "green" },
            { name: "API", color: "orange" },
          ] },
          { name: "Effort", type: "select", options: [
            { name: "S", color: "green" },
            { name: "M", color: "blue" },
            { name: "L", color: "orange" },
            { name: "XL", color: "red" },
          ] },
          { name: "Accepted", type: "checkbox" },
          { name: "Owner", type: "text" },
          { name: "Notes", type: "text" },
          { name: "Rank", type: "formula", formula: 'concat(if(Accepted, "accepted", "open"), " · P", toString(Priority))' },
        ],
        rows: [
          { title: "One row write per reorder", values: { Priority: 1, MoSCoW: "opt:Must", Component: "opt:Editor", Effort: "opt:M", Accepted: true, Owner: "Ana", Notes: "Fractional index between neighbours." } },
          { title: "Shared filter across views", values: { Priority: 1, MoSCoW: "opt:Must", Component: "opt:Views", Effort: "opt:L", Accepted: true, Owner: "Rui" } },
          { title: "Board card order per column", values: { Priority: 2, MoSCoW: "opt:Should", Component: "opt:Views", Effort: "opt:M", Accepted: false, Owner: "Ana" } },
          { title: "Keyboard-only reorder", values: { Priority: 3, MoSCoW: "opt:Could", Component: "opt:Editor", Effort: "opt:S", Accepted: false, Owner: "Sam" } },
          { title: "Multi-user drag locks", values: { Priority: 5, MoSCoW: "opt:Won't (this release)", Component: "opt:API", Effort: "opt:XL", Accepted: false, Notes: "Out of scope: no realtime layer." } },
        ],
        views: [
          { name: "Table", type: "table", sort: [{ prop: "Priority", direction: "ascending" }], aggregates: { Accepted: "percentChecked", Priority: "countAll" } },
          { name: "MoSCoW board", type: "board", group: ["MoSCoW"], hidden: ["Notes"] },
          { name: "Must-have", type: "table", filterRules: [{ prop: "MoSCoW", operator: "is", value: "opt:Must" }], sort: [{ prop: "Priority", direction: "ascending" }] },
        ],
      },
    ],
  },

  // ── 5. Bug tracker ─────────────────────────────────────────────────────────
  {
    name: "Bug tracker",
    icon: "🐞",
    scope: "page",
    description: "Severity, component, repro steps and assignee, with board, table and calendar views over the triage date.",
    build: (ctx) => {
      h1(ctx, "Bug tracker");
      callout(ctx, "A bug is reproducible or it is a hypothesis. Steps to reproduce, expected, actual — every time.", "🐞", "red_background");
      h2(ctx, "How to file a good bug");
      numbered(ctx, "Title: what breaks, where. Not “it crashes”.");
      numbered(ctx, "Severity: how bad it is for a user, not how hard it is to fix.");
      numbered(ctx, "Component: the one module that owns the fix.");
      numbered(ctx, "Repro: steps, expected, actual, and the version you saw it on.");
      h2(ctx, "Triage rules");
      bullet(ctx, "S1 (critical) gets an owner within a day.");
      bullet(ctx, "Anything with no repro steps goes back to the reporter, not the backlog.");
      h2(ctx, "Open bugs");
      para(ctx, "The board below is grouped by severity; the calendar is triage dates.");
    },
    databases: [
      {
        title: "Bugs",
        icon: "🐞",
        properties: [
          { name: "Severity", type: "status", statusGroups: [
            { id: "to_do", name: "Untriaged", color: "gray", options: [{ name: "Untriaged", color: "gray" }] },
            { id: "in_progress", name: "Open", color: "red", options: [
              { name: "S1 critical", color: "red" },
              { name: "S2 major", color: "orange" },
              { name: "S3 minor", color: "yellow" },
            ] },
            { id: "complete", name: "Closed", color: "green", options: [
              { name: "Fixed", color: "green" },
              { name: "Not a bug", color: "gray" },
              { name: "Duplicate", color: "gray" },
            ] },
          ] },
          { name: "Component", type: "select", options: [
            { name: "editor", color: "blue" },
            { name: "database", color: "purple" },
            { name: "views", color: "green" },
            { name: "sync", color: "orange" },
            { name: "ui", color: "pink" },
          ] },
          { name: "ReproSteps", type: "text" },
          { name: "Expected", type: "text" },
          { name: "Actual", type: "text" },
          { name: "Assignee", type: "text" },
          { name: "Reporter", type: "text" },
          { name: "Opened", type: "date" },
          { name: "Triage", type: "date" },
          { name: "Resolved", type: "date" },
          { name: "Reproducible", type: "checkbox" },
          { name: "Ticket", type: "unique_id", prefix: "BUG" },
          { name: "Age", type: "formula", formula: 'if(empty(Opened), 0, toNumber(dateDiff(today(), Opened, "days")))' },
          { name: "Triage status", type: "formula", formula: 'if(empty(Triage), "needs triage", if(Reproducible, "ready", "needs repro"))' },
        ],
        rows: [
          {
            title: "Drag reorder renumbers every sibling",
            values: {
              Severity: "opt:S1 critical", Component: "opt:editor", Opened: { day: -4 },
              "ReproSteps": "1. Open a 200-block page. 2. Drag block 150 to the top.",
              Expected: "One row write.", Actual: "Every sibling is rewritten; the drag stutters.",
              Assignee: "Ana", Reporter: "Rui", Triage: { day: -1 }, Reproducible: true,
            },
            blocks: [["paragraph", "Suspect: the reorder path recomputes positions for the whole parent instead of writing a key between neighbours."]],
          },
          {
            title: "Board shows a task after the relation is cleared",
            values: {
              Severity: "opt:S2 major", Component: "opt:database", Opened: { day: -6 },
              "ReproSteps": "1. Link a task to a project. 2. Remove the link from the task. 3. Open the project's board.",
              Expected: "The task is gone.", Actual: "The mirror edge survives and the card stays.",
              Assignee: "Rui", Reporter: "Priya", Triage: { day: -3 }, Reproducible: true,
            },
          },
          {
            title: "Calendar month label uses the local timezone",
            values: {
              Severity: "opt:S3 minor", Component: "opt:views", Opened: { day: -2 },
              "ReproSteps": "Open the calendar view at 23:30 local with a UTC+2 offset.",
              Expected: "UTC bucketing, matching the formula engine.", Actual: "Buckets shift by a day.",
              Assignee: "Sam", Reporter: "Sam", Triage: { day: 1 }, Reproducible: true,
            },
          },
          { title: "Search returns trashed pages", values: { Severity: "opt:Untriaged", Component: "opt:database", Opened: { day: 0 }, "ReproSteps": "Trash a page, search for its title.", Assignee: "", Reporter: "Ana", Reproducible: false } },
          { title: "Formula shows empty for a valid dateDiff", values: { Severity: "opt:Fixed", Component: "opt:database", Opened: { day: -14 }, Assignee: "Priya", Reporter: "Ana", Triage: { day: -10 }, Resolved: { day: -6 }, Reproducible: true } },
        ],
        views: [
          { name: "Table", type: "table", sort: [{ prop: "Severity", direction: "ascending" }], hidden: ["Expected", "Actual"], aggregates: { Reproducible: "countChecked", Ticket: "countAll", Age: "avg" } },
          { name: "Board", type: "board", group: ["Severity"], sort: [{ prop: "Triage", direction: "ascending" }], hidden: ["Expected", "Actual", "Reporter"] },
          { name: "Calendar", type: "calendar", calendarBy: "Triage", hidden: ["ReproSteps", "Expected", "Actual"] },
          { name: "Needs triage", type: "table", filterRules: [{ prop: "Severity", operator: "is", value: "opt:Untriaged" }], hidden: ["Expected", "Actual"] },
        ],
      },
    ],
  },

  // ── 6. Reading list ────────────────────────────────────────────────────────
  {
    name: "Reading list",
    icon: "📚",
    scope: "page",
    description: "Title, author, status, rating, pages and finished date, with gallery and table views.",
    build: (ctx) => {
      h1(ctx, "Reading list");
      callout(ctx, "A book you finished and forgot is a book you did not read. The Notes column is the point of this template.", "📖", "yellow_background");
      h2(ctx, "This month");
      bullet(ctx, rich([["Reading: ", { bold: true }], "Designing Data-Intensive Applications."]));
      bullet(ctx, rich([["Queued: ", { bold: true }], "The Timeless Way of Building."]));
      h2(ctx, "Rules");
      bullet(ctx, "Rate on a 1–5 scale against what you read it for, not in the abstract.");
      bullet(ctx, "Write the one-line takeaway the day you finish, while it is still true.");
      h2(ctx, "Shelf");
      para(ctx, "The gallery view shows the status and rating on each card.");
    },
    databases: [
      {
        title: "Books",
        icon: "📚",
        properties: [
          { name: "Author", type: "text" },
          { name: "Status", type: "status", statusGroups: [
            { id: "to_do", name: "Queued", color: "gray", options: [
              { name: "Queued", color: "gray" },
              { name: "Want to read", color: "blue" },
            ] },
            { id: "in_progress", name: "Reading", color: "yellow", options: [{ name: "Reading", color: "yellow" }] },
            { id: "complete", name: "Finished", color: "green", options: [
              { name: "Finished", color: "green" },
              { name: "Abandoned", color: "red" },
            ] },
          ] },
          { name: "Rating", type: "number", format: "number", precision: 1 },
          { name: "Pages", type: "number", format: "number", precision: 0 },
          { name: "Page", type: "number", format: "number", precision: 0 },
          { name: "Started", type: "date" },
          { name: "Finished", type: "date" },
          { name: "Genre", type: "multi_select", options: [
            { name: "engineering", color: "blue" },
            { name: "design", color: "purple" },
            { name: "business", color: "orange" },
            { name: "fiction", color: "pink" },
          ] },
          { name: "Notes", type: "text" },
          { name: "Link", type: "url" },
          { name: "Progress", type: "formula", formula: 'if(empty(Pages) || Pages == 0, 0, round(100 * Page / Pages, 0))' },
          { name: "Summary", type: "formula", formula: 'concat(Name, " — ", Author, if(empty(Rating), "", concat(" · ", toString(Rating), "/5")))' },
        ],
        rows: [
          { title: "Designing Data-Intensive Applications", values: { Author: "Martin Kleppmann", Status: "opt:Reading", Rating: 5, Pages: 612, Page: 340, Started: { day: -12 }, Genre: ["opt:engineering"], Notes: "Chapter 5 is the replication chapter everyone should read twice.", Link: "https://dataintensive.net" } },
          { title: "The Timeless Way of Building", values: { Author: "Christopher Alexander", Status: "opt:Queued", Pages: 551, Page: 0, Genre: ["opt:design"], Notes: "Recommended for the pattern language in the block schema." } },
          { title: "Shape Up", values: { Author: "Ryan Singer", Status: "opt:Finished", Rating: 4, Pages: 216, Page: 216, Started: { day: -60 }, Finished: { day: -40 }, Genre: ["opt:business"], Notes: "Ramps over roadmaps. Adopted for the quarterly plan." } },
          { title: "The Pragmatic Programmer", values: { Author: "Hunt & Thomas", Status: "opt:Finished", Rating: 4, Pages: 352, Page: 352, Started: { day: -120 }, Finished: { day: -95 }, Genre: ["opt:engineering"] } },
          { title: "Dune", values: { Author: "Frank Herbert", Status: "opt:Abandoned", Rating: 2, Pages: 688, Page: 120, Started: { day: -200 }, Genre: ["opt:fiction"], Notes: "Not the right season for it." } },
        ],
        views: [
          { name: "Table", type: "table", sort: [{ prop: "Finished", direction: "descending" }], hidden: ["Notes"], aggregates: { Rating: "avg", Pages: "sum", Progress: "avg" } },
          { name: "Gallery", type: "gallery", card: { size: "medium", properties: ["Status", "Rating", "Author", "Progress"] }, group: ["Status"] },
          { name: "Reading now", type: "table", filterRules: [{ prop: "Status", operator: "is", value: "opt:Reading" }], sort: [{ prop: "Progress", direction: "descending" }] },
        ],
      },
    ],
  },

  // ── 7. Content calendar ────────────────────────────────────────────────────
  {
    name: "Content calendar",
    icon: "📣",
    scope: "page",
    description: "Title, channel, status, publish date and word count, with calendar and board views over the pipeline.",
    build: (ctx) => {
      h1(ctx, "Content calendar");
      callout(ctx, "Publishing is a pipeline, not a mood. Every piece has a channel, a date, and an owner before it has a draft.", "🗞️", "orange_background");
      h2(ctx, "Cadence");
      bullet(ctx, "Engineering blog: one post a month, published the second Tuesday.");
      bullet(ctx, "Changelog: every release, same day.");
      bullet(ctx, "Newsletter: last Friday of the month.");
      h2(ctx, "Editorial rules");
      numbered(ctx, "A piece starts as an idea row, never a document.");
      numbered(ctx, "It moves to Drafting only when the outline is in the row's page.");
      numbered(ctx, "Nothing publishes without a review date in the past.");
      h2(ctx, "Pipeline");
      para(ctx, "The board view is the pipeline; the calendar view is the schedule.");
    },
    databases: [
      {
        title: "Content",
        icon: "📣",
        properties: [
          { name: "Channel", type: "select", options: [
            { name: "Blog", color: "blue" },
            { name: "Changelog", color: "green" },
            { name: "Newsletter", color: "purple" },
            { name: "Docs", color: "orange" },
          ] },
          { name: "Status", type: "status", statusGroups: [
            { id: "to_do", name: "Backlog", color: "gray", options: [
              { name: "Idea", color: "gray" },
              { name: "Outlined", color: "blue" },
            ] },
            { id: "in_progress", name: "Writing", color: "yellow", options: [
              { name: "Drafting", color: "yellow" },
              { name: "In review", color: "orange" },
            ] },
            { id: "complete", name: "Published", color: "green", options: [
              { name: "Published", color: "green" },
              { name: "Killed", color: "red" },
            ] },
          ] },
          { name: "Publish", type: "date" },
          { name: "Review", type: "date" },
          { name: "Words", type: "number", format: "number", precision: 0 },
          { name: "Author", type: "text" },
          { name: "Tags", type: "multi_select", options: [
            { name: "performance", color: "red" },
            { name: "release", color: "green" },
            { name: "design", color: "purple" },
          ] },
          { name: "Published", type: "checkbox" },
          { name: "Draft", type: "formula", formula: 'if(empty(Words) || Words == 0, "not started", if(Words < 800, "short", if(Words < 2000, "standard", "long read")))' },
          { name: "Schedule", type: "formula", formula: 'if(Published, "live", if(empty(Publish), "unscheduled", if(Publish < today(), concat("overdue ", toNumber(dateDiff(today(), Publish, "days")), "d"), "on track")))' },
        ],
        rows: [
          { title: "Why a drag-reorder writes one row", values: { Channel: "opt:Blog", Status: "opt:Drafting", Publish: { day: 9 }, Review: { day: 4 }, Words: 1450, Author: "Ana", Tags: ["opt:performance"], Published: false }, blocks: [["heading_2", "Outline"], ["bulleted_list_item", "The fractional index"], ["bulleted_list_item", "Why renumbering loses"]] },
          { title: "v0.1 release notes", values: { Channel: "opt:Changelog", Status: "opt:In review", Publish: { day: 2 }, Review: { day: 0 }, Words: 620, Author: "Rui", Published: false } },
          { title: "Local-first, what it actually buys you", values: { Channel: "opt:Newsletter", Status: "opt:Outlined", Publish: { day: 24 }, Words: 0, Author: "Priya", Published: false } },
          { title: "The formula language, in 10 minutes", values: { Channel: "opt:Docs", Status: "opt:Published", Publish: { day: -6 }, Words: 2400, Author: "Sam", Tags: ["opt:design"], Published: true } },
          { title: "Our roadmap for 2026", values: { Channel: "opt:Blog", Status: "opt:Idea", Words: 0, Author: "Ana", Published: false } },
        ],
        views: [
          { name: "Calendar", type: "calendar", calendarBy: "Publish", hidden: ["Words", "Tags"] },
          { name: "Board", type: "board", group: ["Status"], sort: [{ prop: "Publish", direction: "ascending" }] },
          { name: "Table", type: "table", sort: [{ prop: "Publish", direction: "ascending" }], aggregates: { Words: "sum", Published: "countChecked" } },
        ],
      },
    ],
  },

  // ── 8. CRM / contacts ──────────────────────────────────────────────────────
  {
    name: "CRM / contacts",
    icon: "🤝",
    scope: "page",
    description: "Name, company, stage, last contact, next touch and deal value, with table and board views.",
    build: (ctx) => {
      h1(ctx, "CRM");
      callout(ctx, "A contact without a next touch is a lost contact. Every row in the table below has a date in Next touch.", "📇", "green_background");
      h2(ctx, "Pipeline rules");
      bullet(ctx, "New → Contacted within 24 hours of the intro.");
      bullet(ctx, "Proposal sent → Negotiating needs a written answer, not a vibe.");
      bullet(ctx, "Anything idle for 30 days moves to Lost, with a reason.");
      h2(ctx, "This week's touches");
      para(ctx, "Sort the table by Next touch; the board shows where the money is.");
      h2(ctx, "Notes on the relationship");
      para(ctx, "Write down the personal details that make the next call human.");
      bullet(ctx, "Rui's team ships on Fridays — do not call Friday afternoon.");
    },
    databases: [
      {
        title: "Contacts",
        icon: "🤝",
        properties: [
          { name: "Company", type: "text" },
          { name: "Role", type: "text" },
          { name: "Stage", type: "status", statusGroups: [
            { id: "to_do", name: "Top of funnel", color: "gray", options: [
              { name: "New", color: "gray" },
              { name: "Contacted", color: "blue" },
            ] },
            { id: "in_progress", name: "Working", color: "yellow", options: [
              { name: "Qualified", color: "yellow" },
              { name: "Proposal sent", color: "orange" },
              { name: "Negotiating", color: "pink" },
            ] },
            { id: "complete", name: "Closed", color: "green", options: [
              { name: "Won", color: "green" },
              { name: "Lost", color: "red" },
            ] },
          ] },
          { name: "LastContact", type: "date" },
          { name: "NextTouch", type: "date" },
          { name: "Value", type: "number", format: "dollar", precision: 0 },
          { name: "Email", type: "email" },
          { name: "Phone", type: "phone" },
          { name: "Source", type: "select", options: [
            { name: "referral", color: "green" },
            { name: "inbound", color: "blue" },
            { name: "conference", color: "purple" },
            { name: "cold", color: "gray" },
          ] },
          { name: "Owner", type: "text" },
          { name: "Notes", type: "text" },
          { name: "Stale", type: "formula", formula: 'if(empty(LastContact), "never contacted", if(dateDiff(today(), LastContact, "days") > 30, "stale", "warm"))' },
          { name: "Due", type: "formula", formula: 'if(empty(NextTouch), "no plan", if(NextTouch <= today(), "touch today", concat("in ", toNumber(dateDiff(NextTouch, today(), "days")), "d")))' },
        ],
        rows: [
          { title: "Dana Whitfield", values: { Company: "Northwind Labs", Role: "Head of Platform", Stage: "opt:Negotiating", LastContact: { day: -3 }, NextTouch: { day: 0 }, Value: 48000, Email: "dana@northwind.example", Phone: "+1 555 0100", Source: "opt:referral", Owner: "Ana", Notes: "Wants the self-hosted story in writing before signing." }, blocks: [["heading_2", "Relationship log"], ["paragraph", "Met at the local-first meetup. Cares about data ownership more than features."]] },
          { title: "Kenji Sato", values: { Company: "Meridian Health", Role: "Director of Engineering", Stage: "opt:Proposal sent", LastContact: { day: -9 }, NextTouch: { day: 2 }, Value: 120000, Email: "kenji@meridian.example", Source: "opt:conference", Owner: "Rui" } },
          { title: "Lena Fischer", values: { Company: "Fischer & Co", Role: "Owner", Stage: "opt:Contacted", LastContact: { day: -34 }, NextTouch: { day: 5 }, Value: 9000, Email: "lena@fischer.example", Source: "opt:cold", Owner: "Ana" } },
          { title: "Marcus Bell", values: { Company: "Bell Analytics", Role: "CTO", Stage: "opt:Qualified", LastContact: { day: -5 }, NextTouch: { day: 1 }, Value: 26000, Email: "marcus@bell.example", Source: "opt:inbound", Owner: "Priya" } },
          { title: "Sofia Duarte", values: { Company: "Aurora Retail", Role: "VP Product", Stage: "opt:Won", LastContact: { day: -1 }, NextTouch: { day: 14 }, Value: 75000, Email: "sofia@aurora.example", Source: "opt:referral", Owner: "Ana", Notes: "Expansion conversation in Q1." } },
          { title: "Tom Iverson", values: { Company: "Iverson Legal", Role: "Managing partner", Stage: "opt:Lost", LastContact: { day: -40 }, Value: 15000, Source: "opt:cold", Owner: "Rui", Notes: "Lost on price; revisit at renewal." } },
        ],
        views: [
          { name: "Table", type: "table", sort: [{ prop: "NextTouch", direction: "ascending" }], hidden: ["Notes", "Phone"], aggregates: { Value: "sum", LastContact: "countAll" } },
          { name: "Board", type: "board", group: ["Stage"], sort: [{ prop: "Value", direction: "descending" }], hidden: ["Notes", "Source"] },
          { name: "Needs a touch", type: "table", filterRules: [{ prop: "NextTouch", operator: "before", value: { day: 1 } }], sort: [{ prop: "NextTouch", direction: "ascending" }] },
        ],
      },
    ],
  },

  // ── 9. OKRs ────────────────────────────────────────────────────────────────
  {
    name: "OKRs",
    icon: "🎯",
    scope: "page",
    description: "Objective pages over a key-results database, with a rollup of the KR progress and a formula that scores the objective.",
    build: (ctx) => {
      h1(ctx, "OKRs");
      callout(ctx, "Key results are measurements, not tasks. If a KR can be “done” without a number moving, it is a task and belongs in a task list.", "🎯", "purple_background");
      h2(ctx, "How this template works");
      numbered(ctx, "Each objective is a row in the Objectives database.");
      numbered(ctx, "Each key result is a row in the Key results database, linked to its objective through the Objective relation.");
      numbered(ctx, "The Progress rollup on the objective counts the linked key results; the Score formula averages their progress percentages.");
      h2(ctx, "Cadence");
      bullet(ctx, "Weekly: update each KR's Current value. One number, one minute.");
      bullet(ctx, "Monthly: score every objective 0–1.0 and write one sentence of context.");
      h2(ctx, "Scoring");
      para(ctx, "0.7 is a strong quarter. A 1.0 on everything means the targets were too small.");
      divider(ctx);
      const q1 = childPage(ctx, "Objective — make the editor feel instant", "⚡");
      blk(ctx, q1, "callout", plainTextToBody("Objective: the editor stops being the reason people hesitate to switch."), { icon: "🎯", color: "blue_background" });
      blk(ctx, q1, "heading_2", plainTextToBody("Why this objective"));
      blk(ctx, q1, "paragraph", plainTextToBody("Every competitor demo loses on editing latency. This is the objective that changes the sales conversation."));
      blk(ctx, q1, "heading_2", plainTextToBody("Key results"));
      blk(ctx, q1, "paragraph", rich([["Every key result lives in the ", {}], ["Key results", { bold: true }], [" database on the OKR page, linked to this objective through the Objective relation."]]));
    },
    databases: [
      {
        title: "Key results",
        icon: "📏",
        heading: "Key results",
        properties: [
          { name: "Objective", type: "relation", relationTo: "Objectives", mirrorName: "Key results" },
          { name: "Baseline", type: "number", format: "number", precision: 1 },
          { name: "Target", type: "number", format: "number", precision: 1 },
          { name: "Current", type: "number", format: "number", precision: 1 },
          { name: "Owner", type: "text" },
          { name: "Unit", type: "text" },
          { name: "Updated", type: "last_edited_time" },
          {
            name: "Progress",
            type: "formula",
            formula:
              'if(empty(Target) || empty(Baseline) || Target == Baseline, 0, max(0, min(100, round(100 * (Current - Baseline) / (Target - Baseline), 0))))',
          },
          { name: "Status", type: "formula", formula: 'if(Progress >= 70, "on track", if(Progress >= 40, "at risk", "off track"))' },
        ],
        rows: [
          { title: "Median reorder latency under 16 ms", values: { Objective: "db:Objectives:Make the editor feel instant", Baseline: 180, Target: 16, Current: 41, Owner: "Ana", Unit: "ms" } },
          { title: "Zero full-parent rewrites on reorder", values: { Objective: "db:Objectives:Make the editor feel instant", Baseline: 100, Target: 0, Current: 12, Owner: "Rui", Unit: "%" } },
          { title: "Ship board, calendar and gallery views", values: { Objective: "db:Objectives:Make the editor feel instant", Baseline: 0, Target: 3, Current: 2, Owner: "Sam", Unit: "views" } },
          { title: "Onboard 10 local-first design partners", values: { Objective: "db:Objectives:Own the local-first niche", Baseline: 0, Target: 10, Current: 4, Owner: "Priya", Unit: "partners" } },
          { title: "Time to first page under 30 seconds", values: { Objective: "db:Objectives:Own the local-first niche", Baseline: 240, Target: 30, Current: 95, Owner: "Ana", Unit: "s" } },
          { title: "Publish the formula language reference", values: { Objective: "db:Objectives:Own the local-first niche", Baseline: 0, Target: 1, Current: 1, Owner: "Sam", Unit: "doc" } },
        ],
        views: [
          { name: "Table", type: "table", sort: [{ prop: "Progress", direction: "descending" }], aggregates: { Progress: "avg", Current: "sum" } },
          { name: "By objective", type: "board", group: ["Objective"], hidden: ["Baseline", "Unit"] },
          { name: "Off track", type: "table", filterRules: [{ prop: "Progress", operator: "lessThan", value: 40 }], sort: [{ prop: "Progress", direction: "ascending" }] },
        ],
      },
      {
        title: "Objectives",
        icon: "🎯",
        heading: "Objectives",
        // The "Key results" relation property is the mirror `createRelation`
        // made on the Key results database, so it is not declared here.
        properties: [
          { name: "Quarter", type: "select", options: [
            { name: "Q1", color: "blue" },
            { name: "Q2", color: "green" },
            { name: "Q3", color: "orange" },
            { name: "Q4", color: "purple" },
          ] },
          { name: "Owner", type: "text" },
          { name: "Confidence", type: "number", format: "percent", precision: 0 },
          { name: "KRprogress", type: "rollup", rollup: { relation: "Key results", target: "Progress", fn: "avg" } },
          { name: "KRcount", type: "rollup", rollup: { relation: "Key results", target: "Progress", fn: "countAll" } },
          { name: "Score", type: "formula", formula: 'if(empty(KRprogress), 0, round(KRprogress / 100, 2))' },
          { name: "Verdict", type: "formula", formula: 'if(Score >= 0.7, "strong quarter", if(Score >= 0.4, "partial", "missed"))' },
        ],
        rows: [
          { title: "Make the editor feel instant", values: { Quarter: "opt:Q1", Owner: "Ana", Confidence: 0.7 }, blocks: [["paragraph", "Objective: the editor stops being the reason people hesitate to switch."]] },
          { title: "Own the local-first niche", values: { Quarter: "opt:Q1", Owner: "Priya", Confidence: 0.5 } },
        ],
        views: [
          { name: "Table", type: "table", sort: [{ prop: "Score", direction: "descending" }], aggregates: { Score: "avg", KRcount: "sum" } },
          { name: "Board", type: "board", group: ["Quarter"], hidden: ["Owner"] },
        ],
      },
    ],
  },

  // ── 10. Sprint retro ───────────────────────────────────────────────────────
  {
    name: "Sprint retro",
    icon: "🔍",
    scope: "page",
    description: "Keep / drop / try prompts over a voted items database with a rating column and a priority formula.",
    build: (ctx) => {
      h1(ctx, "Sprint retro");
      callout(ctx, "A retro that produces no owner and no date is a meeting. Every item that gets votes gets a row in the experiments database.", "🔍", "yellow_background");
      h2(ctx, "Logistics");
      bullet(ctx, rich([["Sprint: ", { bold: true }], "the two weeks just ended."]));
      bullet(ctx, rich([["Facilitator: ", { bold: true }], "whoever is not the tech lead."]));
      bullet(ctx, rich([["Timebox: ", { bold: true }], "45 minutes. Gather 6 minutes, vote 4, discuss 25, close 10."]));
      h2(ctx, "Keep");
      para(ctx, "What worked, and we should protect it?");
      bullet(ctx, "The async design review doc — nobody sat in a meeting to read a list.");
      h2(ctx, "Drop");
      para(ctx, "What cost us time and bought nothing?");
      bullet(ctx, "The weekly status deck. The board view already says the same thing.");
      h2(ctx, "Try");
      para(ctx, "What will we try next sprint, and how will we know it worked?");
      bullet(ctx, "Pair on the formula parser for the first two days.");
      h2(ctx, "Voting");
      para(ctx, "Dot-vote in the items database: the Votes column is the count, and Priority ranks them.");
    },
    databases: [
      {
        title: "Retro items",
        icon: "🗳️",
        heading: "Voted items",
        properties: [
          { name: "Bucket", type: "select", options: [
            { name: "Keep", color: "green" },
            { name: "Drop", color: "red" },
            { name: "Try", color: "blue" },
          ] },
          { name: "Votes", type: "number", format: "number", precision: 0 },
          { name: "Impact", type: "number", format: "number", precision: 0 },
          { name: "Effort", type: "number", format: "number", precision: 0 },
          { name: "Priority", type: "formula", formula: 'if(empty(Effort) || Effort == 0, 0, round(Votes + Impact / max(1, Effort), 2))' },
          { name: "Owner", type: "text" },
          { name: "Try by", type: "date" },
          { name: "Adopted", type: "checkbox" },
          { name: "Raised by", type: "text" },
        ],
        rows: [
          { title: "Keep the async design review", values: { Bucket: "opt:Keep", Votes: 7, Impact: 3, Effort: 1, Owner: "Sam", "Raised by": "Ana" } },
          { title: "Drop the weekly status deck", values: { Bucket: "opt:Drop", Votes: 6, Impact: 2, Effort: 1, Owner: "Rui", "Raised by": "Priya" } },
          { title: "Try pairing on the parser", values: { Bucket: "opt:Try", Votes: 5, Impact: 4, Effort: 3, Owner: "Ana", "Try by": { day: 2 }, "Raised by": "Rui" } },
          { title: "Try a 10-minute demo at standup", values: { Bucket: "opt:Try", Votes: 4, Impact: 3, Effort: 1, Owner: "Sam", "Try by": { day: 2 }, "Raised by": "Sam" } },
          { title: "Drop the shared branch", values: { Bucket: "opt:Drop", Votes: 2, Impact: 1, Effort: 2, "Raised by": "Sam" } },
        ],
        views: [
          { name: "Table", type: "table", sort: [{ prop: "Priority", direction: "descending" }], aggregates: { Votes: "sum", Priority: "avg", Adopted: "countChecked" } },
          { name: "Board", type: "board", group: ["Bucket"], sort: [{ prop: "Priority", direction: "descending" }] },
          { name: "Top 3 to run", type: "table", filterRules: [{ prop: "Bucket", operator: "is", value: "opt:Try" }], sort: [{ prop: "Priority", direction: "descending" }], hidden: ["Raised by"] },
        ],
      },
    ],
  },

  // ── 11. Daily journal ──────────────────────────────────────────────────────
  {
    name: "Daily journal",
    icon: "📓",
    scope: "page",
    description: "Mood, habit checkboxes, gratitude and a one-line log per day, with a calendar view and a streak formula.",
    build: (ctx) => {
      h1(ctx, "Daily journal");
      callout(ctx, "One line a day beats a novel a month. The calendar view is the streak you can see.", "📓", "blue_background");
      h2(ctx, "Today");
      para(ctx, "Write the one-line log first, then the checkboxes, then the mood. Mood last, because it is the least reliable memory.");
      h2(ctx, "Gratitude");
      bullet(ctx, "The long walk at lunch.");
      bullet(ctx, "Rui's comment on the reorder patch — it made the fix obvious.");
      h2(ctx, "Prompts, when one line is not enough");
      bullet(ctx, "What did I avoid today, and why?");
      bullet(ctx, "What would make tomorrow one hour easier?");
      bullet(ctx, "Who did I not reply to?");
      h2(ctx, "This month");
      para(ctx, "The calendar view shows the entries; the table view shows the habit columns side by side.");
    },
    databases: [
      {
        title: "Journal",
        icon: "📓",
        properties: [
          { name: "Date", type: "date" },
          { name: "Mood", type: "select", options: [
            { name: "great", color: "green" },
            { name: "good", color: "blue" },
            { name: "flat", color: "gray" },
            { name: "low", color: "orange" },
            { name: "rough", color: "red" },
          ] },
          { name: "Slept7h", type: "checkbox" },
          { name: "Moved", type: "checkbox" },
          { name: "Read", type: "checkbox" },
          { name: "DeepWork", type: "checkbox" },
          { name: "NoPhoneInBed", type: "checkbox" },
          { name: "Gratitude", type: "text" },
          { name: "Log", type: "text" },
          { name: "Habits", type: "formula", formula: "sum(Slept7h, Moved, Read, DeepWork, NoPhoneInBed)" },
          { name: "Day score", type: "formula", formula: 'round(100 * Habits / 5, 0)' },
          { name: "Streak", type: "formula", formula: 'if(Habits == 0, 0, max(1, toNumber(dateDiff(today(), dateStart(Date, "day"), "days")) + 1))' },
          { name: "Label", type: "formula", formula: 'concat(toDateString(Date, "YYYY-MM-DD"), " · ", toString(Habits), "/5 habits")' },
        ],
        rows: [
          { title: "2026-11-25", values: { Date: { day: 0 }, Mood: "opt:good", Slept7h: true, Moved: true, Read: false, DeepWork: true, NoPhoneInBed: true, Gratitude: "The walk. The comment on the patch.", Log: "Shipped the board grouping; the status order was already right." } },
          { title: "2026-11-24", values: { Date: { day: -1 }, Mood: "opt:flat", Slept7h: false, Moved: true, Read: false, DeepWork: false, NoPhoneInBed: false, Gratitude: "Coffee with Priya.", Log: "Meetings. Read the provider API docs in the gaps." } },
          { title: "2026-11-23", values: { Date: { day: -2 }, Mood: "opt:great", Slept7h: true, Moved: true, Read: true, DeepWork: true, NoPhoneInBed: true, Gratitude: "A whole quiet morning.", Log: "Formula engine: 190 assertions green." } },
          { title: "2026-11-22", values: { Date: { day: -3 }, Mood: "opt:rough", Slept7h: false, Moved: false, Read: false, DeepWork: false, NoPhoneInBed: true, Gratitude: "Dinner at seven.", Log: "Production incident, then a long walk." } },
          { title: "2026-11-21", values: { Date: { day: -4 }, Mood: "opt:good", Slept7h: true, Moved: true, Read: true, DeepWork: false, NoPhoneInBed: true, Gratitude: "The demo landed.", Log: "Prepared the demo, then did not ship anything." } },
        ],
        views: [
          { name: "Calendar", type: "calendar", calendarBy: "Date", hidden: ["Gratitude"] },
          { name: "Table", type: "table", sort: [{ prop: "Date", direction: "descending" }], aggregates: { Slept7h: "percentChecked", Moved: "percentChecked", DeepWork: "percentChecked", "Day score": "avg" } },
          { name: "Good days", type: "table", filterRules: [{ prop: "Mood", operator: "is", value: "opt:great" }], sort: [{ prop: "Date", direction: "descending" }] },
        ],
      },
    ],
  },

  // ── 12. Recipe ─────────────────────────────────────────────────────────────
  {
    name: "Recipe",
    icon: "🍳",
    scope: "page",
    description: "Description, an ingredients database, numbered steps, prep and cook minutes, rating and yield.",
    build: (ctx) => {
      h1(ctx, "Recipe");
      callout(ctx, "Write the recipe the way you want to read it at 8pm: quantities first, steps short, and the one thing that ruins it in bold.", "🍳", "orange_background");
      h2(ctx, "Description");
      para(ctx, "One paragraph: what this dish is, when to make it, and what it is better than.");
      h2(ctx, "Ingredients");
      para(ctx, "The database below scales with the Yield formula: set Servings and every quantity shows the scaled amount.");
      h2(ctx, "Steps");
      numbered(ctx, "Read the whole recipe first. Mise en place before the pan is hot.");
      numbered(ctx, "Season each stage, not only the end.");
      numbered(ctx, "Taste before you plate, and adjust once, decisively.");
      numbered(ctx, "Rest what needs resting; serve what does not, hot.");
      h2(ctx, "Tips");
      bullet(ctx, "The pan must be properly hot before anything goes in — the sound is the test.");
      bullet(ctx, "If the sauce breaks, one spoonful of warm water and a whisk, off the heat.");
      h2(ctx, "Notes from cooking it");
      para(ctx, "What you changed, and what you would change next time.");
      quote(ctx, "“Half the chilli the second time. It was the whole dish.”");
    },
    databases: [
      {
        title: "Ingredients",
        icon: "🧺",
        properties: [
          { name: "Qty", type: "number", format: "number", precision: 2 },
          { name: "Unit", type: "text" },
          { name: "Note", type: "text" },
          { name: "Pantry", type: "checkbox" },
          { name: "Cost", type: "number", format: "dollar", precision: 2 },
          { name: "Scaled", type: "formula", formula: 'if(empty(Qty), "", concat(toString(round(Qty * 4 / 2, 2)), " ", Unit))' },
          { name: "Line", type: "formula", formula: 'concat(toString(Qty), " ", Unit, " ", Name)' },
        ],
        rows: [
          { title: "olive oil", values: { Qty: 2, Unit: "tbsp", Note: "good enough to drink", Pantry: true, Cost: 0.4 } },
          { title: "onion", values: { Qty: 1, Unit: "medium", Note: "finely diced", Pantry: true, Cost: 0.5 } },
          { title: "garlic", values: { Qty: 3, Unit: "cloves", Pantry: true, Cost: 0.2 } },
          { title: "tomatoes, tinned", values: { Qty: 400, Unit: "g", Note: "San Marzano if you have them", Cost: 2.1 } },
          { title: "pappardelle", values: { Qty: 250, Unit: "g", Cost: 2.4 } },
          { title: "chilli flakes", values: { Qty: 0.5, Unit: "tsp", Note: "halve it the second time", Pantry: true, Cost: 0.1 } },
          { title: "parmesan", values: { Qty: 40, Unit: "g", Cost: 1.8 } },
        ],
        views: [
          { name: "Table", type: "table", aggregates: { Cost: "sum", Pantry: "countChecked", Qty: "countAll" } },
          { name: "Shopping", type: "table", filterRules: [{ prop: "Pantry", operator: "unchecked" }], hidden: ["Note", "Scaled", "Line"], sort: [{ prop: "Cost", direction: "descending" }] },
          { name: "Gallery", type: "gallery", card: { size: "small", properties: ["Qty", "Unit", "Pantry"] } },
        ],
      },
    ],
  },

  // ── 13. Wiki article ───────────────────────────────────────────────────────
  {
    name: "Wiki article",
    icon: "📖",
    scope: "page",
    description: "A summary callout, contents, sections, references and a related-pages database with a self-relation.",
    build: (ctx) => {
      h1(ctx, "Wiki article");
      callout(
        ctx,
        rich([["Summary. ", { bold: true }], "Two or three sentences that stand on their own. A reader who stops here should still know what the page is about."]),
        "ℹ️",
      );
      h2(ctx, "Contents");
      para(ctx, "The headings below are the contents. A wiki page that needs a hand-written table of contents is a page that needs splitting.");
      bullet(ctx, rich([linkTo(ctx.rootId, "Overview"), [" — what this is, in three sentences.", {}]]));
      bullet(ctx, "How it works");
      bullet(ctx, "Trade-offs");
      bullet(ctx, "References and related pages");
      h2(ctx, "Overview");
      para(ctx, "Define the term in the first sentence, in the words your readers would use. Do not open with history.");
      h2(ctx, "How it works");
      para(ctx, "Explain the mechanism, then the consequence. One idea per paragraph.");
      codeBlock(ctx, "SELECT n.id FROM node n\n WHERE n.parent_id = :host\n   AND n.deleted_at IS NULL\n ORDER BY n.pos;", "sql");
      h2(ctx, "Trade-offs");
      bullet(ctx, rich([["Pro: ", { bold: true }], "a single write path buys undo, history, trash and sync for free."]));
      bullet(ctx, rich([["Con: ", { bold: true }], "every feature pays the op-log tax on the way in."]));
      h2(ctx, "Open questions");
      bullet(ctx, "Does the op log need compaction, and at what size?");
      h2(ctx, "Related pages");
      para(ctx, "The Related pages database links articles to each other in both directions, so the backlinks panel fills itself.");
      divider(ctx);
      const child = childPage(ctx, "Appendix — benchmarks", "📊");
      blk(ctx, child, "callout", plainTextToBody("Appendices hold the evidence so the article stays readable."), { icon: "📊", color: "gray_background" });
      blk(ctx, child, "paragraph", plainTextToBody("Numbers, methodology, and the run date. Link the article from here."));
    },
    databases: [
      {
        title: "References",
        icon: "🔗",
        heading: "References",
        properties: [
          { name: "Type", type: "select", options: [
            { name: "paper", color: "purple" },
            { name: "docs", color: "blue" },
            { name: "blog", color: "orange" },
            { name: "spec", color: "green" },
          ] },
          { name: "URL", type: "url" },
          { name: "Cited", type: "date" },
          { name: "Verified", type: "checkbox" },
          { name: "Author", type: "text" },
        ],
        rows: [
          { title: "Fractional indexing for ordered trees", values: { Type: "opt:blog", URL: "https://example.com/fractional-indexing", Cited: { day: -20 }, Verified: true, Author: "David Greenspan" } },
          { title: "SQLite FTS5 external content tables", values: { Type: "opt:docs", URL: "https://sqlite.org/fts5.html", Cited: { day: -14 }, Verified: true, Author: "SQLite project" } },
          { title: "Local-first software", values: { Type: "opt:paper", URL: "https://www.inkandswitch.com/local-first/", Cited: { day: -40 }, Verified: false, Author: "Kleppmann et al." } },
        ],
        views: [
          { name: "Table", type: "table", sort: [{ prop: "Cited", direction: "descending" }], aggregates: { Verified: "countChecked" } },
          { name: "Unverified", type: "table", filterRules: [{ prop: "Verified", operator: "unchecked" }], hidden: ["Author"] },
        ],
      },
      {
        title: "Related pages",
        icon: "🧭",
        heading: "Related pages",
        properties: [
          { name: "Related", type: "relation", relationTo: "Related pages", mirrorName: "Linked from" },
          { name: "Why related", type: "text" },
          { name: "Status", type: "status", statusGroups: [
            { id: "to_do", name: "To write", color: "gray", options: [{ name: "Stub", color: "gray" }] },
            { id: "in_progress", name: "Draft", color: "yellow", options: [{ name: "Draft", color: "yellow" }] },
            { id: "complete", name: "Published", color: "green", options: [{ name: "Published", color: "green" }] },
          ] },
          { name: "Owner", type: "text" },
        ],
        rows: [
          { title: "Fractional indexes", values: { Related: "row:Op log", "Why related": "The ordering mechanism this article depends on.", Status: "opt:Published", Owner: "Ana" } },
          { title: "Op log", values: { Related: "row:Fractional indexes", "Why related": "Both are consequences of the single write path.", Status: "opt:Draft", Owner: "Rui" } },
          { title: "Formula language", values: { "Why related": "Referenced by the computed-property section.", Status: "opt:Stub", Owner: "Priya" } },
        ],
        views: [
          { name: "Table", type: "table", aggregates: { Status: "countAll" } },
          { name: "Board", type: "board", group: ["Status"], hidden: ["Owner"] },
        ],
      },
    ],
  },

  // ── 14. Habit tracker ──────────────────────────────────────────────────────
  {
    name: "Habit tracker",
    icon: "🔥",
    scope: "page",
    description: "Daily checkbox columns, a formula that computes a streak from them, and a summary rollup per habit.",
    build: (ctx) => {
      h1(ctx, "Habit tracker");
      callout(ctx, "The streak formula reads the checkbox columns on the row and counts the run of days ending today. Miss a day and it resets — that is the feature.", "🔥", "red_background");
      h2(ctx, "The rules");
      bullet(ctx, "One row per day. The Date column is what the calendar view buckets on.");
      bullet(ctx, "Check the boxes at the end of the day, in the same order every time.");
      bullet(ctx, "The Streak formula is per day; the Summary database rolls each habit's streak up over its rows.");
      h2(ctx, "This week");
      para(ctx, "The board view groups by the day of the week, so a bad day is visible as a column.");
      h2(ctx, "What the numbers say");
      para(ctx, "Longest streak, current streak and completion rate live in the Summary database below.");
    },
    databases: [
      {
        title: "Daily habits",
        icon: "📆",
        heading: "Daily",
        properties: [
          { name: "Date", type: "date" },
          { name: "Meditate", type: "checkbox" },
          { name: "Exercise", type: "checkbox" },
          { name: "Read", type: "checkbox" },
          { name: "NoSugar", type: "checkbox" },
          { name: "Journal", type: "checkbox" },
          // createRelation makes the mirror "Habits" on Habit summary, which is
          // what that database's rows and rollups reference below.
          { name: "Summary", type: "relation", relationTo: "Habit summary", mirrorName: "Habits" },
          { name: "Done", type: "formula", formula: "sum(Meditate, Exercise, Read, NoSugar, Journal)" },
          {
            name: "Perfect",
            type: "formula",
            formula: "if(Done == 5, true, false)",
          },
          {
            name: "Streak",
            type: "formula",
            formula:
              'if(Done == 0, 0, if(empty(Date), 0, max(1, toNumber(dateDiff(today(), dateStart(Date, "day"), "days")) + 1)))',
          },
          { name: "Rate", type: "formula", formula: "round(100 * Done / 5, 0)" },
          { name: "Note", type: "text" },
        ],
        rows: [
          { title: "Today", values: { Date: { day: 0 }, Meditate: true, Exercise: true, Read: true, NoSugar: true, Journal: true, Note: "Five for five." } },
          { title: "Yesterday", values: { Date: { day: -1 }, Meditate: true, Exercise: true, Read: true, NoSugar: true, Journal: true } },
          { title: "Two days ago", values: { Date: { day: -2 }, Meditate: true, Exercise: false, Read: true, NoSugar: true, Journal: true, Note: "Skipped the run." } },
          { title: "Three days ago", values: { Date: { day: -3 }, Meditate: true, Exercise: true, Read: false, NoSugar: false, Journal: true } },
          { title: "Four days ago", values: { Date: { day: -4 }, Meditate: false, Exercise: true, Read: true, NoSugar: true, Journal: false } },
          { title: "Five days ago", values: { Date: { day: -5 }, Meditate: true, Exercise: true, Read: true, NoSugar: true, Journal: true } },
          { title: "Six days ago", values: { Date: { day: -6 }, Meditate: true, Exercise: true, Read: true, NoSugar: true, Journal: true } },
        ],
        views: [
          { name: "Table", type: "table", sort: [{ prop: "Date", direction: "descending" }], aggregates: { Meditate: "percentChecked", Exercise: "percentChecked", Read: "percentChecked", NoSugar: "percentChecked", Journal: "percentChecked", Rate: "avg", Streak: "max" } },
          { name: "Calendar", type: "calendar", calendarBy: "Date", hidden: ["Note"] },
          { name: "Perfect days", type: "board", group: ["Perfect"], hidden: ["Note"] },
        ],
      },
      {
        title: "Habit summary",
        icon: "📊",
        heading: "Summary",
        // "Habits" is the mirror relation `createRelation` created on the Daily
        // habits database; rows reference it by name.
        properties: [
          { name: "Target", type: "number", format: "number", precision: 0 },
          { name: "CheckedDays", type: "rollup", rollup: { relation: "Habits", target: "Date", fn: "countAll" } },
          { name: "BestStreak", type: "rollup", rollup: { relation: "Habits", target: "Streak", fn: "max" } },
          { name: "LatestStreak", type: "rollup", rollup: { relation: "Habits", target: "Streak", fn: "showOriginal" } },
          { name: "Completion", type: "formula", formula: 'if(empty(Target) || Target == 0, 0, round(100 * CheckedDays / Target, 0))' },
        ],
        rows: [
          { title: "Meditate", values: { Habits: ["row:Today", "row:Yesterday", "row:Two days ago", "row:Three days ago", "row:Four days ago", "row:Five days ago", "row:Six days ago"], Target: 7 } },
          { title: "Exercise", values: { Habits: ["row:Today", "row:Yesterday", "row:Two days ago", "row:Three days ago", "row:Five days ago", "row:Six days ago"], Target: 7 } },
          { title: "Read", values: { Habits: ["row:Today", "row:Yesterday", "row:Two days ago", "row:Four days ago", "row:Five days ago", "row:Six days ago"], Target: 7 } },
          { title: "Journal", values: { Habits: ["row:Today", "row:Yesterday", "row:Two days ago", "row:Three days ago"], Target: 7 } },
        ],
        views: [
          { name: "Table", type: "table", sort: [{ prop: "Completion", direction: "descending" }], aggregates: { Completion: "avg", BestStreak: "max" } },
          { name: "Board", type: "board", group: ["Completion"] },
        ],
      },
    ],
  },

  // ── 15. Goal tracker ───────────────────────────────────────────────────────
  {
    name: "Goal tracker",
    icon: "🏔️",
    scope: "page",
    description: "Target, a progress formula from a percentage, and milestones with dates, status and owners.",
    build: (ctx) => {
      h1(ctx, "Goal tracker");
      callout(ctx, "A goal without a number is a wish. Current over Target gives the percentage; the pace formula tells you whether the percentage is moving fast enough.", "🏔️", "green_background");
      h2(ctx, "The goal");
      para(ctx, "State it as a number and a date: what will be true, by when.");
      h2(ctx, "Why now");
      bullet(ctx, "It compounds: the habit built here is the one that carries the next goal.");
      h2(ctx, "How progress is measured");
      numbered(ctx, "Each goal row has Target and Current.");
      numbered(ctx, "The Progress formula turns them into a percentage, and Status into a verdict.");
      numbered(ctx, "Each milestone is a row in the Milestones database, linked back through the Goal relation.");
      h2(ctx, "Review rhythm");
      bullet(ctx, "Weekly: update Current. One number.");
      bullet(ctx, "Monthly: read the pace formula and decide whether the target date moves.");
    },
    databases: [
      {
        title: "Goals",
        icon: "🎯",
        heading: "Goals",
        properties: [
          { name: "Target", type: "number", format: "number", precision: 1 },
          { name: "Current", type: "number", format: "number", precision: 1 },
          { name: "Unit", type: "text" },
          { name: "Deadline", type: "date" },
          { name: "Started", type: "date" },
          { name: "Progress", type: "formula", formula: 'if(empty(Target) || Target == 0, 0, max(0, min(100, round(100 * Current / Target, 0))))' },
          { name: "DaysLeft", type: "formula", formula: 'if(empty(Deadline), 0, toNumber(dateDiff(Deadline, today(), "days")))' },
          { name: "Span", type: "formula", formula: 'if(empty(Deadline) || empty(Started), 0, max(1, toNumber(dateDiff(Deadline, Started, "days"))))' },
          { name: "Status", type: "formula", formula: 'if(Progress >= 100, "done", if(empty(Deadline), "no deadline", if(DaysLeft < 0, "overdue", if(Progress >= 100 * (1 - DaysLeft / Span), "on pace", "behind"))))' },
          { name: "Category", type: "select", options: [
            { name: "health", color: "green" },
            { name: "learning", color: "blue" },
            { name: "money", color: "orange" },
            { name: "shipping", color: "purple" },
          ] },
          { name: "Done", type: "checkbox" },
          { name: "Notes", type: "text" },
        ],
        rows: [
          { title: "Read 24 books", values: { Target: 24, Current: 9, Unit: "books", Started: { day: -120 }, Deadline: { day: 245 }, Category: "opt:learning", Done: false, Notes: "Audiobooks count at half." }, blocks: [["paragraph", "Nine down, fifteen to go. The pace is right if the reading habit holds."]] },
          { title: "Run 500 km", values: { Target: 500, Current: 212, Unit: "km", Started: { day: -90 }, Deadline: { day: 120 }, Category: "opt:health", Done: false } },
          { title: "Ship v0.2", values: { Target: 1, Current: 0.6, Unit: "release", Started: { day: -45 }, Deadline: { day: 30 }, Category: "opt:shipping", Done: false, Notes: "Board and calendar views are the remaining 40%." } },
          { title: "Emergency fund, 6 months", values: { Target: 30000, Current: 30000, Unit: "USD", Started: { day: -400 }, Deadline: { day: -10 }, Category: "opt:money", Done: true } },
        ],
        views: [
          { name: "Table", type: "table", sort: [{ prop: "Progress", direction: "descending" }], aggregates: { Progress: "avg", Done: "percentChecked" } },
          { name: "Board", type: "board", group: ["Category"], hidden: ["Notes", "Unit"] },
          { name: "Behind pace", type: "table", filterRules: [{ prop: "Progress", operator: "lessThan", value: 50 }], sort: [{ prop: "Deadline", direction: "ascending" }] },
        ],
      },
      {
        title: "Goal milestones",
        icon: "🚩",
        heading: "Milestones",
        properties: [
          { name: "Goal", type: "relation", relationTo: "Goals", mirrorName: "Milestones" },
          { name: "Owner", type: "text" },
          { name: "Start", type: "date" },
          { name: "End", type: "date" },
          { name: "State", type: "status", statusGroups: [
            { id: "to_do", name: "Planned", color: "gray", options: [{ name: "Planned", color: "gray" }] },
            { id: "in_progress", name: "Active", color: "blue", options: [{ name: "Active", color: "blue" }] },
            { id: "complete", name: "Shipped", color: "green", options: [{ name: "Shipped", color: "green" }] },
          ] },
          { name: "Done", type: "checkbox" },
          { name: "Progress", type: "formula", formula: "if(Done, 100, 0)" },
          { name: "Due in", type: "formula", formula: 'if(empty(End), "", concat(toString(toNumber(dateDiff(End, today(), "days"))), " days"))' },
        ],
        rows: [
          { title: "Finish the board view", values: { Goal: "db:Goals:Ship v0.2", Owner: "Ana", Start: { day: -7 }, End: { day: 7 }, State: "opt:Active", Done: false } },
          { title: "Calendar view", values: { Goal: "db:Goals:Ship v0.2", Owner: "Rui", Start: { day: 7 }, End: { day: 21 }, State: "opt:Planned", Done: false } },
          { title: "100 km in March", values: { Goal: "db:Goals:Run 500 km", Owner: "Ana", Start: { day: -30 }, End: { day: 30 }, State: "opt:Active", Done: false } },
          { title: "12 books by June", values: { Goal: "db:Goals:Read 24 books", Owner: "Ana", Start: { day: -120 }, End: { day: 60 }, State: "opt:Active", Done: false } },
        ],
        views: [
          { name: "Table", type: "table", sort: [{ prop: "End", direction: "ascending" }], aggregates: { Done: "percentChecked", Progress: "avg" } },
          { name: "Timeline", type: "timeline", timelineBy: { start: "Start", end: "End" }, sort: [{ prop: "Start", direction: "ascending" }] },
          { name: "Board", type: "board", group: ["State"] },
        ],
      },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Formula verification
//
// `recomputeRow` swallows a throwing formula and caches null, so a broken
// formula would be invisible. `verifyTemplateFormulas` evaluates every formula
// property of every seeded row through the same AST the storage layer uses and
// reports each result, so a test can fail on it.
// ─────────────────────────────────────────────────────────────────────────────

export interface FormulaCheck {
  template: string;
  database: string;
  property: string;
  source: string;
  row: string;
  ok: boolean;
  value: FormulaValue | null;
  error?: string;
}

export function parseFormulaSource(source: string): FormulaNode {
  const v = validateFormulaSource(source);
  if (!v.ok || !v.ast) throw new Error(`formula does not parse: ${v.error ?? ""}`);
  return v.ast;
}

/**
 * Evaluate every formula property on every row of every database in the
 * template subtree. Reads the property definitions from the live database, so
 * it checks what was actually stored.
 *
 * `rootId` is the id of the template's root page in the live workspace.
 */
export function verifyTemplateFormulas(
  db: Db,
  rootId: string,
  templateName: string,
): FormulaCheck[] {
  const out: FormulaCheck[] = [];
  const hostNodes = db.all<{ id: string }>(
    `WITH RECURSIVE tree(id, type) AS (
       SELECT id, type FROM node WHERE id = ?
       UNION ALL
       SELECT n.id, n.type FROM node n JOIN tree t ON n.parent_id = t.id
     )
     SELECT id FROM tree WHERE type = 'child_database'`,
    rootId,
  );

  for (const host of hostNodes) {
    const databaseId = db.scalar<string>("SELECT id FROM database_obj WHERE inline_in_id = ?", host.id);
    if (!databaseId) continue;
    const dbTitle = db.scalar<string>("SELECT title FROM database_obj WHERE id = ?", databaseId) ?? "";
    const props = listProperties(db, databaseId);
    const byName = new Map(props.map((p) => [p.name, p]));
    const formulas = props.filter((p) => p.type === "formula");
    if (!formulas.length) continue;

    const rows = db.all<{ id: string; body: string | null }>(
      "SELECT id, body FROM node WHERE parent_id = ? AND kind = 'row' AND deleted_at IS NULL ORDER BY pos",
      host.id,
    );

    for (const r of rows) {
      const rowTitle = r.body ? safePlainText(r.body) : r.id;
      for (const prop of formulas) {
        const config = prop.config as { ast?: FormulaNode; source?: string };
        const ast = config.ast && config.ast.k ? config.ast : config.source ? parseFormulaSource(config.source) : null;
        if (!ast) {
          out.push({ template: templateName, database: dbTitle, property: prop.name, source: "", row: rowTitle, ok: false, value: null, error: "no AST stored" });
          continue;
        }
        const ctx: EvalContext = {
          prop(name: string): FormulaValue {
            const target = byName.get(name);
            if (!target) return null;
            return normalizeValue(readPropertyValue(db, r.id, target));
          },
          today() {
            const now = new Date();
            return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
          },
        };
        try {
          const value = evaluateFormula(ast, ctx);
          out.push({ template: templateName, database: dbTitle, property: prop.name, source: String(config.source ?? ""), row: rowTitle, ok: true, value });
        } catch (e) {
          out.push({
            template: templateName,
            database: dbTitle,
            property: prop.name,
            source: String(config.source ?? ""),
            row: rowTitle,
            ok: false,
            value: null,
            error: (e as Error).message,
          });
        }
      }
    }
  }
  return out;
}

function safePlainText(json: string): string {
  try {
    const body = JSON.parse(json) as { text: string }[];
    return body.map((i) => i.text).join("");
  } catch {
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && process.argv[1].includes("seed-templates");

if (isMain) {
  const root = process.argv[2] ?? join(import.meta.dirname!, "..", ".data", "tpl-seed");
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });

  const { db } = openWorkspace(root);
  const ws = "ws-templates";
  db.run(
    "INSERT INTO workspace (id, name, created_at) VALUES (?, ?, ?)",
    ws,
    "Template library",
    Date.now(),
  );

  console.log(`\n  Seeding first-party templates into ${root}`);
  const report = seedFirstPartyTemplates(db, ws);

  // verify every formula evaluates, and report anything that does not
  let checks = 0;
  let broken = 0;
  for (const s of report.seeded) {
    const res = verifyTemplateFormulas(db, s.rootId, s.name);
    checks += res.length;
    for (const c of res) {
      if (!c.ok) {
        broken++;
        console.log(`  \x1b[31mbroken formula\x1b[0m ${c.template} · ${c.database} · ${c.property} — ${c.error}`);
      }
    }
  }

  console.log(
    `\n  ${report.seeded.length} templates · ${report.totalBlocks} blocks · ${report.totalRows} rows · ` +
      `formulas evaluated: ${checks} · broken: ${broken}\n`,
  );

  db.close();
  if (broken) process.exitCode = 1;
}
