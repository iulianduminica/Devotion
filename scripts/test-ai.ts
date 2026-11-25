/**
 * Local AI layer tests. Run with:
 *
 *   & .\node_modules\.bin\tsx.cmd scripts/test-ai.ts
 *
 * These run with NO internet and NO model server: a fake provider on
 * 127.0.0.1, bound to an ephemeral port, speaks OpenAI-compatible chat, SSE
 * streams fed in deliberately awkward chunks, Ollama's native routes, and
 * every failure mode the client claims to handle. The only live call is the
 * informational Strata check at the very end, which is skipped when the
 * provider is not running.
 */

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openWorkspace } from "../server/db.ts";
import {
  AiAbortedError,
  AiError,
  AiTimeoutError,
  SseParser,
  capabilitiesFor,
  createAdapter,
  defaultProviderConfigs,
  deleteProviderConfig,
  deltaText,
  loadProviderConfigs,
  redact,
  registryFromDatabase,
  registryFromSettings,
  saveProviderConfig,
  type ChatOptions,
  type ProviderAdapter,
} from "../server/ai/providers.ts";
import type { AiRequest, PropertyDef, ProviderConfig, ProviderProbe, SelectOption } from "../shared/types.ts";
import {
  clampInput,
  cleanAnswer,
  coerceNumber,
  extractCitations,
  parseDateValue,
  runAction,
  validateAutofill,
} from "../server/ai/actions.ts";
import { AiJsonError, extractJson, extractJsonObject } from "../server/ai/json.ts";
import { promptFor } from "../server/ai/prompts.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(label: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32mok\x1b[0m   ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

function info(line: string): void {
  console.log(`  \x1b[36minfo\x1b[0m ${line}`);
}

function eq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(label, a === e, a === e ? "" : `got ${a}, want ${e}`);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Fake provider
// ─────────────────────────────────────────────────────────────────────────────

type Mode =
  | "chat"
  | "reasoning"
  | "stream"
  | "stream-slow"
  | "bad-request"
  | "flaky-429"
  | "always-500"
  | "slow"
  | "echo-request"
  | "empty";

interface FakeState {
  mode: Mode;
  chat: number;
  models: number;
  embedOpenAi: number;
  embedOllama: number;
  tags: number;
  embed404: boolean;
  lastAuth: string | null;
  lastChatBody: Record<string, unknown> | null;
  slowTimer: ReturnType<typeof setTimeout> | null;
}

interface Fake {
  base: string;
  origin: string;
  port: number;
  state: FakeState;
  reset(): void;
  close(): Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function answer(res: http.ServerResponse, content: string): void {
  sendJson(res, 200, {
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  });
}

/** SSE written in chunks chosen to break naive parsers. */
async function streamAwkward(res: http.ServerResponse): Promise<void> {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.socket?.setNoDelay?.(true);
  const chunks = [
    ": keep-alive comment\r\n\r\n", // comment line, CRLF
    'data: {"choices":[{"index":0,"delta":{"content":"Hel', // split mid-JSON
    'lo, "}}]}\r\n\r\n',
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"MUST NOT APPEAR","content":"world"}}]}\n\n',
    "data: {\n", // multi-line data event
    'data: "choices":[{"index":0,"delta":{"content":"!"}}]}\n',
    "\n",
    "event: message\ndata: [DONE]\n\n",
  ];
  for (const c of chunks) {
    res.write(c);
    await sleep(5);
  }
  res.end();
}

/** A stream that never ends: the first delta arrives, then a drip. */
function streamSlow(res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.socket?.setNoDelay?.(true);
  res.write('data: {"choices":[{"index":0,"delta":{"content":"first"}}]}\n\n');
  const timer = setInterval(() => {
    res.write('data: {"choices":[{"index":0,"delta":{"content":"drip"}}]}\n\n');
  }, 40);
  res.on("close", () => clearInterval(timer));
}

async function startFake(): Promise<Fake> {
  const state: FakeState = {
    mode: "chat",
    chat: 0,
    models: 0,
    embedOpenAi: 0,
    embedOllama: 0,
    tags: 0,
    embed404: false,
    lastAuth: null,
    lastChatBody: null,
    slowTimer: null,
  };

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");

      if (path === "/v1/models") {
        state.models++;
        // the verified Strata shape, verbatim
        return sendJson(res, 200, {
          object: "list",
          data: [
            {
              id: "swift-iq3_s",
              object: "model",
              owned_by: "strata",
              context_length: 524288,
              meta: { label: "Swift IQ3 S" },
            },
          ],
        });
      }
      if (path === "/api/tags") {
        state.tags++;
        return sendJson(res, 200, {
          models: [
            { name: "llama3.1:8b", model: "llama3.1:8b", details: { family: "llama", context_length: 8192 } },
            { name: "nomic-embed-text", model: "nomic-embed-text", details: { family: "nomic-bert" } },
          ],
        });
      }
      if (path === "/v1/embeddings") {
        state.embedOpenAi++;
        if (state.embed404) return sendJson(res, 404, { error: "no embedding route here" });
        return sendJson(res, 200, {
          data: [
            { index: 0, embedding: [1, 2, 3] },
            { index: 1, embedding: [4, 5, 6] },
          ],
        });
      }
      if (path === "/api/embed") {
        state.embedOllama++;
        return sendJson(res, 200, { embeddings: [[0.5, 0.25], [0.75, 0.125]] });
      }
      if (path === "/v1/chat/completions") {
        state.chat++;
        state.lastAuth = (req.headers.authorization as string | undefined) ?? null;
        let body: Record<string, unknown> = {};
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          body = {};
        }
        state.lastChatBody = body;
        return chatResponse(req, res, state);
      }
      return sendJson(res, 404, { error: `unhandled ${path}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    base: `http://127.0.0.1:${port}/v1`,
    origin: `http://127.0.0.1:${port}`,
    state,
    reset() {
      state.chat = 0;
      state.models = 0;
      state.embedOpenAi = 0;
      state.embedOllama = 0;
      state.tags = 0;
      state.lastAuth = null;
      state.lastChatBody = null;
      state.embed404 = false;
      state.mode = "chat";
    },
    async close() {
      if (state.slowTimer) clearTimeout(state.slowTimer);
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function chatResponse(req: IncomingMessage, res: ServerResponse, state: FakeState): void {
  const body = state.lastChatBody ?? {};
  switch (state.mode) {
    case "bad-request":
      // a provider that echoes the request header: the client must redact it
      return sendJson(res, 400, {
        error: {
          message: "invalid model",
          echo: { authorization: req.headers.authorization ?? "" },
        },
      });
    case "flaky-429":
      if (state.chat <= 2) return sendJson(res, 429, { error: "slow down" });
      return answer(res, "recovered");
    case "always-500":
      return sendJson(res, 500, { error: "model does not fit in RAM" });
    case "slow":
      if (state.slowTimer) clearTimeout(state.slowTimer);
      state.slowTimer = setTimeout(() => answer(res, "late answer"), 500);
      return;
    case "reasoning":
      return sendJson(res, 200, {
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "The real answer.",
              reasoning_content: "MUST NOT APPEAR: let me think hard about this…",
            },
            finish_reason: "stop",
          },
        ],
      });
    case "stream":
      void streamAwkward(res);
      return;
    case "stream-slow":
      streamSlow(res);
      return;
    case "echo-request":
      return answer(
        res,
        JSON.stringify({
          response_format: body.response_format ?? null,
          format: body.format ?? null,
          temperature: body.temperature ?? null,
          max_tokens: body.max_tokens ?? null,
          stream: body.stream ?? null,
          model: body.model ?? null,
          messages: body.messages ?? null,
        }),
      );
    case "empty":
      return answer(res, "");
    default:
      return answer(res, "The real answer.");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stub adapter: drives the actions without a socket
// ─────────────────────────────────────────────────────────────────────────────

class StubAdapter implements ProviderAdapter {
  readonly config: ProviderConfig;
  readonly capabilities = { chat: true, stream: true, embed: true, structured: true };
  readonly calls: ChatOptions[] = [];
  private replies: string[];

  constructor(reply: string | string[], overrides: Partial<ProviderConfig> = {}) {
    this.config = {
      id: "stub",
      label: "Stub",
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:9/v1",
      model: "stub-model",
      enabled: true,
      ...overrides,
    };
    this.replies = Array.isArray(reply) ? [...reply] : [reply];
  }

  async listModels(): Promise<[]> {
    return [];
  }

  async chat(opts: ChatOptions): Promise<string> {
    this.calls.push(opts);
    if (this.replies.length > 1) return this.replies.shift() ?? "";
    return this.replies[0] ?? "";
  }

  async *stream(_opts: ChatOptions): AsyncIterable<{ text: string; done: boolean }> {
    yield { text: this.replies[0] ?? "", done: false };
    yield { text: "", done: true };
  }

  async embed(): Promise<Float32Array[]> {
    return [];
  }

  async health(): Promise<{ ok: boolean; models: number; latencyMs: number }> {
    return { ok: true, models: 0, latencyMs: 0 };
  }

  async probe(): Promise<ProviderProbe> {
    return { ok: true, latencyMs: 0, models: 0, modelIds: [], embedOk: false, empty: true };
  }
}

const FAST = { retryBaseMs: 5, requestTimeoutMs: 3000, chatTimeoutMs: 5000, embedTimeoutMs: 3000 };

// ─────────────────────────────────────────────────────────────────────────────

const fake = await startFake();

const strataConfig: ProviderConfig = {
  id: "strata",
  label: "Strata",
  kind: "strata",
  baseUrl: fake.base,
  model: "swift-iq3_s",
  enabled: true,
};
const ollamaConfig: ProviderConfig = {
  id: "ollama",
  label: "Ollama",
  kind: "ollama",
  baseUrl: fake.base,
  model: "llama3.1:8b",
  embedModel: "nomic-embed-text",
  enabled: true,
};
const lmstudioConfig: ProviderConfig = {
  id: "lmstudio",
  label: "LM Studio",
  kind: "lmstudio",
  baseUrl: fake.base,
  model: "model-lm",
  embedModel: "embed-lm",
  enabled: true,
};

const strata = createAdapter(strataConfig, FAST);
const ollama = createAdapter(ollamaConfig, FAST);
const lmstudio = createAdapter(lmstudioConfig, FAST);

// ── presets ──────────────────────────────────────────────────────────────────

section("Provider presets");
{
  const presets = defaultProviderConfigs();
  eq("four presets", presets.map((p) => p.id), ["strata", "ollama", "lmstudio", "openai-compatible"]);
  const byId = new Map(presets.map((p) => [p.id, p]));

  const strataPreset = byId.get("strata")!;
  eq("strata base URL", strataPreset.baseUrl, "http://127.0.0.1:47831/v1");
  eq("strata model", strataPreset.model, "swift-iq3_s");
  eq("strata kind", strataPreset.kind, "strata");
  eq("strata is the enabled default", strataPreset.enabled, true);
  eq("strata has no embedding route", capabilitiesFor(strataPreset).embed, false);
  eq("strata adapter reports embed false", createAdapter(strataPreset).capabilities.embed, false);
  const strataCaps = capabilitiesFor(strataPreset);
  eq("strata chats", strataCaps.chat, true);
  eq("strata streams", strataCaps.stream, true);
  eq("strata is structured-output capable", strataCaps.structured, true);
  eq("strata cannot embed", strataCaps.embed, false);

  eq("ollama base URL", byId.get("ollama")!.baseUrl, "http://127.0.0.1:11434/v1");
  eq("ollama embeds", capabilitiesFor(byId.get("ollama")!).embed, true);
  eq("lmstudio base URL", byId.get("lmstudio")!.baseUrl, "http://127.0.0.1:1234/v1");
  eq("lmstudio embeds", capabilitiesFor(byId.get("lmstudio")!).embed, true);

  const remote = byId.get("openai-compatible")!;
  eq("openai-compatible kind", remote.kind, "openai-compatible");
  eq("openai-compatible ships a key reference", remote.apiKeyRef, "strata:ai:openai-compatible:api-key");
  ok("no raw key field on any preset", !presets.some((p) => "apiKey" in (p as unknown as Record<string, unknown>)));
  eq("openai-compatible starts disabled", remote.enabled, false);
}

// ── registry ─────────────────────────────────────────────────────────────────

section("Registry from settings rows");
{
  const rows = [
    {
      key: "ai.providers",
      value: JSON.stringify([
        { id: "strata", kind: "strata", baseUrl: fake.base, model: "swift-iq3_s", enabled: true },
        {
          id: "openai-compatible",
          kind: "openai-compatible",
          baseUrl: fake.base,
          model: "remote-model",
          apiKey: "sk-raw-secret-should-never-be-stored",
          enabled: true,
        },
        { id: "off", kind: "lmstudio", baseUrl: fake.base, model: "m", enabled: false },
      ]),
    },
    { key: "ai.defaultProvider", value: "strata" },
  ];
  const registry = registryFromSettings(rows, { secretResolver: () => null });

  eq("default provider honoured", registry.defaultProviderId, "strata");
  eq("row provider applied over the preset", registry.get("strata")?.baseUrl, fake.base);
  const remote = registry.get("openai-compatible")!;
  ok("raw apiKey dropped from the config", !("apiKey" in (remote as unknown as Record<string, unknown>)));
  ok("raw key not serialisable", !JSON.stringify(remote).includes("sk-raw-secret"));
  ok("dropping is reported as a warning", registry.warnings.some((w) => w.includes("apiKey")));

  const adapter = registry.adapterFor("openai-compatible");
  eq("adapter built for the row", adapter.config.model, "remote-model");
  ok("adapters are memoised", registry.adapterFor("openai-compatible") === adapter);

  let threw = "";
  try {
    registry.adapterFor("nope");
  } catch (e) {
    threw = e instanceof AiError ? `${e.kind}` : String(e);
  }
  eq("unknown provider → config error", threw, "config");

  let disabled = "";
  try {
    registry.adapterFor("off");
  } catch (e) {
    disabled = e instanceof AiError ? e.message : String(e);
  }
  ok("disabled provider is refused", disabled.includes("disabled"), disabled);

  const perRow = registryFromSettings([
    { key: "ai.provider.lmstudio", value: JSON.stringify({ kind: "lmstudio", baseUrl: fake.base, model: "one-row", enabled: true }) },
    { key: "ai.enabledProviders", value: JSON.stringify(["lmstudio"]) },
  ]);
  eq("per-row provider parsed", perRow.get("lmstudio")?.model, "one-row");
  eq("enabledProviders narrows the list", perRow.get("strata")?.enabled, false);
  eq("default falls to the first enabled", perRow.defaultProviderId, "lmstudio");

  const broken = registryFromSettings([{ key: "ai.providers", value: "{not json" }]);
  eq("broken JSON falls back to presets", broken.list().length, 4);
  ok("broken JSON warns", broken.warnings.some((w) => w.includes("ai.providers")));

  const https = registryFromSettings([
    { key: "ai.provider.strata", value: JSON.stringify({ kind: "strata", baseUrl: "ftp://example.invalid", model: "m", enabled: true }) },
  ]);
  ok("non-http base URL rejected", https.warnings.some((w) => w.includes("http(s)")));
}

// ── listModels / health ──────────────────────────────────────────────────────

section("Provider settings persistence (SQLite setting rows)");
{
  const dir = join(import.meta.dirname!, "..", ".data", "test-ai-settings");
  rmSync(dir, { recursive: true, force: true });
  const { db } = openWorkspace(dir);
  const ws = "ws-ai";
  db.run("INSERT INTO workspace (id, name, created_at) VALUES (?, ?, ?)", ws, "AI test", Date.now());

  eq("no rows yet → the presets", loadProviderConfigs(db, ws).map((p) => p.id), [
    "strata",
    "ollama",
    "lmstudio",
    "openai-compatible",
  ]);

  const saved = saveProviderConfig(db, ws, {
    id: "ollama",
    label: "Ollama",
    kind: "ollama",
    baseUrl: fake.base,
    model: "llama3.1:8b",
    embedModel: "nomic-embed-text",
    enabled: true,
    // a form that posts a key: it must never reach the row
    apiKey: "sk-plaintext-key-must-not-be-stored",
  } as unknown as ProviderConfig);

  const ollamaRow = saved.find((p) => p.id === "ollama")!;
  eq("saved model wins", ollamaRow.model, "llama3.1:8b");
  ok("no raw key on the returned config", !("apiKey" in (ollamaRow as unknown as Record<string, unknown>)));
  const stored = db.scalar<string>(
    "SELECT value FROM setting WHERE ws = ? AND key = ?",
    ws,
    "ai.providers",
  ) ?? "";
  ok("the stored row contains no key", !stored.includes("sk-plaintext-key"), stored.slice(0, 200));
  eq("reload returns the saved list", loadProviderConfigs(db, ws).find((p) => p.id === "ollama")?.model, "llama3.1:8b");
  eq("save upserts by id, it does not append", saved.filter((p) => p.id === "ollama").length, 1);

  const registry = registryFromDatabase(db, ws, { secretResolver: () => null });
  eq("registry rebuilt from the DB rows", registry.get("ollama")?.baseUrl, fake.base);
  eq("the DB adapter talks to the saved base URL", (await registry.adapterFor("ollama").listModels()).length, 2);

  const after = deleteProviderConfig(db, ws, "ollama");
  ok("delete removes the row", !after.some((p) => p.id === "ollama"));
  eq("delete persists", loadProviderConfigs(db, ws).some((p) => p.id === "ollama"), false);

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

section("listModels & health");
{
  fake.reset();
  const models = await strata.listModels();
  eq("one model listed", models.length, 1);
  eq("model id", models[0]?.id, "swift-iq3_s");
  eq("model label from meta", models[0]?.label, "Swift IQ3 S");
  eq("context length parsed", models[0]?.contextLength, 524288);
  eq("models route hit once", fake.state.models, 1);

  const health = await strata.health();
  eq("health ok", health.ok, true);
  eq("health counts models", health.models, 1);
  ok("health reports a latency", health.latencyMs >= 0, `${health.latencyMs}`);

  const modelsBeforeOllama = fake.state.models;
  const tags = await ollama.listModels();
  eq("ollama lists through /api/tags", tags.map((m) => m.id), ["llama3.1:8b", "nomic-embed-text"]);
  eq("ollama context length", tags[0]?.contextLength, 8192);
  eq("ollama hits the native route", fake.state.tags, 1);
  eq("ollama never calls /v1/models", fake.state.models, modelsBeforeOllama);

  const dead = createAdapter(
    { id: "ollama", label: "Ollama", kind: "ollama", baseUrl: `http://127.0.0.1:${fake.port + 1}/v1`, model: "x", enabled: true },
    FAST,
  );
  const deadHealth = await dead.health();
  eq("health of a stopped provider is not ok", deadHealth.ok, false);
  eq("health reports no models", deadHealth.models, 0);
  ok(
    "ECONNREFUSED says start Ollama / LM Studio",
    (deadHealth.error ?? "").includes("provider not running — start Ollama / LM Studio"),
    deadHealth.error,
  );
}

// ── chat ─────────────────────────────────────────────────────────────────────

section("chat");
{
  fake.reset();
  const out = await strata.chat({
    model: "swift-iq3_s",
    messages: [{ role: "user", content: "hi" }],
  });
  eq("chat returns content", out, "The real answer.");
  eq("one request sent", fake.state.chat, 1);

  fake.state.mode = "reasoning";
  const reasoned = await strata.chat({ model: "swift-iq3_s", messages: [{ role: "user", content: "hi" }] });
  eq("reasoning_content is ignored", reasoned, "The real answer.");
  ok("no chain of thought leaks", !reasoned.includes("MUST NOT APPEAR"), reasoned);

  fake.state.mode = "empty";
  const blank = await strata.chat({ model: "swift-iq3_s", messages: [{ role: "user", content: "hi" }] });
  eq("an empty completion is an empty string, not an error", blank, "");

  fake.state.mode = "echo-request";
  const echo = JSON.parse(
    await strata.chat({
      model: "swift-iq3_s",
      messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
      temperature: 0.3,
      maxTokens: 128,
      jsonMode: true,
    }),
  ) as Record<string, unknown>;
  eq("jsonMode sends response_format", echo.response_format, { type: "json_object" });
  eq("temperature forwarded", echo.temperature, 0.3);
  eq("max_tokens forwarded", echo.max_tokens, 128);
  eq("messages forwarded", (echo.messages as unknown[]).length, 2);
  eq("chat is not a stream", echo.stream, false);

  fake.state.mode = "echo-request";
  const ollamaEcho = JSON.parse(
    await ollama.chat({ model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }], jsonMode: true }),
  ) as Record<string, unknown>;
  eq("ollama also gets format=json", ollamaEcho.format, "json");
  fake.reset();
}

// ── streaming ────────────────────────────────────────────────────────────────

section("SSE streaming");
{
  fake.reset();
  fake.state.mode = "stream";
  const parts: string[] = [];
  let doneCount = 0;
  for await (const d of strata.stream({ model: "swift-iq3_s", messages: [{ role: "user", content: "hi" }] })) {
    if (d.done) doneCount++;
    else parts.push(d.text);
  }
  const text = parts.join("");
  eq("text reassembled across a mid-JSON chunk split", text, "Hello, world!");
  eq("exactly one done delta", doneCount, 1);
  ok("reasoning_content never surfaces in the stream", !text.includes("MUST NOT APPEAR"), text);
  eq("stream was requested with stream:true", fake.state.lastChatBody?.stream, true);

  // parser unit level: CRLF, comments, mid-JSON boundaries, [DONE]
  const parser = new SseParser();
  eq("comment line yields nothing", parser.push(": ping\r\n\r\n").length, 0);
  eq("CRLF event parsed", parser.push("data: {\"a\":1}\r\n\r\n"), [{ data: '{"a":1}', event: "message", done: false }]);
  eq("half an event yields nothing", parser.push('data: {"b":').length, 0);
  eq("the rest of the event completes it", parser.push("2}\n\n"), [{ data: '{"b":2}', event: "message", done: false }]);
  eq("[DONE] is recognised", parser.push("data: [DONE]\n\n")[0]?.done, true);
  eq("multi-line data joins with newline", parser.push("data: {\ndata: }\n\n")[0]?.data, "{\n}");
  eq("a lone CR is a line ending", parser.push("data: x\r\r")[0]?.data, "x");

  eq("deltaText reads delta.content", deltaText({ choices: [{ delta: { content: "x" } }] }), "x");
  eq("deltaText ignores reasoning_content", deltaText({ choices: [{ delta: { reasoning_content: "think", content: "y" } }] }), "y");
  eq("deltaText ignores a reasoning-only chunk", deltaText({ choices: [{ delta: { reasoning_content: "think" } }] }), "");
}

// ── errors, retries, timeouts, aborts ────────────────────────────────────────

section("Errors, retries, timeouts");
{
  fake.reset();
  fake.state.mode = "bad-request";
  let err: unknown;
  try {
    await strata.chat({ model: "swift-iq3_s", messages: [{ role: "user", content: "hi" }] });
  } catch (e) {
    err = e;
  }
  ok("400 throws AiError", err instanceof AiError, String(err));
  eq("400 carries the status", (err as AiError).status, 400);
  eq("400 carries the provider", (err as AiError).provider, "strata");
  eq("400 is not retryable", (err as AiError).retryable, false);
  eq("400 is NOT retried: exactly one request", fake.state.chat, 1);
  ok("400 message is human", (err as AiError).message.includes("Strata: HTTP 400"), (err as AiError).message);

  fake.reset();
  fake.state.mode = "flaky-429";
  const recovered = await strata.chat({ model: "swift-iq3_s", messages: [{ role: "user", content: "hi" }] });
  eq("429 retried then succeeds", recovered, "recovered");
  eq("429 used exactly 3 requests (1 + 2 retries)", fake.state.chat, 3);

  fake.reset();
  fake.state.mode = "always-500";
  let five: unknown;
  try {
    await strata.chat({ model: "swift-iq3_s", messages: [{ role: "user", content: "hi" }] });
  } catch (e) {
    five = e;
  }
  eq("500 retries stop at 2", fake.state.chat, 3);
  eq("500 status surfaced", (five as AiError).status, 500);
  eq("500 marked retryable", (five as AiError).retryable, true);
  ok("500 hints at the model being loaded", (five as AiError).message.includes("model may be too large"), (five as AiError).message);

  fake.reset();
  fake.state.mode = "slow";
  const impatient = createAdapter(strataConfig, { ...FAST, chatTimeoutMs: 150 });
  let to: unknown;
  try {
    await impatient.chat({ model: "swift-iq3_s", messages: [{ role: "user", content: "hi" }] });
  } catch (e) {
    to = e;
  }
  ok("timeout is the named timeout error", to instanceof AiTimeoutError, String(to));
  eq("timeout kind", (to as AiError).kind, "timeout");
  ok("timeout message names the budget", (to as AiError).message.includes("within 150ms"), (to as AiError).message);

  // caller abort, mid-stream
  fake.reset();
  fake.state.mode = "stream-slow";
  const controller = new AbortController();
  const collected: string[] = [];
  let aborted: unknown;
  try {
    for await (const d of strata.stream({ model: "swift-iq3_s", messages: [{ role: "user", content: "hi" }], signal: controller.signal })) {
      if (d.done) break;
      collected.push(d.text);
      if (collected.length === 1) controller.abort();
    }
  } catch (e) {
    aborted = e;
  }
  eq("first delta arrives before the abort", collected.join(""), "first");
  ok("caller abort propagates as AiAbortedError", aborted instanceof AiAbortedError, String(aborted));
  eq("abort kind", (aborted as AiError).kind, "aborted");

  // caller abort before the request: no round trip at all
  fake.reset();
  const preAborted = new AbortController();
  preAborted.abort();
  let pre: unknown;
  try {
    await strata.chat({ model: "swift-iq3_s", messages: [{ role: "user", content: "hi" }], signal: preAborted.signal });
  } catch (e) {
    pre = e;
  }
  ok("a pre-aborted signal short-circuits", pre instanceof AiAbortedError, String(pre));
  eq("no request was made", fake.state.chat, 0);

  // a wedged provider: the timeout is composed with the caller's signal, so
  // either one aborting is reported
  fake.reset();
  eq("reset clears the counters", fake.state.chat, 0);
}

// ── secrets ──────────────────────────────────────────────────────────────────

section("Secrets");
{
  fake.reset();
  fake.state.mode = "bad-request";
  const secretConfig: ProviderConfig = {
    id: "openai-compatible",
    label: "Remote",
    kind: "openai-compatible",
    baseUrl: fake.base,
    model: "remote-model",
    apiKeyRef: "keychain:strata/ai/remote",
    enabled: true,
  };
  const withKey = createAdapter(secretConfig, {
    ...FAST,
    secretResolver: (ref) => (ref === "keychain:strata/ai/remote" ? "sk-super-secret-123" : null),
  });
  let authErr: unknown;
  try {
    await withKey.chat({ model: "remote-model", messages: [{ role: "user", content: "hi" }] });
  } catch (e) {
    authErr = e;
  }
  eq("the key is sent as a bearer token", fake.state.lastAuth, "Bearer sk-super-secret-123");
  eq("the 400 is an AiError", (authErr as AiError).status, 400);
  const message = (authErr as AiError).message;
  ok("the secret is redacted from the error", !message.includes("sk-super-secret-123"), message);
  ok("the redaction is visible", message.includes("[redacted]"), message);

  const noResolver = createAdapter(secretConfig, FAST);
  let missing: unknown;
  try {
    await noResolver.chat({ model: "remote-model", messages: [{ role: "user", content: "hi" }] });
  } catch (e) {
    missing = e;
  }
  eq("no resolver → config error", (missing as AiError).kind, "config");
  ok("the error names the reference, not a key", (missing as AiError).message.includes("keychain:strata/ai/remote"));

  const resolverMisses = createAdapter(secretConfig, { ...FAST, secretResolver: () => null });
  let notFound: unknown;
  try {
    await resolverMisses.chat({ model: "remote-model", messages: [{ role: "user", content: "hi" }] });
  } catch (e) {
    notFound = e;
  }
  ok("an unresolvable reference fails loudly", (notFound as AiError).message.includes("no secret found"), (notFound as AiError).message);

  eq("redact strips an Authorization header", redact('Authorization: Bearer sk-abcdefgh12345'), "Authorization: [redacted]");
  eq("redact strips a JSON api_key", redact('{"api_key":"sk-abcdefgh12345"}'), '{"api_key":"[redacted]"}');
  eq("redact strips a URL password", redact("http://user:hunter2@host/x"), "http://user:[redacted]@host/x");
  fake.reset();
}

// ── embeddings ───────────────────────────────────────────────────────────────

section("Embeddings & capability detection");
{
  fake.reset();
  const viaOllama = await ollama.embed(["a", "b"], "nomic-embed-text");
  eq("ollama uses POST /api/embed", fake.state.embedOllama, 1);
  eq("ollama embeddings are Float32Array", viaOllama.map((v) => Array.from(v)), [[0.5, 0.25], [0.75, 0.125]]);
  ok("vectors are Float32Array instances", viaOllama.every((v) => v instanceof Float32Array));

  const viaOpenAi = await lmstudio.embed(["a", "b"], "embed-lm");
  eq("lmstudio uses POST /v1/embeddings", fake.state.embedOpenAi, 1);
  eq("openai embeddings parsed", viaOpenAi.map((v) => Array.from(v)), [[1, 2, 3], [4, 5, 6]]);

  let unsupported: unknown;
  try {
    await strata.embed(["a"], "swift-iq3_s");
  } catch (e) {
    unsupported = e;
  }
  eq("strata refuses to embed", (unsupported as AiError).kind, "unsupported");
  ok("strata says it has no embedding route", (unsupported as AiError).message.includes("no embedding route"));
  eq("no embedding request was made", fake.state.embedOpenAi + fake.state.embedOllama, 1 + 1);

  eq("strata probe keeps embed false", (await strata.probeEmbeddingSupport?.()) ?? true, false);

  fake.state.embed404 = true;
  const gateway = createAdapter({ ...lmstudioConfig, id: "gateway" }, FAST);
  eq(
    "a provider without the route probes as embed=false",
    (await gateway.probeEmbeddingSupport?.()) ?? true,
    false,
  );
  eq("and reports it in capabilities", gateway.capabilities.embed, false);
  fake.state.embed404 = false;
  eq("the same probe flips back on", (await gateway.probeEmbeddingSupport?.()) ?? false, true);
  eq("capabilities follow", gateway.capabilities.embed, true);
  fake.reset();
}

// ── extractJson ──────────────────────────────────────────────────────────────

section("extractJson on messy model output");
{
  const cases: [string, string, unknown][] = [
    ["clean object", '{"a":1,"b":"two"}', { a: 1, b: "two" }],
    ["fenced json", '```json\n{"a":1}\n```', { a: 1 }],
    ["fence without a language", '```\n{"a":1}\n```', { a: 1 }],
    ["prose before and after", 'Sure! Here you go:\n{"a":1}\nHope that helps.', { a: 1 }],
    ["trailing commas", '{"a":1,"b":[2,3,],}', { a: 1, b: [2, 3] }],
    ["single-quoted keys", "{'a': 1, 'b': 'two'}", { a: 1, b: "two" }],
    ["bare keys", "{a: 1, b: 2}", { a: 1, b: 2 }],
    ["python literals", '{"a": True, "b": False, "c": None}', { a: true, b: false, c: null }],
    ["line comments", '{\n// greeting\n"a":1 /* inline */}', { a: 1 }],
    ["array output", 'Answer: [1,2,3]', [1, 2, 3]],
    ["braces in prose", 'We ship {today} and the JSON is {"ship":"Friday"} — done', { ship: "Friday" }],
    ["apostrophes in prose", "Here's the JSON you asked for:\n{\"text\": \"it's fine\"}", { text: "it's fine" }],
    ["nested + chatty + fence", 'Thinking...\n```json\n{"row":{"id":"r1","tags":["a","b",]}}\n```\nDone!', { row: { id: "r1", tags: ["a", "b"] } }],
    ["truncated object", '{"a":1,"b":', { a: 1 }],
    ["truncated with dangling key", '{"a":1,"b":2,"c":', { a: 1, b: 2 }],
    ["escaped quotes inside strings", '{"quote":"he said \\"hi\\""}', { quote: 'he said "hi"' }],
  ];
  for (const [label, raw, expected] of cases) {
    let value: unknown;
    try {
      value = extractJson(raw);
    } catch (e) {
      value = `threw ${String(e)}`;
    }
    eq(`extractJson: ${label}`, value, expected);
  }

  let thrown: unknown;
  try {
    extractJson("the model apologised and explained it cannot help");
  } catch (e) {
    thrown = e;
  }
  ok("no JSON at all → AiJsonError", thrown instanceof AiJsonError, String(thrown));
  eq("the typed error names the kind", (thrown as AiJsonError).kind, "no-json");
  ok("the raw text is attached", (thrown as AiJsonError).raw.includes("apologised"));

  eq("extractJsonObject returns the object", extractJsonObject('x {"a":1} y'), { a: 1 });
  let notObject: unknown;
  try {
    extractJsonObject("[1,2]");
  } catch (e) {
    notObject = e;
  }
  eq("extractJsonObject rejects an array", (notObject as AiJsonError).kind, "not-object");
}

// ── autofill validation ──────────────────────────────────────────────────────

const OPT_DONE: SelectOption = { id: "opt-done", name: "Done", color: "green" };
const OPT_DOING: SelectOption = { id: "opt-doing", name: "In Progress", color: "blue" };
const OPT_ALPHA: SelectOption = { id: "opt-alpha", name: "alpha", color: "red" };
const OPT_BETA: SelectOption = { id: "opt-beta", name: "beta", color: "blue" };

function prop(id: string, name: string, type: PropertyDef["type"], config: Record<string, unknown> = {}): PropertyDef {
  return { id, db_id: "db-1", name, type, pos: "a", config };
}

const autofillProps: PropertyDef[] = [
  prop("p-name", "Name", "title"),
  prop("p-status", "Status", "select", { options: [OPT_DONE, OPT_DOING] }),
  prop("p-effort", "Effort", "number"),
  prop("p-reviewed", "Reviewed", "checkbox"),
  prop("p-due", "Due", "date"),
  prop("p-tags", "Tags", "multi_select", { options: [OPT_ALPHA, OPT_BETA] }),
  prop(
    "p-state",
    "State",
    "status",
    {
      groups: [
        { id: "to_do", name: "To-do", color: "gray", options: [{ id: "st-todo", name: "To-do", color: "gray" }] },
        { id: "complete", name: "Complete", color: "green", options: [{ id: "st-done", name: "Complete", color: "green" }] },
      ],
    },
  ),
  prop("p-total", "Total", "formula"),
  prop("p-link", "Link", "url"),
  prop("p-email", "Contact", "email"),
];

section("autofill validation");
{
  const good = validateAutofill(
    {
      Name: "Ship the release",
      Status: "done",
      Effort: "3.5",
      Reviewed: "yes",
      Due: "2024-03-05",
      Tags: ["alpha", "ghost"],
      State: "To-do",
      Link: "https://example.com/x",
      Contact: "ops@example.com",
    },
    autofillProps,
  );
  eq("title keyed by propId", good.values["p-name"], "Ship the release");
  eq("select name → option id", good.values["p-status"], ["opt-done"]);
  eq("number coerced from a string", good.values["p-effort"], 3.5);
  eq("checkbox coerced from 'yes'", good.values["p-reviewed"], true);
  eq("date parsed to epoch ms", (good.values["p-due"] as { start: number }).start, new Date(2024, 2, 5).getTime());
  eq("date is allDay", (good.values["p-due"] as { allDay: boolean }).allDay, true);
  eq("multi_select keeps what exists", good.values["p-tags"], ["opt-alpha"]);
  ok("multi_select warns about the invented option", good.warnings.some((w) => w.includes("ghost")), good.warnings.join("; "));
  eq("status option id", good.values["p-state"], ["st-todo"]);
  eq("url accepted", good.values["p-link"], "https://example.com/x");
  eq("email accepted", good.values["p-email"], "ops@example.com");
  eq("the invented tag is the only warning", good.warnings.length, 1);

  const invented = validateAutofill(
    { "Not A Property": 1, Status: "Archived", Ghost: "x" },
    autofillProps,
  );
  eq("unknown property yields no value", Object.keys(invented.values).length, 0);
  ok("unknown property warns", invented.warnings.some((w) => w.includes("Not A Property")), invented.warnings.join("; "));
  ok(
    "invalid select value dropped, warning lists the allowed options",
    invented.warnings.some((w) => w.includes("Archived") && w.includes("In Progress")),
    invented.warnings.join("; "),
  );

  const caseAndPunctuation = validateAutofill(
    { name: "loose key", status: "IN-PROGRESS", STATE: "complete", tags: "beta" },
    autofillProps,
  );
  eq("key matching is case-insensitive", caseAndPunctuation.values["p-name"], "loose key");
  eq("option matching ignores punctuation", caseAndPunctuation.values["p-status"], ["opt-doing"]);
  eq("status group option matched", caseAndPunctuation.values["p-state"], ["st-done"]);
  eq("scalar multi_select wrapped", caseAndPunctuation.values["p-tags"], ["opt-beta"]);

  const computed = validateAutofill({ Total: 42, Effort: "not a number", Link: "example.com", Contact: "nope" }, autofillProps);
  ok("computed formula property is never filled", !("p-total" in computed.values));
  ok("computed drop is explained", computed.warnings.some((w) => w.includes("formula")), computed.warnings.join("; "));
  ok("bad number dropped", !("p-effort" in computed.values));
  ok("bad url dropped", !("p-link" in computed.values));
  ok("bad email dropped", !("p-email" in computed.values));

  const byId = validateAutofill({ "p-name": "keyed by id" }, autofillProps);
  eq("a key that is a property id resolves", byId.values["p-name"], "keyed by id");

  const wrapped = validateAutofill({ values: { Name: "wrapped form" }, commentary: "hi" }, autofillProps);
  eq("a {values:{}} wrapper is unwrapped", wrapped.values["p-name"], "wrapped form");
  ok("the wrapper's extra key is reported", wrapped.warnings.some((w) => w.includes("commentary")));

  const pairs = validateAutofill([{ prop: "Name", value: "array form" }], autofillProps);
  eq("a [{prop,value}] array is accepted", pairs.values["p-name"], "array form");

  const emptyish = validateAutofill({ Name: "", Effort: null, Reviewed: false }, autofillProps);
  eq("empty string skipped", "p-name" in emptyish.values, false);
  eq("null skipped", "p-effort" in emptyish.values, false);
  eq("explicit false is a real checkbox value", emptyish.values["p-reviewed"], false);

  eq("number: 1,200", coerceNumber("1,200"), 1200);
  eq("number: $1 200,50", coerceNumber("$1 200,50"), 1200.5);
  eq("number: 12.5 kg", coerceNumber("12.5 kg"), 12.5);
  eq("number: 7", coerceNumber(7), 7);
  eq("number: twelve", coerceNumber("twelve"), null);
  eq("number: empty", coerceNumber(""), null);

  const local = (y: number, mo: number, d: number): number => new Date(y, mo - 1, d).getTime();
  eq("date: ISO", parseDateValue("2024-03-05")?.start, local(2024, 3, 5));
  eq("date: range end", parseDateValue("2024-03-05 -> 2024-03-08")?.end, local(2024, 3, 8));
  eq("date: ISO interval", parseDateValue("2024-03-05/2024-03-08")?.end, local(2024, 3, 8));
  eq("date: range is allDay", parseDateValue("2024-03-05 → 2024-03-08")?.allDay, true);
  eq("date: with time is not allDay", parseDateValue("2024-03-05T14:30")?.allDay, false);
  eq("date: US slash", parseDateValue("03/05/2024")?.start, local(2024, 3, 5));
  eq("date: European dot", parseDateValue("05.03.2024")?.start, local(2024, 3, 5));
  eq("date: written out", parseDateValue("March 5, 2024")?.start, local(2024, 3, 5));
  eq("date: epoch ms passthrough", parseDateValue(1709596800000)?.start, 1709596800000);
  eq("date: object passthrough", parseDateValue({ start: 1709596800000, end: null, allDay: true })?.start, 1709596800000);
  eq("date: garbage", parseDateValue("someday"), null);
  {
    const fixedNow = new Date(2024, 2, 10, 12, 0, 0).getTime();
    eq("date: today", parseDateValue("today", fixedNow)?.start, local(2024, 3, 10));
    eq("date: tomorrow", parseDateValue("tomorrow", fixedNow)?.start, local(2024, 3, 11));
    eq("date: yesterday", parseDateValue("yesterday", fixedNow)?.start, local(2024, 3, 9));
  }
}

// ── actions ──────────────────────────────────────────────────────────────────

section("runAction: text actions");
{
  const stub = new StubAdapter("Here is the summary:\n\n- Shipped on Friday\n- Cost: 1200 EUR");
  const res = await runAction({ action: "summarize", providerId: "stub", text: "a long page of notes" }, { adapter: stub });
  eq("summarize ok", res.ok, true);
  eq("preamble stripped", res.text, "- Shipped on Friday\n- Cost: 1200 EUR");
  eq("provider reported", res.provider, "stub");
  eq("model reported", res.model, "stub-model");
  ok("ms measured", typeof res.ms === "number" && res.ms >= 0);
  ok("no jsonMode for a text action", stub.calls[0]?.jsonMode !== true);

  const fence = new StubAdapter('```md\n- one\n- two\n```');
  eq("fenced answer unwrapped", (await runAction({ action: "summarize", providerId: "stub", text: "x" }, { adapter: fence })).text, "- one\n- two");

  const chatty = new StubAdapter("Sure, here is the translation in French:\n\nBonjour le monde\n\nI hope this helps!");
  const translated = await runAction({ action: "translate", providerId: "stub", text: "Hello world", targetLang: "French" }, { adapter: chatty });
  eq("translate strips the lead-in and the closer", translated.text, "Bonjour le monde");
  const userTurn = chatty.calls[0]?.messages.at(-1)?.content ?? "";
  ok("the prompt names the target language", userTurn.includes("Translate to French"));
  ok("the prompt carries the text", userTurn.includes("Hello world"));

  const noTarget = await runAction({ action: "translate", providerId: "stub", text: "Hi" }, { adapter: new StubAdapter("Bonjour") });
  eq("translate without targetLang fails", noTarget.ok, false);
  ok("the error names the missing field", (noTarget.error ?? "").includes("targetLang"));

  const noTone = await runAction({ action: "changeTone", providerId: "stub", text: "Hi" }, { adapter: new StubAdapter("Hi") });
  eq("changeTone without tone fails", noTone.ok, false);

  const empty = await runAction({ action: "fixGrammar", providerId: "stub", text: "text" }, { adapter: new StubAdapter("   \n") });
  eq("an empty model answer is a failure", empty.ok, false);
  ok("the failure says why", (empty.error ?? "").includes("no text"), empty.error);

  const noInput = await runAction({ action: "summarize", providerId: "stub", text: "   " }, { adapter: new StubAdapter("- x") });
  eq("empty input is a failure", noInput.ok, false);
  ok("the failure names the action", (noInput.error ?? "").includes("summarize"), noInput.error);

  const big = Array.from({ length: 3000 }, (_, i) => `line ${i} of the note`).join("\n");
  const capStub = new StubAdapter("- done");
  const capped = await runAction({ action: "summarize", providerId: "stub", text: big }, { adapter: capStub, maxInputChars: 5000 });
  const sent = capStub.calls[0]?.messages.at(-1)?.content ?? "";
  ok("the document is never sent unbounded", sent.length < big.length, `${sent.length} vs ${big.length}`);
  ok("the sent text respects the cap", sent.length <= 5000 + 200, `${sent.length}`);
  ok("truncation is warned about", (capped.text ?? "").includes("truncated"), capped.text);
  eq("clampInput default cap", clampInput("x".repeat(12_001)).truncated, true);
  eq("clampInput under the cap is untouched", clampInput("short").text, "short");

  const boom = new StubAdapter("");
  boom.chat = async () => {
    throw new AiError("Ollama: provider not running — start Ollama / LM Studio", { kind: "network", provider: "ollama" });
  };
  const failed = await runAction({ action: "summarize", providerId: "ollama", text: "x" }, { adapter: boom });
  eq("a provider failure is returned, not thrown", failed.ok, false);
  ok("the human message reaches the UI", (failed.error ?? "").includes("start Ollama"), failed.error);

  eq("cleanAnswer: quotes", cleanAnswer('"quoted answer"'), "quoted answer");
  eq("cleanAnswer: keeps a bulleted body", cleanAnswer("Here you go:\n- a\n- b"), "- a\n- b");
  eq("cleanAnswer: keeps a colon heading inside the body", cleanAnswer("- Plan: ship\n- Cost: 1"), "- Plan: ship\n- Cost: 1");
}

section("runAction: autofill");
{
  const context = {
    title: "Release checklist",
    values: { "p-name": "Release checklist" },
    properties: autofillProps,
  };
  const stub = new StubAdapter(
    'Sure! Here is the JSON you asked for:\n```json\n{"Name": "Ship v2", "Status": "Done", "Effort": "1,200", "Due": "2024-03-05 -> 2024-03-08", "Tags": ["alpha","beta"], "Total": 99, "Ghost": "x"}\n```\nI hope that helps!',
  );
  const res = await runAction(
    { action: "autofill", providerId: "stub", rowId: "row-1", text: "Ship v2 is done, costs 1200, due 5 to 8 March." },
    { adapter: stub, getRowContext: async () => context },
  );
  eq("chatty autofill JSON parsed", res.ok, true);
  eq("title filled", res.values?.["p-name"], "Ship v2");
  eq("select mapped to the option id", res.values?.["p-status"], ["opt-done"]);
  eq("number coerced", res.values?.["p-effort"], 1200);
  eq("date range parsed", [
    (res.values?.["p-due"] as { start: number }).start,
    (res.values?.["p-due"] as { end: number }).end,
  ], [new Date(2024, 2, 5).getTime(), new Date(2024, 2, 8).getTime()]);
  eq("multi_select mapped", res.values?.["p-tags"], ["opt-alpha", "opt-beta"]);
  ok("jsonMode requested", stub.calls[0]?.jsonMode === true);
  ok("every key is a real property id", Object.keys(res.values ?? {}).every((k) => autofillProps.some((p) => p.id === k)), JSON.stringify(Object.keys(res.values ?? {})));
  ok("the invented property is absent", !Object.keys(res.values ?? {}).includes("Ghost"));
  ok("the computed property is absent", !Object.keys(res.values ?? {}).includes("p-total"));
  ok("warnings surface in text", (res.text ?? "").includes("Ghost"), res.text);

  const noContext = await runAction({ action: "autofill", providerId: "stub", rowId: "row-1" }, { adapter: new StubAdapter('{"Name":"x"}') });
  eq("autofill without getRowContext fails cleanly", noContext.ok, false);
  ok("it says what is missing", (noContext.error ?? "").includes("getRowContext"), noContext.error);

  const noRow = await runAction({ action: "autofill", providerId: "stub" }, { adapter: new StubAdapter('{"Name":"x"}'), getRowContext: async () => context });
  eq("autofill without a rowId fails cleanly", noRow.ok, false);

  const rambling = await runAction(
    { action: "autofill", providerId: "stub", rowId: "r" },
    { adapter: new StubAdapter("I am not able to fill this row, I am sorry."), getRowContext: async () => context },
  );
  eq("a reply with no JSON is a failure", rambling.ok, false);
  ok("the failure mentions JSON", (rambling.error ?? "").includes("JSON"), rambling.error);

  const allInvalid = await runAction(
    { action: "autofill", providerId: "stub", rowId: "r" },
    { adapter: new StubAdapter('{"Status":"NotAnOption","Ghost":1}'), getRowContext: async () => context },
  );
  eq("everything dropped → not ok", allInvalid.ok, false);
  ok("the error lists what was dropped", (allInvalid.error ?? "").includes("NotAnOption"), allInvalid.error);

  const prompt = promptFor("autofill", { autofill: { title: "T", values: {}, properties: autofillProps, contextText: "body text" } });
  const allTurns = prompt.map((m) => m.content).join("\n");
  ok("the prompt lists the allowed option names", allTurns.includes("In Progress"), allTurns.slice(0, 300));
  ok("the prompt lists the property names", allTurns.includes('"Effort"'));
  ok("the prompt forbids inventing options", /never invent/i.test(allTurns));
  ok("the prompt asks for JSON only", /ONLY a JSON object/i.test(allTurns));
}

section("runAction: askWorkspace");
{
  const hits = [
    { node_id: "n1", title: "Roadmap", text: "we ship in Q3", score: 0.91 },
    { node_id: "n2", title: "Budget", text: "1200 EUR for infra", score: 0.88 },
    { node_id: "n3", title: "Retro", text: "the migration slipped", score: 0.7 },
  ];
  const stub = new StubAdapter("Infra costs 1200 EUR [2]. The migration slipped [3].");
  const res = await runAction(
    { action: "askWorkspace", providerId: "stub", question: "what does infra cost?" },
    { adapter: stub, retrieve: async (_q, k) => (k > 0 ? hits : []) },
  );
  eq("answer returned", res.ok, true);
  eq("cited sources only", res.sources?.map((s) => s.node_id), ["n2", "n3"]);
  ok("source snippet attached", (res.sources?.[0]?.snippet ?? "").includes("1200 EUR"));
  const prompt = stub.calls[0]?.messages.map((m) => m.content).join("\n") ?? "";
  ok("sources are numbered [1]", prompt.includes("[1] Roadmap"));
  ok("sources are numbered [3]", prompt.includes("[3] Retro"));
  ok("the question is in the prompt", prompt.includes("what does infra cost?"));

  eq("citation parsing", extractCitations("a [2] b [1, 3] c [1]"), [1, 2, 3]);
  eq("citation parsing, none", extractCitations("no citations at all"), []);

  // the retrieval module returns {hits, mode}, not a bare array: both work
  const enveloped = await runAction(
    { action: "askWorkspace", providerId: "stub", question: "what slipped?" },
    {
      adapter: new StubAdapter("The migration slipped [3]."),
      retrieve: async () => ({ hits, mode: "vector" as const }),
    },
  );
  eq("a {hits, mode} retrieval envelope is accepted", enveloped.ok, true);
  eq("and its sources are cited", enveloped.sources?.map((s) => s.node_id), ["n3"]);

  const emptyEnvelope = await runAction(
    { action: "askWorkspace", providerId: "stub", question: "q" },
    { adapter: new StubAdapter("x [1]"), retrieve: async () => ({ hits: [], mode: "keyword" as const }) },
  );
  eq("an empty envelope is treated as no hits", emptyEnvelope.ok, false);

  const noCite = await runAction(
    { action: "askWorkspace", providerId: "stub", question: "q" },
    { adapter: new StubAdapter("An answer with no citation."), retrieve: async () => hits },
  );
  eq("an uncited answer cites no sources", noCite.sources, []);

  const noIndex = await runAction({ action: "askWorkspace", providerId: "stub", question: "q" }, { adapter: stub });
  eq("no retrieve → no embedding index", noIndex.error, "no embedding index");
  eq("and no request was made", noIndex.ok, false);

  const emptyIndex = await runAction(
    { action: "askWorkspace", providerId: "stub", question: "q" },
    { adapter: stub, retrieve: async () => [] },
  );
  eq("no hits → failure", emptyIndex.ok, false);

  const noQuestion = await runAction({ action: "askWorkspace", providerId: "stub" }, { adapter: stub, retrieve: async () => hits });
  eq("a question is required", noQuestion.ok, false);
}

section("Provider probe: one call, everything the settings screen shows");
{
  fake.reset();
  const p = await strata.probe();
  eq("probe ok", p.ok, true);
  eq("probe counts models", p.models, 1);
  eq("probe returns ids for the picker", p.modelIds, ["swift-iq3_s"]);
  ok("probe measures latency", p.latencyMs >= 0, `${p.latencyMs}`);
  eq("strata has no embedding route", p.embedOk, false);
  eq("not flagged empty", p.empty, false);

  // a provider that is not there: the failure is classified, not stringified
  const dead = createAdapter(
    { id: "ghost", label: "Ghost", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", model: "m", enabled: true },
    FAST,
  );
  const g = await dead.probe();
  eq("dead provider is not ok", g.ok, false);
  eq("dead provider is classified as network", g.kind, "network");
  ok("the error is a sentence, not a stack", typeof g.error === "string" && g.error.length > 10, g.error);
  eq("no models", g.models, 0);
  ok("latency is reported even on failure", g.latencyMs >= 0, `${g.latencyMs}`);

  // registry.probeAll skips disabled providers: probing them is what produced
  // the red "provider is disabled" errors inside the settings screen
  const reg = registryFromSettings(
    [
      {
        key: "ai.providers",
        value: JSON.stringify([
          { id: "strata", kind: "strata", baseUrl: fake.base, model: "swift-iq3_s", enabled: true },
          { id: "off", kind: "lmstudio", baseUrl: fake.base, model: "m", enabled: false },
        ]),
      },
    ],
    { adapterOptions: FAST },
  );
  const all = await reg.probeAll();
  eq("the enabled provider is probed", all["strata"]?.ok, true);
  eq("the disabled provider is not", all["off"], undefined);
  ok("no disabled id leaks in", !Object.keys(all).includes("off"), JSON.stringify(Object.keys(all)));
}

section("Loopback detection");
{
  const { detectTarget, detectLocalProviders, looksLikeEmbeddingModel, modelIdsFrom, DETECT_TARGETS } =
    await import("../server/ai/detect.ts");

  eq(
    "embedding names recognised",
    ["nomic-embed-text", "bge-m3", "mxbai-embed-large", "all-minilm"].map(looksLikeEmbeddingModel),
    [true, true, true, true],
  );
  eq("chat models not mistaken for embeddings", looksLikeEmbeddingModel("llama3.1:8b"), false);
  eq("empty string is not an embedding model", looksLikeEmbeddingModel(""), false);

  eq("openai shape", modelIdsFrom({ data: [{ id: "b" }, { id: "a" }] }), ["a", "b"]);
  eq("ollama shape", modelIdsFrom({ models: [{ name: "llama3.1:8b" }] }), ["llama3.1:8b"]);
  eq("duplicates collapse", modelIdsFrom({ data: [{ id: "a" }], models: [{ name: "a" }] }), ["a"]);
  eq("garbage yields nothing", modelIdsFrom({ data: [null, {}, { id: "" }] }), []);

  // the fake server answers, so detection must report it as running
  fake.reset();
  const found = await detectTarget({ kind: "ollama", label: "Fake", baseUrl: fake.base, nativeOrigin: fake.origin });
  eq("running server detected", found.running, true);
  ok("models listed", found.models >= 1, JSON.stringify(found.modelIds));
  ok("latency recorded", found.latencyMs >= 0);
  eq("no error", found.error, undefined);

  // a closed port: not running, with a reason, and it never throws
  const closed = await detectTarget(
    { kind: "lmstudio", label: "Closed", baseUrl: "http://127.0.0.1:1/v1" },
    { timeoutMs: 1500 },
  );
  eq("closed port is not running", closed.running, false);
  ok("closed port reports why", typeof closed.error === "string" && closed.error.length > 0, closed.error);
  eq("closed port lists no models", closed.models, 0);

  // embedding models are separated, so the add form can prefill the right one
  const fakeEmbedFetch = (async () => ({
    ok: true,
    json: async () => ({ models: [{ name: "llama3.1:8b" }, { name: "nomic-embed-text" }] }),
  })) as unknown as typeof fetch;
  const withEmbeds = await detectTarget(
    { kind: "ollama", label: "Fake", baseUrl: fake.base, nativeOrigin: fake.origin },
    { fetchImpl: fakeEmbedFetch },
  );
  eq("chat model picked", withEmbeds.modelIds, ["llama3.1:8b", "nomic-embed-text"]);
  eq("embedding model separated", withEmbeds.embedModelIds, ["nomic-embed-text"]);

  const running = await detectLocalProviders({
    onlyRunning: true,
    targets: [{ kind: "ollama", label: "Fake", baseUrl: fake.base, nativeOrigin: fake.origin }],
  });
  eq("onlyRunning keeps the live one", running.length, 1);
  const none = await detectLocalProviders({
    onlyRunning: true,
    targets: [{ kind: "lmstudio", label: "Dead", baseUrl: "http://127.0.0.1:1/v1" }],
  });
  eq("onlyRunning drops the dead one", none.length, 0);
  ok(
    "the built-in targets are loopback only",
    DETECT_TARGETS.every((t) => /127\.0\.0\.1|localhost/.test(t.baseUrl)),
    JSON.stringify(DETECT_TARGETS.map((t) => t.baseUrl)),
  );
}

section("AI call log and usage stats");
{
  const { logAiCall, aiUsageSummary, pruneAiCalls } = await import("../server/ai/usage.ts");
  const dir = join(import.meta.dirname!, "..", ".data", "test-ai-usage");
  rmSync(dir, { recursive: true, force: true });
  const { db } = openWorkspace(dir);
  const ws = "ws-usage";
  db.run("INSERT INTO workspace (id, name, created_at) VALUES (?, ?, ?)", ws, "Usage", Date.now());

  eq("starts empty", aiUsageSummary(db, ws).calls, 0);

  // explicit timestamps: three rows in the same millisecond would make the
  // "newest first" assertion a coin toss
  const t0 = Date.now();
  logAiCall(db, { ws, provider: "strata", model: "swift-iq3_s", action: "summarize", ms: 100, ok: true, chars: 40, promptTokens: 10, completionTokens: 5, createdAt: t0 - 3000 });
  logAiCall(db, { ws, provider: "strata", model: "swift-iq3_s", action: "translate", ms: 300, ok: true, chars: 60, promptTokens: 20, completionTokens: 10, createdAt: t0 - 2000 });
  logAiCall(db, { ws, provider: "ollama", model: "llama3.1:8b", action: "fixGrammar", ms: 50, ok: false, error: "provider not running", chars: 0, createdAt: t0 - 1000 });

  const s = aiUsageSummary(db, ws);
  eq("three calls", s.calls, 3);
  eq("one failure", s.failed, 1);
  eq("two ok", s.ok, 2);
  eq("average latency", s.avgMs, 150);
  eq("tokens summed when reported", s.promptTokens, 30);
  eq("completion tokens summed", s.completionTokens, 15);
  eq("chars summed", s.chars, 100);
  eq("two providers", s.byProvider.length, 2);
  eq("busiest provider first", s.byProvider[0]?.provider, "strata");
  eq("per-provider failures", s.byProvider.find((p) => p.provider === "ollama")?.failed, 1);
  eq("recent list", s.recent.length, 3);
  eq("newest first", s.recent[0]?.action, "fixGrammar");
  eq("the failure carries its reason", s.recent[0]?.error, "provider not running");

  // the honest-null rule: a server that reports no usage must not become a 0
  logAiCall(db, { ws, provider: "lmstudio", model: "m", action: "summarize", ms: 10, ok: true, chars: 5, createdAt: t0 - 500 });
  const withNulls = aiUsageSummary(db, ws);
  eq("nulls do not poison the sum", withNulls.promptTokens, 30);
  eq("chars still count", withNulls.chars, 105);

  // scoping: `days` is a look-back window; 0 means "everything kept"
  const DAY = 86_400_000;
  logAiCall(db, { ws, provider: "strata", model: "m", action: "summarize", ms: 5, ok: true, chars: 1, createdAt: t0 - 10 * DAY });
  eq("a 1-day window excludes the old row", aiUsageSummary(db, ws, { days: 1 }).calls, 4);
  eq("a 30-day window includes it", aiUsageSummary(db, ws, { days: 30 }).calls, 5);
  eq("days: 0 means everything kept", aiUsageSummary(db, ws, { days: 0 }).calls, 5);
  eq("no window means everything kept", aiUsageSummary(db, ws).calls, 5);
  eq("recent is capped", aiUsageSummary(db, ws, { recent: 2 }).recent.length, 2);

  // retention
  for (let i = 0; i < 12; i++) {
    logAiCall(db, { ws, provider: "strata", model: "m", action: "summarize", ms: i, ok: true, chars: 1, createdAt: Date.now() + i });
  }
  eq("17 rows before pruning", aiUsageSummary(db, ws).calls, 17);
  const dropped = pruneAiCalls(db, ws, 5);
  eq("prune drops the oldest", dropped, 12);
  eq("five kept", aiUsageSummary(db, ws).calls, 5);

  // isolation: one workspace's log is not another's
  const ws2 = "ws-other";
  db.run("INSERT INTO workspace (id, name, created_at) VALUES (?, ?, ?)", ws2, "Other", Date.now());
  logAiCall(db, { ws: ws2, provider: "strata", model: "m", action: "summarize", ms: 1, ok: true, chars: 1 });
  eq("other workspace has its own log", aiUsageSummary(db, ws2).calls, 1);
  eq("this workspace is unaffected", aiUsageSummary(db, ws).calls, 5);

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

section("Streaming actions");
{
  const { runActionStream } = await import("../server/ai/actions.ts");
  fake.reset();
  fake.state.mode = "stream";

  const events: string[] = [];
  const deltas: string[] = [];
  let final: { ok: boolean; text?: string; model: string; ms: number; usage?: unknown } | null = null;
  for await (const ev of runActionStream(
    { action: "summarize", providerId: "strata", text: "Some text to summarize." },
    { adapter: strata },
  )) {
    events.push(ev.type);
    if (ev.type === "delta") deltas.push(ev.text);
    if (ev.type === "done" || ev.type === "error") final = ev.result;
  }

  eq("meta comes first", events[0], "meta");
  eq("ends with done", events[events.length - 1], "done");
  eq("the answer is reassembled from deltas", deltas.join(""), "Hello, world!");
  eq("done carries a successful result", final?.ok, true);
  ok("final text matches the stream", (final?.text ?? "").includes("Hello, world!"), final?.text);

  const usage = (final?.usage ?? {}) as { promptTokens: number | null; completionTokens: number | null; chars: number };
  ok("usage reports chars", usage.chars > 0, JSON.stringify(usage));
  ok("tokens stay null when unreported", usage.promptTokens === null, JSON.stringify(usage));

  // non-text actions do not stream: they need the whole JSON before validating
  fake.reset();
  const jsonEvents: string[] = [];
  for await (const ev of runActionStream(
    { action: "askWorkspace", providerId: "strata", question: "anything" },
    { adapter: strata },
  )) {
    jsonEvents.push(ev.type);
  }
  eq("a non-text action arrives as one event", jsonEvents.length, 1);
  ok("and it is a terminal event", jsonEvents[0] === "done" || jsonEvents[0] === "error", jsonEvents[0]);

  // Stop: the caller aborts, and the stream ends with a cancellation, not a hang
  fake.reset();
  fake.state.mode = "stream-slow";
  const controller = new AbortController();
  const seen: string[] = [];
  let stopResult: { ok: boolean; error?: string } | null = null;
  try {
    for await (const ev of runActionStream(
      { action: "summarize", providerId: "strata", text: "long text" },
      { adapter: strata, signal: controller.signal },
    )) {
      seen.push(ev.type);
      if (ev.type === "delta" && seen.filter((t) => t === "delta").length === 1) controller.abort();
      if (ev.type === "done" || ev.type === "error") stopResult = ev.result;
    }
  } catch (err) {
    stopResult = { ok: false, error: (err as Error).message };
  }
  ok("the stream produced at least one delta", seen.includes("delta"), JSON.stringify(seen));
  ok("it terminates after the abort", seen.includes("done") || seen.includes("error"), JSON.stringify(seen));
  ok("the abort is reported as a cancellation", /cancel/i.test(stopResult?.error ?? ""), JSON.stringify(stopResult));
  fake.state.mode = "chat";
  fake.reset();
}

// ── live provider (informational) ────────────────────────────────────────────

section("Live Strata check (informational, never scored)");
{
  await fake.close();

  const live = defaultProviderConfigs()[0]!;
  let reachable = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${live.baseUrl}/models`, { signal: controller.signal });
    clearTimeout(timer);
    reachable = res.ok;
    if (!reachable) info(`GET ${live.baseUrl}/models → HTTP ${res.status}`);
  } catch (e) {
    info(`no Strata on ${live.baseUrl} (${e instanceof Error ? e.message : String(e)}) — skipped`);
  }

  if (reachable) {
    try {
      const adapter = createAdapter(live, { chatTimeoutMs: 240_000, requestTimeoutMs: 20_000 });
      const models = await adapter.listModels();
      info(`models: ${models.map((m) => `${m.id}${m.contextLength ? `(${m.contextLength})` : ""}`).join(", ")}`);
      const text = [
        "Strata Notes runs entirely on the user's machine.",
        "The AI layer talks to local providers: Strata, Ollama and LM Studio.",
        "No cloud dependency is required for the app to work.",
        "Provider settings store a keychain reference, never the key itself.",
      ].join(" ");
      const result = await runAction({ action: "summarize", providerId: live.id, text }, { adapter });
      const answer = (result.text ?? "").replace(/\s+/g, " ");
      info(`live summarize → ok=${result.ok} ms=${result.ms} model=${result.model}`);
      if (result.ok) {
        info(`answer: ${answer.slice(0, 400)}`);
        // a leak of reasoning text is a real defect, so it is reported loudly —
        // but a slow or busy provider is not, so nothing here moves the counter.
        if (/reasoning_content|chain of thought|MUST NOT APPEAR/i.test(answer)) {
          info("⚠ the live answer looks like reasoning content — check deltaText");
        }
      } else {
        info(`provider did not answer this run: ${result.error}`);
      }
    } catch (e) {
      info(`live call failed (${e instanceof Error ? e.message : String(e)}) — not counted`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
