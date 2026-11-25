/**
 * Workspace Q&A retrieval: chunking, embeddings, and ranking.
 *
 * No vector extension is required. Embeddings are Float32 blobs; ranking is
 * brute-force cosine in JS, which is tens of milliseconds for the tens of
 * thousands of chunks a personal workspace produces. `sqlite-vec` is a later
 * optimisation, not a dependency.
 *
 * Degrades honestly: with no embedding-capable provider, Q&A answers from the
 * FTS5 index and says so, instead of failing.
 */

import type { Db } from "../db.ts";
import { getTree, search, nodeTitle, getNode } from "../library.ts";
import { bodyToPlainText, type NodeTree, type ProviderConfig } from "../../shared/types.ts";
import { createAdapter } from "./providers.ts";

export const CHUNK_TARGET_CHARS = 1200;
export const CHUNK_OVERLAP_CHARS = 120;

export interface ChunkInput {
  node_id: string;
  ord: number;
  text: string;
}

/** Flatten a page tree into text chunks, block by block, never splitting a block. */
export function chunkTree(tree: NodeTree): ChunkInput[] {
  const parts: string[] = [];

  const walk = (node: NodeTree): void => {
    const text = bodyToPlainText(node.body).trim();
    if (text) parts.push(text);
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);

  const chunks: ChunkInput[] = [];
  let current = "";
  let ord = 0;

  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed) {
      chunks.push({ node_id: tree.id, ord: ord++, text: trimmed });
      current = "";
    }
  };

  for (const part of parts) {
    if (part.length > CHUNK_TARGET_CHARS) {
      flush();
      for (let i = 0; i < part.length; i += CHUNK_TARGET_CHARS - CHUNK_OVERLAP_CHARS) {
        const slice = part.slice(i, i + CHUNK_TARGET_CHARS);
        if (slice.trim()) chunks.push({ node_id: tree.id, ord: ord++, text: slice });
        if (i + CHUNK_TARGET_CHARS >= part.length) break;
      }
      continue;
    }
    if (current.length + part.length + 1 > CHUNK_TARGET_CHARS) flush();
    current += (current ? "\n" : "") + part;
  }
  flush();
  return chunks;
}

export function chunkNode(db: Db, nodeId: string): ChunkInput[] {
  const tree = getTree(db, nodeId, 30);
  return tree ? chunkTree(tree) : [];
}

export function f32ToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

export function blobToF32(b: Uint8Array): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export interface RebuildResult {
  chunks: number;
  pages: number;
  ms: number;
  model: string;
  skipped?: string;
}

/** (Re)build the embedding index for every active page. */
export async function rebuildEmbeddings(
  db: Db,
  ws: string,
  configs: ProviderConfig[],
  opts: { onProgress?: (done: number, total: number) => void } = {},
): Promise<RebuildResult> {
  const started = Date.now();
  const embeddable = pickEmbedProvider(configs);
  if (!embeddable) {
    return {
      chunks: 0,
      pages: 0,
      ms: Date.now() - started,
      model: "",
      skipped:
        "no provider exposes embeddings — start Ollama (e.g. `ollama pull nomic-embed-text`) " +
        "or LM Studio, then rebuild. Q&A falls back to keyword search.",
    };
  }

  const adapter = createAdapter(embeddable);
  const model = embeddable.embedModel ?? "nomic-embed-text";

  const pages = db.all<{ id: string }>(
    `SELECT id FROM node
     WHERE ws = ? AND deleted_at IS NULL AND kind IN ('page','row')
     ORDER BY updated_at DESC`,
    ws,
  );

  db.run("DELETE FROM chunk WHERE ws = ? AND model <> ?", ws, model);

  let chunks = 0;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    const items = chunkNode(db, page.id);
    if (!items.length) continue;

    const vectors = await adapter.embed(
      items.map((c) => c.text),
      model,
    );

    db.tx(() => {
      db.run("DELETE FROM chunk WHERE node_id = ? AND model = ?", page.id, model);
      items.forEach((item, idx) => {
        const vec = vectors[idx];
        if (!vec?.length) return;
        db.run(
          `INSERT INTO chunk (id, node_id, ws, ord, text, dim, emb, model, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          crypto.randomUUID(),
          item.node_id,
          ws,
          item.ord,
          item.text,
          vec.length,
          f32ToBlob(vec),
          model,
          Date.now(),
        );
        chunks++;
      });
    });

    opts.onProgress?.(i + 1, pages.length);
  }

  return { chunks, pages: pages.length, ms: Date.now() - started, model };
}

function pickEmbedProvider(configs: ProviderConfig[]): ProviderConfig | undefined {
  return configs.find((c) => c.enabled && c.embedModel);
}

export interface Retrieved {
  node_id: string;
  title: string;
  text: string;
  score: number;
}

/**
 * Top-k chunks for a query.
 *
 * Vector ranking when an embedding provider is configured; FTS5 keyword ranking
 * otherwise. The caller is told which path ran via `mode`, so the UI can label
 * the answer accurately.
 */
export async function retrieve(
  db: Db,
  ws: string,
  query: string,
  k = 8,
  configs: ProviderConfig[] = [],
): Promise<{ hits: Retrieved[]; mode: "vector" | "keyword" }> {
  const embeddable = pickEmbedProvider(configs);

  if (embeddable) {
    try {
      const adapter = createAdapter(embeddable);
      const model = embeddable.embedModel ?? "nomic-embed-text";
      const [q] = await adapter.embed([query], model);
      if (q?.length) {
        const rows = db.all<{ node_id: string; text: string; emb: Uint8Array }>(
          "SELECT node_id, text, emb FROM chunk WHERE ws = ? AND model = ?",
          ws,
          model,
        );
        const scored = rows
          .map((r) => ({ node_id: r.node_id, text: r.text, score: cosine(q, blobToF32(r.emb)) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, k);

        return {
          hits: scored.map((s) => ({
            ...s,
            title: titleOf(db, s.node_id),
          })),
          mode: "vector",
        };
      }
    } catch {
      // fall through to keyword
    }
  }

  const hits = search(db, ws, query, { limit: k }).map((h) => ({
    node_id: h.node_id,
    title: h.title,
    text: h.snippet,
    score: h.score,
  }));
  return { hits, mode: "keyword" };
}

function titleOf(db: Db, nodeId: string): string {
  const n = getNode(db, nodeId);
  return n ? nodeTitle(n) : "Untitled";
}

export function indexStats(db: Db, ws: string): { chunks: number; pages: number; models: string[] } {
  return {
    chunks: Number(db.scalar<number>("SELECT count(*) c FROM chunk WHERE ws = ?", ws) ?? 0),
    pages: Number(
      db.scalar<number>("SELECT count(DISTINCT node_id) c FROM chunk WHERE ws = ?", ws) ?? 0,
    ),
    models: db.all<{ model: string }>("SELECT DISTINCT model FROM chunk WHERE ws = ?", ws).map((r) => r.model),
  };
}
