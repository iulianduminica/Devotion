/**
 * Workspace services: search, breadcrumbs, trash, version history, templates,
 * media blobs, settings, and page stats.
 *
 * Version history reads the `op_log` and materialises `snapshot` rows; trash is
 * the `deleted_at` flag written by the same op path, so restore is an inverse op.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import type { Db, WorkspacePaths } from "./db.ts";
import { parseJson, nowMs } from "./db.ts";
import { newId, keyBetween } from "./ids.ts";
import {
  createNode,
  updateNode,
  trashNode,
  restoreNode,
  getBacklinks,
  DEFAULT_ACTOR,
  type ActorInfo,
} from "./ops.ts";
import { cloneDatabase } from "./databases.ts";
import {
  bodyToPlainText,
  plainTextToBody,
  type BacklinkEntry,
  type Body,
  type NodeRow,
  type NodeTree,
  type PageMeta,
  type SearchHit,
  type SnapshotEntry,
  type TrashEntry,
  type WorkspaceInfo,
} from "../shared/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Node mapping
// ─────────────────────────────────────────────────────────────────────────────

const NODE_COLUMNS = `id, ws, kind, type, parent_id, parent_kind, pos, props, body, meta,
  created_at, created_by, updated_at, updated_by, deleted_at, template_ref`;

export function mapNode(r: Record<string, unknown>): NodeRow {
  return {
    ...r,
    props: parseJson<Record<string, unknown>>(r["props"], {}),
    body: parseJson<Body | null>(r["body"], null),
    meta: parseJson<PageMeta>(r["meta"], {}),
  } as unknown as NodeRow;
}

export function getNode(db: Db, id: string): NodeRow | null {
  const r = db.get<Record<string, unknown>>(
    `SELECT ${NODE_COLUMNS} FROM node WHERE id = ?`,
    id,
  );
  return r ? mapNode(r) : null;
}

export function nodeTitle(node: NodeRow): string {
  return bodyToPlainText(node.body) || "Untitled";
}

export function nodeIcon(node: NodeRow): string | undefined {
  const meta = typeof node.meta === "string" ? parseJson<PageMeta>(node.meta, {}) : node.meta;
  if (meta?.icon) return meta.icon;
  if (node.type === "to_do") return node.props && (node.props as { checked?: boolean }).checked ? "☑️" : "⬜";
  return undefined;
}

/** Children of a node, active only, in fractional-index order. */
export function childrenOf(db: Db, parentId: string | null): NodeRow[] {
  return db
    .all<Record<string, unknown>>(
      `SELECT ${NODE_COLUMNS} FROM node
       WHERE parent_id IS ? AND deleted_at IS NULL
       ORDER BY pos`,
      parentId,
    )
    .map(mapNode);
}

/** The full block tree under a node, in document order. */
export function getTree(db: Db, rootId: string, maxDepth = 20): NodeTree | null {
  const root = getNode(db, rootId);
  if (!root) return null;

  const build = (node: NodeRow, depth: number): NodeTree => {
    const children =
      depth >= maxDepth
        ? []
        : childrenOf(db, node.id).map((c) => build(c, depth + 1));
    return { ...node, children } as NodeTree;
  };
  return build(root, 0);
}

/** Ancestor chain, root first — the breadcrumb trail. */
export function breadcrumbs(db: Db, nodeId: string): { id: string; title: string; icon?: string }[] {
  const rows = db.all<{ id: string; title: string; icon: string | null }>(
    `WITH RECURSIVE chain(id, parent_id, depth, title, icon) AS (
       SELECT id, parent_id, 0,
              ifnull((SELECT group_concat(json_extract(j.value,'$.text'),' ') FROM json_each(node.body) j), ''),
              json_extract(node.meta, '$.icon')
       FROM node WHERE id = ?
       UNION ALL
       SELECT n.id, n.parent_id, c.depth + 1,
              ifnull((SELECT group_concat(json_extract(j.value,'$.text'),' ') FROM json_each(n.body) j), ''),
              json_extract(n.meta, '$.icon')
       FROM node n JOIN chain c ON n.id = c.parent_id
       WHERE c.depth < 30 AND n.deleted_at IS NULL
     )
     SELECT id, title, icon FROM chain ORDER BY depth DESC`,
    nodeId,
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title || "Untitled",
    icon: r.icon ?? undefined,
  }));
}

/** Pages and sub-pages for the sidebar tree. */
export function pageTree(db: Db, ws: string): NodeTree[] {
  const roots = db.all<Record<string, unknown>>(
    `SELECT ${NODE_COLUMNS} FROM node
     WHERE ws = ? AND parent_id IS NULL AND deleted_at IS NULL
       AND kind IN ('page','block')
       AND json_extract(meta, '$.tpl') IS NULL
     ORDER BY pos`,
    ws,
  );

  const build = (row: NodeRow, depth: number): NodeTree => {
    const kids = depth > 12 ? [] : pageChildren(db, row.id);
    return { ...row, children: kids.map((k) => build(k, depth + 1)) } as NodeTree;
  };
  return roots.map((r) => build(mapNode(r), 0));
}

function pageChildren(db: Db, parentId: string): NodeRow[] {
  return db
    .all<Record<string, unknown>>(
      `SELECT ${NODE_COLUMNS} FROM node
       WHERE parent_id = ? AND deleted_at IS NULL
         AND type IN ('page','child_page')
         AND json_extract(meta, '$.tpl') IS NULL
       ORDER BY pos`,
      parentId,
    )
    .map(mapNode);
}

// ─────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────

/** Quote a user query so FTS5 operators can't be injected. */
export function ftsQuote(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
  return terms.join(" AND ");
}

export function search(
  db: Db,
  ws: string,
  query: string,
  opts: { limit?: number; includeTrash?: boolean } = {},
): SearchHit[] {
  const q = ftsQuote(query);
  if (!q) return [];

  const rows = db.all<{
    node_id: string;
    title: string;
    body: string;
    score: number;
  }>(
    `SELECT s.node_id,
            s.title,
            snippet(node_fts, 1, '<<', '>>', ' … ', 12) AS body,
            bm25(node_fts, 8.0, 1.0) AS score
     FROM node_fts
     JOIN search_doc s ON s.rid = node_fts.rowid
     WHERE node_fts MATCH ? AND s.ws = ? ${opts.includeTrash ? "" : "AND s.deleted = 0"}
       AND NOT EXISTS (
         SELECT 1 FROM node n WHERE n.id = s.node_id AND json_extract(n.meta, '$.tpl') IS NOT NULL
       )
     ORDER BY score
     LIMIT ?`,
    q,
    ws,
    opts.limit ?? 50,
  );

  return rows.map((r) => ({
    node_id: r.node_id,
    title: r.title || "Untitled",
    snippet: (r.body || "").replace(/<<|>>/g, "").slice(0, 300),
    score: -r.score,
    path: breadcrumbs(db, r.node_id),
    updated_at: getNode(db, r.node_id)?.updated_at ?? 0,
  }));
}

/** Recent pages for the home panel. */
export function recentPages(db: Db, ws: string, limit = 12): NodeRow[] {
  return db
    .all<Record<string, unknown>>(
      `SELECT ${NODE_COLUMNS} FROM node
       WHERE ws = ? AND deleted_at IS NULL AND kind IN ('page','row','block')
         AND (type IN ('page','child_page','table_row','child_database')
              OR body IS NOT NULL)
       ORDER BY updated_at DESC
       LIMIT ?`,
      ws,
      limit,
    )
    .map(mapNode);
}

// ─────────────────────────────────────────────────────────────────────────────
// Trash
// ─────────────────────────────────────────────────────────────────────────────

export function listTrash(db: Db, ws: string): TrashEntry[] {
  const rows = db.all<Record<string, unknown>>(
    `SELECT ${NODE_COLUMNS} FROM node
     WHERE ws = ? AND deleted_at IS NOT NULL
     ORDER BY deleted_at DESC`,
    ws,
  );
  return rows.map((raw) => {
    const node = mapNode(raw);
    return {
      node_id: node.id,
      title: nodeTitle(node),
      icon: nodeIcon(node),
      type: node.type,
      deleted_at: node.deleted_at ?? 0,
      path: node.parent_id ? breadcrumbs(db, node.parent_id) : [],
    };
  });
}

export function purgeNode(db: Db, id: string): void {
  db.tx(() => {
    db.run("DELETE FROM backlink WHERE src = ? OR dst = ?", id, id);
    db.run("DELETE FROM node WHERE id = ?", id);
  });
}

export function emptyTrash(db: Db, ws: string): number {
  const ids = db.all<{ id: string }>(
    "SELECT id FROM node WHERE ws = ? AND deleted_at IS NOT NULL",
    ws,
  );
  db.tx(() => {
    for (const row of ids) purgeNode(db, row.id);
  });
  return ids.length;
}

export function trashDescendants(db: Db, rootId: string): void {
  db.run(
    `WITH RECURSIVE tree(id) AS (
       SELECT id FROM node WHERE id = ?
       UNION ALL
       SELECT n.id FROM node n JOIN tree t ON n.parent_id = t.id
     )
     UPDATE node SET deleted_at = ? WHERE id IN (SELECT id FROM tree) AND id <> ?`,
    rootId,
    nowMs(),
    rootId,
  );
}

export function restoreDescendants(db: Db, rootId: string): void {
  db.run(
    `WITH RECURSIVE tree(id) AS (
       SELECT id FROM node WHERE id = ?
       UNION ALL
       SELECT n.id FROM node n JOIN tree t ON n.parent_id = t.id
     )
     UPDATE node SET deleted_at = NULL WHERE id IN (SELECT id FROM tree)`,
    rootId,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Version history
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A snapshot is the gzipped subtree of a page. The op log records what changed;
 * snapshots make "restore to Tuesday" a single read, so history stays fast as
 * the log grows.
 */
export function snapshotPage(
  db: Db,
  nodeId: string,
  label: string | null = null,
): SnapshotEntry | null {
  const node = getNode(db, nodeId);
  if (!node) return null;
  const tree = getTree(db, nodeId, 40);
  if (!tree) return null;

  const payload = gzipSync(Buffer.from(JSON.stringify(tree), "utf8"));
  const id = newId();
  const ts = nowMs();

  db.run(
    `INSERT INTO snapshot (id, node_id, ws, ts, label, state, bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    nodeId,
    node.ws,
    ts,
    label,
    payload,
    payload.byteLength,
  );

  // keep history bounded: the newest 50 snapshots per page
  const stale = db.all<{ id: string }>(
    `SELECT id FROM snapshot WHERE node_id = ? ORDER BY ts DESC LIMIT -1 OFFSET 50`,
    nodeId,
  );
  for (const s of stale) db.run("DELETE FROM snapshot WHERE id = ?", s.id);

  return { id, node_id: nodeId, ts, label, bytes: payload.byteLength };
}

export function listSnapshots(db: Db, nodeId: string): SnapshotEntry[] {
  return db
    .all<{ id: string; node_id: string; ts: number; label: string | null; bytes: number }>(
      `SELECT id, node_id, ts, label, bytes FROM snapshot
       WHERE node_id = ? ORDER BY ts DESC`,
      nodeId,
    )
    .map((s) => ({ id: s.id, node_id: s.node_id, ts: s.ts, label: s.label, bytes: s.bytes }));
}

export function snapshotState(db: Db, snapshotId: string): NodeTree | null {
  const s = db.get<{ state: Uint8Array }>("SELECT state FROM snapshot WHERE id = ?", snapshotId);
  if (!s) return null;
  try {
    const json = gunzipSync(Buffer.from(s.state)).toString("utf8");
    return JSON.parse(json) as NodeTree;
  } catch {
    return null;
  }
}

/**
 * Restore a page to a snapshot: remove current children, re-insert the captured
 * subtree. Goes through the op path, so the restore itself is undoable.
 */
export function restoreSnapshot(
  db: Db,
  snapshotId: string,
  opts: { actor?: ActorInfo } = {},
): boolean {
  const actor = opts.actor ?? DEFAULT_ACTOR;
  const meta = db.get<{ node_id: string }>("SELECT node_id FROM snapshot WHERE id = ?", snapshotId);
  if (!meta) return false;
  const tree = snapshotState(db, snapshotId);
  if (!tree) return false;

  const nodeId = meta.node_id;
  const current = getNode(db, nodeId);
  if (!current) return false;

  snapshotPage(db, nodeId, "before restore");

  db.tx(() => {
    db.run(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM node WHERE parent_id = ?
         UNION ALL
         SELECT n.id FROM node n JOIN tree t ON n.parent_id = t.id
       )
       DELETE FROM node WHERE id IN (SELECT id FROM tree)`,
      nodeId,
    );

    updateNode(db, nodeId, { body: tree.body, props: tree.props, meta: tree.meta }, { actor });

    const walk = (node: NodeTree, parentId: string) => {
      for (const child of node.children) {
        const created = createNode(db, {
          ws: current.ws,
          kind: child.kind,
          type: child.type,
          parent_id: parentId,
          parent_kind: "node",
          pos: child.pos,
          props: child.props as Record<string, unknown>,
          body: child.body,
          meta: child.meta,
          actor,
        });
        walk(child, created);
      }
    };
    walk(tree, nodeId);
  });

  return true;
}

/** Ops touching a node, newest first — the "recent edits" list. */
export function nodeOps(db: Db, nodeId: string, limit = 100) {
  return db
    .all<{ seq: number; ts: number; actor: string; op: string; tx: number }>(
      `SELECT seq, ts, actor, op, tx FROM op_log
       WHERE node_id = ? ORDER BY seq DESC LIMIT ?`,
      nodeId,
      limit,
    )
    .map((r) => ({ ...r, patch: {} }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

export interface TemplateSummary {
  id: string;
  name: string;
  scope: "page" | "database";
  icon: string | null;
  created_at: number;
}

export function saveTemplate(
  db: Db,
  ws: string,
  name: string,
  nodeId: string,
  scope: "page" | "database",
): TemplateSummary {
  const tree = getTree(db, nodeId, 40);
  const payload = gzipSync(Buffer.from(JSON.stringify(tree ?? {}), "utf8"));
  const id = newId();
  const node = getNode(db, nodeId);

  db.run(
    `INSERT INTO template (id, ws, name, scope, icon, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    ws,
    name,
    scope,
    nodeIcon(node ?? ({ meta: {}, type: "page", body: null } as NodeRow)) ?? null,
    payload,
    nowMs(),
  );
  return { id, name, scope, icon: nodeIcon(node ?? ({} as NodeRow)) ?? null, created_at: nowMs() };
}

export function listTemplates(db: Db, ws: string): TemplateSummary[] {
  return db
    .all<{ id: string; name: string; scope: string; icon: string | null; created_at: number }>(
      `SELECT id, name, scope, icon, created_at FROM template WHERE ws = ? ORDER BY name`,
      ws,
    )
    .map((t) => ({
      id: t.id,
      name: t.name,
      scope: t.scope as "page" | "database",
      icon: t.icon,
      created_at: t.created_at,
    }));
}

export function deleteTemplate(db: Db, id: string): void {
  db.run("DELETE FROM template WHERE id = ?", id);
}

/** Instantiate a template as a new page under `parentId`. */
export function applyTemplate(
  db: Db,
  templateId: string,
  ws: string,
  parentId: string | null,
  title?: string,
  opts: { actor?: ActorInfo } = {},
): string | null {
  const actor = opts.actor ?? DEFAULT_ACTOR;
  const row = db.get<{ payload: Uint8Array; name: string }>(
    "SELECT payload, name FROM template WHERE id = ?",
    templateId,
  );
  if (!row) return null;

  const tree = JSON.parse(gunzipSync(Buffer.from(row.payload)).toString("utf8")) as NodeTree;
  const body = title ? plainTextToBody(title) : tree.body;

  return db.tx(() => {
    const root = createNode(db, {
      ws,
      kind: "page",
      type: parentId ? "child_page" : "page",
      parent_id: parentId,
      parent_kind: parentId ? "node" : "workspace",
      body,
      props: tree.props as Record<string, unknown>,
      meta: tree.meta,
      actor,
    });

    // One map for the whole template: a relation from one cloned database to
    // another must resolve to the clones, not to the template's originals.
    const idMap = new Map<string, string>();

    const walk = (node: NodeTree, parentIdInner: string) => {
      for (const child of node.children) {
        const childProps = child.props as Record<string, unknown> | null;
        if (child.type === "child_database" && typeof childProps?.databaseId === "string") {
          // Cloning gives this page its own copy of the database — properties,
          // rows and views — so applying the same template twice produces two
          // independent databases instead of two windows onto one.
          // cloneDatabase creates the host node itself, under this parent.
          cloneDatabase(db, childProps.databaseId, {
            ws,
            parent_id: parentIdInner,
            parent_kind: "node",
            actor,
            idMap,
          });
          continue;
        }

        const created = createNode(db, {
          ws,
          kind: child.kind,
          type: child.type,
          parent_id: parentIdInner,
          parent_kind: "node",
          props: childProps as Record<string, unknown>,
          body: child.body,
          meta: child.meta,
          actor,
        });
        walk(child, created);
      }
    };
    walk(tree, root);
    return root;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Media: content-addressed blobs
// ─────────────────────────────────────────────────────────────────────────────

export interface StoredMedia {
  id: string;
  sha256: string;
  mime: string;
  bytes: number;
  name: string | null;
  width: number | null;
  height: number | null;
  reused: boolean;
}

export function putMedia(
  db: Db,
  paths: WorkspacePaths,
  ws: string,
  data: Buffer,
  mime: string,
  name: string | null = null,
): StoredMedia {
  const sha256 = createHash("sha256").update(data).digest("hex");

  const existing = db.get<{ id: string }>(
    "SELECT id FROM media WHERE ws = ? AND sha256 = ?",
    ws,
    sha256,
  );
  if (existing) return { ...existing, sha256, mime, bytes: data.byteLength, name, width: null, height: null, reused: true };

  const subdir = join(paths.mediaDir, sha256.slice(0, 2));
  if (!existsSync(subdir)) mkdirSync(subdir, { recursive: true });
  const filePath = join(subdir, sha256);
  writeFileSync(filePath, data);

  const id = newId();
  const dims = imageDims(mime, data);
  db.run(
    `INSERT INTO media (id, ws, sha256, mime, bytes, name, width, height, path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    ws,
    sha256,
    mime,
    data.byteLength,
    name,
    dims.width,
    dims.height,
    filePath,
    nowMs(),
  );

  return { id, sha256, mime, bytes: data.byteLength, name, ...dims, reused: false };
}

/** Read width/height from PNG, JPEG, GIF, WebP headers without a dependency. */
function imageDims(mime: string, buf: Buffer): { width: number | null; height: number | null } {
  try {
    if (mime === "image/png" && buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === "image/gif" && buf.length > 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === "image/jpeg") {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1]!;
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    if (mime === "image/webp" && buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF") {
      const chunk = buf.toString("ascii", 8, 12);
      if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === "VP8 " && buf.length > 29) {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
    }
  } catch {
    // dimensions are a nicety; never fail an upload over them
  }
  return { width: null, height: null };
}

export function getMedia(db: Db, id: string): { path: string; mime: string; name: string | null } | null {
  const r = db.get<{ path: string; mime: string; name: string | null }>(
    "SELECT path, mime, name FROM media WHERE id = ?",
    id,
  );
  return r ?? null;
}

export function readMedia(db: Db, id: string): Buffer | null {
  const m = getMedia(db, id);
  if (!m || !existsSync(m.path)) return null;
  return readFileSync(m.path);
}

export function totalMediaBytes(db: Db, ws: string): number {
  return Number(db.scalar<number>("SELECT ifnull(sum(bytes),0) b FROM media WHERE ws = ?", ws) ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace info & settings
// ─────────────────────────────────────────────────────────────────────────────

export function workspaceInfo(db: Db, ws: string): WorkspaceInfo | null {
  const w = db.get<{ id: string; name: string; created_at: number }>(
    "SELECT id, name, created_at FROM workspace WHERE id = ?",
    ws,
  );
  if (!w) return null;
  return {
    id: w.id,
    name: w.name,
    created_at: w.created_at,
    nodeCount:
      Number(db.scalar<number>(
        "SELECT count(*) c FROM node WHERE ws = ? AND deleted_at IS NULL",
        ws,
      )) || 0,
    dbCount:
      Number(db.scalar<number>(
        "SELECT count(*) c FROM database_obj WHERE ws = ? AND deleted_at IS NULL",
        ws,
      )) || 0,
    bytes: totalMediaBytes(db, ws),
  };
}

export function setSetting(db: Db, ws: string, key: string, value: unknown): void {
  db.run(
    `INSERT INTO setting (ws, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(ws, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ws,
    key,
    JSON.stringify(value),
    nowMs(),
  );
}

export function getSetting<T>(db: Db, ws: string, key: string, fallback: T): T {
  const r = db.get<{ value: string }>("SELECT value FROM setting WHERE ws = ? AND key = ?", ws, key);
  return r ? parseJson<T>(r.value, fallback) : fallback;
}

export function allSettings(db: Db, ws: string): Record<string, unknown> {
  const rows = db.all<{ key: string; value: string }>("SELECT key, value FROM setting WHERE ws = ?", ws);
  return Object.fromEntries(rows.map((r) => [r.key, parseJson<unknown>(r.value, null)]));
}

// ─────────────────────────────────────────────────────────────────────────────
// Page creation helpers used by the UI
// ─────────────────────────────────────────────────────────────────────────────

export function createPage(
  db: Db,
  ws: string,
  parentId: string | null,
  title = "",
  icon?: string,
  opts: { actor?: ActorInfo; pos?: string; before?: string | null; after?: string | null } = {},
): string {
  return createNode(db, {
    ws,
    kind: "page",
    type: parentId ? "child_page" : "page",
    parent_id: parentId,
    parent_kind: parentId ? "node" : "workspace",
    body: plainTextToBody(title),
    meta: icon ? { icon } : {},
    pos: opts.pos,
    before: opts.before,
    after: opts.after,
    actor: opts.actor,
  });
}

export function setPageMeta(
  db: Db,
  nodeId: string,
  patch: Partial<PageMeta>,
  opts: { actor?: ActorInfo } = {},
): void {
  const node = getNode(db, nodeId);
  if (!node) return;
  const meta = { ...(typeof node.meta === "string" ? parseJson<PageMeta>(node.meta, {}) : node.meta), ...patch };
  updateNode(db, nodeId, { meta }, opts);
}

export { getBacklinks, trashNode, restoreNode, keyBetween, newId };
export type { BacklinkEntry };
