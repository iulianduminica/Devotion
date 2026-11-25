/**
 * The write path.
 *
 * Every mutation in the app goes through here and nowhere else. That single
 * choke point is what buys undo/redo, page version history, trash/restore,
 * backup, and later multi-device sync — each one derives from `op_log`.
 *
 * Invariants:
 *   - A user "edit" is a `tx` (transaction id) grouping many ops, so undo is
 *     word/paragraph granular, not per keystroke.
 *   - Every op stores `prev` so it can be inverted exactly.
 *   - Derived tables (backlinks) are rebuilt in the same transaction, so they
 *     can never drift. FTS is handled by SQL triggers.
 */

import type { Db, SqlParam } from "./db.ts";
import { nowMs } from "./db.ts";
import { keyBetween, keysBetween, newId, MAX_KEY_LEN } from "./ids.ts";
import {
  bodyToPlainText,
  type BacklinkEntry,
  type Body,
  type BlockType,
  type NodeKind,
  type PageMeta,
  type ParentKind,
} from "../shared/types.ts";

export type OpKind = "insert" | "update" | "delete" | "move" | "restore";

export interface ActorInfo {
  actor: string;
  device: string;
}

export const DEFAULT_ACTOR: ActorInfo = {
  actor: "local",
  device: "this-install",
};

/** Fields we persist on a node, and allow patches on. */
export interface NodeFields {
  body?: Body | null;
  props?: Record<string, unknown>;
  meta?: PageMeta;
  parent_id?: string | null;
  parent_kind?: ParentKind;
  pos?: string;
  deleted_at?: number | null;
  type?: BlockType;
}

interface NodeRecord {
  id: string;
  ws: string;
  kind: NodeKind;
  type: BlockType;
  parent_id: string | null;
  parent_kind: ParentKind;
  pos: string;
  props: string;
  body: string | null;
  meta: string;
  created_at: number;
  created_by: string;
  updated_at: number;
  updated_by: string;
  deleted_at: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction ids
// ─────────────────────────────────────────────────────────────────────────────

let txCounter = 0;

export function nextTx(db: Db): number {
  const max = Number(db.scalar<number>("SELECT max(tx) m FROM op_log") ?? 0);
  txCounter = Math.max(max + 1, nowMs());
  return txCounter;
}

function logOp(
  db: Db,
  tx: number,
  actor: ActorInfo,
  node_id: string,
  op: OpKind,
  patch: Record<string, unknown>,
): void {
  db.run(
    "INSERT INTO op_log (ts, actor, device, node_id, op, patch, tx) VALUES (?, ?, ?, ?, ?, ?, ?)",
    nowMs(),
    actor.actor,
    actor.device,
    node_id,
    op,
    JSON.stringify(patch),
    tx,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Positioning
//
// Resolve "insert before X" / "insert after Y" into a fractional key. The lower
// bound is the sibling immediately preceding the target — NOT the max sibling
// position, which can sort after the target and invert the bounds.
// ─────────────────────────────────────────────────────────────────────────────

export interface PositionTarget {
  parent_id: string | null;
  before?: string | null;
  after?: string | null;
  pos?: string;
  /** id of the node being moved, excluded from the sibling scan */
  excludeId?: string;
}

function posOf(db: Db, id: string): string | null {
  return db.scalar<string>("SELECT pos FROM node WHERE id = ?", id) ?? null;
}

export function resolvePosition(db: Db, target: PositionTarget): string {
  if (target.pos) return target.pos;

  const { parent_id, before, after, excludeId } = target;

  if (before) {
    const hi = posOf(db, before);
    if (hi == null) throw new Error(`resolvePosition: 'before' node ${before} not found`);

    if (after) {
      const lo = posOf(db, after);
      if (lo == null) throw new Error(`resolvePosition: 'after' node ${after} not found`);
      return lo < hi ? keyBetween(lo, hi) : keyBetween(null, hi);
    }

    // greatest sibling position that still sorts before the target
    const lo = db.scalar<string>(
      `SELECT max(pos) FROM node
       WHERE parent_id IS ? AND deleted_at IS NULL AND pos < ?
         AND (? IS NULL OR id != ?)`,
      parent_id,
      hi,
      excludeId ?? null,
      excludeId ?? null,
    );
    return keyBetween(lo ?? null, hi);
  }

  if (after) {
    const lo = posOf(db, after);
    if (lo == null) throw new Error(`resolvePosition: 'after' node ${after} not found`);
    const hi = db.scalar<string>(
      `SELECT min(pos) FROM node
       WHERE parent_id IS ? AND deleted_at IS NULL AND pos > ?
         AND (? IS NULL OR id != ?)`,
      parent_id,
      lo,
      excludeId ?? null,
      excludeId ?? null,
    );
    return keyBetween(lo, hi ?? null);
  }

  const lo = db.scalar<string>(
    `SELECT max(pos) FROM node
     WHERE parent_id IS ? AND deleted_at IS NULL
       AND (? IS NULL OR id != ?)`,
    parent_id,
    excludeId ?? null,
    excludeId ?? null,
  );
  return keyBetween(lo ?? null, null);
}

/**
 * Rewrite one parent's direct children with evenly spaced keys. Triggered when a
 * generated key grows past MAX_KEY_LEN. Scoped to a single parent, so the cost
 * is bounded by the number of blocks on a page, not the size of the workspace.
 */
export function rebalanceSiblings(
  db: Db,
  parentId: string | null,
  opts: { actor?: ActorInfo; tx?: number } = {},
): number {
  const actor = opts.actor ?? DEFAULT_ACTOR;
  const rows = db.all<{ id: string }>(
    `SELECT id FROM node
     WHERE parent_id IS ? AND deleted_at IS NULL
     ORDER BY pos, created_at`,
    parentId,
  );
  if (rows.length < 2) return 0;

  const keys = keysBetween(null, null, rows.length);
  const tx = opts.tx ?? nextTx(db);

  return db.tx(() => {
    rows.forEach((row, i) => {
      const key = keys[i]!;
      const prev = db.scalar<string>("SELECT pos FROM node WHERE id = ?", row.id);
      db.run("UPDATE node SET pos = ? WHERE id = ?", key, row.id);
      logOp(db, tx, actor, row.id, "move", {
        prev: { parent_id: parentId, pos: prev },
        after: { parent_id: parentId, pos: key },
      });
    });
    return rows.length;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived data: backlinks
// ─────────────────────────────────────────────────────────────────────────────

/** Page/database links referenced by a node's inline content. */
export function extractLinks(body: Body | null | undefined): {
  dst: string;
  context: string;
}[] {
  if (!body?.length) return [];
  const out: { dst: string; context: string }[] = [];
  const full = bodyToPlainText(body);

  for (const inline of body) {
    const targets = new Set<string>();
    for (const link of inline.links ?? []) {
      if (link.kind === "page" || link.kind === "database") targets.add(link.url);
    }
    const mention = (inline.styles as { mention?: string } | undefined)?.mention;
    if (mention) targets.add(mention);

    for (const dst of targets) {
      if (typeof dst === "string" && dst.length) out.push({ dst, context: full });
    }
  }
  return out;
}

/** Rebuild the outgoing backlink edges for one node. */
export function syncBacklinks(db: Db, nodeId: string): void {
  const row = db.get<{ body: string | null }>(
    "SELECT body FROM node WHERE id = ?",
    nodeId,
  );
  if (!row) return;

  let body: Body | null = null;
  try {
    body = row.body ? (JSON.parse(row.body) as Body) : null;
  } catch {
    body = null;
  }

  const links = extractLinks(body);
  const srcTitle = bodyToPlainText(body).slice(0, 200);

  db.tx(() => {
    // mention edges only; relation edges are owned by the properties layer
    db.run(
      "DELETE FROM backlink WHERE src = ? AND kind = 'mention'",
      nodeId,
    );
    for (const link of links) {
      if (link.dst === nodeId) continue; // no self-links
      db.run(
        `INSERT INTO backlink (src, dst, prop_id, context, kind)
         VALUES (?, ?, '', ?, 'mention')
         ON CONFLICT(src, dst, prop_id) DO UPDATE SET context = excluded.context`,
        nodeId,
        link.dst,
        srcTitle,
      );
    }
  });
}

/**
 * The page a node belongs to. Backlink edges are recorded per block (the block
 * is what physically contains the link), but "Linked mentions" is a page-level
 * view. Attributing edges to the block shows a sentence from the source block
 * instead of the source page's name, so every lookup resolves to a page first.
 */
export function pageOwnerOf(db: Db, nodeId: string): string | null {
  const chain = db.all<{ id: string; kind: string; type: string }>(
    `WITH RECURSIVE up(id, parent_id, depth) AS (
       SELECT id, parent_id, 0 FROM node WHERE id = ?
       UNION ALL
       SELECT n.id, n.parent_id, up.depth + 1
       FROM node n JOIN up ON n.id = up.parent_id
       WHERE up.depth < 40
     )
     SELECT up.id, n.kind, n.type
     FROM up JOIN node n ON n.id = up.id
     ORDER BY up.depth`,
    nodeId,
  );
  for (const row of chain) {
    if (row.kind === "page" || row.kind === "row") return row.id;
    if (row.type === "page" || row.type === "child_page") return row.id;
  }
  return null;
}

function titleAndIcon(db: Db, id: string): { title: string; icon?: string } | null {
  const row = db.get<{ body: string | null; meta: string; deleted_at: number | null }>(
    "SELECT body, meta, deleted_at FROM node WHERE id = ?",
    id,
  );
  if (!row || row.deleted_at != null) return null;
  let icon: string | undefined;
  try {
    icon = (JSON.parse(row.meta) as PageMeta)?.icon;
  } catch {
    icon = undefined;
  }
  let title = "";
  try {
    title = bodyToPlainText(row.body ? (JSON.parse(row.body) as Body) : null);
  } catch {
    title = "";
  }
  return { title: title || "Untitled", icon };
}

export function getBacklinks(db: Db, nodeId: string): BacklinkEntry[] {
  const rows = db.all<{
    src: string;
    context: string;
    prop_id: string;
    kind: "mention" | "relation";
  }>(
    `SELECT b.src, b.context, b.prop_id, b.kind
     FROM backlink b
     WHERE b.dst = ?`,
    nodeId,
  );

  // resolve to owning pages and collapse repeats: several mentions from the same
  // page are one entry, labelled with that page's title
  const byPage = new Map<string, BacklinkEntry>();
  for (const row of rows) {
    const owner = pageOwnerOf(db, row.src) ?? row.src;
    if (owner === nodeId || byPage.has(owner)) continue;
    const meta = titleAndIcon(db, owner);
    if (!meta) continue;
    byPage.set(owner, {
      src: owner,
      srcTitle: meta.title,
      srcIcon: meta.icon,
      context: row.context,
      prop_id: row.prop_id,
      kind: row.kind,
    });
  }
  return [...byPage.values()];
}

/** Pages this page links out to (its own blocks, at any depth). */
export function getOutgoingLinks(db: Db, pageId: string): { dst: string; title: string; icon?: string }[] {
  const ids = db
    .all<{ id: string }>(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM node WHERE id = ?
         UNION ALL
         SELECT n.id FROM node n JOIN tree t ON n.parent_id = t.id
       )
       SELECT id FROM tree`,
      pageId,
    )
    .map((r) => r.id);
  if (!ids.length) return [];

  const ph = ids.map(() => "?").join(",");
  const rows = db.all<{ dst: string }>(
    `SELECT DISTINCT dst FROM backlink WHERE src IN (${ph}) AND dst <> ?`,
    ...ids,
    pageId,
  );

  const out: { dst: string; title: string; icon?: string }[] = [];
  for (const row of rows) {
    const meta = titleAndIcon(db, row.dst);
    if (!meta) continue;
    out.push({ dst: row.dst, title: meta.title, icon: meta.icon });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Node writes
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateNodeInput {
  ws: string;
  kind: NodeKind;
  type: BlockType;
  parent_id: string | null;
  parent_kind: ParentKind;
  /** explicit position; otherwise appended after the last sibling */
  pos?: string;
  /** insert before/after a sibling id (mutually exclusive with pos) */
  before?: string | null;
  after?: string | null;
  props?: Record<string, unknown>;
  body?: Body | null;
  meta?: PageMeta;
  actor?: ActorInfo;
  tx?: number;
  /**
   * Reuse a specific id. Redo must re-create nodes under their original ids,
   * because later ops in the same transaction reference them.
   */
  id?: string;
}

export function createNode(db: Db, input: CreateNodeInput): string {
  const actor = input.actor ?? DEFAULT_ACTOR;
  const id = input.id ?? newId();
  const ts = nowMs();

  const pos = resolvePosition(db, {
    parent_id: input.parent_id,
    before: input.before,
    after: input.after,
    pos: input.pos,
  });

  return db.tx(() => {
    const tx = input.tx ?? nextTx(db);
    db.run(
      `INSERT INTO node
         (id, ws, kind, type, parent_id, parent_kind, pos, props, body, meta,
          created_at, created_by, updated_at, updated_by, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      id,
      input.ws,
      input.kind,
      input.type,
      input.parent_id,
      input.parent_kind,
      pos,
      JSON.stringify(input.props ?? {}),
      input.body ? JSON.stringify(input.body) : null,
      JSON.stringify(input.meta ?? {}),
      ts,
      actor.actor,
      ts,
      actor.actor,
    );

    syncBacklinks(db, id);
    logOp(db, tx, actor, id, "insert", {
      after: {
        ws: input.ws,
        kind: input.kind,
        type: input.type,
        parent_id: input.parent_id,
        parent_kind: input.parent_kind,
        pos,
        props: input.props ?? {},
        body: input.body ?? null,
        meta: input.meta ?? {},
      },
    });

    if (pos.length > MAX_KEY_LEN) {
      rebalanceSiblings(db, input.parent_id, { actor, tx });
    }
    return id;
  });
}

/**
 * Patch a node's mutable fields. `fields` is a partial patch; only the keys
 * present are written, and their prior values are captured for undo.
 */
export function updateNode(
  db: Db,
  id: string,
  fields: NodeFields,
  opts: { actor?: ActorInfo; tx?: number } = {},
): void {
  const actor = opts.actor ?? DEFAULT_ACTOR;
  const keys = Object.keys(fields) as (keyof NodeFields)[];
  if (!keys.length) return;

  const before = db.get<NodeRecord>("SELECT * FROM node WHERE id = ?", id);
  if (!before) throw new Error(`updateNode: node ${id} not found`);

  const prev: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  const sets: string[] = [];
  const params: SqlParam[] = [];

  for (const key of keys) {
    const value = fields[key];
    prev[key] = encodeField(key, before);
    next[key] = value;
    sets.push(`${key} = ?`);
    params.push(encodeFieldValue(key, value));
  }

  sets.push("updated_at = ?", "updated_by = ?");
  params.push(nowMs(), actor.actor, id);

  db.tx(() => {
    db.run(`UPDATE node SET ${sets.join(", ")} WHERE id = ?`, ...params);
    if ("body" in fields) syncBacklinks(db, id);
    logOp(db, opts.tx ?? nextTx(db), actor, id, "update", { prev, after: next });
  });
}

function encodeField(key: keyof NodeFields, row: NodeRecord): unknown {
  switch (key) {
    case "body":
      return row.body == null ? null : JSON.parse(row.body);
    case "props":
      return JSON.parse(row.props);
    case "meta":
      return JSON.parse(row.meta);
    case "parent_id":
      return row.parent_id;
    case "parent_kind":
      return row.parent_kind;
    case "pos":
      return row.pos;
    case "deleted_at":
      return row.deleted_at;
    case "type":
      return row.type;
  }
}

function encodeFieldValue(key: keyof NodeFields, value: unknown): SqlParam {
  switch (key) {
    case "body":
    case "props":
    case "meta":
      return value == null ? null : JSON.stringify(value);
    default:
      return (value as SqlParam) ?? null;
  }
}

/**
 * Move a node. Only the moved row is written — `pos` is a fractional index,
 * so siblings are never renumbered.
 */
export function moveNode(
  db: Db,
  id: string,
  target: {
    parent_id: string | null;
    parent_kind?: ParentKind;
    before?: string | null;
    after?: string | null;
    pos?: string;
  },
  opts: { actor?: ActorInfo; tx?: number } = {},
): void {
  const actor = opts.actor ?? DEFAULT_ACTOR;
  const before = db.get<NodeRecord>("SELECT * FROM node WHERE id = ?", id);
  if (!before) throw new Error(`moveNode: node ${id} not found`);

  const pos = resolvePosition(db, {
    parent_id: target.parent_id,
    before: target.before,
    after: target.after,
    pos: target.pos,
    excludeId: id,
  });

  const parentKind = target.parent_kind ?? before.parent_kind;

  db.tx(() => {
    db.run(
      "UPDATE node SET parent_id = ?, parent_kind = ?, pos = ?, updated_at = ?, updated_by = ? WHERE id = ?",
      target.parent_id,
      parentKind,
      pos,
      nowMs(),
      actor.actor,
      id,
    );
    const tx = opts.tx ?? nextTx(db);
    logOp(db, tx, actor, id, "move", {
      prev: {
        parent_id: before.parent_id,
        parent_kind: before.parent_kind,
        pos: before.pos,
      },
      after: { parent_id: target.parent_id, parent_kind: parentKind, pos },
    });

    // Same-slot insertions lengthen keys; compact this parent when that happens.
    if (pos.length > MAX_KEY_LEN) {
      rebalanceSiblings(db, target.parent_id, { actor, tx });
    }
  });
}

/** Soft delete → trash. Inverse op restores it. */
export function trashNode(
  db: Db,
  id: string,
  opts: { actor?: ActorInfo; tx?: number } = {},
): void {
  const actor = opts.actor ?? DEFAULT_ACTOR;
  const before = db.get<NodeRecord>("SELECT * FROM node WHERE id = ?", id);
  if (!before) return;
  const ts = nowMs();

  db.tx(() => {
    db.run(
      "UPDATE node SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ?",
      ts,
      ts,
      actor.actor,
      id,
    );
    logOp(db, opts.tx ?? nextTx(db), actor, id, "delete", {
      prev: { deleted_at: before.deleted_at },
      after: { deleted_at: ts },
    });
  });
}

export function restoreNode(
  db: Db,
  id: string,
  opts: { actor?: ActorInfo; tx?: number } = {},
): void {
  const actor = opts.actor ?? DEFAULT_ACTOR;
  const ts = nowMs();
  db.tx(() => {
    db.run(
      "UPDATE node SET deleted_at = NULL, updated_at = ?, updated_by = ? WHERE id = ?",
      ts,
      actor.actor,
      id,
    );
    logOp(db, opts.tx ?? nextTx(db), actor, id, "restore", {
      prev: { deleted_at: ts },
      after: { deleted_at: null },
    });
  });
}

/** Convert a block to another type, keeping its text. */
export function convertNode(
  db: Db,
  id: string,
  type: BlockType,
  extraProps: Record<string, unknown> = {},
  opts: { actor?: ActorInfo; tx?: number } = {},
): void {
  const current = db.get<{ props: string }>("SELECT props FROM node WHERE id = ?", id);
  const props = { ...(current ? JSON.parse(current.props) : {}), ...extraProps };
  updateNode(db, id, { type, props }, opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Undo / redo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-memory stacks of committed transaction ids. Single-user, single-device,
 * so an in-RAM undo stack is honest and sufficient. After a restart, version
 * history (snapshots) is the recovery path.
 */
export class UndoManager {
  private undoStack: number[] = [];
  private redoStack: number[] = [];

  record(tx: number): void {
    this.undoStack.push(tx);
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(db: Db, actor: ActorInfo = DEFAULT_ACTOR): number | null {
    const tx = this.undoStack.pop();
    if (tx == null) return null;
    invertTx(db, tx, actor);
    this.redoStack.push(tx);
    return tx;
  }

  redo(db: Db, actor: ActorInfo = DEFAULT_ACTOR): number | null {
    const tx = this.redoStack.pop();
    if (tx == null) return null;
    applyTx(db, tx, actor);
    this.undoStack.push(tx);
    return tx;
  }

  /** tx ids captured by a record() that were later undone. */
  peek(): { undo: number[]; redo: number[] } {
    return { undo: [...this.undoStack], redo: [...this.redoStack] };
  }
}

interface OpRow {
  seq: number;
  node_id: string;
  op: OpKind;
  patch: string;
}

function opsInTx(db: Db, tx: number): OpRow[] {
  return db.all<OpRow>(
    "SELECT seq, node_id, op, patch FROM op_log WHERE tx = ? ORDER BY seq",
    tx,
  );
}

/** Apply a transaction's `after` state (redo). */
function applyTx(db: Db, tx: number, actor: ActorInfo): void {
  const ops = opsInTx(db, tx);
  db.tx(() => {
    for (const op of ops) {
      const patch = JSON.parse(op.patch) as Record<string, unknown>;
      const after = (patch.after ?? {}) as NodeFields & {
        ws?: string;
        kind?: NodeKind;
      };
      switch (op.op) {
        case "insert":
          // Reuse the original id: later ops in this tx reference it, so a fresh
          // ULID would leave the redoed subtree pointing at missing nodes.
          createNode(db, {
            ws: (after.ws as string) ?? "",
            id: op.node_id,
            kind: (after.kind ?? "block") as NodeKind,
            type: (after.type ?? "paragraph") as BlockType,
            parent_id: after.parent_id ?? null,
            parent_kind: after.parent_kind ?? "node",
            pos: after.pos,
            props: after.props as Record<string, unknown> | undefined,
            body: after.body as Body | undefined,
            meta: after.meta as PageMeta | undefined,
            actor,
            tx,
          });
          break;
        case "delete":
          db.run(
            "UPDATE node SET deleted_at = ? WHERE id = ?",
            after.deleted_at ?? nowMs(),
            op.node_id,
          );
          break;
        case "restore":
          db.run("UPDATE node SET deleted_at = NULL WHERE id = ?", op.node_id);
          break;
        case "update":
        case "move": {
          // Set ONLY the keys present in the patch. Writing a default for an
          // untouched field (e.g. type) would clobber a heading into a paragraph.
          const sets: string[] = [];
          const params: SqlParam[] = [];
          for (const key of [
            "body",
            "props",
            "meta",
            "parent_id",
            "parent_kind",
            "pos",
            "type",
            "deleted_at",
          ] as (keyof NodeFields)[]) {
            if (key in after) {
              sets.push(`${key} = ?`);
              params.push(encodeFieldValue(key, after[key]));
            }
          }
          if (sets.length) {
            params.push(op.node_id);
            db.run(`UPDATE node SET ${sets.join(", ")} WHERE id = ?`, ...params);
          }
          break;
        }
      }
      syncBacklinks(db, op.node_id);
    }
  });
}

/** Apply a transaction's `prev` state (undo). */
function invertTx(db: Db, tx: number, actor: ActorInfo): void {
  const ops = opsInTx(db, tx).reverse();
  db.tx(() => {
    for (const op of ops) {
      const patch = JSON.parse(op.patch) as Record<string, unknown>;
      const prev = (patch.prev ?? {}) as NodeFields;
      switch (op.op) {
        case "insert":
          // hard-remove the node created by this tx; its subtree cascades
          db.run("DELETE FROM node WHERE id = ?", op.node_id);
          break;
        case "delete":
          db.run(
            "UPDATE node SET deleted_at = ? WHERE id = ?",
            prev.deleted_at ?? null,
            op.node_id,
          );
          break;
        case "restore":
          db.run(
            "UPDATE node SET deleted_at = ? WHERE id = ?",
            prev.deleted_at ?? nowMs(),
            op.node_id,
          );
          break;
        case "update":
        case "move": {
          const sets: string[] = [];
          const params: SqlParam[] = [];
          for (const key of [
            "body",
            "props",
            "meta",
            "parent_id",
            "parent_kind",
            "pos",
            "type",
            "deleted_at",
          ] as (keyof NodeFields)[]) {
            if (key in prev) {
              sets.push(`${key} = ?`);
              params.push(encodeFieldValue(key, prev[key]));
            }
          }
          if (sets.length) {
            params.push(op.node_id);
            db.run(`UPDATE node SET ${sets.join(", ")} WHERE id = ?`, ...params);
          }
          break;
        }
      }
      syncBacklinks(db, op.node_id);
    }
  });
}
