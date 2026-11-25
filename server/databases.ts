/**
 * Databases: schema, rows, property values, views, and the query engine.
 *
 * The query engine is the important part. Every view (table, board, list,
 * gallery, calendar) reads through `queryRows`, so a filter defined once behaves
 * identically everywhere. `property_value` spreads each value across typed
 * columns (text_v/num_v/date_v/bool_v/json_v) specifically so multi-rule
 * filtering, sorting and aggregation compile to plain SQL.
 *
 * Convention: a row's Title property mirrors `node.body`. That keeps page
 * titles, breadcrumbs and the FTS trigger working for rows with no extra
 * bookkeeping.
 */

import type { Db } from "./db.ts";
import { nowMs, parseJson } from "./db.ts";
import { keyBetween, newId } from "./ids.ts";
import {
  createNode,
  updateNode,
  trashNode,
  restoreNode,
  DEFAULT_ACTOR,
  type ActorInfo,
} from "./ops.ts";
import {
  parseFormula,
  evaluateFormula,
  extractRefs,
  inferResultType,
  normalizeValue,
} from "./formula.ts";
import {
  type FormulaNode,
  bodyToPlainText,
  plainTextToBody,
  defaultViewSpec,
  type AggregateFunction,
  type Body,
  type FilterGroup,
  type FilterRule,
  type NodeRow,
  type PropertyDef,
  type PropertyValueInput,
  type PropertyType,
  type SelectOption,
  type StatusGroup,
  type ViewDef,
  type ViewSpec,
  type ViewType,
} from "../shared/types.ts";

// `SqlParam` lives in db.ts; alias keeps this file's imports tidy.
type SqlParam = string | number | bigint | null | Uint8Array;

export interface EncodedValue {
  text_v: string | null;
  num_v: number | null;
  date_v: number | null;
  bool_v: number | null;
  json_v: string | null;
}

export interface RowView {
  node: NodeRow;
  values: Record<string, PropertyValueInput>;
  title: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Creation
// ─────────────────────────────────────────────────────────────────────────────

export interface SeedProperty {
  name: string;
  type: PropertyType;
  config?: Record<string, unknown>;
}

export const DEFAULT_SEED_PROPERTIES: SeedProperty[] = [
  { name: "Name", type: "title" },
];

export interface CreateDatabaseInput {
  ws: string;
  parent_id: string | null;
  parent_kind: "node" | "database" | "workspace";
  title: string;
  icon?: string;
  properties?: SeedProperty[];
  views?: { name: string; type: ViewType }[];
  actor?: ActorInfo;
}

export interface CreatedDatabase {
  databaseId: string;
  node: string;
  properties: PropertyDef[];
  views: ViewDef[];
}

export function createDatabase(
  db: Db,
  input: CreateDatabaseInput,
): CreatedDatabase {
  const actor = input.actor ?? DEFAULT_ACTOR;
  const databaseId = newId();
  const ts = nowMs();

  return db.tx(() => {
    db.run(
      `INSERT INTO database_obj (id, ws, title, icon, inline_in_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      databaseId,
      input.ws,
      input.title,
      input.icon ?? null,
      null,
      ts,
      ts,
    );

    // The database's node is created FIRST: rows hang off it, and node.parent_id
    // has a foreign key to node(id). Parenting rows on the database id would
    // break referential integrity, and parenting them on this node gives us
    // ON DELETE CASCADE for free (deleting the block deletes the database).
    const node = createNode(db, {
      ws: input.ws,
      kind: "block",
      type: "child_database",
      parent_id: input.parent_id,
      parent_kind: input.parent_kind,
      props: { databaseId },
      body: plainTextToBody(input.title),
      actor,
    });

    db.run(
      "UPDATE database_obj SET inline_in_id = ? WHERE id = ?",
      node,
      databaseId,
    );

    const properties: PropertyDef[] = [];
    let afterPos: string | null = null;
    for (const seed of input.properties ?? DEFAULT_SEED_PROPERTIES) {
      const prop = addProperty(db, databaseId, seed.name, seed.type, seed.config ?? {}, {
        actor,
        afterPos,
      });
      properties.push(prop);
      afterPos = prop.pos;
    }

    const views = (input.views ?? [
      { name: "Table", type: "table" as ViewType },
    ]).map((v, i) => createView(db, databaseId, v.name, v.type, i, { actor }));

    return { databaseId, node, properties, views };
  });
}

/**
 * The node that owns a database's rows. Rows parent to this, not to the
 * database id, so `node.parent_id`'s foreign key stays valid.
 */
export function databaseHostNode(db: Db, databaseId: string): string | null {
  return (
    db.scalar<string>(
      "SELECT inline_in_id FROM database_obj WHERE id = ?",
      databaseId,
    ) ?? null
  );
}

/** Reverse lookup: the database a host node belongs to. */
export function databaseForNode(db: Db, nodeId: string): string | null {
  return (
    db.scalar<string>("SELECT id FROM database_obj WHERE inline_in_id = ?", nodeId) ??
    null
  );
}

export function addProperty(
  db: Db,
  databaseId: string,
  name: string,
  type: PropertyType,
  config: Record<string, unknown> = {},
  opts: { actor?: ActorInfo; afterPos?: string | null } = {},
): PropertyDef {
  const id = newId();
  const pos = keyBetween(opts.afterPos ?? null, null);

  const existing = db.get<{ id: string }>(
    "SELECT id FROM property_def WHERE db_id = ? AND name = ?",
    databaseId,
    name,
  );
  if (existing) throw new Error(`addProperty: "${name}" already exists`);

  const fullConfig = withDefaultConfig(type, config);

  db.run(
    "INSERT INTO property_def (id, db_id, name, type, pos, config) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    databaseId,
    name,
    type,
    pos,
    JSON.stringify(fullConfig),
  );

  return { id, db_id: databaseId, name, type, pos, config: fullConfig } as PropertyDef;
}

function withDefaultConfig(
  type: PropertyType,
  config: Record<string, unknown>,
): Record<string, unknown> {
  switch (type) {
    case "number":
      return { format: "number", precision: 0, ...config };
    case "select":
    case "multi_select":
      return { options: [], ...config };
    case "status":
      return {
        groups: [
          {
            id: "to_do",
            name: "To-do",
            color: "gray",
            options: [{ id: newId(), name: "To-do", color: "gray" }],
          },
          {
            id: "in_progress",
            name: "In Progress",
            color: "blue",
            options: [{ id: newId(), name: "In Progress", color: "blue" }],
          },
          {
            id: "complete",
            name: "Complete",
            color: "green",
            options: [{ id: newId(), name: "Complete", color: "green" }],
          },
        ] as StatusGroup[],
        ...config,
      };
    case "date":
      return { withTime: false, ...config };
    case "unique_id":
      return { prefix: "", next: 1, ...config };
    case "formula":
      return { source: "", ast: { k: "str", v: "" }, resultType: "text", ...config };
    case "button":
      return { label: "Button", action: "setProperties", set: {}, ...config };
    default:
      return config;
  }
}

export function createView(
  db: Db,
  databaseId: string,
  name: string,
  type: ViewType,
  index: number,
  opts: { actor?: ActorInfo; spec?: Partial<ViewSpec> } = {},
): ViewDef {
  const id = newId();
  const last = db.scalar<string>(
    "SELECT max(pos) FROM view WHERE db_id = ?",
    databaseId,
  );
  const pos = keyBetween(index === 0 ? null : (last ?? null), null);
  const spec: ViewSpec = { ...defaultViewSpec(), ...(opts.spec ?? {}) };

  db.run(
    "INSERT INTO view (id, db_id, name, type, spec, pos) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    databaseId,
    name,
    type,
    JSON.stringify(spec),
    pos,
  );
  return { id, db_id: databaseId, name, type, spec, pos };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

export function getDatabase(db: Db, id: string): (Omit<CreatedDatabase, "node"> & {
  title: string;
  inline_in_id: string | null;
  icon: string | null;
}) | null {
  const row = db.get<{
    id: string;
    title: string;
    icon: string | null;
    inline_in_id: string | null;
  }>(
    "SELECT id, title, icon, inline_in_id FROM database_obj WHERE id = ? AND deleted_at IS NULL",
    id,
  );
  if (!row) return null;
  return {
    databaseId: row.id,
    title: row.title,
    icon: row.icon,
    inline_in_id: row.inline_in_id,
    properties: listProperties(db, row.id),
    views: listViews(db, row.id),
  };
}

export function listProperties(db: Db, databaseId: string): PropertyDef[] {
  return db
    .all<{
      id: string;
      db_id: string;
      name: string;
      type: string;
      pos: string;
      config: string;
    }>(
      "SELECT * FROM property_def WHERE db_id = ? ORDER BY pos",
      databaseId,
    )
    .map((r) => ({
      id: r.id,
      db_id: r.db_id,
      name: r.name,
      type: r.type as PropertyType,
      pos: r.pos,
      config: parseJson<Record<string, unknown>>(r.config, {}),
    }));
}

export function getProperty(db: Db, id: string): PropertyDef | null {
  const r = db.get<{
    id: string;
    db_id: string;
    name: string;
    type: string;
    pos: string;
    config: string;
  }>("SELECT * FROM property_def WHERE id = ?", id);
  if (!r) return null;
  return {
    id: r.id,
    db_id: r.db_id,
    name: r.name,
    type: r.type as PropertyType,
    pos: r.pos,
    config: parseJson<Record<string, unknown>>(r.config, {}),
  };
}

export function listViews(db: Db, databaseId: string): ViewDef[] {
  return db
    .all<{ id: string; db_id: string; name: string; type: string; spec: string; pos: string }>(
      "SELECT * FROM view WHERE db_id = ? ORDER BY pos",
      databaseId,
    )
    .map((r) => ({
      id: r.id,
      db_id: r.db_id,
      name: r.name,
      type: r.type as ViewType,
      spec: parseJson<ViewSpec>(r.spec, defaultViewSpec()),
      pos: r.pos,
    }));
}

export function getView(db: Db, id: string): ViewDef | null {
  const r = db.get<{ id: string; db_id: string; name: string; type: string; spec: string; pos: string }>(
    "SELECT * FROM view WHERE id = ?",
    id,
  );
  if (!r) return null;
  return {
    id: r.id,
    db_id: r.db_id,
    name: r.name,
    type: r.type as ViewType,
    spec: parseJson<ViewSpec>(r.spec, defaultViewSpec()),
    pos: r.pos,
  };
}

export function updateViewSpec(
  db: Db,
  viewId: string,
  spec: ViewSpec,
  name?: string,
): void {
  db.run(
    "UPDATE view SET spec = ?, name = ? WHERE id = ?",
    JSON.stringify(spec),
    name ?? db.scalar<string>("SELECT name FROM view WHERE id = ?", viewId) ?? "View",
    viewId,
  );
}

export function titlePropertyOf(db: Db, databaseId: string): PropertyDef | null {
  const t = listProperties(db, databaseId).find((p) => p.type === "title");
  return t ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────

export function createRow(
  db: Db,
  databaseId: string,
  values: Record<string, PropertyValueInput> = {},
  opts: { actor?: ActorInfo; tx?: number; after?: string | null } = {},
): string {
  const actor = opts.actor ?? DEFAULT_ACTOR;
  const props = listProperties(db, databaseId);
  const titleProp = props.find((p) => p.type === "title");
  const titleValue = titleProp ? values[titleProp.id] : undefined;
  const title = typeof titleValue === "string" ? titleValue : "Untitled";

  const hostNode = databaseHostNode(db, databaseId);
  if (!hostNode) throw new Error(`createRow: database ${databaseId} has no host node`);

  const rowId = createNode(db, {
    ws: db.scalar<string>("SELECT ws FROM database_obj WHERE id = ?", databaseId) ?? "",
    kind: "row",
    type: "table_row",
    parent_id: hostNode,
    parent_kind: "database",
    body: plainTextToBody(title),
    actor,
    tx: opts.tx,
  });

  db.tx(() => {
    // unique_id allocation: one atomic UPDATE, so ids never collide
    for (const prop of props) {
      if (prop.type === "unique_id") {
        const next = allocateUniqueId(db, prop);
        setPropertyValue(db, rowId, prop.id, next, { actor, tx: opts.tx });
      }
    }
    for (const [propId, value] of Object.entries(values)) {
      if (getProperty(db, propId)?.type === "unique_id") continue;
      setPropertyValue(db, rowId, propId, value, { actor, tx: opts.tx });
    }
  });

  return rowId;
}

function allocateUniqueId(db: Db, prop: PropertyDef): number {
  const config = prop.config as { prefix?: string; next?: number };
  const next = Number(config.next ?? 1);
  db.run(
    "UPDATE property_def SET config = ? WHERE id = ?",
    JSON.stringify({ ...config, next: next + 1 }),
    prop.id,
  );
  return next;
}

export function getRow(db: Db, rowId: string): RowView | null {
  const node = getNodeRow(db, rowId);
  if (!node) return null;
  const databaseId = node.parent_id ? databaseForNode(db, node.parent_id) : null;
  if (!databaseId) return null;
  const props = listProperties(db, databaseId);
  const values: Record<string, PropertyValueInput> = {};
  for (const prop of props) {
    values[prop.id] = readPropertyValue(db, rowId, prop);
  }
  return { node, values, title: bodyToPlainText(parseBody(node)) };
}

function getNodeRow(db: Db, id: string): NodeRow | null {
  const r = db.get<Record<string, unknown>>("SELECT * FROM node WHERE id = ?", id);
  if (!r) return null;
  return {
    ...r,
    props: parseJson<Record<string, unknown>>(r.props, {}),
    body: parseJson<Body | null>(r.body, null),
    meta: parseJson(r.meta, {}),
  } as unknown as NodeRow;
}

function parseBody(node: NodeRow): Body | null {
  return typeof node.body === "string"
    ? parseJson<Body>(node.body, [])
    : (node.body as Body | null);
}

export function listRows(db: Db, databaseId: string): RowView[] {
  const host = databaseHostNode(db, databaseId);
  if (!host) return [];
  const ids = db.all<{ id: string }>(
    "SELECT id FROM node WHERE parent_id = ? AND kind = 'row' AND deleted_at IS NULL ORDER BY pos",
    host,
  );
  return ids
    .map((r) => getRow(db, r.id))
    .filter((r): r is RowView => r !== null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Value encoding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SQLite INTEGER is 64-bit, but node:sqlite throws RangeError when a value
 * outside the JS safe-integer range is read back. A single bad write would
 * therefore make every row of a database unreadable, so values are clamped on
 * the way in. Dates use the same guard: a normal epoch-ms timestamp is ~1.7e12,
 * so anything beyond ~1e15 is already nonsense.
 */
const SAFE_INT = Number.MAX_SAFE_INTEGER;

function safeNum(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (!Number.isFinite(v)) return null;
  if (v > SAFE_INT) return SAFE_INT;
  if (v < -SAFE_INT) return -SAFE_INT;
  return v;
}

export function encodeValue(
  prop: PropertyDef,
  value: PropertyValueInput,
): EncodedValue {
  const empty: EncodedValue = {
    text_v: null,
    num_v: null,
    date_v: null,
    bool_v: null,
    json_v: null,
  };
  if (value === null || value === undefined) return empty;

  switch (prop.type) {
    case "title":
    case "text":
    case "url":
    case "email":
    case "phone":
      return { ...empty, text_v: String(value) };

    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      return { ...empty, num_v: Number.isFinite(n) ? safeNum(n) : null };
    }

    case "unique_id": {
      const n = typeof value === "number" ? value : Number(value);
      return { ...empty, num_v: Number.isFinite(n) ? safeNum(n) : null };
    }

    case "checkbox":
      return { ...empty, bool_v: value === true || value === "true" ? 1 : 0 };

    case "date": {
      const v = value as { start: number | null; end: number | null; allDay: boolean };
      return {
        ...empty,
        date_v: safeNum(v?.start ?? null),
        json_v: JSON.stringify({ end: safeNum(v?.end ?? null), allDay: v?.allDay ?? true }),
      };
    }

    case "select":
    case "status": {
      const ids = Array.isArray(value) ? value.slice(0, 1) : value ? [String(value)] : [];
      return { ...empty, json_v: JSON.stringify(ids) };
    }

    case "multi_select": {
      const ids = Array.isArray(value) ? value : value ? [String(value)] : [];
      return { ...empty, json_v: JSON.stringify(ids) };
    }

    case "relation": {
      const v = value as { rows: string[] } | string[];
      const rows = Array.isArray(v) ? v : (v?.rows ?? []);
      return { ...empty, json_v: JSON.stringify({ rows }) };
    }

    case "files": {
      const v = value as { mediaIds: string[] } | string[];
      const mediaIds = Array.isArray(v) ? v : (v?.mediaIds ?? []);
      return { ...empty, json_v: JSON.stringify({ mediaIds }) };
    }

    case "formula":
    case "rollup":
    case "button":
      return { ...empty, json_v: JSON.stringify({ v: value }) };

    case "created_time":
    case "last_edited_time": {
      const n = typeof value === "number" ? value : Number(value);
      return { ...empty, date_v: Number.isFinite(n) ? safeNum(n) : null };
    }

    case "created_by":
    case "last_edited_by":
      return { ...empty, text_v: String(value) };
  }
}

export function readPropertyValue(
  db: Db,
  rowId: string,
  prop: PropertyDef,
): PropertyValueInput {
  const r = db.get<{
    text_v: string | null;
    num_v: number | null;
    date_v: number | null;
    bool_v: number | null;
    json_v: string | null;
  }>("SELECT * FROM property_value WHERE row_id = ? AND prop_id = ?", rowId, prop.id);

  switch (prop.type) {
    case "title": {
      const node = db.get<{ body: string | null }>("SELECT body FROM node WHERE id = ?", rowId);
      const body = parseJson<Body>(node?.body, []);
      return bodyToPlainText(body);
    }
    case "text":
    case "url":
    case "email":
    case "phone":
    case "created_by": {
      if (r?.text_v != null && r.text_v !== "") return r.text_v;
      const node = db.get<{ created_by: string }>(
        "SELECT created_by FROM node WHERE id = ?",
        rowId,
      );
      return node?.created_by ?? "";
    }
    case "last_edited_by": {
      if (r?.text_v != null && r.text_v !== "") return r.text_v;
      const node = db.get<{ updated_by: string }>(
        "SELECT updated_by FROM node WHERE id = ?",
        rowId,
      );
      return node?.updated_by ?? "";
    }
    case "number":
    case "unique_id":
      return r?.num_v ?? null;
    case "checkbox":
      return (r?.bool_v ?? 0) === 1;
    case "date": {
      const meta = parseJson<{ end: number | null; allDay: boolean }>(r?.json_v, {
        end: null,
        allDay: true,
      });
      return { start: r?.date_v ?? null, end: meta.end, allDay: meta.allDay };
    }
    case "select":
    case "status": {
      const ids = parseJson<string[]>(r?.json_v, []);
      return ids[0] ? [ids[0]] : [];
    }
    case "multi_select":
      return parseJson<string[]>(r?.json_v, []);
    case "relation": {
      const edges = db.all<{ to_row: string }>(
        "SELECT to_row FROM relation_edge WHERE prop_id = ? AND from_row = ? ORDER BY to_row",
        prop.id,
        rowId,
      );
      if (edges.length) return { rows: edges.map((e) => e.to_row) };
      return { rows: parseJson<{ rows: string[] }>(r?.json_v, { rows: [] }).rows };
    }
    case "files":
      return { mediaIds: parseJson<{ mediaIds: string[] }>(r?.json_v, { mediaIds: [] }).mediaIds };
    case "formula":
    case "rollup": {
      const cached = parseJson<{ v: unknown }>(r?.json_v, { v: null });
      return (cached.v as PropertyValueInput) ?? null;
    }
    case "button":
      return null;
    case "created_time": {
      if (r?.date_v != null) return { start: r.date_v, end: null, allDay: true };
      const node = db.get<{ created_at: number }>("SELECT created_at FROM node WHERE id = ?", rowId);
      return { start: node?.created_at ?? null, end: null, allDay: true };
    }
    case "last_edited_time": {
      if (r?.date_v != null) return { start: r.date_v, end: null, allDay: true };
      const node = db.get<{ updated_at: number }>("SELECT updated_at FROM node WHERE id = ?", rowId);
      return { start: node?.updated_at ?? null, end: null, allDay: true };
    }
  }
}

export function setPropertyValue(
  db: Db,
  rowId: string,
  propId: string,
  value: PropertyValueInput,
  opts: { actor?: ActorInfo; tx?: number } = {},
): void {
  const actor = opts.actor ?? DEFAULT_ACTOR;
  const prop = getProperty(db, propId);
  if (!prop) throw new Error(`setPropertyValue: unknown property ${propId}`);

  const encoded = encodeValue(prop, value);

  db.tx(() => {
    db.run(
      `INSERT INTO property_value (row_id, prop_id, text_v, num_v, date_v, bool_v, json_v)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(row_id, prop_id) DO UPDATE SET
         text_v = excluded.text_v, num_v = excluded.num_v, date_v = excluded.date_v,
         bool_v = excluded.bool_v, json_v = excluded.json_v`,
      rowId,
      propId,
      encoded.text_v,
      encoded.num_v,
      encoded.date_v,
      encoded.bool_v,
      encoded.json_v,
    );

    if (prop.type === "relation") syncRelationEdges(db, prop, rowId, value);

    // Title mirrors node.body so page titles, breadcrumbs and FTS stay correct.
    if (prop.type === "title" && typeof value === "string") {
      updateNode(db, rowId, { body: plainTextToBody(value) }, { actor, tx: opts.tx });
    }

    db.run(
      "UPDATE node SET updated_at = ?, updated_by = ? WHERE id = ?",
      nowMs(),
      actor.actor,
      rowId,
    );

    // Formula and rollup results are cached, so they must be refreshed whenever
    // an input changes. Written directly (not via setPropertyValue) so a formula
    // that reads its own property cannot recurse.
    recomputeRow(db, rowId);
    recomputeDependents(db, rowId);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Computed properties: Formula and Rollup
//
// Evaluation uses the hand-written formula engine (no eval, no new Function).
// Results are cached into property_value so filtering, sorting and aggregation
// treat them like any other column.
// ─────────────────────────────────────────────────────────────────────────────

export interface FormulaValidation {
  ok: boolean;
  ast?: FormulaNode;
  resultType?: "number" | "text" | "date" | "checkbox" | "unknown";
  refs?: string[];
  error?: string;
  code?: string;
  position?: number;
}

export function validateFormulaSource(source: string): FormulaValidation {
  try {
    const ast = parseFormula(source);
    return {
      ok: true,
      ast,
      resultType: inferResultType(ast),
      refs: extractRefs(ast),
    };
  } catch (err) {
    const e = err as { message?: string; code?: string; position?: number };
    return { ok: false, error: e.message ?? "parse error", code: e.code, position: e.position };
  }
}

/** Evaluate every formula/rollup property of one row and cache the results. */
export function recomputeRow(db: Db, rowId: string): void {
  const node = db.get<{ parent_id: string | null }>("SELECT parent_id FROM node WHERE id = ?", rowId);
  if (!node?.parent_id) return;
  const databaseId = databaseForNode(db, node.parent_id);
  if (!databaseId) return;

  const props = listProperties(db, databaseId);
  const computed = props.filter((p) => p.type === "formula" || p.type === "rollup");
  if (!computed.length) return;

  const byName = new Map(props.map((p) => [p.name, p]));

  for (const prop of computed) {
    let value: PropertyValueInput = null;
    try {
      value =
        prop.type === "formula"
          ? evalFormulaProp(db, rowId, prop, byName)
          : evalRollupProp(db, rowId, prop);
    } catch {
      value = null; // a broken formula shows as empty, never takes the row down
    }
    const encoded = encodeValue(prop, value);
    db.run(
      `INSERT INTO property_value (row_id, prop_id, text_v, num_v, date_v, bool_v, json_v)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(row_id, prop_id) DO UPDATE SET
         text_v = excluded.text_v, num_v = excluded.num_v, date_v = excluded.date_v,
         bool_v = excluded.bool_v, json_v = excluded.json_v`,
      rowId,
      prop.id,
      encoded.text_v,
      encoded.num_v,
      encoded.date_v,
      encoded.bool_v,
      encoded.json_v,
    );
  }
}

function evalFormulaProp(
  db: Db,
  rowId: string,
  prop: PropertyDef,
  byName: Map<string, PropertyDef>,
): PropertyValueInput {
  const config = prop.config as { source?: string; ast?: FormulaNode };
  if (!config.source?.trim() && !config.ast) return null;

  const ast = config.ast && config.ast.k ? config.ast : config.source ? parseFormula(config.source) : null;
  if (!ast) return null;

  const value = evaluateFormula(ast, {
    prop(name: string) {
      const target = byName.get(name);
      if (!target) return null;
      return normalizeValue(readPropertyValue(db, rowId, target));
    },
    today() {
      const now = new Date();
      return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    },
  });

  return denormalizeValue(prop, value);
}

function evalRollupProp(db: Db, rowId: string, prop: PropertyDef): PropertyValueInput {
  const config = prop.config as { relationProp?: string; targetProp?: string; function?: AggregateFunction };
  if (!config.relationProp || !config.targetProp) return null;

  const relation = getProperty(db, config.relationProp);
  if (!relation) return null;
  const targets = (readPropertyValue(db, rowId, relation) as { rows: string[] })?.rows ?? [];

  const targetProp = getProperty(db, config.targetProp);
  if (!targetProp) return null;

  const values = targets
    .map((t) => readPropertyValue(db, t, targetProp))
    .filter((v) => v !== null && v !== undefined && !(typeof v === "string" && v === ""));

  const nums = values
    .map((v) => (typeof v === "number" ? v : Number(v)))
    .filter((n) => Number.isFinite(n));

  const fn = config.function ?? "count";
  switch (fn) {
    case "count":
    case "countValues":
      return values.length;
    case "countAll":
      return targets.length;
    case "countUnique":
      return new Set(values.map((v) => JSON.stringify(v))).size;
    case "countChecked":
      return values.filter((v) => v === true).length;
    case "percentChecked":
      return values.length ? Math.round((values.filter((v) => v === true).length / values.length) * 100) : 0;
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    case "min":
      return nums.length ? Math.min(...nums) : null;
    case "max":
      return nums.length ? Math.max(...nums) : null;
    case "range":
      return nums.length ? Math.max(...nums) - Math.min(...nums) : null;
    case "median": {
      if (!nums.length) return 0;
      const s = [...nums].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid]! : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
    }
    case "showOriginal":
      return values.length ? joinValues(values) : null;
  }
}

function joinValues(values: PropertyValueInput[]): string {
  return values
    .map((v) => {
      if (Array.isArray(v)) return v.join(", ");
      if (typeof v === "object" && v !== null) {
        const o = v as { rows?: string[]; mediaIds?: string[]; start?: number | null };
        if (o.rows) return o.rows.length + " related";
        if (o.mediaIds) return o.mediaIds.length + " files";
        return o.start != null ? new Date(o.start).toISOString().slice(0, 10) : "";
      }
      return String(v ?? "");
    })
    .filter(Boolean)
    .join(", ");
}

/** FormulaValue → the PropertyValueInput shape this property type stores. */
function denormalizeValue(prop: PropertyDef, value: unknown): PropertyValueInput {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return prop.type === "formula" ? value : value;
  if (typeof value === "number") return value;
  if (typeof value === "string") return value;
  const v = value as { start?: number; end?: number; allDay?: boolean; items?: unknown[] };
  if (v && typeof v === "object" && "start" in v) {
    return { start: v.start ?? null, end: v.end ?? null, allDay: v.allDay ?? true };
  }
  if (v && typeof v === "object" && Array.isArray(v.items)) {
    return joinValues(v.items as PropertyValueInput[]);
  }
  return String(value);
}

/**
 * A row's computed values can depend on rows in ANOTHER database (rollups over
 * a relation). When a target row changes, refresh the rows that point at it.
 */
export function recomputeDependents(db: Db, rowId: string, depth = 0): void {
  if (depth > 4) return;
  const sources = db.all<{ from_row: string }>(
    "SELECT DISTINCT from_row FROM relation_edge WHERE to_row = ?",
    rowId,
  );
  for (const s of sources) recomputeRow(db, s.from_row);
}

// ─────────────────────────────────────────────────────────────────────────────
// Relation edges
// ─────────────────────────────────────────────────────────────────────────────

function syncRelationEdges(
  db: Db,
  prop: PropertyDef,
  rowId: string,
  value: PropertyValueInput,
): void {
  const config = prop.config as { bidirectional?: boolean; mirrorPropId?: string };
  const v = value as { rows: string[] } | string[];
  const rows = Array.isArray(v) ? v : (v?.rows ?? []);

  db.tx(() => {
    db.run("DELETE FROM relation_edge WHERE prop_id = ? AND from_row = ?", prop.id, rowId);

    // The mirror lives on the TARGET row, so clearing the forward side must also
    // remove mirror edges that point back at this row. Without this, the target
    // keeps showing a task that no longer references it.
    if (config.bidirectional && config.mirrorPropId) {
      db.run(
        "DELETE FROM relation_edge WHERE prop_id = ? AND to_row = ?",
        config.mirrorPropId,
        rowId,
      );
      db.run(
        "DELETE FROM backlink WHERE prop_id = ? AND (src = ? OR dst = ?)",
        config.mirrorPropId,
        rowId,
        rowId,
      );
    }
    db.run(
      "DELETE FROM backlink WHERE prop_id = ? AND kind = 'relation' AND src = ?",
      prop.id,
      rowId,
    );

    for (const target of rows) {
      db.run(
        "INSERT OR IGNORE INTO relation_edge (prop_id, from_row, to_row) VALUES (?, ?, ?)",
        prop.id,
        rowId,
        target,
      );
      db.run(
        `INSERT INTO backlink (src, dst, prop_id, context, kind)
         VALUES (?, ?, ?, '', 'relation')
         ON CONFLICT(src, dst, prop_id) DO NOTHING`,
        rowId,
        target,
        prop.id,
      );

      if (config.bidirectional && config.mirrorPropId) {
        db.run(
          "INSERT OR IGNORE INTO relation_edge (prop_id, from_row, to_row) VALUES (?, ?, ?)",
          config.mirrorPropId,
          target,
          rowId,
        );
        db.run(
          `INSERT INTO backlink (src, dst, prop_id, context, kind)
           VALUES (?, ?, ?, '', 'relation')
           ON CONFLICT(src, dst, prop_id) DO NOTHING`,
          target,
          rowId,
          config.mirrorPropId,
        );
      }
    }
  });
}

/** Create a relation pair on two databases in one transaction. */
export function createRelation(
  db: Db,
  sourceDb: string,
  targetDb: string,
  name: string,
  mirrorName: string,
  opts: { bidirectional?: boolean } = {},
): { source: PropertyDef; mirror: PropertyDef } {
  return db.tx(() => {
    const source = addProperty(db, sourceDb, name, "relation", {
      targetDb,
      bidirectional: opts.bidirectional ?? true,
    });
    const mirror = addProperty(db, targetDb, mirrorName, "relation", {
      targetDb: sourceDb,
      bidirectional: false,
      mirrorPropId: source.id,
      selfRelation: sourceDb === targetDb,
    });
    db.run(
      "UPDATE property_def SET config = ? WHERE id = ?",
      JSON.stringify({ ...source.config, mirrorPropId: mirror.id }),
      source.id,
    );
    return {
      source: { ...source, config: { ...source.config, mirrorPropId: mirror.id } },
      mirror,
    } as unknown as { source: PropertyDef; mirror: PropertyDef };
  });
}

export function trashRow(db: Db, rowId: string, opts: { actor?: ActorInfo } = {}): void {
  trashNode(db, rowId, opts);
}

export function restoreRow(db: Db, rowId: string, opts: { actor?: ActorInfo } = {}): void {
  restoreNode(db, rowId, opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Query engine
// ─────────────────────────────────────────────────────────────────────────────

interface Compiled {
  sql: string;
  params: SqlParam[];
}

/** SQL predicate that is true when this property's value is empty. */
function emptinessClause(prop: PropertyDef, alias: string): string {
  const c = (n: keyof EncodedValue) => `${alias}.${n}`;
  switch (prop.type) {
    case "number":
    case "unique_id":
      return `(${c("num_v")} IS NULL)`;
    case "date":
    case "created_time":
    case "last_edited_time":
      return `(${c("date_v")} IS NULL)`;
    case "checkbox":
      // a checkbox always holds 0/1, so it is never "empty"
      return `(0)`;
    case "relation":
      return `(${c("json_v")} IS NULL OR
                ifnull(json_array_length(${c("json_v")}, '$.rows'), 0) = 0)`;
    case "files":
      return `(${c("json_v")} IS NULL OR
                ifnull(json_array_length(${c("json_v")}, '$.mediaIds'), 0) = 0)`;
    case "select":
    case "multi_select":
    case "status":
      return `(${c("json_v")} IS NULL OR
                ifnull(json_array_length(${c("json_v")}), 0) = 0)`;
    case "formula":
    case "rollup":
      return `(${c("json_v")} IS NULL OR json_extract(${c("json_v")}, '$.v') IS NULL)`;
    default:
      return `(${c("text_v")} IS NULL OR ${c("text_v")} = '')`;
  }
}

/**
 * Compile one filter rule to SQL against the typed value columns.
 * `pv` is the property_value alias for THIS rule's property, so a row with
 * several filtered properties gets one join per property.
 */
function compileRule(
  rule: FilterRule,
  prop: PropertyDef,
  alias: string,
): { clause: string; params: SqlParam[] } {
  const col = (name: keyof EncodedValue) => `${alias}.${name}`;
  const { operator, value } = rule;

  const text = typeof value === "string" ? value : "";

  // Emptiness is per-type: a number is empty when num_v is NULL, a select when
  // its option array is empty, a relation when it has no target rows.
  if (operator === "isEmpty" || operator === "isNotEmpty") {
    const empty = emptinessClause(prop, alias);
    return {
      clause: operator === "isEmpty" ? empty : `NOT (${empty})`,
      params: [],
    };
  }

  switch (operator) {
    case "checked":
      return { clause: `${col("bool_v")} = 1`, params: [] };
    case "unchecked":
      return { clause: `(${col("bool_v")} = 0 OR ${col("bool_v")} IS NULL)`, params: [] };
  }

  switch (prop.type) {
    case "number":
    case "unique_id":
    case "formula":
    case "rollup": {
      const n = typeof value === "number" ? value : Number(value);
      const target: SqlParam = Number.isFinite(n) ? n : 0;
      switch (operator) {
        case "greaterThan":
          return { clause: `${col("num_v")} > ?`, params: [target] };
        case "lessThan":
          return { clause: `${col("num_v")} < ?`, params: [target] };
        case "greaterThanOrEqualTo":
          return { clause: `${col("num_v")} >= ?`, params: [target] };
        case "lessThanOrEqualTo":
          return { clause: `${col("num_v")} <= ?`, params: [target] };
        case "isNot":
          return { clause: `(${col("num_v")} <> ? OR ${col("num_v")} IS NULL)`, params: [target] };
        default:
          return { clause: `${col("num_v")} = ?`, params: [target] };
      }
    }

    case "date":
    case "created_time":
    case "last_edited_time": {
      const v = value as { start: number | null; end: number | null };
      const start = v?.start ?? 0;
      const end = v?.end ?? start;
      switch (operator) {
        case "before":
          return { clause: `${col("date_v")} < ?`, params: [start] };
        case "after":
          return { clause: `${col("date_v")} > ?`, params: [end] };
        case "isNot":
          return {
            clause: `(${col("date_v")} IS NULL OR ${col("date_v")} > ? OR ${col("date_v")} < ?)`,
            params: [end, start],
          };
        default:
          return { clause: `${col("date_v")} BETWEEN ? AND ?`, params: [start, end] };
      }
    }

    case "checkbox":
      return {
        clause: `${col("bool_v")} = ?`,
        params: [value === true || value === "true" ? 1 : 0],
      };

    case "select":
    case "multi_select":
    case "status": {
      const ids = Array.isArray(value) ? value : value ? [String(value)] : [];
      if (!ids.length) return { clause: "1=1", params: [] };
      const placeholders = ids.map(() => "?").join(",");
      // "isNot" / "doesNotContain" must negate; falling through to the positive
      // EXISTS returned exactly the rows the user asked to exclude.
      const negate = operator === "isNot" || operator === "doesNotContain";
      return {
        clause: `${negate ? "NOT " : ""}EXISTS (SELECT 1 FROM json_each(${col("json_v")}) je
                   WHERE je.value IN (${placeholders}))`,
        params: ids,
      };
    }

    case "relation": {
      const rows = Array.isArray(value)
        ? (value as string[])
        : ((value as { rows: string[] })?.rows ?? []);
      if (!rows.length) return { clause: "1=1", params: [] };
      const ph = rows.map(() => "?").join(",");
      const exists =
        operator === "doesNotContain"
          ? "NOT EXISTS"
          : "EXISTS";
      return {
        clause: `${exists} (SELECT 1 FROM relation_edge re
                   WHERE re.prop_id = ? AND re.from_row = n.id AND re.to_row IN (${ph}))`,
        params: [prop.id, ...rows],
      };
    }

    default: {
      // text-ish
      const like = `%${text.toLowerCase()}%`;
      switch (operator) {
        case "isNot":
          return {
            clause: `(${col("text_v")} IS NULL OR lower(${col("text_v")}) <> lower(?))`,
            params: [text],
          };
        case "doesNotContain":
          return {
            clause: `(${col("text_v")} IS NULL OR lower(${col("text_v")}) NOT LIKE ?)`,
            params: [like],
          };
        case "startsWith":
          return { clause: `lower(${col("text_v")}) LIKE ?`, params: [`${text.toLowerCase()}%`] };
        case "endsWith":
          return { clause: `lower(${col("text_v")}) LIKE ?`, params: [`%${text.toLowerCase()}`] };
        case "is":
          return { clause: `lower(${col("text_v")}) = lower(?)`, params: [text] };
        default:
          // isEmpty / isNotEmpty never reach here: they are handled per-type
          // at the top of compileRule.
          return { clause: `lower(${col("text_v")}) LIKE ?`, params: [like] };
      }
    }
  }
}

function compileFilter(
  group: FilterGroup,
  resolve: (propId: string) => PropertyDef | null,
  joins: { alias: string; propId: string }[],
): { clause: string; params: SqlParam[] } {
  const parts: string[] = [];
  const params: SqlParam[] = [];

  for (const rule of group.rules ?? []) {
    const prop = resolve(rule.prop);
    if (!prop) continue;

    // Title needs no special case: setPropertyValue stores it in text_v AND
    // mirrors it onto node.body, so filtering sorts on the same typed column
    // as every other text-ish property.
    let entry = joins.find((j) => j.propId === rule.prop);
    if (!entry) {
      entry = { alias: `pv${joins.length}`, propId: rule.prop };
      joins.push(entry);
    }
    const r = compileRule(rule, prop, entry.alias);
    parts.push(r.clause);
    params.push(...r.params);
  }

  for (const sub of group.groups ?? []) {
    const r = compileFilter(sub, resolve, joins);
    if (r.clause) {
      parts.push(`(${r.clause})`);
      params.push(...r.params);
    }
  }

  if (!parts.length) return { clause: "", params: [] };
  return { clause: parts.join(group.and === false ? " OR " : " AND "), params };
}

export interface QueryOptions {
  limit?: number;
  offset?: number;
}

export interface QueryResult {
  rows: RowView[];
  total: number;
}

/**
 * Fetch rows for a database under a view spec: filter, sort, group ordering,
 * pagination. Grouping itself is applied by the caller (board/calendar) over
 * this ordered result, which is why one filter definition serves every view.
 */
export function queryRows(
  db: Db,
  databaseId: string,
  spec: ViewSpec,
  opts: QueryOptions = {},
): QueryResult {
  const props = listProperties(db, databaseId);
  const byId = new Map(props.map((p) => [p.id, p]));
  const resolve = (id: string) => byId.get(id) ?? getProperty(db, id);

  const host = databaseHostNode(db, databaseId);
  const joins: { alias: string; propId: string }[] = [];
  const where = [
    "n.parent_id = ?",
    "n.kind = 'row'",
    "n.deleted_at IS NULL",
  ];
  const params: SqlParam[] = [host ?? ""];

  const filter = compileFilter(spec.filter, resolve, joins);
  if (filter.clause) {
    where.push(`(${filter.clause})`);
    params.push(...filter.params);
  }

  const joinSql = joins
    .map(
      (j) =>
        `LEFT JOIN property_value ${j.alias}
           ON ${j.alias}.row_id = n.id AND ${j.alias}.prop_id = ?`,
    )
    .join("\n");
  const joinParams = joins.map((j) => j.propId);

  const orderParts: string[] = [];
  for (const sort of spec.sort) {
    const prop = resolve(sort.prop);
    if (!prop) continue;
    const dir = sort.direction === "descending" ? "DESC" : "ASC";
    let entry = joins.find((j) => j.propId === sort.prop);
    if (!entry) {
      entry = { alias: `pv${joins.length}`, propId: sort.prop };
      joins.push(entry);
    }
    const col =
      prop.type === "number" || prop.type === "unique_id"
        ? `${entry.alias}.num_v`
        : prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time"
          ? `${entry.alias}.date_v`
          : prop.type === "checkbox"
            ? `${entry.alias}.bool_v`
            : prop.type === "select" || prop.type === "multi_select" || prop.type === "status"
              ? `json_extract(${entry.alias}.json_v, '$[0]')`
              : `${entry.alias}.text_v`;
    orderParts.push(`(${col} IS NULL) ASC, ${col} ${dir}`);
  }
  orderParts.push("n.pos ASC");

  // joins added by sorting must appear in the SQL as well
  const allJoinSql = joins
    .map(
      (j) =>
        `LEFT JOIN property_value ${j.alias}
           ON ${j.alias}.row_id = n.id AND ${j.alias}.prop_id = ?`,
    )
    .join("\n");
  const allJoinParams = joins.map((j) => j.propId);

  const total =
    db.scalar<number>(
      `SELECT count(DISTINCT n.id) FROM node n ${allJoinSql}
       WHERE ${where.join(" AND ")}`,
      ...allJoinParams,
      ...params,
    ) ?? 0;

  const rows = db.all<{ id: string }>(
    `SELECT n.id FROM node n ${allJoinSql}
     WHERE ${where.join(" AND ")}
     GROUP BY n.id
     ORDER BY ${orderParts.join(", ")}
     ${opts.limit ? `LIMIT ${Math.trunc(opts.limit)}${opts.offset ? ` OFFSET ${Math.trunc(opts.offset)}` : ""}` : ""}`,
    ...allJoinParams,
    ...params,
  );

  return {
    rows: rows
      .map((r) => getRow(db, r.id))
      .filter((r): r is RowView => r !== null),
    total,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregations (column footers)
// ─────────────────────────────────────────────────────────────────────────────

export function aggregate(
  db: Db,
  databaseId: string,
  propId: string,
  fn: AggregateFunction,
  spec?: ViewSpec,
): number | string | null {
  const prop = resolveProp(db, databaseId, propId);
  if (!prop) return null;

  const scoped = spec
    ? queryRows(db, databaseId, spec).rows
    : listRows(db, databaseId);

  const values = scoped.map((r) => r.values[propId]);

  const nums = values
    .map((v) => (typeof v === "number" ? v : Number(v)))
    .filter((n) => Number.isFinite(n));

  switch (fn) {
    case "count":
      return values.filter((v) => !isEmptyValue(v)).length;
    case "countAll":
      return values.length;
    case "countValues":
      return values.filter((v) => !isEmptyValue(v)).length;
    case "countUnique":
      return new Set(values.map((v) => JSON.stringify(v))).size;
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
      if (prop.type === "date") {
        const first = values.find((v) => v && typeof v === "object") as
          | { start: number }
          | undefined;
        return first?.start ? new Date(first.start).toISOString().slice(0, 10) : "";
      }
      const first = values.find((v) => !isEmptyValue(v));
      return typeof first === "string" ? first : (String(first ?? "") || null);
    }
  }
}

function isEmptyValue(v: PropertyValueInput | undefined): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") {
    const o = v as { rows?: string[]; mediaIds?: string[]; start?: number | null };
    if ("rows" in o) return (o.rows ?? []).length === 0;
    if ("mediaIds" in o) return (o.mediaIds ?? []).length === 0;
    return o.start == null;
  }
  return false;
}

function resolveProp(db: Db, databaseId: string, propId: string): PropertyDef | null {
  const p = getProperty(db, propId);
  return p && p.db_id === databaseId ? p : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grouping (board columns, calendar buckets)
// ─────────────────────────────────────────────────────────────────────────────

export interface GroupBucket {
  key: string;
  label: string;
  color: string;
  rows: RowView[];
}

export function groupRows(
  db: Db,
  databaseId: string,
  rows: RowView[],
  groupPropId: string,
  subGroupPropId?: string,
): GroupBucket[] {
  const prop = resolveProp(db, databaseId, groupPropId);
  if (!prop) return [{ key: "", label: "Ungrouped", color: "default", rows }];

  const buckets = new Map<string, GroupBucket>();

  const labelFor = (
    value: PropertyValueInput | undefined,
  ): { key: string; label: string; color: string } => {
    if (prop.type === "select" || prop.type === "multi_select" || prop.type === "status") {
      const ids = (Array.isArray(value) ? value : []) as string[];
      const options = optionsOf(prop);
      if (!ids.length) return { key: "__empty", label: "Empty", color: "gray" };
      const opt = options.find((o) => o.id === ids[0]);
      return { key: ids[0] ?? "__empty", label: opt?.name ?? "Empty", color: opt?.color ?? "default" };
    }
    if (prop.type === "checkbox") {
      return value === true
        ? { key: "checked", label: "Checked", color: "green" }
        : { key: "unchecked", label: "Unchecked", color: "gray" };
    }
    if (prop.type === "relation") {
      const rowsV = (value as { rows?: string[] })?.rows ?? [];
      if (!rowsV.length) return { key: "__empty", label: "Empty", color: "gray" };
      const first = rowsV[0]!;
      const title = db.scalar<string>(
        `SELECT ifnull(group_concat(json_extract(j.value,'$.text'),' '),'')
         FROM json_each((SELECT body FROM node WHERE id = ?)) j`,
        first,
      );
      return { key: first, label: title || "Untitled", color: "default" };
    }
    if (prop.type === "date") {
      const start = (value as { start?: number })?.start;
      if (!start) return { key: "__empty", label: "No date", color: "gray" };
      const d = new Date(start);
      return {
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
        label: d.toLocaleDateString(undefined, { year: "numeric", month: "long" }),
        color: "default",
      };
    }
    const s = typeof value === "string" ? value : String(value ?? "");
    return { key: s || "__empty", label: s || "Empty", color: "default" };
  };

  for (const row of rows) {
    const { key, label, color } = labelFor(row.values[groupPropId]);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, label, color, rows: [] };
      buckets.set(key, bucket);
    }
    bucket.rows.push(row);
  }

  // status groups keep Notion's canonical order
  if (prop.type === "status") {
    const order = ["to_do", "in_progress", "complete"];
    const options = optionsOf(prop);
    const rank = (k: string): number => {
      const opt = options.find((o) => o.id === k);
      const g = (prop.config as { groups?: StatusGroup[] }).groups ?? [];
      const gi = g.findIndex((grp) => grp.options.some((o) => o.id === opt?.id));
      return gi === -1 ? 99 : order.indexOf(g[gi]!.id);
    };
    return [...buckets.values()].sort((a, b) => rank(a.key) - rank(b.key));
  }

  return [...buckets.values()];
}

export function optionsOf(prop: PropertyDef): SelectOption[] {
  if (prop.type === "status") {
    const groups = (prop.config as { groups?: StatusGroup[] }).groups ?? [];
    return groups.flatMap((g) => g.options);
  }
  return ((prop.config as { options?: SelectOption[] }).options ?? []) as SelectOption[];
}

export function addSelectOption(
  db: Db,
  propId: string,
  name: string,
  color = "default",
): SelectOption {
  const prop = getProperty(db, propId);
  if (!prop) throw new Error(`addSelectOption: unknown property ${propId}`);
  const option: SelectOption = { id: newId(), name, color: color as SelectOption["color"] };

  if (prop.type === "status") {
    const config = prop.config as { groups?: StatusGroup[] };
    const groups = config.groups ?? [];
    groups[0]?.options.push(option);
    db.run(
      "UPDATE property_def SET config = ? WHERE id = ?",
      JSON.stringify({ ...config, groups }),
      propId,
    );
  } else {
    const config = prop.config as { options?: SelectOption[] };
    const options = config.options ?? [];
    options.push(option);
    db.run(
      "UPDATE property_def SET config = ? WHERE id = ?",
      JSON.stringify({ ...config, options }),
      propId,
    );
  }
  return option;
}

export function renameSelectOption(
  db: Db,
  propId: string,
  optionId: string,
  patch: Partial<SelectOption>,
): void {
  const prop = getProperty(db, propId);
  if (!prop) return;
  const mutate = (o: SelectOption): SelectOption => ({ ...o, ...patch });

  if (prop.type === "status") {
    const config = prop.config as { groups?: StatusGroup[] };
    for (const g of config.groups ?? []) {
      g.options = g.options.map((o) => (o.id === optionId ? mutate(o) : o));
    }
    db.run("UPDATE property_def SET config = ? WHERE id = ?", JSON.stringify(config), propId);
  } else {
    const config = prop.config as { options?: SelectOption[] };
    config.options = (config.options ?? []).map((o) =>
      o.id === optionId ? mutate(o) : o,
    );
    db.run("UPDATE property_def SET config = ? WHERE id = ?", JSON.stringify(config), propId);
  }
}

export function removeSelectOption(db: Db, propId: string, optionId: string): void {
  const prop = getProperty(db, propId);
  if (!prop) return;

  if (prop.type === "status") {
    const config = prop.config as { groups?: StatusGroup[] };
    for (const g of config.groups ?? []) {
      g.options = g.options.filter((o) => o.id !== optionId);
    }
    db.run("UPDATE property_def SET config = ? WHERE id = ?", JSON.stringify(config), propId);
  } else {
    const config = prop.config as { options?: SelectOption[] };
    config.options = (config.options ?? []).filter((o) => o.id !== optionId);
    db.run("UPDATE property_def SET config = ? WHERE id = ?", JSON.stringify(config), propId);
  }

  // drop the option from every row that used it
  for (const row of listRows(db, prop.db_id)) {
    const value = row.values[propId];
    if (!Array.isArray(value)) continue;
    const next = value.filter((id) => id !== optionId);
    if (next.length !== value.length) {
      setPropertyValue(db, row.node.id, propId, next as PropertyValueInput);
    }
  }
}

export function deleteProperty(db: Db, propId: string): void {
  const prop = getProperty(db, propId);
  if (!prop) return;
  if (prop.type === "title") {
    const rest = listProperties(db, prop.db_id).filter((p) => p.type === "title");
    if (rest.length <= 1) throw new Error("deleteProperty: a database needs a Title property");
  }
  db.run("DELETE FROM property_def WHERE id = ?", propId);
}

export function renameProperty(db: Db, propId: string, name: string): void {
  db.run("UPDATE property_def SET name = ? WHERE id = ?", name, propId);
}

export function changePropertyType(
  db: Db,
  propId: string,
  type: PropertyType,
  config?: Record<string, unknown>,
): void {
  const prop = getProperty(db, propId);
  if (!prop) return;
  db.run(
    "UPDATE property_def SET type = ?, config = ? WHERE id = ?",
    type,
    JSON.stringify(withDefaultConfig(type, config ?? {})),
    propId,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cloning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rewrite id references inside a JSON value.
 *
 * Formula configs, rollup configs, view specs and relation values all store
 * property and row ids as quoted JSON strings, so replacing exact quoted
 * tokens is safe — a ULID never appears as a fragment of a longer quoted token.
 */
function remapIds<T>(value: T, map: Map<string, string>): T {
  if (typeof value === "string") {
    let out: string = value;
    for (const [from, to] of map) out = out.split(`"${from}"`).join(`"${to}"`);
    return out as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => remapIds(v, map)) as T;
  if (value && typeof value === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) o[k] = remapIds(v, map);
    return o as T;
  }
  return value;
}

interface ValueRow {
  prop_id: string;
  text_v: string | null;
  num_v: number | null;
  date_v: number | null;
  bool_v: number | null;
  json_v: string | null;
}

export interface CloneDatabaseInput {
  ws: string;
  parent_id: string | null;
  parent_kind: "node" | "database" | "workspace";
  title?: string;
  icon?: string;
  actor?: ActorInfo;
  /**
   * Shared across a multi-database clone so a relation from one cloned database
   * to another lands on the clone, not on the template's original.
   */
  idMap?: Map<string, string>;
}

/**
 * Deep-copy a database: properties, rows with their typed values, and views.
 *
 * Templates must not share a live database. Applying "Bug tracker" twice has to
 * produce two independent trackers, not two windows onto one — so every id is
 * regenerated and every reference to an old id (formula refs, rollup targets,
 * view filters and sorts, relation values) is rewritten through the map.
 */
export function cloneDatabase(
  db: Db,
  sourceId: string,
  input: CloneDatabaseInput,
): { databaseId: string; node: string; idMap: Map<string, string> } {
  const actor = input.actor ?? DEFAULT_ACTOR;
  const map = input.idMap ?? new Map<string, string>();

  const src = db.get<{ title: string; icon: string | null }>(
    "SELECT title, icon FROM database_obj WHERE id = ?",
    sourceId,
  );
  if (!src) throw new Error(`cloneDatabase: database ${sourceId} does not exist`);

  const created = createDatabase(db, {
    ws: input.ws,
    parent_id: input.parent_id,
    parent_kind: input.parent_kind,
    title: input.title ?? src.title,
    icon: input.icon ?? src.icon ?? undefined,
    properties: [],
    views: [],
    actor,
  });

  // Properties first: values and view specs reference their ids.
  for (const p of listProperties(db, sourceId)) {
    const np = addProperty(
      db,
      created.databaseId,
      p.name,
      p.type,
      remapIds(p.config, map) as unknown as Record<string, unknown>,
      { actor },
    );
    map.set(p.id, np.id);
  }

  // Rows: the node, then its typed value columns.
  for (const r of listRows(db, sourceId)) {
    const rowId = createNode(db, {
      ws: input.ws,
      kind: "row",
      type: "table_row",
      parent_id: created.node,
      parent_kind: "node",
      body: r.node.body,
      props: r.node.props,
      meta: r.node.meta,
      actor,
    });
    map.set(r.node.id, rowId);

    for (const v of db.all<ValueRow>("SELECT prop_id, text_v, num_v, date_v, bool_v, json_v FROM property_value WHERE row_id = ?", r.node.id)) {
      db.run(
        `INSERT INTO property_value (row_id, prop_id, text_v, num_v, date_v, bool_v, json_v)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        rowId,
        map.get(v.prop_id) ?? v.prop_id,
        v.text_v,
        v.num_v,
        v.date_v,
        v.bool_v,
        v.json_v == null ? null : remapIds(v.json_v, map),
      );
    }
  }

  // Views last: their specs reference properties and rows.
  for (const v of listViews(db, sourceId)) {
    createView(db, created.databaseId, v.name, v.type, 1, { actor, spec: remapIds(v.spec, map) });
  }

  return { databaseId: created.databaseId, node: created.node, idMap: map };
}
