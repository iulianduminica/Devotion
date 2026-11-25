/**
 * Entry point. Boots the API, wires the AI bridge, and serves the built app.
 *
 * Usage:
 *   npm run dev     → vite on :5175 + API on :8790 (proxy)
 *   npm run build && npm start → single server on :8790 serving dist/ + /api
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import type { AiResult, ProviderConfig } from "../shared/types.ts";
import { createApp, type App, type AiBridge } from "./api.ts";
import { openWorkspace } from "./db.ts";

/**
 * Fail with a sentence, not a stack.
 *
 * The workspace is stored through `node:sqlite`, which does not exist before
 * Node 22.5 and is only dependable in 24. Without this check, an older Node
 * dies with `ERR_UNKNOWN_BUILTIN_MODULE`, which points nobody at the fix.
 */
const MIN_NODE_MAJOR = 24;
const nodeMajor = Number(process.versions.node.split(".")[0] ?? 0);
if (nodeMajor < MIN_NODE_MAJOR) {
  console.error(
    `\n  Devotion needs Node.js ${MIN_NODE_MAJOR} or newer — this is ${process.versions.node}.\n` +
      "  The workspace is stored with node:sqlite, which older Node versions do not ship.\n" +
      "  Install Node 24+ (https://nodejs.org) or run the Docker image, which bundles it.\n",
  );
  process.exit(1);
}

export interface StartOptions {
  workspace?: string;
  port?: number;
  devOrigins?: string[];
}

async function buildAiBridge(workspaceRoot: string): Promise<AiBridge | null> {
  // The AI layer is optional at boot: if it is missing or broken, the app runs
  // with every AI feature hidden rather than failing to start.
  try {
    const mod = await import("./ai/index.ts");
    const { retrieve } = await import("./ai/retrieval.ts");
    const { detectLocalProviders } = await import("./ai/detect.ts");
    const { logAiCall, aiUsageSummary, pruneAiCalls } = await import("./ai/usage.ts");
    const { setSetting } = await import("./library.ts");
    const { db } = openWorkspace(workspaceRoot);
    const ws = db.scalar<string>("SELECT id FROM workspace LIMIT 1") ?? "";

    // Provider configs live in the `setting` table; a keychain reference is
    // stored, never a raw key.
    const registry = mod.registryFromDatabase(db, ws, {
      secretResolver: (ref: string) => process.env[ref] ?? null,
    });

    /** One row per request: the diagnostics drawer and the usage stats read it. */
    const record = (
      provider: string,
      action: string,
      result: { ok: boolean; model?: string; ms: number; error?: string; usage?: AiResult["usage"] },
    ): void => {
      try {
        logAiCall(db, {
          ws,
          provider,
          model: result.model ?? "",
          action,
          ms: result.ms,
          ok: result.ok,
          promptTokens: result.usage?.promptTokens ?? null,
          completionTokens: result.usage?.completionTokens ?? null,
          chars: result.usage?.chars ?? 0,
          error: result.error,
        });
        pruneAiCalls(db, ws);
      } catch {
        // A broken log must never break the AI call it is logging.
      }
    };

    const depsFor = (providerId?: string, signal?: AbortSignal) => {
      const adapter = registry.adapterFor(providerId);
      const configs = registry.list();
      return {
        adapter,
        signal,
        retrieve: (query: string, k: number) => retrieve(db, ws, query, k, configs),
        getRowContext: async (rowId: string) => {
          const { getRow, databaseForNode, listProperties } = await import("./databases.ts");
          const row = getRow(db, rowId);
          if (!row) return { title: "", values: {}, properties: [] };
          const dbId = row.node.parent_id ? databaseForNode(db, row.node.parent_id) : null;
          return {
            title: row.title,
            values: row.values as Record<string, unknown>,
            properties: dbId ? listProperties(db, dbId) : [],
          };
        },
      };
    };

    const bridge: AiBridge = {
      providers: () => registry.list(),

      defaultId: () => registry.defaultProviderId ?? null,

      addProvider: (config) => {
        mod.saveProviderConfig(db, ws, config as never);
        registry.add(config as never);
        return registry.list();
      },

      patchProvider: (id, patch) => {
        const current = registry.get(id);
        if (!current) throw new Error(`unknown provider "${id}"`);
        const next = { ...current, ...(patch as Partial<ProviderConfig>) };
        mod.saveProviderConfig(db, ws, next);
        registry.add(next); // invalidates the memoised adapter, so a new base URL takes effect
        return registry.list();
      },

      removeProvider: (id) => {
        mod.deleteProviderConfig(db, ws, id);
        registry.remove(id);
      },

      setDefault: (id) => {
        registry.setDefault(id);
        setSetting(db, ws, "ai.defaultProvider", id);
      },

      models: async (id) => registry.adapterFor(id).listModels(),

      test: async (id) => (id ? { [id]: await registry.adapterFor(id).probe() } : await registry.probeAll()),

      detect: async (onlyRunning) => detectLocalProviders({ onlyRunning: onlyRunning !== false }),

      runAction: async (body) => {
        const req = body as Parameters<typeof mod.runAction>[0];
        const started = Date.now();
        try {
          const result = await mod.runAction(req, depsFor(req.providerId));
          record(req.providerId ?? registry.defaultProviderId ?? "", req.action, {
            ...result,
            ms: result.ms ?? Date.now() - started,
          });
          return result;
        } catch (err) {
          record(req.providerId ?? "", req.action, {
            ok: false,
            ms: Date.now() - started,
            error: (err as Error).message,
          });
          throw err;
        }
      },

      streamAction: (body, signal) => {
        const req = body as Parameters<typeof mod.runAction>[0];
        const deps = depsFor(req.providerId, signal);
        const started = Date.now();
        return (async function* () {
          for await (const event of mod.runActionStream(req, deps)) {
            if (event.type === "done" || event.type === "error") {
              record(req.providerId ?? registry.defaultProviderId ?? "", req.action, {
                ...event.result,
                ms: event.result.ms ?? Date.now() - started,
              });
            }
            yield event;
          }
        })();
      },

      rebuildIndex: async () => {
        const { rebuildEmbeddings } = await import("./ai/retrieval.ts");
        const result = await rebuildEmbeddings(db, ws, registry.list());
        return { chunks: result.chunks, ms: result.ms };
      },

      usage: (opts) => aiUsageSummary(db, ws, opts),

      health: async () => {
        const out: Record<string, unknown> = {};
        for (const config of registry.list()) {
          try {
            out[config.id] = await registry.adapterFor(config.id).health();
          } catch (err) {
            out[config.id] = { ok: false, models: 0, latencyMs: 0, error: (err as Error).message };
          }
        }
        return out;
      },
    };
    return bridge;
  } catch (err) {
    console.warn(`[ai] disabled: ${(err as Error).message}`);
    return null;
  }
}

/**
 * `--port 8791`, `--workspace /data`, and the matching environment variables.
 *
 * Small on purpose: this is a single-user app, and a flag parser is not a
 * feature. It exists because Docker and a second local instance both need a
 * port, and editing a file to change one is the kind of friction that makes
 * people give up on running something.
 */
function cliOverrides(argv: string[]): StartOptions {
  const opts: StartOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--port" && next) {
      const port = Number(next);
      if (Number.isInteger(port) && port > 0 && port < 65_536) opts.port = port;
      i++;
    } else if (flag === "--workspace" && next) {
      opts.workspace = next;
      i++;
    }
  }
  return opts;
}

function envPort(): number | undefined {
  const raw = process.env.DEVOTION_PORT;
  if (!raw) return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

export async function start(options: StartOptions = {}): Promise<App> {
  const port = options.port ?? envPort() ?? 8790;
  const workspaceRoot =
    options.workspace ??
    process.env.DEVOTION_WORKSPACE ??
    // fileURLToPath, not `.pathname`: on Windows that returns "/C:/…" and the
    // regex patch people reach for is a Windows-only fix in a cross-platform app
    fileURLToPath(new URL("../.data/workspace", import.meta.url));

  const bridge = await buildAiBridge(workspaceRoot);

  const app = await createApp({
    workspaceRoot,
    port,
    devOrigins: options.devOrigins ?? ["http://127.0.0.1:5175", "http://localhost:5175"],
    // null means "no AI": the routes are absent and the UI hides the feature
    ai: bridge ?? undefined,
  });

  /**
   * Loopback by default, on purpose.
   *
   * Devotion is single-user and single-device: the session token is embedded in
   * the HTML shell and there is no account system. Binding 0.0.0.0 puts the
   * whole workspace on the LAN with that as its only defence, so it is opt-in
   * and it is announced when it happens.
   */
  const host = process.env.DEVOTION_HOST ?? "127.0.0.1";
  await app.fastify.listen({ host, port });

  console.log(`\n  Devotion  →  http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  console.log(`  workspace: ${workspaceRoot}`);
  console.log(`  session token: ${app.token}`);
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.log(
      `  WARNING: listening on ${host}: anyone on this network can open your notes.\n` +
        "    Devotion has no accounts — the token in the page is the only gate.",
    );
  }
  console.log("");
  return app;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  start(cliOverrides(process.argv.slice(2))).catch((err) => {
    console.error("failed to start:", err);
    process.exit(1);
  });
}
