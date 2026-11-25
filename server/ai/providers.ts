/**
 * Local AI providers: the adapter interface, the registry, and the
 * OpenAI-compatible client every preset is built on.
 *
 * Everything here talks to a process on the user's machine. The default
 * provider is the Strata bridge on loopback; Ollama and LM Studio are presets.
 * No cloud dependency is required for the app to work.
 *
 * The rules this file enforces are the places local-AI code usually goes wrong:
 *   - every request carries a timeout, composed with the caller's own
 *     AbortSignal, so a wedged model server can never hang a request;
 *   - SSE is parsed incrementally: `data: [DONE]`, multi-line data, a chunk
 *     that splits a JSON object in half, CRLF lines, `:` comment lines, and
 *     `reasoning_content` (thinking models) all handled — reasoning is ignored
 *     and never surfaces as answer text;
 *   - 429/5xx retry twice with jittered backoff, a 4xx never retries;
 *   - an API key is never stored in the DB: it is a keychain reference
 *     resolved through an injected `secretResolver`, and it is redacted from
 *     every error string.
 */

import type {
  ModelInfo,
  ProviderCapabilities,
  ProviderConfig,
  ProviderKind,
  ProviderProbe,
} from "../../shared/types.ts";
import type { Db } from "../db.ts";
import { isRecord } from "./json.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
  /**
   * Called with the provider's own token counts when it sends them. A callback
   * rather than a return value because `chat()` returns the answer text, and
   * putting usage on the adapter would be shared mutable state across requests.
   */
  onUsage?: (usage: { promptTokens: number | null; completionTokens: number | null }) => void;
}

export interface Delta {
  text: string;
  done: boolean;
}

export interface ProviderAdapter {
  readonly config: ProviderConfig;
  readonly capabilities: ProviderCapabilities;
  listModels(): Promise<ModelInfo[]>;
  chat(opts: ChatOptions): Promise<string>;
  stream(opts: ChatOptions): AsyncIterable<Delta>;
  embed(texts: string[], model: string): Promise<Float32Array[]>;
  health(): Promise<{ ok: boolean; models: number; latencyMs: number; error?: string }>;
  /** Rich, single-call diagnostics for the settings screen. */
  probe(opts?: { embedModel?: string; maxModelIds?: number }): Promise<ProviderProbe>;
  /**
   * Optional: ask the provider whether it really serves embeddings and update
   * `capabilities.embed`. The settings screen calls it after a provider is
   * added; adapters that cannot probe simply omit it.
   */
  probeEmbeddingSupport?(model?: string): Promise<boolean>;
}

export type SecretResolver = (ref: string) => string | null;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export type AiErrorKind =
  | "config"
  | "network"
  | "timeout"
  | "aborted"
  | "http"
  | "parse"
  | "unsupported";

export class AiError extends Error {
  readonly kind: AiErrorKind;
  /** provider id, e.g. "ollama" */
  readonly provider: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly url?: string;

  constructor(
    message: string,
    init: {
      kind: AiErrorKind;
      provider: string;
      status?: number;
      retryable?: boolean;
      url?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "AiError";
    this.kind = init.kind;
    this.provider = init.provider;
    this.status = init.status;
    this.retryable = init.retryable ?? false;
    this.url = init.url;
    if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
  }
}

/** A request outlived its budget. Named so callers can distinguish it. */
export class AiTimeoutError extends AiError {
  constructor(message: string, init: { provider: string; url?: string; cause?: unknown }) {
    super(message, { kind: "timeout", provider: init.provider, retryable: true, url: init.url, cause: init.cause });
    this.name = "AiTimeoutError";
  }
}

/** The caller cancelled. Never retried, never reported as a provider failure. */
export class AiAbortedError extends AiError {
  constructor(message: string, init: { provider: string; url?: string; cause?: unknown }) {
    super(message, { kind: "aborted", provider: init.provider, retryable: false, url: init.url, cause: init.cause });
    this.name = "AiAbortedError";
  }
}

export function isAiError(e: unknown): e is AiError {
  return e instanceof AiError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

// ─────────────────────────────────────────────────────────────────────────────
// Redaction
// ─────────────────────────────────────────────────────────────────────────────

const REDACT_PATTERNS: [RegExp, string][] = [
  // `"authorization": "Bearer sk-..."` and `Authorization: Bearer sk-...`
  [/(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+|basic\s+)?[^"',\r\n}]+/gi, "$1[redacted]"],
  [/(["']?(?:api[_-]?key|apikey|access[_-]?key|secret|token|password)["']?\s*[:=]\s*["']?)[^"',\r\n}]+/gi, "$1[redacted]"],
  // provider-shaped keys: sk-..., gpt-..., key-...
  [/\b(sk|pk|key|api)[-_][A-Za-z0-9_\-]{6,}\b/g, "[redacted-key]"],
  // credentials inside a URL
  [/(\w+:\/\/)([^\s/@:"]+):([^\s@"']+)@/g, "$1$2:[redacted]@"],
];

/** Strip anything key-shaped from text destined for a log line or the UI. */
export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const [re, to] of REDACT_PATTERNS) out = out.replace(re, to);
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Presets
// ─────────────────────────────────────────────────────────────────────────────

export const STRATA_BASE_URL = "http://127.0.0.1:47831/v1";
export const STRATA_MODEL = "swift-iq3_s";
export const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
export const LMSTUDIO_BASE_URL = "http://127.0.0.1:1234/v1";

export const DEFAULT_CHAT_TIMEOUT_MS = 60_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_EMBED_TIMEOUT_MS = 60_000;
export const MAX_RETRIES = 2;
export const RETRY_BASE_MS = 400;
export const RETRY_CAP_MS = 4_000;

/**
 * The four presets the settings screen offers. `strata` is the default and has
 * no embedding route, so `capabilities.embed` is false for it — see
 * `capabilitiesFor`.
 */
export function defaultProviderConfigs(): ProviderConfig[] {
  return [
    {
      id: "strata",
      label: "Strata",
      kind: "strata",
      baseUrl: STRATA_BASE_URL,
      model: STRATA_MODEL,
      enabled: true,
    },
    {
      id: "ollama",
      label: "Ollama",
      kind: "ollama",
      baseUrl: OLLAMA_BASE_URL,
      model: "llama3.1:8b",
      embedModel: "nomic-embed-text",
      enabled: true,
    },
    {
      id: "lmstudio",
      label: "LM Studio",
      kind: "lmstudio",
      baseUrl: LMSTUDIO_BASE_URL,
      model: "",
      embedModel: "",
      enabled: true,
    },
    {
      id: "openai-compatible",
      label: "OpenAI-compatible",
      kind: "openai-compatible",
      baseUrl: "",
      model: "",
      // a keychain reference, never the key itself
      apiKeyRef: "strata:ai:openai-compatible:api-key",
      enabled: false,
    },
  ];
}

export function capabilitiesFor(config: ProviderConfig): ProviderCapabilities {
  return {
    chat: true,
    stream: true,
    structured: true,
    // The Strata bridge is a chat/completions gateway: it exposes no embedding
    // route, so asking it to embed is a bug, not a 404 to discover at runtime.
    embed: config.kind !== "strata",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// URL helpers
// ─────────────────────────────────────────────────────────────────────────────

export function originOf(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return baseUrl.replace(/\/+$/, "");
  }
}

/** Join a base that may already carry a path (`/v1`) with a route. */
export function joinUrl(baseUrl: string, route: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const r = route.startsWith("/") ? route : `/${route}`;
  return `${base}${r}`;
}

/** A number, or null for anything a provider might send in a numeric field. */
function numOrNull(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function routesFor(kind: ProviderKind, baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, "");
  const origin = originOf(base);
  return {
    models: joinUrl(base, "/models"),
    chat: joinUrl(base, "/chat/completions"),
    // OpenAI-compatible embeddings on the same base...
    embeddings: joinUrl(base, "/embeddings"),
    // ...plus Ollama's native routes, which live at the origin, not under /v1.
    tags: `${origin}/api/tags`,
    ollamaEmbed: `${origin}/api/embed`,
  };
}

function assertHttpBaseUrl(config: ProviderConfig): void {
  const raw = config.baseUrl?.trim();
  if (!raw) {
    throw new AiError(`provider "${config.id}" has no base URL — set it in Settings → AI`, {
      kind: "config",
      provider: config.id,
    });
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AiError(`provider "${config.id}" has an invalid base URL: ${raw}`, {
      kind: "config",
      provider: config.id,
    });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new AiError(
      `provider "${config.id}" base URL must be http(s), got ${u.protocol}`,
      { kind: "config", provider: config.id },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE
// ─────────────────────────────────────────────────────────────────────────────

export interface SseEvent {
  data: string;
  event: string;
  /** true when the provider signalled end of stream (`[DONE]` / `done:true`) */
  done: boolean;
}

/**
 * Incremental SSE reader. Feed it network chunks of any shape; it emits
 * complete events and keeps whatever is unfinished.
 *
 * Handles: LF, CRLF and CR line endings; a boundary splitting a JSON object
 * mid-token; `:` comment / keep-alive lines; multi-line `data:` fields (joined
 * with `\n` per spec); `data: [DONE]`; and Ollama's `{"done":true}`.
 */
export class SseParser {
  private buf = "";
  private data: string[] = [];
  private event = "message";
  private sawData = false;

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const events: SseEvent[] = [];
    // Split on LF, CRLF, or a lone CR. The trailing piece is kept buffered.
    const lines = this.buf.split(/\r\n|\n|\r/);
    const rest = lines.pop();
    this.buf = rest ?? "";
    for (const line of lines) {
      const e = this.consume(line);
      if (e) events.push(e);
    }
    return events;
  }

  /** Flush a stream that ended without a trailing blank line. */
  end(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buf.length) {
      const e = this.consume(this.buf);
      this.buf = "";
      if (e) events.push(e);
    }
    const last = this.flush();
    if (last) events.push(last);
    return last ? [...events, last] : events;
  }

  private consume(line: string): SseEvent | null {
    if (line === "") return this.flush();
    if (line.startsWith(":")) return null; // comment / keep-alive

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "data":
        this.data.push(value);
        this.sawData = true;
        return null;
      case "event":
        this.event = value || "message";
        return null;
      default:
        return null; // id, retry, unknown
    }
  }

  private flush(): SseEvent | null {
    const event = this.event;
    const data = this.data.join("\n");
    this.data = [];
    this.event = "message";
    if (!this.sawData) return null;
    this.sawData = false;
    const trimmed = data.trim();
    return { data, event, done: trimmed === "[DONE]" || trimmed === "done" };
  }
}

/**
 * Pull answer text out of one streamed chunk.
 * `reasoning_content` / `reasoning` are deliberately never read: thinking
 * models put their chain of thought there, and it must not reach the document.
 */
export function deltaText(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") return "";
  const c = chunk as Record<string, unknown>;
  const choices = Array.isArray(c.choices) ? c.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const target = (first?.delta ?? first?.message ?? first) as Record<string, unknown> | undefined;
  if (!target) {
    // some gateways put text at the top level
    return typeof c.content === "string" ? c.content : "";
  }
  const content = target.content;
  if (typeof content === "string" && content.length) return content;
  if (Array.isArray(content)) {
    // OpenAI "content parts" shape
    const parts = content
      .map((p) => {
        if (typeof p === "string") return p;
        const o = p as Record<string, unknown>;
        return typeof o.text === "string" ? o.text : "";
      })
      .join("");
    if (parts) return parts;
  }
  if (typeof first?.text === "string") return first.text as string;
  return "";
}

export function streamIsDone(chunk: unknown): boolean {
  if (!chunk || typeof chunk !== "object") return false;
  const c = chunk as Record<string, unknown>;
  if (c.done === true) return true; // Ollama's shape
  const choices = Array.isArray(c.choices) ? c.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  // A finish_reason with no text is the provider's last chunk. Providers that
  // never send `[DONE]` end here.
  return typeof first?.finish_reason === "string" && deltaText(chunk) === "";
}

export function streamError(chunk: unknown): string | null {
  if (!chunk || typeof chunk !== "object") return null;
  const c = chunk as Record<string, unknown>;
  const err = c.error;
  if (!err) return null;
  if (typeof err === "string") return err;
  const o = err as Record<string, unknown>;
  return String(o.message ?? o.code ?? JSON.stringify(err));
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export interface AdapterOptions {
  /** injectable for tests; defaults to global fetch (Node 24) */
  fetchImpl?: typeof fetch;
  chatTimeoutMs?: number;
  requestTimeoutMs?: number;
  embedTimeoutMs?: number;
  secretResolver?: SecretResolver;
  maxRetries?: number;
  retryBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface ComposedSignal {
  signal: AbortSignal;
  timeout: AbortSignal;
  caller?: AbortSignal;
}

function composeSignal(caller: AbortSignal | undefined, ms: number): ComposedSignal {
  const timeout = AbortSignal.timeout(Math.max(1, Math.floor(ms)));
  if (!caller) return { signal: timeout, timeout };
  if (caller.aborted) return { signal: caller, timeout, caller };
  return { signal: AbortSignal.any([caller, timeout]), timeout, caller };
}

function abortReason(c: ComposedSignal): "aborted" | "timeout" | null {
  if (c.caller?.aborted) return "aborted";
  if (c.timeout.aborted) return "timeout";
  return null;
}

/** "60s" at second scale, "150ms" below one second. */
function secondsLabel(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms)}ms`;
}

export function createAdapter(config: ProviderConfig, opts: AdapterOptions = {}): ProviderAdapter {
  return new OpenAiCompatibleAdapter(config, opts);
}

/**
 * One client for all four presets. Ollama differs in two places only — model
 * listing (`/api/tags`) and embeddings (`/api/embed`) — and both are handled by
 * its own routes, not by a subclass.
 */
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly config: ProviderConfig;
  readonly capabilities: ProviderCapabilities;
  private readonly opts: AdapterOptions;
  private readonly routes: ReturnType<typeof routesFor>;
  /** resolved once per adapter; the raw secret is never stored on the config */
  private secretCache: { ref: string; value: string } | null = null;

  constructor(config: ProviderConfig, opts: AdapterOptions = {}) {
    this.config = config;
    this.opts = opts;
    this.capabilities = capabilitiesFor(config);
    this.routes = routesFor(config.kind, config.baseUrl);
  }

  get label(): string {
    return this.config.label || this.config.id;
  }

  // ── requests ──────────────────────────────────────────────────────────────

  private get fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? globalThis.fetch;
  }

  private get maxRetries(): number {
    return this.opts.maxRetries ?? MAX_RETRIES;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    const secret = this.secret();
    if (secret) h.authorization = `Bearer ${secret}`;
    return h;
  }

  /** Resolve the keychain reference. Never returns a stored raw key. */
  private secret(): string | null {
    const ref = this.config.apiKeyRef;
    if (!ref) return null;
    if (this.secretCache && this.secretCache.ref === ref) return this.secretCache.value;
    const resolver = this.opts.secretResolver;
    if (!resolver) {
      throw new AiError(
        `provider "${this.config.id}" needs a secret for reference "${ref}", but no secret resolver is configured`,
        { kind: "config", provider: this.config.id },
      );
    }
    const value = resolver(ref);
    if (!value) {
      throw new AiError(
        `no secret found for provider "${this.config.id}" (reference "${ref}") — store the key in the keychain, then reconnect the provider`,
        { kind: "config", provider: this.config.id },
      );
    }
    this.secretCache = { ref, value };
    return value;
  }

  private backoffMs(attempt: number, res: Response | null): number {
    const base = this.opts.retryBaseMs ?? RETRY_BASE_MS;
    const exp = Math.min(RETRY_CAP_MS, base * 2 ** (attempt - 1));
    const rand = this.opts.random ?? Math.random;
    const jittered = Math.round(exp * (0.5 + rand()));
    if (res) {
      const ra = res.headers.get("retry-after");
      if (ra) {
        const secs = Number(ra);
        if (Number.isFinite(secs) && secs >= 0) {
          return Math.min(RETRY_CAP_MS, Math.max(jittered, Math.round(secs * 1000)));
        }
      }
    }
    return Math.min(RETRY_CAP_MS, jittered);
  }

  /**
   * Send one request, with the timeout composed with the caller's signal and
   * the retry policy applied. Returns the response; the body is left unread.
   */
  private async send(
    url: string,
    init: {
      method: "GET" | "POST";
      body?: string;
      timeoutMs: number;
      signal?: AbortSignal;
      accept?: string;
      /** set when the caller already composed the timeout with its signal */
      preComposed?: boolean;
      /** the caller's own signal, kept separate so aborts attribute correctly */
      callerSignal?: AbortSignal;
    },
  ): Promise<Response> {
    assertHttpBaseUrl(this.config);
    const sleep = this.opts.sleep ?? defaultSleep;
    const headers = this.headers();
    if (init.accept) headers.accept = init.accept;
    const secrets = [String(headers.authorization ?? "").replace(/^Bearer\s+/i, "")].filter(Boolean);
    const callerSignal = init.callerSignal ?? init.signal;

    let attempt = 0;
    for (;;) {
      const signal = init.preComposed
        ? (init.signal ?? AbortSignal.timeout(init.timeoutMs))
        : composeSignal(callerSignal, init.timeoutMs).signal;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: init.method,
          headers,
          body: init.body,
          signal,
          // local providers, no cache: a model server restart must not be cached
          cache: "no-store",
        } as RequestInit);
      } catch (err) {
        if (callerSignal?.aborted) {
          throw new AiAbortedError(`${this.label}: request cancelled by the caller`, {
            provider: this.config.id,
            url,
            cause: err,
          });
        }
        if (signal.aborted) {
          throw new AiTimeoutError(
            `${this.label}: no response within ${secondsLabel(init.timeoutMs)} — the model may still be loading`,
            { provider: this.config.id, url, cause: err },
          );
        }
        throw this.mapNetworkError(err, url, secrets);
      }

      if (res.ok) return res;

      const detail = await this.readSnippet(res, secrets);
      const retriable = res.status === 429 || res.status >= 500;
      if (retriable && attempt < this.maxRetries) {
        attempt++;
        await sleep(this.backoffMs(attempt, res));
        continue;
      }
      throw new AiError(this.httpMessage(res, detail, attempt), {
        kind: "http",
        provider: this.config.id,
        status: res.status,
        retryable: retriable,
        url,
      });
    }
  }

  private httpMessage(res: Response, detail: string, attempts: number): string {
    const status = res.status;
    let hint = "";
    if (status === 401 || status === 403) {
      hint = " — the provider rejected the credentials; check the API key reference in Settings";
    } else if (status === 404) {
      hint = " — that route does not exist on this provider; check the base URL (is the server exposing /v1?)";
    } else if (status === 429) {
      hint = ` — rate limited${attempts ? ` after ${attempts + 1} attempts` : ""}; try again shortly`;
    } else if (status >= 500) {
      hint = " — the provider failed; the model may be too large for RAM or still loading";
    }
    const head = `${this.label}: HTTP ${status}${res.statusText ? ` ${res.statusText}` : ""}${hint}`;
    return detail ? `${head}. Provider said: ${detail}` : head;
  }

  private mapNetworkError(err: unknown, url: string, secrets: string[]): AiError {
    const e = err as {
      name?: string;
      message?: string;
      code?: string;
      cause?: { code?: string; message?: string };
    };
    const code = e?.cause?.code ?? e?.code ?? "";
    const provider = this.config.id;
    const target = redact(url, secrets);

    if (e?.name === "AbortError") {
      // An abort we did not attribute to a signal: treat as caller cancellation.
      return new AiAbortedError(`${this.label}: request cancelled`, { provider, url: target, cause: err });
    }
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EADDRNOTAVAIL") {
      return new AiError(
        `${this.label}: provider not running — start Ollama / LM Studio (nothing is listening at ${this.origin()})`,
        { kind: "network", provider, url: target, retryable: true, cause: err },
      );
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return new AiError(
        `${this.label}: host not found — "${this.origin()}" is unreachable from this machine`,
        { kind: "network", provider, url: target, retryable: true, cause: err },
      );
    }
    if (code === "EPROTO" || /certificate|self-signed|TLS/i.test(errorMessage(err))) {
      return new AiError(
        `${this.label}: TLS handshake failed at ${target} — a local provider usually wants http://, not https://`,
        { kind: "network", provider, url: target, cause: err },
      );
    }
    return new AiError(
      `${this.label}: cannot reach ${target}${code ? ` (${code})` : ""}`,
      { kind: "network", provider, url: target, retryable: true, cause: err },
    );
  }

  private origin(): string {
    return originOf(this.config.baseUrl);
  }

  private async readSnippet(res: Response, secrets: string[]): Promise<string> {
    try {
      const text = await res.text();
      const flat = text.replace(/\s+/g, " ").trim();
      if (!flat) return "";
      const snippet = flat.length > 400 ? `${flat.slice(0, 400)}…` : flat;
      return redact(snippet, secrets);
    } catch {
      return "";
    }
  }

  private async requestJson<T>(
    url: string,
    body: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.send(url, {
      method: body === undefined ? "GET" : "POST",
      body,
      timeoutMs,
      signal,
      accept: "application/json",
    });
    const text = await res.text().catch(() => "");
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new AiError(
        `${this.label}: replied with something that is not JSON (${res.status} at ${url})`,
        { kind: "parse", provider: this.config.id, url, cause: err },
      );
    }
  }

  private chatBody(opts: ChatOptions, stream: boolean): string {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream,
    };
    if (opts.temperature != null) body.temperature = opts.temperature;
    if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
    if (opts.jsonMode) {
      body.response_format = { type: "json_object" };
      // Ollama's OpenAI shim honours its own native flag too; sending both is
      // ignored by strict servers and helps the loose ones.
      if (this.config.kind === "ollama") body.format = "json";
    }
    return JSON.stringify(body);
  }

  // ── API ───────────────────────────────────────────────────────────────────

  async listModels(): Promise<ModelInfo[]> {
    const timeout = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (this.config.kind === "ollama") {
      const json = await this.requestJson<{ models?: unknown[] }>(
        this.routes.tags,
        undefined,
        timeout,
      );
      const rows = Array.isArray(json.models) ? json.models : [];
      const out: ModelInfo[] = [];
      for (const raw of rows) {
        const r = (raw ?? {}) as Record<string, unknown>;
        const details = (r.details ?? {}) as Record<string, unknown>;
        const parameters = (r.parameters ?? {}) as Record<string, unknown>;
        const id = String(r.name ?? r.model ?? "");
        if (!id) continue;
        const ctx = Number(details.context_length ?? parameters.num_ctx ?? 0);
        const info: ModelInfo = { id, label: id };
        if (Number.isFinite(ctx) && ctx > 0) info.contextLength = ctx;
        if (details.family) info.ownedBy = String(details.family);
        out.push(info);
      }
      return out.sort((a, b) => a.id.localeCompare(b.id));
    }

    const json = await this.requestJson<{ data?: unknown[] }>(this.routes.models, undefined, timeout);
    const rows = Array.isArray(json.data) ? json.data : [];
    const out: ModelInfo[] = [];
    for (const raw of rows) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const meta = (r.meta ?? {}) as Record<string, unknown>;
      const id = String(r.id ?? r.name ?? "");
      if (!id) continue;
      const ctx = Number(r.context_length ?? meta.context_length ?? r.max_context_length ?? 0);
      const info: ModelInfo = { id, label: String(r.alias ?? meta.label ?? r.name ?? id) };
      if (Number.isFinite(ctx) && ctx > 0) info.contextLength = ctx;
      const owner = r.owned_by ?? meta.owned_by;
      if (owner) info.ownedBy = String(owner);
      out.push(info);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async chat(opts: ChatOptions): Promise<string> {
    const timeout = this.opts.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
    const url = this.routes.chat;
    const json = await this.requestJson<Record<string, unknown>>(
      url,
      this.chatBody(opts, false),
      timeout,
      opts.signal,
    );
    this.reportUsage(json, opts);
    const choice = (Array.isArray(json.choices) ? json.choices[0] : undefined) as
      | Record<string, unknown>
      | undefined;
    if (!choice) {
      const err = streamError(json);
      throw new AiError(
        `${this.label}: completion response has no choices${err ? ` — ${redact(err)}` : ""}`,
        { kind: "parse", provider: this.config.id, url },
      );
    }
    const message = (choice.message ?? choice) as Record<string, unknown>;
    // `reasoning_content` is read by nobody here: thinking models stream their
    // chain of thought into it and it must never become answer text.
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return deltaText(json);
    if (typeof choice.text === "string") return choice.text;
    return "";
  }

  /**
   * Report the provider's token counts, if it sent any. `null` is meaningful:
   * it means "this server does not report usage", and the UI must not render it
   * as a zero.
   */
  private reportUsage(json: Record<string, unknown>, opts: ChatOptions): void {
    if (!opts.onUsage) return;
    const usage = isRecord(json.usage) ? json.usage : {};
    const prompt = numOrNull(usage.prompt_tokens ?? usage.input_tokens);
    const completion = numOrNull(usage.completion_tokens ?? usage.output_tokens);
    opts.onUsage({ promptTokens: prompt, completionTokens: completion });
  }

  async *stream(opts: ChatOptions): AsyncGenerator<Delta> {
    const timeout = this.opts.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
    const url = this.routes.chat;
    // One signal for the whole operation: the timeout has to cover the body
    // read too, because a model that sends headers and then stalls forever is
    // the common local failure mode.
    const composed = composeSignal(opts.signal, timeout);
    const res = await this.send(url, {
      method: "POST",
      body: this.chatBody(opts, true),
      timeoutMs: timeout,
      signal: composed.signal,
      callerSignal: opts.signal,
      accept: "text/event-stream",
      preComposed: true,
    });

    const contentType = res.headers.get("content-type") ?? "";
    if (!res.body || !contentType.includes("event-stream")) {
      // The server ignored `stream:true` and answered with one JSON body.
      const answer = this.chatFromJson(await res.text().catch(() => ""), url);
      yield { text: answer, done: false };
      yield { text: "", done: true };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const parser = new SseParser();
    let finished = false;

    try {
      for (;;) {
        let read: { done: boolean; value?: Uint8Array };
        try {
          read = await reader.read();
        } catch (err) {
          throw this.streamAbortError(err, opts, composed, url);
        }
        if (read.done) break;
        const events = parser.push(decoder.decode(read.value, { stream: true }));
        for (const ev of events) {
          if (ev.done) {
            finished = true;
            break;
          }
          const payload = ev.data.trim();
          if (!payload) continue;
          let obj: unknown;
          try {
            obj = JSON.parse(payload);
          } catch {
            continue; // an event the provider never finished; the next one completes it
          }
          const err = streamError(obj);
          if (err) {
            throw new AiError(`${this.label}: stream error — ${redact(err)}`, {
              kind: "http",
              provider: this.config.id,
              url,
            });
          }
          const text = deltaText(obj);
          if (text) yield { text, done: false };
          if (streamIsDone(obj)) {
            finished = true;
            break;
          }
        }
        if (finished) break;
      }

      // A stream that ended without its trailing blank line: flush what is left.
      if (!finished) {
        for (const ev of parser.end()) {
          if (ev.done) {
            finished = true;
            break;
          }
          const payload = ev.data.trim();
          if (!payload) continue;
          try {
            const text = deltaText(JSON.parse(payload) as unknown);
            if (text) yield { text, done: false };
          } catch {
            /* ignore a malformed tail */
          }
        }
      }
      yield { text: "", done: true };
    } catch (err) {
      if (isAiError(err)) throw err;
      throw this.streamAbortError(err, opts, composed, url);
    } finally {
      // Release the socket when the caller stops reading early.
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      try {
        reader.releaseLock();
      } catch {
        /* cancel holds the lock */
      }
    }
  }

  private streamAbortError(
    err: unknown,
    _opts: ChatOptions,
    composed: ComposedSignal,
    url: string,
  ): AiError {
    const why = abortReason(composed);
    if (why === "aborted") {
      return new AiAbortedError(`${this.label}: stream cancelled by the caller`, {
        provider: this.config.id,
        url,
        cause: err,
      });
    }
    if (why === "timeout") {
      return new AiTimeoutError(
        `${this.label}: stream stalled — no data within ${secondsLabel(this.opts.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS)}`,
        { provider: this.config.id, url, cause: err },
      );
    }
    return this.mapNetworkError(err, url, []);
  }

  private chatFromJson(text: string, url: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new AiError(`${this.label}: non-JSON completion response`, {
        kind: "parse",
        provider: this.config.id,
        url,
        cause: err,
      });
    }
    const json = parsed as Record<string, unknown>;
    const choice = (Array.isArray(json.choices) ? json.choices[0] : undefined) as
      | Record<string, unknown>
      | undefined;
    const message = (choice?.message ?? choice) as Record<string, unknown> | undefined;
    const content = message?.content;
    return typeof content === "string" ? content : "";
  }

  async embed(texts: string[], model: string): Promise<Float32Array[]> {
    return this.embedNow(texts, model, false);
  }

  /**
   * `embedNow(..., force)` skips the capability gate. The probe has to be able
   * to ask a provider that previously answered "no embeddings" — a user can add
   * an embedding server to Ollama at any moment, and the cache must not
   * permanent-block the retry path.
   */
  private async embedNow(texts: string[], model: string, force: boolean): Promise<Float32Array[]> {
    if (!this.capabilities.embed && !force) {
      throw new AiError(
        `${this.label} has no embedding route — configure Ollama or LM Studio for workspace Q&A`,
        { kind: "unsupported", provider: this.config.id },
      );
    }
    if (!texts.length) return [];
    const timeout = this.opts.embedTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
    const name = model || this.config.embedModel || "";
    if (!name) {
      throw new AiError(`provider "${this.config.id}" has no embedding model configured`, {
        kind: "config",
        provider: this.config.id,
      });
    }

    if (this.config.kind === "ollama") {
      const url = this.routes.ollamaEmbed;
      const json = await this.requestJson<{ embeddings?: unknown[] }>(
        url,
        JSON.stringify({ model: name, input: texts }),
        timeout,
      );
      const rows = Array.isArray(json.embeddings) ? json.embeddings : [];
      return rows.map((v) => Float32Array.from((v as number[]).map(Number)));
    }

    const url = this.routes.embeddings;
    const json = await this.requestJson<{ data?: unknown[] }>(
      url,
      JSON.stringify({ model: name, input: texts }),
      timeout,
    );
    const rows = Array.isArray(json.data) ? json.data : [];
    return rows
      .map((raw) => raw as { index?: number; embedding?: number[] })
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((r) => Float32Array.from((r.embedding ?? []).map(Number)));
  }

  /**
   * Ask the provider whether it really serves embeddings, and remember the
   * answer. A provider that 404s the route stops advertising the capability,
   * so the UI can hide the indexing action instead of failing later.
   */
  async probeEmbeddingSupport(model?: string): Promise<boolean> {
    if (this.config.kind === "strata") {
      this.capabilities.embed = false;
      return false;
    }
    try {
      await this.embedNow(["capability probe"], model ?? this.config.embedModel ?? "probe", true);
      this.capabilities.embed = true;
      return true;
    } catch (e) {
      const kind = isAiError(e) ? e.kind : "unknown";
      const status = isAiError(e) ? e.status : undefined;
      if (kind === "unsupported" || kind === "config") this.capabilities.embed = false;
      else if (status === 404 || status === 400 || status === 501) this.capabilities.embed = false;
      return this.capabilities.embed;
    }
  }

  async health(): Promise<{ ok: boolean; models: number; latencyMs: number; error?: string }> {
    const started = Date.now();
    try {
      const models = await this.listModels();
      return { ok: true, models: models.length, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, models: 0, latencyMs: Date.now() - started, error: redact(errorMessage(e)) };
    }
  }

  /**
   * Everything the settings screen needs to say about one provider, in one call.
   *
   * `health()` answered ok/models/error, which is why the UI could only render a
   * dot and a count. This adds the latency the user is really asking about, the
   * model ids the picker needs, the distinction between "not running" and
   * "running with no models pulled", and a probed — not assumed — embedding
   * answer.
   */
  async probe(opts: { embedModel?: string; maxModelIds?: number } = {}): Promise<ProviderProbe> {
    const started = Date.now();
    const max = opts.maxModelIds ?? 50;
    try {
      const models = await this.listModels();
      const latencyMs = Date.now() - started;
      const probe: ProviderProbe = {
        ok: true,
        latencyMs,
        models: models.length,
        modelIds: models.slice(0, max).map((m) => m.id),
        embedOk: false,
        embedModel: opts.embedModel ?? this.config.embedModel,
        empty: models.length === 0,
      };
      if (this.capabilities.embed && probe.embedModel) {
        probe.embedOk = await this.probeEmbeddingSupport(probe.embedModel);
      }
      return probe;
    } catch (e) {
      const latencyMs = Date.now() - started;
      const known = isAiError(e);
      return {
        ok: false,
        latencyMs,
        models: 0,
        modelIds: [],
        embedOk: false,
        embedModel: opts.embedModel ?? this.config.embedModel,
        error: redact(errorMessage(e)),
        kind: known ? e.kind : "network",
        status: known ? e.status : undefined,
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

export interface RegistryOptions {
  defaultId?: string;
  secretResolver?: SecretResolver;
  adapterOptions?: AdapterOptions;
}

const SECRET_SETTING_FIELDS = [
  "apiKey",
  "api_key",
  "apikey",
  "key",
  "token",
  "accessKey",
  "access_key",
  "secret",
  "password",
  "authorization",
];

/**
 * Registry of provider configs. Adapters are memoised per provider id, so a
 * request path never rebuilds a client and the capabilities a probe discovered
 * survive for the life of the process.
 */
export class ProviderRegistry {
  private readonly configs = new Map<string, ProviderConfig>();
  private readonly adapters = new Map<string, ProviderAdapter>();
  private defaultId: string | undefined;
  readonly warnings: string[] = [];
  readonly secretResolver?: SecretResolver;
  readonly adapterOptions: AdapterOptions;

  constructor(configs: ProviderConfig[] = defaultProviderConfigs(), opts: RegistryOptions = {}) {
    this.secretResolver = opts.secretResolver;
    this.adapterOptions = opts.adapterOptions ?? {};
    for (const c of configs) this.add(c);
    if (opts.defaultId) this.defaultId = opts.defaultId;
    this.defaultId = this.defaultId ?? this.firstEnabledId();
  }

  list(): ProviderConfig[] {
    return [...this.configs.values()];
  }

  get(id: string): ProviderConfig | undefined {
    return this.configs.get(id);
  }

  get defaultProviderId(): string | undefined {
    return this.defaultId;
  }

  setDefault(id: string): void {
    if (!this.configs.has(id)) {
      throw new AiError(`cannot default to unknown provider "${id}"`, { kind: "config", provider: id });
    }
    this.defaultId = id;
  }

  add(config: ProviderConfig): void {
    this.configs.set(config.id, config);
    this.adapters.delete(config.id);
    if (!this.defaultId) this.defaultId = this.firstEnabledId();
  }

  /**
   * Drop a provider and its cached adapter. If it was the default, the default
   * moves to the next enabled provider rather than pointing at nothing — a
   * dangling default makes every AI call fail with "unknown provider".
   */
  remove(id: string): boolean {
    const existed = this.configs.delete(id);
    this.adapters.delete(id);
    if (this.defaultId === id) this.defaultId = this.firstEnabledId();
    return existed;
  }

  private firstEnabledId(): string | undefined {
    return this.list().find((c) => c.enabled)?.id;
  }

  /** The adapter for `id` (or the default provider). Throws `AiError` (config). */
  adapterFor(id?: string): ProviderAdapter {
    const pid = id ?? this.defaultId;
    if (!pid) {
      throw new AiError("no AI provider configured", { kind: "config", provider: id ?? "" });
    }
    const existing = this.adapters.get(pid);
    if (existing) return existing;
    const config = this.configs.get(pid);
    if (!config) {
      throw new AiError(`unknown provider "${pid}"`, { kind: "config", provider: pid });
    }
    if (!config.enabled) {
      throw new AiError(`provider "${pid}" is disabled — enable it in Settings → AI`, {
        kind: "config",
        provider: pid,
      });
    }
    const adapter = createAdapter(config, {
      ...this.adapterOptions,
      secretResolver: this.adapterOptions.secretResolver ?? this.secretResolver,
    });
    this.adapters.set(pid, adapter);
    return adapter;
  }

  /** Health of every enabled provider, in parallel. For the settings screen. */
  async healthAll(): Promise<
    Record<string, { ok: boolean; models: number; latencyMs: number; error?: string }>
  > {
    const out: Record<string, { ok: boolean; models: number; latencyMs: number; error?: string }> = {};
    await Promise.all(
      this.list()
        .filter((c) => c.enabled)
        .map(async (c) => {
          out[c.id] = await this.adapterFor(c.id).health();
        }),
    );
    return out;
  }

  /**
   * Probe providers in parallel. Disabled ones are skipped: probing a provider
   * the user switched off produces a red error for a thing they deliberately
   * turned off, which is noise, not information.
   */
  async probeAll(ids?: string[]): Promise<Record<string, ProviderProbe>> {
    const wanted = this.list().filter(
      (c) => (ids ? ids.includes(c.id) : c.enabled),
    );
    const out: Record<string, ProviderProbe> = {};
    await Promise.all(
      wanted.map(async (c) => {
        try {
          out[c.id] = await this.adapterFor(c.id).probe();
        } catch (e) {
          out[c.id] = {
            ok: false,
            latencyMs: 0,
            models: 0,
            modelIds: [],
            embedOk: false,
            error: redact(errorMessage(e)),
            kind: isAiError(e) ? e.kind : "config",
          };
        }
      }),
    );
    return out;
  }
}

export const PROVIDERS_SETTING_KEY = "ai.providers";
export const DEFAULT_PROVIDER_SETTING_KEY = "ai.defaultProvider";
export const ENABLED_PROVIDERS_SETTING_KEY = "ai.enabledProviders";

/**
 * Build the registry from `setting` rows.
 *
 * Recognised keys:
 *   ai.providers        JSON array of ProviderConfig
 *   ai.provider.<id>    JSON one-per-row form
 *   ai.defaultProvider  provider id
 *   ai.enabledProviders JSON array of ids
 *
 * A raw key found in a row is dropped, never used and never echoed: Strata
 * stores keychain references (`apiKeyRef`) and resolves them through
 * `secretResolver`.
 */
export function registryFromSettings(
  rows: { key: string; value: string }[],
  opts: { secretResolver?: SecretResolver; adapterOptions?: AdapterOptions } = {},
): ProviderRegistry {
  const warnings: string[] = [];
  const byKey = new Map<string, string>();
  for (const r of rows ?? []) byKey.set(r.key, r.value);

  const parsed: ProviderConfig[] = [];

  const bulk = byKey.get(PROVIDERS_SETTING_KEY);
  if (bulk) {
    try {
      const v = JSON.parse(bulk) as unknown;
      if (Array.isArray(v)) {
        for (const c of v) {
          const cfg = coerceConfig(c, warnings);
          if (cfg) parsed.push(cfg);
        }
      } else if (v && typeof v === "object") {
        for (const [id, c] of Object.entries(v as Record<string, unknown>)) {
          const cfg = coerceConfig({ id, ...(isRecord(c) ? c : {}) }, warnings);
          if (cfg) parsed.push(cfg);
        }
      } else {
        warnings.push(`${PROVIDERS_SETTING_KEY} is not a JSON array — ignored`);
      }
    } catch (e) {
      warnings.push(`${PROVIDERS_SETTING_KEY} is not valid JSON — ignored (${errorMessage(e)})`);
    }
  }

  for (const [key, value] of byKey) {
    if (!key.startsWith("ai.provider.")) continue;
    const idHint = key.slice("ai.provider.".length);
    try {
      const cfg = coerceConfig({ id: idHint, ...(JSON.parse(value) as object) }, warnings);
      if (cfg) parsed.push(cfg);
    } catch (e) {
      warnings.push(`${key} is not valid JSON — ignored (${errorMessage(e)})`);
    }
  }

  const configs = mergePresets(parsed);

  const enabled = byKey.get(ENABLED_PROVIDERS_SETTING_KEY);
  if (enabled) {
    try {
      const ids = new Set(JSON.parse(enabled) as string[]);
      for (const c of configs) c.enabled = ids.has(c.id);
    } catch (e) {
      warnings.push(`${ENABLED_PROVIDERS_SETTING_KEY} is not a JSON array — ignored (${errorMessage(e)})`);
    }
  }

  const registry = new ProviderRegistry(configs, {
    defaultId: byKey.get(DEFAULT_PROVIDER_SETTING_KEY),
    secretResolver: opts.secretResolver,
    adapterOptions: opts.adapterOptions,
  });
  registry.warnings.push(...warnings);
  return registry;
}

function mergePresets(parsed: ProviderConfig[]): ProviderConfig[] {
  const out = defaultProviderConfigs();
  const byId = new Map(out.map((c) => [c.id, c]));
  for (const cfg of parsed) {
    const existing = byId.get(cfg.id);
    if (existing) {
      const merged = { ...existing, ...cfg };
      byId.set(cfg.id, merged);
      const i = out.findIndex((c) => c.id === cfg.id);
      out[i] = merged;
    } else {
      byId.set(cfg.id, cfg);
      out.push(cfg);
    }
  }
  return out;
}

function coerceConfig(raw: unknown, warnings: string[]): ProviderConfig | null {  if (!isRecord(raw)) {
    warnings.push("provider entry is not an object — ignored");
    return null;
  }
  const src: Record<string, unknown> = { ...raw };
  const id = String(src.id ?? "").trim();
  if (!id) {
    warnings.push("provider entry has no id — ignored");
    return null;
  }
  const kind = String(src.kind ?? "openai-compatible") as ProviderKind;
  if (!["strata", "ollama", "lmstudio", "openai-compatible"].includes(kind)) {
    warnings.push(`provider "${id}" has unknown kind "${kind}" — ignored`);
    return null;
  }

  // Secrets: strip anything key-shaped. The reference is the only thing stored.
  for (const field of SECRET_SETTING_FIELDS) {
    if (src[field] != null && src[field] !== "") {
      warnings.push(
        `provider "${id}": dropped "${field}" from stored settings — Strata keeps a keychain reference (apiKeyRef), never the key`,
      );
      delete src[field];
    }
  }
  if (src.headers != null) {
    warnings.push(`provider "${id}": dropped custom headers — they can carry credentials`);
    delete src.headers;
  }
  if (typeof src.apiKeyRef !== "string" || !src.apiKeyRef.trim()) delete src.apiKeyRef;

  const baseUrl = String(src.baseUrl ?? "").trim();
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    warnings.push(`provider "${id}": base URL must be http(s) — "${baseUrl}" ignored`);
  }
  const preset = defaultProviderConfigs().find((c) => c.id === id);

  const config: ProviderConfig = {
    id,
    label: String(src.label ?? preset?.label ?? id),
    kind,
    baseUrl: baseUrl || preset?.baseUrl || "",
    model: String(src.model ?? preset?.model ?? ""),
    enabled: src.enabled === undefined ? (preset?.enabled ?? true) : Boolean(src.enabled),
  };
  const embedModel = src.embedModel;
  if (typeof embedModel === "string" && embedModel.trim()) config.embedModel = embedModel.trim();
  else if (preset?.embedModel) config.embedModel = preset.embedModel;
  if (typeof src.apiKeyRef === "string") config.apiKeyRef = src.apiKeyRef.trim();
  return config;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence: provider settings in the `setting` table
//
// The API layer owns the HTTP surface; these are the reads and writes behind it.
// A raw key can arrive in a POST body from a form that has a key field — it is
// stripped here, before the row is written, so the database never holds a
// secret. Only `apiKeyRef` (a keychain reference) is persisted.
// ─────────────────────────────────────────────────────────────────────────────

/** The stored list, or the presets when nothing is saved yet. */
export function loadProviderConfigs(db: Db, ws: string): ProviderConfig[] {
  const row = db.get<{ value: string }>(
    "SELECT value FROM setting WHERE ws = ? AND key = ?",
    ws,
    PROVIDERS_SETTING_KEY,
  );
  if (!row) return defaultProviderConfigs();
  const warnings: string[] = [];
  try {
    const parsed = JSON.parse(row.value) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed)
        ? Object.entries(parsed).map(([id, cfg]) => ({ id, ...(isRecord(cfg) ? cfg : {}) }))
        : [];
    const configs = list
      .map((c) => coerceConfig(c, warnings))
      .filter((c): c is ProviderConfig => c !== null);
    return configs.length ? configs : defaultProviderConfigs();
  } catch {
    return defaultProviderConfigs();
  }
}

/** Upsert one provider by id. Returns the new list, so the caller can re-send it. */
export function saveProviderConfig(db: Db, ws: string, config: ProviderConfig): ProviderConfig[] {
  const warnings: string[] = [];
  const clean = coerceConfig(config, warnings);
  if (!clean) throw new AiError(`provider was rejected: ${warnings.join("; ")}`, {
    kind: "config",
    provider: String(config?.id ?? ""),
  });
  const list = loadProviderConfigs(db, ws);
  const at = list.findIndex((c) => c.id === clean.id);
  if (at >= 0) list[at] = clean;
  else list.push(clean);
  writeProviderConfigs(db, ws, list);
  return list;
}

export function deleteProviderConfig(db: Db, ws: string, id: string): ProviderConfig[] {
  const list = loadProviderConfigs(db, ws).filter((c) => c.id !== id);
  writeProviderConfigs(db, ws, list);
  return list;
}

export function writeProviderConfigs(db: Db, ws: string, configs: ProviderConfig[]): void {
  db.run(
    `INSERT INTO setting (ws, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ws, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ws,
    PROVIDERS_SETTING_KEY,
    JSON.stringify(configs),
    Date.now(),
  );
}

/** Registry wired to the saved settings, ready for the API layer. */
export function registryFromDatabase(
  db: Db,
  ws: string,
  opts: { secretResolver?: SecretResolver; adapterOptions?: AdapterOptions } = {},
): ProviderRegistry {
  const rows: { key: string; value: string }[] = db
    .all<{ key: string; value: string }>("SELECT key, value FROM setting WHERE ws = ?", ws)
    .map((r) => ({ key: r.key, value: r.value }));
  const registry = registryFromSettings(rows, opts);
  registry.setDefault(registry.defaultProviderId ?? "strata");
  return registry;
}
