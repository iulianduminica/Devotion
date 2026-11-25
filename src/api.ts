/**
 * API client. Same-origin, token from the server-injected bootstrap.
 *
 * In dev, vite proxies /api to the Fastify server, so the app is same-origin in
 * both modes and needs no CORS.
 */

import type {
  AiResult,
  AiStreamEvent,
  AiUsageSummary,
  BacklinkEntry,
  DetectedProvider,
  ModelInfo,
  NodeRow,
  NodeTree,
  PageMeta,
  PropertyDef,
  PropertyValueInput,
  ProviderConfig,
  ProviderProbe,
  RowView,
  SearchHit,
  SnapshotEntry,
  TrashEntry,
  ViewSpec,
  ViewType,
  WorkspaceInfo,
} from "../shared/types.ts";
import type { GroupBucket } from "../server/databases.ts";

const TOKEN_KEY = "strata-token";

let token: string | null =
  (globalThis as { __STRATA_TOKEN__?: string }).__STRATA_TOKEN__ ?? null;
let ws: string | null = (globalThis as { __STRATA_WS__?: string }).__STRATA_WS__ ?? null;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Fetch a session token. The server issues a new one on every start. */
async function fetchToken(): Promise<string> {
  const res = await fetch("/api/bootstrap");
  const data = (await res.json()) as { token: string; ws: string };
  token = data.token;
  ws = data.ws;
  localStorage.setItem(TOKEN_KEY, token);
  (globalThis as { __STRATA_TOKEN__?: string }).__STRATA_TOKEN__ = token;
  return token;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const send = (): Promise<Response> => {
    const headers = new Headers(init.headers);
    // Fastify rejects a JSON request whose body is empty (FST_ERR_CTP_EMPTY_JSON_BODY),
    // so only claim the JSON content type when a body is actually being sent.
    const hasBody = init.body !== undefined && init.body !== null;
    if (hasBody) headers.set("content-type", "application/json");
    if (token) headers.set("x-strata-token", token);
    headers.set("x-strata-device", deviceId());
    return fetch(path, { ...init, headers });
  };

  let res = await send();

  // A token cached from a previous server run is rejected once the server
  // restarts. Re-bootstrap and retry, so a restart never wedges the app.
  if (res.status === 401 && path !== "/api/bootstrap") {
    await fetchToken();
    res = await send();
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(text || res.statusText, res.status);
  }
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("json") ? await res.json() : await res.text()) as T;
}

function deviceId(): string {
  let id = localStorage.getItem("strata-device");
  if (!id) {
    id = "dev-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("strata-device", id);
  }
  return id;
}

/**
 * Read a streamed AI action.
 *
 * `EventSource` cannot POST, so this reads the response body manually. The
 * parser keeps the tail of a chunk that split an event mid-JSON — a token
 * boundary landing inside a payload is the normal case over a local socket, not
 * an edge case.
 *
 * `signal` is the Stop button: aborting it closes the connection, the server
 * sees the socket close and aborts the upstream request, so the model stops
 * generating instead of finishing an answer nobody is watching.
 */
async function streamAiAction(
  req: Record<string, unknown>,
  onEvent: (e: AiStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const send = (): Promise<Response> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-strata-device": deviceId(),
    };
    if (token) headers["x-strata-token"] = token;
    return fetch("/api/ai/action/stream", {
      method: "POST",
      headers,
      body: JSON.stringify(req),
      signal,
      cache: "no-store",
    });
  };

  let res = await send();
  if (res.status === 401) {
    await fetchToken();
    res = await send();
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new ApiError(text || `stream failed with HTTP ${res.status}`, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    const events = buf.split("\n\n");
    buf = events.pop() ?? "";
    for (const block of events) {
      const line = block.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        onEvent(JSON.parse(payload) as AiStreamEvent);
      } catch {
        // A payload the provider never finished; the next event completes it.
      }
    }
  }
}

export async function bootstrap(): Promise<{ ws: string; info: WorkspaceInfo | null }> {
  // always take a fresh token: /api/bootstrap is the one token-less route, so a
  // cached token buys nothing and goes stale the moment the server restarts
  await fetchToken();
  const data = await call<{ ws: string; info: WorkspaceInfo | null }>("/api/bootstrap");
  return { ws: data.ws, info: data.info };
}

// ── types the server returns that the shared contract doesn't define ─────────

export interface RowDetail extends RowView {
  databaseId: string | null;
  properties: PropertyDef[];
}

export interface QueryResponse {
  rows: RowView[];
  total: number;
  properties: PropertyDef[];
  spec: ViewSpec;
  view: ViewType;
}

export interface DatabaseFull {
  databaseId: string;
  title: string;
  icon: string | null;
  inline_in_id: string | null;
  properties: PropertyDef[];
  views: { id: string; db_id: string; name: string; type: ViewType; spec: ViewSpec; pos: string }[];
}

export interface NodeDetail {
  node: NodeRow;
  children: NodeRow[];
  breadcrumbs: { id: string; title: string; icon?: string }[];
}

// ── endpoints ────────────────────────────────────────────────────────────────

export const api = {
  health: () => call<{ ok: boolean; sqlite: string; nodes: number; ops: number }>("/api/health"),
  workspace: () => call<WorkspaceInfo>("/api/workspace"),
  renameWorkspace: (name: string) =>
    call<WorkspaceInfo>("/api/workspace", { method: "PATCH", body: JSON.stringify({ name }) }),

  tree: () => call<NodeTree[]>("/api/tree"),
  recent: (limit = 12) => call<NodeRow[]>(`/api/recent?limit=${limit}`),

  node: (id: string) => call<NodeDetail>(`/api/nodes/${id}`),
  /** Batch title lookup — relation cells need many titles in one request. */
  titles: (ids: string[]) =>
    call<{ id: string; title: string; icon?: string }[]>(
      `/api/titles?ids=${encodeURIComponent(ids.join(","))}`,
    ),
  fullTree: (id: string, depth = 20) => call<NodeTree | null>(`/api/nodes/${id}/tree?depth=${depth}`),
  breadcrumbs: (id: string) => call<{ id: string; title: string; icon?: string }[]>(`/api/nodes/${id}/breadcrumbs`),
  backlinks: (id: string) =>
    call<{ backlinks: BacklinkEntry[]; outgoing: { dst: string; title: string }[] }>(
      `/api/nodes/${id}/backlinks`,
    ),

  createPage: (parentId: string | null, title = "", icon?: string) =>
    call<{ id: string; node: NodeRow }>("/api/pages", {
      method: "POST",
      body: JSON.stringify({ parentId, title, icon }),
    }),

  createNode: (input: {
    parentId: string | null;
    type: string;
    kind?: "page" | "block" | "row";
    before?: string | null;
    after?: string | null;
    body?: unknown;
    props?: Record<string, unknown>;
    meta?: PageMeta;
  }) => call<{ id: string; node: NodeRow }>("/api/nodes", { method: "POST", body: JSON.stringify(input) }),

  patchNode: (id: string, patch: Record<string, unknown>) =>
    call<{ node: NodeRow }>(`/api/nodes/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  convert: (id: string, type: string, props?: Record<string, unknown>) =>
    call<{ node: NodeRow }>(`/api/nodes/${id}/convert`, {
      method: "POST",
      body: JSON.stringify({ type, props }),
    }),

  move: (id: string, target: { parentId: string | null; before?: string | null; after?: string | null }) =>
    call<{ node: NodeRow }>(`/api/nodes/${id}/move`, { method: "POST", body: JSON.stringify(target) }),

  setMeta: (id: string, patch: Partial<PageMeta>) =>
    call<{ node: NodeRow }>(`/api/nodes/${id}/meta`, { method: "PATCH", body: JSON.stringify(patch) }),

  trash: (id: string) => call<{ ok: boolean }>(`/api/nodes/${id}`, { method: "DELETE" }),
  restore: (id: string) => call<{ ok: boolean }>(`/api/nodes/${id}/restore`, { method: "POST" }),
  purge: (id: string) => call<{ ok: boolean }>(`/api/nodes/${id}/purge`, { method: "DELETE" }),

  tx: (ops: unknown[]) =>
    call<{ tx: number; touched: string[] }>("/api/tx", { method: "POST", body: JSON.stringify({ ops }) }),
  undo: () => call<{ tx: number | null; canUndo: boolean; canRedo: boolean }>("/api/undo", { method: "POST" }),
  undoState: () => call<{ canUndo: boolean; canRedo: boolean }>("/api/undo/state"),
  redo: () => call<{ tx: number | null; canUndo: boolean; canRedo: boolean }>("/api/redo", { method: "POST" }),

  search: (q: string, limit = 30) =>
    call<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),

  trashList: () => call<TrashEntry[]>("/api/trash"),
  emptyTrash: () => call<{ removed: number }>("/api/trash/empty", { method: "POST" }),

  history: (id: string) =>
    call<{ snapshots: SnapshotEntry[]; ops: { seq: number; ts: number; actor: string; op: string; tx: number }[] }>(
      `/api/history/${id}`,
    ),
  snapshot: (id: string, label: string) =>
    call<SnapshotEntry>(`/api/history/${id}/snapshot`, { method: "POST", body: JSON.stringify({ label }) }),
  restoreSnapshot: (snapshotId: string) =>
    call<{ ok: boolean }>(`/api/history/restore/${snapshotId}`, { method: "POST" }),

  templates: () =>
    call<{ id: string; name: string; scope: "page" | "database"; icon: string | null; created_at: number }[]>(
      "/api/templates",
    ),
  saveTemplate: (name: string, nodeId: string, scope: "page" | "database" = "page") =>
    call<{ id: string }>("/api/templates", { method: "POST", body: JSON.stringify({ name, nodeId, scope }) }),
  /** Install the 15 first-party templates. Idempotent server-side. */
  seedFirstPartyTemplates: () =>
    call<{ seeded: number; removed: number; templates: string[] }>("/api/templates/seed-first-party", {
      method: "POST",
    }),
  deleteTemplate: (id: string) => call<{ ok: boolean }>(`/api/templates/${id}`, { method: "DELETE" }),
  applyTemplate: (id: string, parentId: string | null, title?: string) =>
    call<{ id: string | null }>(`/api/templates/${id}/apply`, {
      method: "POST",
      body: JSON.stringify({ parentId, title }),
    }),

  settings: () => call<Record<string, unknown>>("/api/settings"),
  saveSettings: (patch: Record<string, unknown>) =>
    call<Record<string, unknown>>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) }),

  uploadMedia: async (file: File): Promise<{ id: string; mime: string; bytes: number }> => {
    const buf = await file.arrayBuffer();
    const res = await fetch(
      `/api/media?name=${encodeURIComponent(file.name)}&mime=${encodeURIComponent(file.type)}`,
      {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          ...(token ? { "x-strata-token": token } : {}),
        },
        body: buf,
      },
    );
    if (!res.ok) throw new ApiError(await res.text(), res.status);
    return (await res.json()) as { id: string; mime: string; bytes: number };
  },
  mediaUrl: (id: string) => `/media/${id}`,

  // ── databases ────────────────────────────────────────────────────────────
  createDatabase: (input: {
    parentId: string | null;
    title: string;
    properties?: { name: string; type: string; config?: Record<string, unknown> }[];
    views?: { name: string; type: ViewType }[];
  }) => call<{ databaseId: string; node: string }>("/api/databases", { method: "POST", body: JSON.stringify(input) }),

  database: (id: string) => call<DatabaseFull>(`/api/databases/${id}`),
  databaseForNode: (nodeId: string) => call<DatabaseFull | null>(`/api/nodes/${nodeId}/database`),
  renameDatabase: (id: string, title: string) =>
    call<DatabaseFull>(`/api/databases/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),

  addProperty: (dbId: string, input: { name: string; type: string; config?: Record<string, unknown> }) =>
    call<PropertyDef>(`/api/databases/${dbId}/properties`, { method: "POST", body: JSON.stringify(input) }),
  patchProperty: (propId: string, patch: Record<string, unknown>) =>
    call<PropertyDef[]>(`/api/properties/${propId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteProperty: (propId: string) => call<{ ok: boolean }>(`/api/properties/${propId}`, { method: "DELETE" }),
  addOption: (propId: string, name: string, color?: string) =>
    call<{ id: string }>(`/api/properties/${propId}/options`, {
      method: "POST",
      body: JSON.stringify({ name, color }),
    }),
  renameOption: (propId: string, optionId: string, patch: { name?: string; color?: string }) =>
    call<{ ok: boolean }>(`/api/properties/${propId}/options/${optionId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteOption: (propId: string, optionId: string) =>
    call<{ ok: boolean }>(`/api/properties/${propId}/options/${optionId}`, { method: "DELETE" }),

  createRelation: (input: { sourceDb: string; targetDb: string; name: string; mirrorName: string }) =>
    call<{ source: PropertyDef; mirror: PropertyDef }>("/api/relations", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  createRow: (dbId: string, values: Record<string, PropertyValueInput> = {}, after?: string | null) =>
    call<{ id: string; row: RowView }>(`/api/databases/${dbId}/rows`, {
      method: "POST",
      body: JSON.stringify({ values, after }),
    }),
  row: (id: string) => call<RowDetail>(`/api/rows/${id}`),
  patchRow: (id: string, values: Record<string, PropertyValueInput>) =>
    call<{ row: RowView }>(`/api/rows/${id}`, { method: "PATCH", body: JSON.stringify({ values }) }),
  moveRow: (id: string, target: { before?: string | null; after?: string | null; parentId?: string | null }) =>
    call<{ row: RowView }>(`/api/rows/${id}/move`, { method: "POST", body: JSON.stringify(target) }),
  deleteRow: (id: string) => call<{ ok: boolean }>(`/api/rows/${id}`, { method: "DELETE" }),

  views: (dbId: string) => call<{ id: string; name: string; type: ViewType }[]>(`/api/databases/${dbId}/views`),
  createView: (dbId: string, name: string, type: ViewType) =>
    call<{ id: string }>(`/api/databases/${dbId}/views`, { method: "POST", body: JSON.stringify({ name, type }) }),
  patchView: (viewId: string, patch: { spec?: ViewSpec; name?: string }) =>
    call<{ id: string }>(`/api/views/${viewId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteView: (viewId: string) => call<{ ok: boolean }>(`/api/views/${viewId}`, { method: "DELETE" }),

  query: (viewId: string) => call<QueryResponse>(`/api/views/${viewId}/query`),
  queryWith: (viewId: string, spec: ViewSpec) =>
    call<{ rows: RowView[]; total: number }>(`/api/views/${viewId}/query`, {
      method: "POST",
      body: JSON.stringify({ spec }),
    }),
  grouped: (viewId: string, group: string, spec: ViewSpec, subGroup?: string) =>
    call<{ buckets: GroupBucket[]; total: number }>(`/api/views/${viewId}/grouped`, {
      method: "POST",
      body: JSON.stringify({ group, spec, subGroup }),
    }),
  aggregate: (dbId: string, propId: string, fn: string, viewId?: string) =>
    call<{ value: number | string | null }>(
      `/api/databases/${dbId}/aggregate?prop=${propId}&fn=${fn}${viewId ? `&viewId=${viewId}` : ""}`,
    ),

  // ── AI ──────────────────────────────────────────────────────────────────
  aiProviders: () =>
    call<{ providers: ProviderConfig[]; defaultProvider: string | null }>("/api/ai/providers"),
  addProvider: (config: ProviderConfig) =>
    call<ProviderConfig[]>("/api/ai/providers", { method: "POST", body: JSON.stringify(config) }),
  patchProvider: (id: string, patch: Partial<ProviderConfig>) =>
    call<ProviderConfig[]>(`/api/ai/providers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  removeProvider: (id: string) =>
    call<{ ok: boolean }>(`/api/ai/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setDefaultProvider: (id: string) =>
    call<{ ok: boolean; defaultProvider: string | null }>(
      `/api/ai/providers/${encodeURIComponent(id)}/default`,
      { method: "POST" },
    ),
  aiModels: (id: string) =>
    call<{ models: ModelInfo[] }>(`/api/ai/providers/${encodeURIComponent(id)}/models`),
  /** One provider answers with its own probe; omit `id` to probe every enabled one. */
  aiTest: (id?: string) =>
    call<Record<string, ProviderProbe>>(
      id
        ? `/api/ai/providers/${encodeURIComponent(id)}/test`
        : "/api/ai/test",
      { method: "POST" },
    ),
  aiDetect: (all = false) =>
    call<{ providers: DetectedProvider[] }>(`/api/ai/detect${all ? "?all=1" : ""}`),
  aiUsage: (opts: { days?: number; recent?: number } = {}) =>
    call<AiUsageSummary>(
      `/api/ai/usage?${new URLSearchParams({
        ...(opts.days ? { days: String(opts.days) } : {}),
        ...(opts.recent ? { recent: String(opts.recent) } : {}),
      }).toString()}`,
    ),
  aiAction: (req: Record<string, unknown>) =>
    call<AiResult>("/api/ai/action", { method: "POST", body: JSON.stringify(req) }),
  /** Streamed action. Returns when the stream ends; `onEvent` sees every event. */
  aiActionStream: (
    req: Record<string, unknown>,
    onEvent: (e: AiStreamEvent) => void,
    signal?: AbortSignal,
  ) => streamAiAction(req, onEvent, signal),
  aiRebuild: () => call<{ chunks: number; ms: number }>("/api/ai/index/rebuild", { method: "POST" }),
  aiHealth: () =>
    call<Record<string, { ok: boolean; models?: number; latencyMs?: number; error?: string }>>(
      "/api/ai/health",
    ),

  // ── import / export ─────────────────────────────────────────────────────
  importMarkdown: (content: string, parentId: string | null) =>
    call<{ pages: number; blocks: number; databases: number; rows: number; rootIds: string[]; warnings: string[] }>(
      "/api/import/markdown",
      { method: "POST", body: JSON.stringify({ content, parentId }) },
    ),
  exportUrl: (kind: "markdown" | "html", id: string) => `/api/export/${kind}?nodeId=${encodeURIComponent(id)}`,
  /** CSV is exported from a *view* (its filter and sort define the columns). */
  exportCsvUrl: (viewId: string) => `/api/export/csv?viewId=${encodeURIComponent(viewId)}`,
  /** Authenticated CSV download: returns the file text. */
  exportCsv: (viewId: string) => call<string>(`/api/export/csv?viewId=${encodeURIComponent(viewId)}`),
  /**
   * PDF export. The print document must carry the session token, which a plain
   * navigation cannot do, so it is fetched here and opened from a blob URL.
   * The browser's own print dialog then writes the PDF.
   */
  exportPdf: async (
    nodeId: string,
    opts: {
      page?: "a4" | "letter";
      landscape?: boolean;
      toc?: boolean;
      children?: boolean;
      databases?: boolean;
      margins?: number;
    } = {},
  ): Promise<void> => {
    const q = new URLSearchParams({ nodeId });
    if (opts.page) q.set("page", opts.page);
    if (opts.landscape) q.set("landscape", "1");
    if (opts.toc) q.set("toc", "1");
    if (opts.children === false) q.set("children", "0");
    if (opts.databases === false) q.set("databases", "0");
    if (opts.margins != null) q.set("margins", String(opts.margins));
    q.set("print", "1");

    const html = await call<string>(`/api/export/pdf?${q.toString()}`);
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const win = window.open(url, "_blank");
    if (!win) {
      URL.revokeObjectURL(url);
      throw new ApiError("The browser blocked the print window — allow pop-ups for this site.", 0);
    }
    // the print dialog can stay open a long time; revoke well after
    window.setTimeout(() => URL.revokeObjectURL(url), 120000);
  },
};

export function mediaSrc(idOrUrl: string | undefined): string | undefined {
  if (!idOrUrl) return undefined;
  if (/^(https?:|data:|blob:|\/)/.test(idOrUrl)) return idOrUrl;
  return `/media/${idOrUrl}`;
}
