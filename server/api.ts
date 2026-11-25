/**
 * HTTP API.
 *
 * Threat model for a local-first app: the server binds 127.0.0.1, but ANY web
 * page in your browser can POST to localhost. So every request must carry
 *   - an `Origin` in the allow-list (a foreign page cannot forge this), and
 *   - the per-session `x-strata-token` (keeps non-browser scripts out).
 * `/api/bootstrap` is the one token-less route: it hands the token to the app,
 * and only for an allow-listed origin.
 */

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { openWorkspace, type Db, type WorkspacePaths } from "./db.ts";
import {
  DEFAULT_ACTOR,
  UndoManager,
  nextTx,
  createNode,
  updateNode,
  moveNode,
  trashNode,
  restoreNode,
  convertNode,
  getBacklinks,
  getOutgoingLinks,
  type NodeFields,
} from "./ops.ts";
import {
  mapNode,
  getNode,
  getTree,
  childrenOf,
  breadcrumbs,
  pageTree,
  search,
  recentPages,
  listTrash,
  emptyTrash,
  purgeNode,
  trashDescendants,
  restoreDescendants,
  snapshotPage,
  listSnapshots,
  restoreSnapshot,
  nodeOps,
  saveTemplate,
  listTemplates,
  deleteTemplate,
  applyTemplate,
  putMedia,
  readMedia,
  getMedia,
  workspaceInfo,
  setSetting,
  getSetting,
  allSettings,
  createPage,
  setPageMeta,
  nodeTitle,
} from "./library.ts";
import {
  createDatabase,
  getDatabase,
  listProperties,
  listViews,
  getView,
  updateViewSpec,
  addProperty,
  deleteProperty,
  renameProperty,
  changePropertyType,
  addSelectOption,
  renameSelectOption,
  removeSelectOption,
  createRelation,
  createRow,
  getRow,
  listRows,
  setPropertyValue,
  queryRows,
  aggregate,
  groupRows,
  databaseHostNode,
  databaseForNode,
  type SeedProperty,
} from "./databases.ts";
import {
  defaultViewSpec,
  type AggregateFunction,
  type BlockType,
  type NodeKind,
  type PageMeta,
  type ParentKind,
  type PropertyType,
  type PropertyValueInput,
  type SelectOption,
  type ViewSpec,
  type ViewType,
  type Body,
} from "../shared/types.ts";
import { importText } from "./port/index.ts";
import { importNotionZipLayout } from "./port/markdown.ts";
import {
  materializeImport,
  exportPageMarkdown,
  exportPageHtml,
  exportViewCsv,
  exportWorkspace,
} from "./import-export.ts";
import { parsePrintOptions, printDocumentHtml } from "./pdf.ts";
import { seedFirstPartyTemplates } from "../scripts/seed-templates.ts";
import { validateFormulaSource } from "./databases.ts";
import { FORMULA_FUNCTIONS } from "./formula.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface ApiOptions {
  workspaceRoot: string;
  port: number;
  /** extra origins allowed to call the API (the vite dev server) */
  devOrigins?: string[];
  /** serve dist/ as the app shell */
  serveStatic?: boolean;
  ai?: AiBridge;
}

/** The AI layer is wired in by index.ts once the provider module is loaded. */
export interface AiBridge {
  providers(): unknown[];
  addProvider(config: unknown): unknown;
  patchProvider(id: string, patch: Record<string, unknown>): unknown;
  removeProvider(id: string): void;
  setDefault(id: string): void;
  defaultId(): string | null;
  models(id: string): Promise<unknown>;
  /** one provider when `id` is given, every enabled provider otherwise */
  test(id?: string): Promise<unknown>;
  detect(onlyRunning?: boolean): Promise<unknown>;
  runAction(body: unknown): Promise<unknown>;
  streamAction(body: unknown, signal: AbortSignal): AsyncGenerator<unknown>;
  rebuildIndex(): Promise<{ chunks: number; ms: number }>;
  health(): Promise<unknown>;
  usage(opts?: { days?: number; recent?: number }): unknown;
}

export interface App {
  fastify: ReturnType<typeof Fastify>;
  db: Db;
  paths: WorkspacePaths;
  ws: string;
  token: string;
  undo: UndoManager;
  url: string;
}

export async function createApp(opts: ApiOptions): Promise<App> {
  const { db, paths } = openWorkspace(opts.workspaceRoot);
  const token = randomUUID();
  const undo = new UndoManager();

  // one workspace per folder: adopt the single workspace row, creating it if new
  let ws = db.scalar<string>("SELECT id FROM workspace LIMIT 1");
  if (!ws) {
    ws = "ws-" + randomUUID().slice(0, 8);
    db.run(
      "INSERT INTO workspace (id, name, created_at) VALUES (?, ?, ?)",
      ws,
      "My Workspace",
      Date.now(),
    );
  }
  const wsId = ws;

  const allowedOrigins = new Set<string>([
    `http://127.0.0.1:${opts.port}`,
    `http://localhost:${opts.port}`,
    ...(opts.devOrigins ?? []),
  ]);

  const fastify = Fastify({
    logger: false,
    bodyLimit: 64 * 1024 * 1024, // media uploads
  });

  // Fastify has no parser for binary types, so an image/audio upload returns
  // 415 by default. Register a pass-through that hands us the raw Buffer.
  fastify.addContentTypeParser(
    [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/svg+xml",
      "audio/mpeg",
      "audio/ogg",
      "audio/wav",
      "video/mp4",
      "application/pdf",
      "application/octet-stream",
    ],
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  // ── auth ───────────────────────────────────────────────────────────────────
  fastify.addHook("onRequest", async (req, reply) => {
    if (req.method === "OPTIONS") {
      reply.code(403).send({ error: "no CORS" });
      return;
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      reply.code(403).send({ error: "origin not allowed" });
      return;
    }
    if (req.url.startsWith("/api/") && req.url !== "/api/bootstrap") {
      if (req.headers["x-strata-token"] !== token) {
        reply.code(401).send({ error: "unauthorized" });
        return;
      }
    }
  });

  const actor = (req: { headers: Record<string, unknown> }) => ({
    actor: typeof req.headers["x-strata-actor"] === "string" ? (req.headers["x-strata-actor"] as string) : "local",
    device: typeof req.headers["x-strata-device"] === "string" ? (req.headers["x-strata-device"] as string) : "this-install",
  });

  // ── bootstrap ──────────────────────────────────────────────────────────────
  fastify.get("/api/bootstrap", async () => ({
    token,
    ws: wsId,
    info: workspaceInfo(db, wsId),
    version: "0.1.0",
  }));

  fastify.get("/api/health", async () => ({
    ok: true,
    sqlite: db.scalar<string>("SELECT sqlite_version()"),
    nodes: db.scalar<number>("SELECT count(*) FROM node"),
    ops: db.scalar<number>("SELECT count(*) FROM op_log"),
  }));

  // ── workspace & settings ───────────────────────────────────────────────────
  fastify.get("/api/workspace", async () => workspaceInfo(db, wsId));

  fastify.patch("/api/workspace", async (req) => {
    const body = req.body as { name?: string };
    if (body.name) {
      db.run("UPDATE workspace SET name = ? WHERE id = ?", body.name, wsId);
    }
    return workspaceInfo(db, wsId);
  });

  fastify.get("/api/settings", async () => allSettings(db, wsId));

  fastify.patch("/api/settings", async (req) => {
    const body = req.body as Record<string, unknown>;
    for (const [key, value] of Object.entries(body)) setSetting(db, wsId, key, value);
    return allSettings(db, wsId);
  });

  fastify.get("/api/recent", async (req) => {
    const q = req.query as { limit?: string };
    return recentPages(db, wsId, Number(q.limit ?? 12));
  });

  // ── tree & nodes ───────────────────────────────────────────────────────────
  fastify.get("/api/tree", async () => pageTree(db, wsId));

  fastify.get<{ Params: { id: string } }>("/api/nodes/:id", async (req, reply) => {
    const node = getNode(db, req.params.id);
    if (!node) return reply.code(404).send({ error: "not found" });
    return { node, children: childrenOf(db, node.id), breadcrumbs: breadcrumbs(db, node.id) };
  });

  fastify.get<{ Params: { id: string } }>("/api/nodes/:id/tree", async (req) =>
    getTree(db, req.params.id, Number((req.query as { depth?: string }).depth ?? 20)),
  );

  fastify.get<{ Params: { id: string } }>("/api/nodes/:id/breadcrumbs", async (req) =>
    breadcrumbs(db, req.params.id),
  );

  fastify.get<{ Params: { id: string } }>("/api/nodes/:id/backlinks", async (req) => ({
    backlinks: getBacklinks(db, req.params.id),
    outgoing: getOutgoingLinks(db, req.params.id),
  }));

  fastify.post<{ Body: { parentId?: string | null; title?: string; icon?: string } }>(
    "/api/pages",
    async (req) => {
      const id = createPage(db, wsId, req.body.parentId ?? null, req.body.title ?? "", req.body.icon, {
        actor: actor(req),
      });
      return { id, node: getNode(db, id) };
    },
  );

  fastify.post<{
    Body: {
      parentId: string | null;
      parentKind?: ParentKind;
      kind?: NodeKind;
      type: BlockType;
      before?: string | null;
      after?: string | null;
      pos?: string;
      body?: Body | null;
      props?: Record<string, unknown>;
      meta?: PageMeta;
    };
  }>(
    "/api/nodes",
    async (req) => {
      const b = req.body;
      const id = createNode(db, {
        ws: wsId,
        kind: b.kind ?? "block",
        type: b.type,
        parent_id: b.parentId,
        parent_kind: b.parentKind ?? (b.parentId ? "node" : "workspace"),
        before: b.before,
        after: b.after,
        pos: b.pos,
        body: b.body,
        props: b.props,
        meta: b.meta,
        actor: actor(req),
      });
      return { id, node: getNode(db, id) };
    },
  );

  fastify.patch<{ Params: { id: string }; Body: NodeFields }>(
    "/api/nodes/:id",
    async (req, reply) => {
      if (!getNode(db, req.params.id)) return reply.code(404).send({ error: "not found" });
      updateNode(db, req.params.id, req.body, { actor: actor(req) });
      return { node: getNode(db, req.params.id) };
    },
  );

  fastify.post<{ Params: { id: string }; Body: { type: BlockType; props?: Record<string, unknown> } }>(
    "/api/nodes/:id/convert",
    async (req) => {
      convertNode(db, req.params.id, req.body.type, req.body.props ?? {}, { actor: actor(req) });
      return { node: getNode(db, req.params.id) };
    },
  );

  fastify.post<{
    Params: { id: string };
    Body: { parentId: string | null; parentKind?: ParentKind; before?: string | null; after?: string | null };
  }>("/api/nodes/:id/move", async (req) => {
    moveNode(db, req.params.id, {
      parent_id: req.body.parentId,
      parent_kind: req.body.parentKind,
      before: req.body.before,
      after: req.body.after,
    }, { actor: actor(req) });
    return { node: getNode(db, req.params.id) };
  });

  fastify.delete<{ Params: { id: string } }>("/api/nodes/:id", async (req) => {
    trashNode(db, req.params.id, { actor: actor(req) });
    trashDescendants(db, req.params.id);
    return { ok: true };
  });

  fastify.post<{ Params: { id: string } }>("/api/nodes/:id/restore", async (req) => {
    restoreNode(db, req.params.id, { actor: actor(req) });
    restoreDescendants(db, req.params.id);
    return { ok: true };
  });

  fastify.delete<{ Params: { id: string } }>("/api/nodes/:id/purge", async (req) => {
    purgeNode(db, req.params.id);
    return { ok: true };
  });

  fastify.patch<{ Params: { id: string }; Body: Partial<PageMeta> }>(
    "/api/nodes/:id/meta",
    async (req) => {
      setPageMeta(db, req.params.id, req.body, { actor: actor(req) });
      return { node: getNode(db, req.params.id) };
    },
  );

  // ── batched editor writes: one tx, so undo is one user edit ────────────────
  fastify.post<{
    Body: {
      ops: Array<
        | { op: "insert"; id: string; parentId: string | null; parentKind?: ParentKind; kind?: NodeKind; type: BlockType; pos?: string; before?: string | null; after?: string | null; body?: Body | null; props?: Record<string, unknown>; meta?: PageMeta }
        | { op: "update"; id: string; patch: NodeFields }
        | { op: "move"; id: string; parentId: string | null; parentKind?: ParentKind; before?: string | null; after?: string | null; pos?: string }
        | { op: "delete"; id: string }
      >;
    };
  }>("/api/tx", async (req, reply) => {
    const ops = req.body?.ops;
    if (!Array.isArray(ops)) return reply.code(400).send({ error: "ops[] required" });

    const a = actor(req);
    const tx = nextTx(db);
    const touched: string[] = [];

    try {
      db.tx(() => {
        for (const op of ops) {
          switch (op.op) {
            case "insert":
              createNode(db, {
                ws: wsId,
                id: op.id,
                kind: op.kind ?? "block",
                type: op.type,
                parent_id: op.parentId,
                parent_kind: op.parentKind ?? (op.parentId ? "node" : "workspace"),
                pos: op.pos,
                before: op.before,
                after: op.after,
                body: op.body,
                props: op.props,
                meta: op.meta,
                actor: a,
                tx,
              });
              touched.push(op.id);
              break;
            case "update":
              updateNode(db, op.id, op.patch, { actor: a, tx });
              touched.push(op.id);
              break;
            case "move":
              moveNode(db, op.id, {
                parent_id: op.parentId,
                parent_kind: op.parentKind,
                before: op.before,
                after: op.after,
                pos: op.pos,
              }, { actor: a, tx });
              touched.push(op.id);
              break;
            case "delete":
              trashNode(db, op.id, { actor: a, tx });
              touched.push(op.id);
              break;
          }
        }
      });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    undo.record(tx);
    return { tx, touched };
  });

  fastify.get("/api/undo/state", async () => ({
    canUndo: undo.canUndo,
    canRedo: undo.canRedo,
  }));

  fastify.post("/api/undo", async () => {
    const tx = undo.undo(db, DEFAULT_ACTOR);
    return { tx, canUndo: undo.canUndo, canRedo: undo.canRedo };
  });

  fastify.post("/api/redo", async () => {
    const tx = undo.redo(db, DEFAULT_ACTOR);
    return { tx, canUndo: undo.canUndo, canRedo: undo.canRedo };
  });

  // ── search ─────────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { q: string; limit?: string } }>("/api/search", async (req) =>
    search(db, wsId, req.query.q ?? "", { limit: Number(req.query.limit ?? 50) }),
  );

  // ── trash ──────────────────────────────────────────────────────────────────
  fastify.get("/api/trash", async () => listTrash(db, wsId));
  fastify.post("/api/trash/empty", async () => ({ removed: emptyTrash(db, wsId) }));

  // ── version history ────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>("/api/history/:id", async (req) => ({
    snapshots: listSnapshots(db, req.params.id),
    ops: nodeOps(db, req.params.id),
  }));

  fastify.post<{ Params: { id: string }; Body: { label?: string } }>(
    "/api/history/:id/snapshot",
    async (req) => snapshotPage(db, req.params.id, req.body?.label ?? "manual"),
  );

  fastify.post<{ Params: { snapshotId: string } }>("/api/history/restore/:snapshotId", async (req) => ({
    ok: restoreSnapshot(db, req.params.snapshotId, { actor: actor(req) }),
  }));

  // ── templates ──────────────────────────────────────────────────────────────
  // Install the first-party template library. Idempotent: it deletes its own
  // names before inserting, so pressing this twice does not duplicate anything.
  fastify.post("/api/templates/seed-first-party", async () => {
    const report = seedFirstPartyTemplates(db, wsId, { verbose: false });
    return {
      seeded: report.seeded.length,
      removed: report.removed,
      templates: report.seeded.map((t) => t.name),
    };
  });

  fastify.get("/api/templates", async () => listTemplates(db, wsId));

  fastify.post<{ Body: { name: string; nodeId: string; scope?: "page" | "database" } }>(
    "/api/templates",
    async (req) => saveTemplate(db, wsId, req.body.name, req.body.nodeId, req.body.scope ?? "page"),
  );

  fastify.delete<{ Params: { id: string } }>("/api/templates/:id", async (req) => {
    deleteTemplate(db, req.params.id);
    return { ok: true };
  });

  fastify.post<{ Params: { id: string }; Body: { parentId?: string | null; title?: string } }>(
    "/api/templates/:id/apply",
    async (req, reply) => {
      const id = applyTemplate(db, req.params.id, wsId, req.body?.parentId ?? null, req.body?.title, {
        actor: actor(req),
      });
      // A missing template must not answer 200 with a null id: the caller would
      // silently do nothing. Say so.
      if (!id) return reply.code(404).send({ error: "template not found" });
      return { id, node: getNode(db, id) };
    },
  );

  // ── media ──────────────────────────────────────────────────────────────────
  fastify.post<{ Querystring: { name?: string; mime?: string } }>(
    "/api/media",
    { bodyLimit: 256 * 1024 * 1024 },
    async (req, reply) => {
      const raw = req.body as unknown;
      let buf: Buffer;
      if (Buffer.isBuffer(raw)) buf = raw;
      else if (raw instanceof Uint8Array) buf = Buffer.from(raw);
      else if (typeof raw === "string") buf = Buffer.from(raw, "utf8");
      else if (raw && typeof raw === "object" && "data" in raw) {
        const obj = raw as { data: string; mime?: string; name?: string };
        buf = Buffer.from(obj.data, "base64");
        return putMedia(db, paths, wsId, buf, obj.mime ?? req.query.mime ?? "application/octet-stream", obj.name ?? req.query.name ?? null);
      } else {
        return reply.code(400).send({ error: "expected a binary body" });
      }
      return putMedia(db, paths, wsId, buf, req.query.mime ?? "application/octet-stream", req.query.name ?? null);
    },
  );

  fastify.get<{ Params: { id: string } }>("/media/:id", async (req, reply) => {
    const meta = getMedia(db, req.params.id);
    const buf = readMedia(db, req.params.id);
    if (!meta || !buf) return reply.code(404).send({ error: "not found" });
    reply.header("content-type", meta.mime);
    reply.header("cache-control", "immutable, max-age=31536000");
    reply.header("content-disposition", `inline; filename="${encodeURIComponent(meta.name ?? "file")}"`);
    return reply.send(buf);
  });

  // ── batch titles ───────────────────────────────────────────────────────────
  // Relation cells need the titles of rows they point at. Fetching them one by
  // one turns a table into N requests, so this resolves many ids at once.
  fastify.get<{ Querystring: { ids?: string } }>("/api/titles", async (req, reply) => {
    const ids = (req.query.ids ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 500);
    if (!ids.length) return reply.code(400).send({ error: "ids required" });

    const ph = ids.map(() => "?").join(",");
    const rows = db.all<{ id: string; body: string | null; meta: string }>(
      `SELECT id, body, meta FROM node WHERE id IN (${ph})`,
      ...ids,
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.body ? nodeTitle(mapNode(r)) : "Untitled",
      icon: (() => {
        try {
          return (JSON.parse(r.meta) as PageMeta)?.icon;
        } catch {
          return undefined;
        }
      })(),
    }));
  });

  // ── databases ──────────────────────────────────────────────────────────────
  fastify.post<{
    Body: {
      parentId: string | null;
      title: string;
      icon?: string;
      properties?: SeedProperty[];
      views?: { name: string; type: ViewType }[];
    };
  }>("/api/databases", async (req) => createDatabase(db, {
    ws: wsId,
    parent_id: req.body.parentId,
    parent_kind: req.body.parentId ? "node" : "workspace",
    title: req.body.title,
    icon: req.body.icon,
    properties: req.body.properties,
    views: req.body.views,
    actor: actor(req),
  }));

  fastify.get<{ Params: { id: string } }>("/api/databases/:id", async (req, reply) => {
    const d = getDatabase(db, req.params.id);
    if (!d) return reply.code(404).send({ error: "not found" });
    return d;
  });

  fastify.patch<{ Params: { id: string }; Body: { title?: string; icon?: string } }>(
    "/api/databases/:id",
    async (req) => {
      const b = req.body;
      db.run(
        `UPDATE database_obj SET title = COALESCE(?, title), icon = COALESCE(?, icon), updated_at = ? WHERE id = ?`,
        b.title ?? null,
        b.icon ?? null,
        Date.now(),
        req.params.id,
      );
      const host = databaseHostNode(db, req.params.id);
      if (host && b.title) updateNode(db, host, { body: [{ type: "text", text: b.title, styles: {} }] }, { actor: actor(req) });
      return getDatabase(db, req.params.id);
    },
  );

  fastify.post<{ Params: { id: string }; Body: { name: string; type: PropertyType; config?: Record<string, unknown> } }>(
    "/api/databases/:id/properties",
    async (req, reply) => {
      try {
        const last = db.scalar<string>(
          "SELECT max(pos) FROM property_def WHERE db_id = ?",
          req.params.id,
        );
        return addProperty(db, req.params.id, req.body.name, req.body.type, req.body.config ?? {}, {
          actor: actor(req),
          afterPos: last,
        });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  fastify.get<{ Params: { id: string } }>("/api/databases/:id/properties", async (req) =>
    listProperties(db, req.params.id),
  );

  fastify.patch<{
    Params: { id: string };
    Body: { name?: string; type?: PropertyType; config?: Record<string, unknown> };
  }>("/api/properties/:id", async (req, reply) => {
    const prop = db.get<{ id: string; db_id: string; name: string }>(
      "SELECT id, db_id, name FROM property_def WHERE id = ?",
      req.params.id,
    );
    if (!prop) return reply.code(404).send({ error: "not found" });
    if (req.body.name) renameProperty(db, prop.id, req.body.name);
    if (req.body.type) changePropertyType(db, prop.id, req.body.type, req.body.config);
    else if (req.body.config) {
      db.run(
        "UPDATE property_def SET config = ? WHERE id = ?",
        JSON.stringify(req.body.config),
        prop.id,
      );
    }
    return listProperties(db, prop.db_id);
  });

  fastify.delete<{ Params: { id: string } }>("/api/properties/:id", async (req, reply) => {
    try {
      deleteProperty(db, req.params.id);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  fastify.post<{ Params: { id: string }; Body: { name: string; color?: string } }>(
    "/api/properties/:id/options",
    async (req) => addSelectOption(db, req.params.id, req.body.name, req.body.color),
  );

  fastify.patch<{ Params: { id: string; optionId: string } }>(
    "/api/properties/:id/options/:optionId",
    async (req) => {
      renameSelectOption(
        db,
        req.params.id,
        req.params.optionId,
        req.body as Partial<SelectOption>,
      );
      return { ok: true };
    },
  );

  fastify.delete<{ Params: { id: string; optionId: string } }>(
    "/api/properties/:id/options/:optionId",
    async (req) => {
      removeSelectOption(db, req.params.id, req.params.optionId);
      return { ok: true };
    },
  );

  fastify.post<{
    Body: { sourceDb: string; targetDb: string; name: string; mirrorName: string; bidirectional?: boolean };
  }>("/api/relations", async (req) =>
    createRelation(db, req.body.sourceDb, req.body.targetDb, req.body.name, req.body.mirrorName, {
      bidirectional: req.body.bidirectional,
    }),
  );

  fastify.post<{
    Params: { id: string };
    Body: { values?: Record<string, PropertyValueInput>; after?: string | null };
  }>("/api/databases/:id/rows", async (req) => {
    const id = createRow(db, req.params.id, req.body.values ?? {}, {
      actor: actor(req),
      after: req.body.after,
    });
    return { id, row: getRow(db, id) };
  });

  fastify.get<{ Params: { id: string } }>("/api/rows/:id", async (req, reply) => {
    const row = getRow(db, req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    const dbId = row.node.parent_id ? databaseForNode(db, row.node.parent_id) : null;
    return { ...row, databaseId: dbId, properties: dbId ? listProperties(db, dbId) : [] };
  });

  fastify.patch<{ Params: { id: string }; Body: { values: Record<string, PropertyValueInput> } }>(
    "/api/rows/:id",
    async (req) => {
      const a = actor(req);
      const tx = nextTx(db);
      db.tx(() => {
        for (const [propId, value] of Object.entries(req.body.values ?? {})) {
          setPropertyValue(db, req.params.id, propId, value, { actor: a, tx });
        }
      });
      undo.record(tx);
      return { row: getRow(db, req.params.id) };
    },
  );

  fastify.post<{ Params: { id: string }; Body: { before?: string | null; after?: string | null; parentId?: string | null } }>(
    "/api/rows/:id/move",
    async (req) => {
      const row = getRow(db, req.params.id);
      const parentId = req.body.parentId ?? row?.node.parent_id ?? null;
      moveNode(db, req.params.id, {
        parent_id: parentId,
        parent_kind: "database",
        before: req.body.before,
        after: req.body.after,
      }, { actor: actor(req) });
      return { row: getRow(db, req.params.id) };
    },
  );

  fastify.delete<{ Params: { id: string } }>("/api/rows/:id", async (req) => {
    trashNode(db, req.params.id, { actor: actor(req) });
    return { ok: true };
  });

  fastify.get<{ Params: { id: string } }>("/api/databases/:id/views", async (req) =>
    listViews(db, req.params.id),
  );

  fastify.post<{ Params: { id: string }; Body: { name: string; type: ViewType; spec?: Partial<ViewSpec> } }>(
    "/api/databases/:id/views",
    async (req) => {
      const views = listViews(db, req.params.id);
      const { createView } = await import("./databases.ts");
      return createView(db, req.params.id, req.body.name, req.body.type, views.length, {
        actor: actor(req),
        spec: req.body.spec,
      });
    },
  );

  fastify.patch<{ Params: { id: string }; Body: { spec?: ViewSpec; name?: string } }>(
    "/api/views/:id",
    async (req, reply) => {
      const view = getView(db, req.params.id);
      if (!view) return reply.code(404).send({ error: "not found" });
      updateViewSpec(db, view.id, req.body.spec ?? view.spec, req.body.name);
      return getView(db, view.id);
    },
  );

  fastify.delete<{ Params: { id: string } }>("/api/views/:id", async (req) => {
    db.run("DELETE FROM view WHERE id = ?", req.params.id);
    return { ok: true };
  });

  fastify.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>(
    "/api/views/:id/query",
    async (req, reply) => {
      const view = getView(db, req.params.id);
      if (!view) return reply.code(404).send({ error: "not found" });
      const result = queryRows(db, view.db_id, view.spec, {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      return {
        rows: result.rows,
        total: result.total,
        properties: listProperties(db, view.db_id),
        spec: view.spec,
        view: view.type,
      };
    },
  );

  fastify.post<{ Params: { id: string }; Body: { spec: ViewSpec; limit?: number; offset?: number } }>(
    "/api/views/:id/query",
    async (req, reply) => {
      const view = getView(db, req.params.id);
      if (!view) return reply.code(404).send({ error: "not found" });
      const spec = req.body.spec ?? view.spec;
      return queryRows(db, view.db_id, spec, { limit: req.body.limit, offset: req.body.offset });
    },
  );

  fastify.post<{ Params: { id: string }; Body: { spec: ViewSpec; group: string; subGroup?: string } }>(
    "/api/views/:id/grouped",
    async (req, reply) => {
      const view = getView(db, req.params.id);
      if (!view) return reply.code(404).send({ error: "not found" });
      const spec = req.body.spec ?? view.spec;
      const result = queryRows(db, view.db_id, spec);
      return {
        buckets: groupRows(db, view.db_id, result.rows, req.body.group, req.body.subGroup),
        total: result.total,
      };
    },
  );

  fastify.get<{ Params: { id: string }; Querystring: { prop: string; fn: AggregateFunction; viewId?: string } }>(
    "/api/databases/:id/aggregate",
    async (req) => {
      const spec = req.query.viewId ? getView(db, req.query.viewId)?.spec : undefined;
      return { value: aggregate(db, req.params.id, req.query.prop, req.query.fn, spec) };
    },
  );

  fastify.get<{ Params: { id: string } }>("/api/nodes/:id/database", async (req) => {
    const dbId = databaseForNode(db, req.params.id);
    return dbId ? getDatabase(db, dbId) : null;
  });

  // ── AI ─────────────────────────────────────────────────────────────────────
  if (opts.ai) {
    const bridge = opts.ai;
    fastify.get("/api/ai/providers", async () => ({
      providers: bridge.providers(),
      defaultProvider: bridge.defaultId(),
    }));
    fastify.post("/api/ai/providers", async (req) => bridge.addProvider(req.body));

    // Partial update: the settings pane patches one field (model, enabled,
    // base URL) without the client resending a whole config it may have read
    // before someone else changed it.
    fastify.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
      "/api/ai/providers/:id",
      async (req) => bridge.patchProvider(req.params.id, req.body ?? {}),
    );

    fastify.delete<{ Params: { id: string } }>("/api/ai/providers/:id", async (req) => {
      bridge.removeProvider(req.params.id);
      return { ok: true };
    });

    fastify.post<{ Params: { id: string } }>("/api/ai/providers/:id/default", async (req, reply) => {
      try {
        bridge.setDefault(req.params.id);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      return { ok: true, defaultProvider: bridge.defaultId() };
    });

    // The model list, straight from the provider — this is what the picker
    // reads, so the user chooses a model that exists instead of typing a name.
    fastify.get<{ Params: { id: string } }>("/api/ai/providers/:id/models", async (req, reply) => {
      try {
        return { models: await bridge.models(req.params.id) };
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    });

    // Per-provider diagnostics with latency. The global probe stays for the
    // "Test all" button; a single provider is what the row's Test button calls.
    fastify.post<{ Params: { id?: string } }>("/api/ai/providers/:id/test", async (req, reply) => {
      try {
        return await bridge.test(req.params.id);
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    });
    fastify.post("/api/ai/test", async () => bridge.test());

    // Loopback port probe: "Ollama is running on :11434 with 6 models — add it".
    fastify.get<{ Querystring: { all?: string } }>("/api/ai/detect", async (req) => ({
      providers: await bridge.detect(req.query?.all !== "1"),
    }));

    fastify.get<{ Querystring: { days?: string; recent?: string } }>("/api/ai/usage", async (req) =>
      bridge.usage({
        days: req.query?.days ? Number(req.query.days) : undefined,
        recent: req.query?.recent ? Number(req.query.recent) : undefined,
      }),
    );

    fastify.post("/api/ai/action", async (req) => bridge.runAction(req.body));

    // Server-sent events, so the editor can show tokens as they arrive and a
    // Stop button that actually cancels the upstream request.
    fastify.post("/api/ai/action/stream", async (req, reply) => {
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      // The browser closing the request is the Stop button: aborting this
      // signal propagates into the provider fetch and the model stops generating.
      const abort = new AbortController();
      raw.on("close", () => abort.abort());
      try {
        for await (const event of bridge.streamAction(req.body, abort.signal)) {
          raw.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      } catch (err) {
        raw.write(
          `data: ${JSON.stringify({ type: "error", result: { ok: false, error: (err as Error).message, ms: 0, provider: "", model: "" } })}\n\n`,
        );
      } finally {
        raw.end();
      }
    });

    fastify.post("/api/ai/index/rebuild", async () => bridge.rebuildIndex());
    fastify.get("/api/ai/health", async () => bridge.health());
  }

  // ── import / export ────────────────────────────────────────────────────────
  fastify.post<{ Body: { content: string; parentId?: string | null; title?: string } }>(
    "/api/import/markdown",
    async (req, reply) => {
      const content = req.body?.content;
      if (typeof content !== "string") return reply.code(400).send({ error: "content required" });
      const parsed = importText(content);
      return materializeImport(db, wsId, req.body.parentId ?? null, parsed, {
        actor: actor(req),
        title: req.body.title,
      });
    },
  );

  fastify.post<{ Body: { files: { path: string; content: string }[]; parentId?: string | null } }>(
    "/api/import/notion",
    async (req, reply) => {
      const files = req.body?.files;
      if (!Array.isArray(files) || !files.length) return reply.code(400).send({ error: "files[] required" });
      const parsed = importNotionZipLayout(files);
      return materializeImport(db, wsId, req.body.parentId ?? null, parsed, { actor: actor(req) });
    },
  );

  fastify.get<{ Querystring: { nodeId?: string } }>(
    "/api/export/markdown",
    async (req, reply) => {
      if (!req.query.nodeId) return reply.code(400).send({ error: "nodeId required" });
      reply.header("content-type", "text/markdown; charset=utf-8");
      reply.header(
        "content-disposition",
        `attachment; filename="page-${req.query.nodeId.slice(0, 8)}.md"`,
      );
      return exportPageMarkdown(db, req.query.nodeId);
    },
  );

  fastify.get<{ Querystring: { nodeId?: string } }>(
    "/api/export/html",
    async (req, reply) => {
      if (!req.query.nodeId) return reply.code(400).send({ error: "nodeId required" });
      reply.header("content-type", "text/html; charset=utf-8");
      reply.header(
        "content-disposition",
        `attachment; filename="page-${req.query.nodeId.slice(0, 8)}.html"`,
      );
      return exportPageHtml(db, req.query.nodeId);
    },
  );

  fastify.get<{ Querystring: { viewId?: string } }>(
    "/api/export/csv",
    async (req, reply) => {
      if (!req.query.viewId) return reply.code(400).send({ error: "viewId required" });
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="view.csv"`);
      return exportViewCsv(db, req.query.viewId);
    },
  );

  // PDF export: the server returns a print-ready document and the browser's own
  // "Save as PDF" produces the file. A blob URL is used client-side, so this
  // route stays behind the session token (a plain <a> navigation could not be).
  fastify.get<{ Querystring: { nodeId?: string } & Record<string, string | undefined> }>(
    "/api/export/pdf",
    async (req, reply) => {
      if (!req.query.nodeId) return reply.code(400).send({ error: "nodeId required" });
      const doc = printDocumentHtml(db, req.query.nodeId, parsePrintOptions(req.query));
      if (!doc) return reply.code(404).send({ error: "node not found" });
      const safe = doc.title.replace(/[^\w-]+/g, "-").slice(0, 40) || "page";
      reply.header("content-type", "text/html; charset=utf-8");
      reply.header("cache-control", "no-store");
      reply.header("content-disposition", `inline; filename="${safe}.html"`);
      return doc.html;
    },
  );

  fastify.get("/api/export/workspace", async () => ({
    files: exportWorkspace(db, wsId),
  }));

  // ── formula ────────────────────────────────────────────────────────────────
  fastify.post<{ Body: { source: string } }>("/api/formula/validate", async (req) =>
    validateFormulaSource(req.body?.source ?? ""),
  );

  fastify.get("/api/formula/functions", async () => ({ functions: FORMULA_FUNCTIONS }));

  // ── static app shell ───────────────────────────────────────────────────────
  const dist = join(HERE, "..", "dist");
  if (opts.serveStatic !== false && existsSync(join(dist, "index.html"))) {
    await fastify.register(fastifyStatic, {
      root: dist,
      index: ["index.html"],
      wildcard: true,
      // index.html is served by the routes below with `cache-control: no-store`:
      // it carries the session token, so a cached copy pins the browser to an
      // old bundle and a token from a previous server run.
    });
    // inject the token so the built app is authenticated without a prompt
    fastify.get("/", async (req, reply) => {
      const html = readFileSync(join(dist, "index.html"), "utf8");
      reply.header("content-type", "text/html; charset=utf-8");
      reply.header("cache-control", "no-store");
      return html.replace(
        "</head>",
        `<script>window.__STRATA_TOKEN__=${JSON.stringify(token)};window.__STRATA_WS__=${JSON.stringify(wsId)};</script></head>`,
      );
    });
    fastify.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      if (existsSync(join(dist, "index.html"))) {
        const html = readFileSync(join(dist, "index.html"), "utf8");
        reply.header("content-type", "text/html; charset=utf-8");
        reply.header("cache-control", "no-store");
        reply.code(200);
        return html.replace(
          "</head>",
          `<script>window.__STRATA_TOKEN__=${JSON.stringify(token)};window.__STRATA_WS__=${JSON.stringify(wsId)};</script></head>`,
        );
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

  const url = `http://127.0.0.1:${opts.port}`;
  return { fastify, db, paths, ws: wsId, token, undo, url };
}

export { defaultViewSpec, nodeTitle };
