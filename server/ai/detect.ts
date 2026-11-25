/**
 * Local model-server detection.
 *
 * The settings screen used to ask the user to type a base URL, a model name and
 * an embedding model by hand. Every app in this space does better than that: it
 * looks at the ports a local server is known to listen on, and offers to add
 * what it finds. That is what this file is for.
 *
 * Rules:
 *   - loopback only. Detection never touches a routable address; the whole
 *     promise of this app is that nothing leaves the machine.
 *   - a short timeout. A closed port on localhost answers in milliseconds, so
 *     anything slower than `probeTimeoutMs` is a wedged process, and the panel
 *     must not stall on it.
 *   - failures are data, not exceptions. A closed port is `running: false` with
 *     an error string; the caller renders a list, it does not catch anything.
 */

import type { DetectedProvider, ProviderKind } from "../../shared/types.ts";
import { LMSTUDIO_BASE_URL, OLLAMA_BASE_URL, STRATA_BASE_URL, redact } from "./providers.ts";

export const DETECT_TIMEOUT_MS = 2_000;

export interface DetectTarget {
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  /** extra origin to probe for a native (non-OpenAI) route, e.g. Ollama /api/tags */
  nativeOrigin?: string;
}

/**
 * The loopback ports local model servers are found on. `openai-compatible`
 * entries are generic servers (vLLM, llamafile, LocalAI, text-generation-webui).
 */
export const DETECT_TARGETS: DetectTarget[] = [
  { kind: "strata", label: "Strata", baseUrl: STRATA_BASE_URL },
  { kind: "ollama", label: "Ollama", baseUrl: OLLAMA_BASE_URL, nativeOrigin: "http://127.0.0.1:11434" },
  { kind: "lmstudio", label: "LM Studio", baseUrl: LMSTUDIO_BASE_URL },
  { kind: "openai-compatible", label: "vLLM", baseUrl: "http://127.0.0.1:8000/v1" },
  { kind: "openai-compatible", label: "Llamafile", baseUrl: "http://127.0.0.1:8080/v1" },
  { kind: "openai-compatible", label: "LocalAI", baseUrl: "http://127.0.0.1:5000/v1" },
];

/** Names that indicate an embedding model, so the add form can prefill it. */
const EMBED_HINTS = [
  "embed",
  "bge",
  "nomic",
  "minilm",
  "mxbai",
  "gte",
  "snowflake",
  "jina-embeddings",
  "all-minilm",
  "text2vec",
];

export function looksLikeEmbeddingModel(id: string): boolean {
  const lower = id.toLowerCase();
  return EMBED_HINTS.some((hint) => lower.includes(hint));
}

function originOf(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return baseUrl.replace(/\/+$/, "");
  }
}

function modelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
}

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

/**
 * Probe one target. Returns a `DetectedProvider` in every case, including
 * failure — the caller renders the list.
 */
export async function detectTarget(
  target: DetectTarget,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<DetectedProvider> {
  const fetchImpl = (opts.fetchImpl ?? globalThis.fetch) as typeof fetch;
  const timeoutMs = opts.timeoutMs ?? DETECT_TIMEOUT_MS;
  const started = Date.now();
  const base: DetectedProvider = {
    kind: target.kind,
    label: target.label,
    baseUrl: target.baseUrl,
    origin: originOf(target.baseUrl),
    running: false,
    models: 0,
    modelIds: [],
    embedModelIds: [],
    latencyMs: 0,
  };

  // Ollama's native route lists pulled models with their sizes; its /v1 shim
  // only lists what it can serve, so the native one is the better source.
  const urls = target.nativeOrigin
    ? [`${target.nativeOrigin}/api/tags`, modelsUrl(target.baseUrl)]
    : [modelsUrl(target.baseUrl)];

  let lastError = "";
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const json = (await res.json()) as Record<string, unknown>;
      const ids = modelIdsFrom(json);
      const latencyMs = Date.now() - started;
      return {
        ...base,
        running: true,
        models: ids.length,
        modelIds: ids,
        embedModelIds: ids.filter(looksLikeEmbeddingModel),
        latencyMs,
      };
    } catch (e) {
      lastError = redact((e as Error)?.message ?? String(e));
    }
  }

  return { ...base, latencyMs: Date.now() - started, error: lastError || "no response" };
}

/** Pull model ids out of either the OpenAI `{data:[{id}]}` or Ollama `{models:[{name}]}` shape. */
export function modelIdsFrom(json: Record<string, unknown>): string[] {
  const out: string[] = [];
  const data = json.data;
  if (Array.isArray(data)) {
    for (const row of data) {
      const r = (row ?? {}) as Record<string, unknown>;
      const id = String(r.id ?? r.name ?? "");
      if (id) out.push(id);
    }
  }
  const models = json.models;
  if (Array.isArray(models)) {
    for (const row of models) {
      const r = (row ?? {}) as Record<string, unknown>;
      const id = String(r.name ?? r.model ?? r.id ?? "");
      if (id) out.push(id);
    }
  }
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
}

/**
 * Probe every known loopback target in parallel.
 *
 * `onlyRunning` is what the settings panel passes: the "detected" card should
 * offer things the user can actually add, not a wall of closed ports.
 */
export async function detectLocalProviders(
  opts: { fetchImpl?: FetchLike; timeoutMs?: number; onlyRunning?: boolean; targets?: DetectTarget[] } = {},
): Promise<DetectedProvider[]> {
  const targets = opts.targets ?? DETECT_TARGETS;
  const results = await Promise.all(targets.map((t) => detectTarget(t, opts)));
  return opts.onlyRunning ? results.filter((r) => r.running) : results;
}
