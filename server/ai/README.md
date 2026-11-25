# Local AI layer

Provider adapters and the AI actions. Everything here runs on the user's
machine: the default provider is the Strata bridge on loopback, the presets are
Ollama and LM Studio, and the app works with none of them running — the AI
features are simply hidden.

```
server/ai/
  providers.ts  adapter interface, presets, registry, OpenAI-compatible client
  actions.ts    summarize / translate / fixGrammar / changeTone / autofill / askWorkspace
  prompts.ts    the templates the actions send
  json.ts       digging JSON out of a chatty model
  index.ts      re-exports (this is what server/index.ts imports)
```

No npm dependencies. Global `fetch` (Node 24) only.

## Providers

### Strata (default)

Nothing to install. The Strata bridge serves OpenAI-compatible routes on
loopback:

| | |
| --- | --- |
| base URL | `http://127.0.0.1:47831/v1` |
| models | `GET /v1/models` |
| chat | `POST /v1/chat/completions` |
| model id | `swift-iq3_s` (context 524288) |
| API key | not required from localhost |
| embeddings | **no route** — `capabilities.embed` is `false` |

The bridge is plain OpenAI-compatible: no custom headers, no special auth. The
model also emits `message.reasoning_content` (and reasoning deltas while
streaming). That is the model's chain of thought: the client reads
`message.content` / `delta.content` only, and **reasoning is never surfaced as
answer text** — not in a chat result, not in a stream, not in a document.

Because there is no embedding route, workspace Q&A (`askWorkspace`) and index
rebuilding need Ollama or LM Studio; `askWorkspace` returns
`{ok:false, error:"no embedding index"}` when nothing is indexed.

### Ollama

```powershell
ollama serve                 # usually started as a service; listens on 127.0.0.1:11434
ollama pull llama3.1:8b      # chat model
ollama pull nomic-embed-text # embeddings, for workspace Q&A
```

Preset: base URL `http://127.0.0.1:11434/v1`. Chat goes through the
OpenAI-compatible `/v1/chat/completions`. Two routes are Ollama-native and the
client uses them deliberately:

- models: `GET /api/tags` (not `/v1/models`)
- embeddings: `POST /api/embed` with `{model, input}` → `{embeddings: number[][]}`

`jsonMode` sends both `response_format:{type:"json_object"}` and Ollama's own
`format:"json"`, so strict and loose servers both get the hint.

### LM Studio

1. LM Studio → Local Server → load a chat model → **Start Server**
   (default `http://127.0.0.1:1234/v1`).
2. For workspace Q&A, also load an embedding model (e.g. `nomic-embed-text`) —
   LM Studio serves more than one model at a time only in recent versions, so
   indexing and chat may need the model swapped in the settings screen.
3. Settings → AI → LM Studio: set `model` to the loaded chat model and
   `embedModel` to the embedding model. Both fields can be left empty and
   filled from the model list.

Fully OpenAI-compatible: `/v1/models`, `/v1/chat/completions`,
`/v1/embeddings`.

### OpenAI-compatible (any other gateway)

Set `baseUrl` and `model`, plus `apiKeyRef` — a **keychain reference string**,
never the key. The client resolves it through an injected resolver:

```ts
const adapter = createAdapter(config, {
  secretResolver: (ref) => keychain.get(ref),   // string | null
});
```

A raw key is stripped from anything read out of the settings table (with a
warning in `registry.warnings`), and `Authorization` is redacted from every
error string, log line and toast. If the reference cannot be resolved the
request fails before it is sent, with a message naming the reference.

## Settings rows

Provider settings live in the `setting` table; the layer reads and writes them
through the API layer's `Db`:

```ts
loadProviderConfigs(db, ws)                  // saved list, or the presets
saveProviderConfig(db, ws, config)           // upsert by id, returns the list
deleteProviderConfig(db, ws, id)             // remove, returns the list
registryFromDatabase(db, ws, { secretResolver })
registryFromSettings(rows, { secretResolver })  // pure, from {key,value}[]
```

Recognised keys:

| key | value |
| --- | --- |
| `ai.providers` | JSON array of `ProviderConfig` |
| `ai.provider.<id>` | JSON, one provider per row |
| `ai.defaultProvider` | provider id |
| `ai.enabledProviders` | JSON array of ids |

Unknown kinds, non-`http(s)` base URLs and key-shaped fields (`apiKey`,
`api_key`, `key`, `token`, `secret`, …) are rejected on read, never stored.

## Using it

```ts
import { runAction, registryFromDatabase } from "../server/ai/index.ts";

const registry = registryFromDatabase(db, ws, { secretResolver });
const adapter = registry.adapterFor("ollama");

await runAction(
  { action: "summarize", providerId: "ollama", text: pageText },
  { adapter },
);

await runAction(
  { action: "autofill", providerId: "ollama", rowId },
  { adapter, getRowContext: async (rowId) => ({ title, values, properties }) },
);

await runAction(
  { action: "askWorkspace", providerId: "ollama", question: "what slipped?" },
  { adapter, retrieve: (query, k) => retrieve(db, ws, query, k, config) },
);
```

`runAction` never throws: a provider failure comes back as
`{ok:false, error:"…"}` with a human message, so the UI can show it directly.

Text actions return the transformed text only — a preamble like
"Here is the summary:" and a trailing "I hope this helps!" are stripped, and an
empty answer is a failure, not an empty success. Input is clamped to
`maxInputChars` (default 12000) with a visible truncation warning, so a huge
page is never shipped whole.

`autofill` treats the model's JSON as untrusted input:

- every key is resolved against the real `PropertyDef` list (exact name,
  case/punctuation-insensitive, or property id); anything else is dropped;
- `select` / `status` values must name an existing option — the name is mapped
  to the option **id**, and a name that matches nothing is dropped with a
  warning listing the allowed options;
- `multi_select` keeps the options that exist and reports the ones that do not;
- `number` is coerced (`"1,200"` → `1200`, `"$1 200,50"` → `1200.5`,
  `"12.5 kg"` → `12.5`), `checkbox` is coerced (`"yes"`, `"on"`, `"checked"`),
  `date` is parsed into `{start, end, allDay}` in epoch ms (ISO, ISO interval,
  `YYYY-MM-DD -> YYYY-MM-DD`, `MM/DD/YYYY`, `DD.MM.YYYY`, "March 5, 2024",
  "tomorrow");
- computed and audit properties (`formula`, `rollup`, `created_*`,
  `last_edited_*`, `button`, `unique_id`) are never filled;
- the result is keyed by `propId`, ready for `setPropertyValue`.

Dropped values are reported in `AiResult.text` as warnings.

`askWorkspace` builds numbered `[1]…[n]` sources from `retrieve()`, asks for
citations, and returns only the sources the answer actually cited.

## Client guarantees

- **Timeouts.** 60s for chat/stream, 20s for model listing and health. The
  timeout is composed with the caller's `AbortSignal` (`AbortSignal.any`), so
  the request dies if *either* fires, and the two cases are reported apart:
  `AiTimeoutError` (named) versus `AiAbortedError`.
- **Retries.** 429 and 5xx retry at most twice with jittered exponential
  backoff, honouring `Retry-After` up to 4s. A 4xx other than 429 is never
  retried.
- **SSE.** `data: [DONE]`, CRLF/CR/LF line endings, `:` comment lines,
  multi-line `data:` fields, and a chunk that splits a JSON object mid-token
  all parse. A provider that ignores `stream:true` and answers with one JSON
  body is handled too.
- **Errors.** `AiError` carries `status`, `provider`, `kind` and a human
  message: `ECONNREFUSED` → "provider not running — start Ollama / LM Studio",
  `404` → "check the base URL (is the server exposing /v1?)", `5xx` → "the
  model may be too large for RAM or still loading".
- **jsonMode.** `response_format:{type:"json_object"}` is sent, and the result
  is validated and repaired downstream (`extractJson`) for providers that
  ignore it.
- **Secrets.** No request body is ever logged. `Authorization` is redacted from
  every string the layer can produce.

## Tests

No internet, no model server:

```powershell
& .\node_modules\.bin\tsx.cmd scripts/test-ai.ts
```

A fake provider on `127.0.0.1`, bound to an ephemeral port, serves the verified
Strata model list, chat, awkward SSE streams, Ollama's `/api/tags` and
`/api/embed`, `/v1/embeddings`, a 400 that echoes the `Authorization` header,
a 429 that recovers, a permanent 500, and a stream that never ends. The suite
ends with one live call: if `http://127.0.0.1:47831/v1/models` answers, it runs
a real `summarize` against `swift-iq3_s` and prints the result as an
informational line. That line never fails the suite.
