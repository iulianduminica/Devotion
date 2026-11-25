/**
 * AI provider settings: two panes.
 *
 * The old screen was a flat list of rows that mixed configuration with
 * diagnostics, so the only thing it could tell you was "Enabled" and a model
 * count. This splits it the way Cursor, Continue and Zed do: the left pane is
 * the fleet with a live status per provider, the right pane is everything about
 * the one you selected — endpoints, model pickers, key reference, a probe you
 * can read, and the last calls it made.
 *
 * Rules this file keeps:
 *   - A disabled provider is never probed. Probing it produced the red
 *     "provider is disabled — enable it in Settings → AI" error *inside* that
 *     settings screen, which is noise dressed as information.
 *   - Status is a state, not a flag: Ready / Not running / No models /
 *     Not tested, each with the sentence that explains it.
 *   - A raw API key is never sent to the server: only a keychain reference,
 *     resolved at request time.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  Lock,
  Plus,
  Radar,
  RefreshCw,
  Star,
  Trash2,
} from "lucide-react";

import { api } from "../api.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import type {
  AiUsageSummary,
  DetectedProvider,
  ProviderConfig,
  ProviderKind,
  ProviderProbe,
} from "../../shared/types.ts";

const PRESETS: Record<ProviderKind, { baseUrl: string; model: string; embedModel: string }> = {
  strata: { baseUrl: "http://127.0.0.1:47831/v1", model: "swift-iq3_s", embedModel: "" },
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.1:8b", embedModel: "nomic-embed-text" },
  lmstudio: { baseUrl: "http://127.0.0.1:1234/v1", model: "", embedModel: "" },
  "openai-compatible": { baseUrl: "http://127.0.0.1:8080/v1", model: "", embedModel: "" },
};

type Tone = "ok" | "bad" | "warn" | "off";

interface Status {
  tone: Tone;
  label: string;
  detail: string;
}

/**
 * One honest status per provider.
 *
 * "No models" is separated from "Not running" on purpose: a reachable Ollama
 * with nothing pulled is a different fix (pull a model) from a server that is
 * not started, and collapsing them sends the user to the wrong answer.
 */
export function statusOf(p: ProviderConfig, probe?: ProviderProbe): Status {
  if (!p.enabled) {
    return { tone: "off", label: "Disabled", detail: "Switched off — nothing is sent to it, and it is never probed" };
  }
  if (!p.baseUrl.trim()) {
    return { tone: "warn", label: "No endpoint", detail: "Set a base URL before this provider can be used" };
  }
  if (!probe) {
    return { tone: "off", label: "Not tested", detail: "Test to see latency, models and embedding support" };
  }
  if (!probe.ok) {
    return { tone: "bad", label: "Not running", detail: probe.error ?? `cannot reach ${p.baseUrl}` };
  }
  if (probe.models === 0) {
    return {
      tone: "warn",
      label: "No models",
      detail: "reachable, but it serves no models — pull one, e.g. `ollama pull llama3.1`",
    };
  }
  return {
    tone: "ok",
    label: "Ready",
    detail: `${probe.models} model${probe.models === 1 ? "" : "s"} · ${probe.latencyMs} ms`,
  };
}

function pluralModels(n: number): string {
  return `${n} model${n === 1 ? "" : "s"}`;
}

export function AiSettings(props: { notify: (m: string) => void }): React.ReactNode {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, ProviderProbe>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<DetectedProvider[] | null>(null);
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildNote, setRebuildNote] = useState("");
  const [form, setForm] = useState({
    open: false,
    label: "",
    kind: "ollama" as ProviderKind,
    baseUrl: PRESETS.ollama.baseUrl,
    model: PRESETS.ollama.model,
    embedModel: PRESETS.ollama.embedModel,
    apiKeyRef: "",
  });

  const load = useCallback(async (): Promise<void> => {
    const res = await api.aiProviders();
    setProviders(res.providers ?? []);
    setDefaultId(res.defaultProvider ?? null);
    setSelected((cur) => cur ?? (res.providers?.[0]?.id ?? null));
  }, []);

  useEffect(() => {
    void load().catch((err) => props.notify(`AI settings failed to load: ${(err as Error).message}`));
  }, [load, props]);

  useEffect(() => {
    void api.aiUsage({ recent: 8 }).then(setUsage).catch(() => setUsage(null));
  }, []);

  const probeAll = useCallback(async (): Promise<void> => {
    setTesting("all");
    try {
      setProbes((await api.aiTest()) as Record<string, ProviderProbe>);
    } catch (err) {
      props.notify(`Probe failed: ${(err as Error).message}`);
    } finally {
      setTesting(null);
    }
  }, [props]);

  // Probe enabled providers on open: the panel should answer "is this working"
  // without the user asking, and it must not ask a provider they switched off.
  useEffect(() => {
    if (providers.some((p) => p.enabled)) void probeAll();
    // once per mount; providers arrive from the initial load
  }, [providers.length, probeAll]);

  const current = useMemo(
    () => providers.find((p) => p.id === selected) ?? providers[0] ?? null,
    [providers, selected],
  );

  const patch = async (id: string, fields: Partial<ProviderConfig>): Promise<void> => {
    try {
      const next = await api.patchProvider(id, fields);
      setProviders(next ?? []);
    } catch (err) {
      props.notify(`Update failed: ${(err as Error).message}`);
    }
  };

  const testOne = async (id: string): Promise<void> => {
    setTesting(id);
    try {
      const res = (await api.aiTest(id)) as Record<string, ProviderProbe>;
      setProbes((prev) => ({ ...prev, ...res }));
    } catch (err) {
      props.notify(`Test failed: ${(err as Error).message}`);
    } finally {
      setTesting(null);
    }
  };

  const detect = async (): Promise<void> => {
    setDetecting(true);
    try {
      const res = await api.aiDetect();
      setDetected(res.providers ?? []);
      const running = (res.providers ?? []).filter((d) => d.running);
      props.notify(running.length ? `${running.length} local server${running.length === 1 ? "" : "s"} found` : "nothing listening on the usual local ports");
    } catch (err) {
      props.notify(`Detect failed: ${(err as Error).message}`);
    } finally {
      setDetecting(false);
    }
  };

  const addDetected = async (d: DetectedProvider): Promise<void> => {
    const id = `${d.kind}-${d.origin.replace(/[^a-z0-9]/gi, "")}`;
    const embed = d.embedModelIds[0] ?? "";
    try {
      const next = await api.addProvider({
        id,
        label: d.label,
        kind: d.kind,
        baseUrl: d.baseUrl,
        model: d.modelIds.find((m) => !d.embedModelIds.includes(m)) ?? d.modelIds[0] ?? "",
        embedModel: embed || undefined,
        enabled: true,
      });
      setProviders(next ?? []);
      setSelected(id);
      props.notify(`${d.label} added with ${pluralModels(d.models)}`);
      void testOne(id);
    } catch (err) {
      props.notify(`Add failed: ${(err as Error).message}`);
    }
  };

  const removeProvider = async (id: string): Promise<void> => {
    try {
      await api.removeProvider(id);
      setConfirmRemove(null);
      setSelected(null);
      await load();
      props.notify("Provider removed");
    } catch (err) {
      props.notify(`Remove failed: ${(err as Error).message}`);
    }
  };

  const probe = current ? probes[current.id] : undefined;
  const status = current ? statusOf(current, probe) : null;
  const isDefault = !!current && current.id === defaultId;
  const embedCapable = current?.kind !== "strata";

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span className="sn-eyebrow">AI providers</span>
        <span style={{ flex: 1 }} />
        <button className="sn-btn sn-btn-sm" onClick={() => void detect()} disabled={detecting}>
          {detecting ? <Loader2 size={12} strokeWidth={1.5} /> : <Radar size={12} strokeWidth={1.5} />}
          Detect
        </button>
        <button className="sn-btn sn-btn-sm" onClick={() => void probeAll()} disabled={testing !== null}>
          {testing === "all" ? <Loader2 size={12} strokeWidth={1.5} /> : <RefreshCw size={12} strokeWidth={1.5} />}
          Test all
        </button>
      </div>

      {detected && detected.some((d) => d.running) && (
        <div className="sn-card" style={{ padding: 12, marginBottom: 8 }}>
          <div className="sn-eyebrow" style={{ marginBottom: 6 }}>Detected on this machine</div>
          {detected
            .filter((d) => d.running)
            .map((d) => (
              <div
                key={d.origin}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: "var(--text-sm)" }}
              >
                <span className="sn-dot" style={{ background: "var(--status-success)" }} />
                <span style={{ fontWeight: 500 }}>{d.label}</span>
                <span className="sn-badge">{d.origin}</span>
                <span style={{ color: "var(--text-tertiary)", fontSize: "var(--text-xs)" }}>
                  {pluralModels(d.models)}
                  {d.embedModelIds.length ? ` · ${d.embedModelIds.length} embedding` : ""} · {d.latencyMs} ms
                </span>
                <span style={{ flex: 1 }} />
                {providers.some((p) => p.baseUrl === d.baseUrl) ? (
                  <span className="sn-status is-ok">
                    <Check size={11} strokeWidth={1.5} />
                    added
                  </span>
                ) : (
                  <button className="sn-btn sn-btn-primary sn-btn-sm" onClick={() => void addDetected(d)}>
                    <Plus size={12} strokeWidth={1.5} />
                    Add
                  </button>
                )}
              </div>
            ))}
        </div>
      )}

      <div className="sn-ai-panes">
        {/* ── left: the fleet ─────────────────────────────────────────────── */}
        <div className="sn-ai-list">
          {providers.length === 0 && <div className="sn-empty">No providers — AI features stay hidden</div>}
          {providers.map((p) => {
            const s = statusOf(p, probes[p.id]);
            return (
              <button
                key={p.id}
                type="button"
                className={`sn-ai-row${current?.id === p.id ? " is-active" : ""}`}
                onClick={() => setSelected(p.id)}
              >
                <span className="sn-ai-row-main">
                  <span className="sn-ai-row-title">
                    {p.id === defaultId && <Star size={11} strokeWidth={1.5} style={{ marginRight: 4, verticalAlign: -1 }} />}
                    {p.label}
                  </span>
                  <span className="sn-ai-row-sub">{p.baseUrl || "no endpoint"} · {p.model || "no model"}</span>
                </span>
                <span className={`sn-status is-${s.tone}`}>
                  <span className={`sn-dot${s.tone === "ok" && testing === p.id ? " is-pulse" : ""}`} />
                  {s.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* ── right: the selected provider ────────────────────────────────── */}
        <div className="sn-ai-detail">
          {!current && <div className="sn-empty">Select a provider</div>}

          {current && status && (
            <>
              <div className="sn-ai-detail-head">
                <span style={{ fontSize: "var(--text-lg)", fontWeight: 600 }}>{current.label}</span>
                <span className="sn-badge">{current.kind}</span>
                <span className={`sn-status is-${status.tone}`}>
                  <span className="sn-dot" />
                  {status.label}
                </span>
                <span style={{ flex: 1 }} />
                <button
                  className={`sn-btn sn-btn-sm${isDefault ? " sn-btn-primary" : ""}`}
                  disabled={isDefault}
                  onClick={async () => {
                    await api.setDefaultProvider(current.id);
                    setDefaultId(current.id);
                    props.notify(`${current.label} is now the default`);
                  }}
                >
                  <Star size={12} strokeWidth={1.5} />
                  {isDefault ? "Default" : "Set as default"}
                </button>
                <button className="sn-btn sn-btn-sm" onClick={() => void testOne(current.id)} disabled={testing !== null}>
                  {testing === current.id ? <Loader2 size={12} strokeWidth={1.5} /> : <Radar size={12} strokeWidth={1.5} />}
                  Test
                </button>
              </div>

              <div
                style={{
                  fontSize: "var(--text-sm)",
                  color: status.tone === "bad" ? "var(--status-error)" : "var(--text-secondary)",
                  marginBottom: 16,
                }}
              >
                {status.detail}
              </div>

              <dl className="sn-kv" style={{ marginBottom: 16 }}>
                <dt>Enabled</dt>
                <dd>
                  <button
                    className="sn-btn sn-btn-sm"
                    onClick={() => void patch(current.id, { enabled: !current.enabled })}
                  >
                    {current.enabled ? "On — click to switch off" : "Off — click to enable"}
                  </button>
                </dd>

                <dt>Base URL</dt>
                <dd>
                  <input
                    className="sn-input"
                    style={{ width: "100%", maxWidth: 380 }}
                    defaultValue={current.baseUrl}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== current.baseUrl) void patch(current.id, { baseUrl: v });
                    }}
                    placeholder="http://127.0.0.1:11434/v1"
                  />
                </dd>

                <dt>Model</dt>
                <dd>
                  <ModelPicker
                    providerId={current.id}
                    value={current.model}
                    width={280}
                    onPick={(model) => void patch(current.id, { model })}
                    notify={props.notify}
                  />
                </dd>

                <dt>Embeddings</dt>
                <dd>
                  {embedCapable ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <ModelPicker
                        providerId={current.id}
                        kind="embed"
                        placeholder="No embedding model"
                        value={current.embedModel ?? ""}
                        width={260}
                        onPick={(embedModel) => void patch(current.id, { embedModel })}
                        notify={props.notify}
                      />
                      {probe && (
                        <span className={`sn-status ${probe.embedOk ? "is-ok" : "is-warn"}`}>
                          <span className="sn-dot" />
                          {probe.embedOk ? "embedding route works" : "no embedding route"}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span style={{ color: "var(--text-tertiary)" }}>
                      this provider exposes no embedding route — workspace Q&A stays keyword-based
                    </span>
                  )}
                </dd>

                {current.kind === "openai-compatible" && (
                  <>
                    <dt>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <Lock size={11} strokeWidth={1.5} />
                        Key
                      </span>
                    </dt>
                    <dd>
                      <input
                        className="sn-input"
                        style={{ width: "100%", maxWidth: 320 }}
                        defaultValue={current.apiKeyRef ?? ""}
                        placeholder="environment variable holding the key"
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v !== (current.apiKeyRef ?? "")) void patch(current.id, { apiKeyRef: v || undefined });
                        }}
                      />
                      <div style={{ fontSize: "var(--text-xxs)", color: "var(--text-tertiary)", marginTop: 4 }}>
                        the key itself is never stored here — only this reference, resolved at request time
                      </div>
                    </dd>
                  </>
                )}
              </dl>

              {probe && (
                <div style={{ display: "flex", gap: 16, fontSize: "var(--text-xs)", color: "var(--text-tertiary)", flexWrap: "wrap" }}>
                  <span>latency {probe.latencyMs} ms</span>
                  <span>{pluralModels(probe.models)}</span>
                  <span>embeddings {probe.embedOk ? "ok" : "unavailable"}</span>
                </div>
              )}

              {probe && !probe.ok && probe.error && (
                <div
                  style={{
                    marginTop: 12,
                    padding: 8,
                    border: "1px solid var(--border-default)",
                    borderLeft: "2px solid var(--status-error)",
                    borderRadius: "var(--radius-lg)",
                    background: "var(--bg-raised)",
                    fontSize: "var(--text-xs)",
                    display: "flex",
                    gap: 8,
                    alignItems: "flex-start",
                  }}
                >
                  <AlertTriangle size={12} strokeWidth={1.5} style={{ color: "var(--status-error)", flex: "none", marginTop: 2 }} />
                  <code style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{probe.error}</code>
                  <button
                    className="sn-btn sn-btn-ghost sn-btn-sm"
                    onClick={() => {
                      void navigator.clipboard?.writeText(probe.error ?? "");
                      props.notify("Error copied");
                    }}
                  >
                    <Copy size={12} strokeWidth={1.5} />
                  </button>
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 20, alignItems: "center" }}>
                {confirmRemove === current.id ? (
                  <>
                    <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
                      Remove {current.label}?
                    </span>
                    <button className="sn-btn sn-btn-destructive sn-btn-sm" onClick={() => void removeProvider(current.id)}>
                      Remove
                    </button>
                    <button className="sn-btn sn-btn-sm" onClick={() => setConfirmRemove(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    className="sn-btn sn-btn-ghost sn-btn-sm"
                    disabled={isDefault}
                    title={isDefault ? "Switch the default to another provider first" : undefined}
                    onClick={() => setConfirmRemove(current.id)}
                  >
                    <Trash2 size={12} strokeWidth={1.5} />
                    Remove
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── add provider ──────────────────────────────────────────────────── */}
      <div className="sn-card" style={{ padding: 12, marginTop: 8 }}>
        <button
          className="sn-btn sn-btn-ghost sn-btn-sm"
          onClick={() => setForm((f) => ({ ...f, open: !f.open }))}
        >
          <Plus size={12} strokeWidth={1.5} />
          Add provider
        </button>

        {form.open && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12, marginTop: 12, maxWidth: 720 }}>
            {(
              [
                ["kind", "Type"],
                ["label", "Label"],
                ["baseUrl", "Base URL"],
                ["model", "Model"],
                ["embedModel", "Embedding model (optional)"],
                ["apiKeyRef", "Key reference (OpenAI-compatible only)"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>{label}</span>
                {key === "kind" ? (
                  <select
                    className="sn-input"
                    value={form.kind}
                    onChange={(e) => setForm({ ...form, kind: e.target.value as ProviderKind, ...PRESETS[e.target.value as ProviderKind] })}
                  >
                    <option value="strata">Strata (local)</option>
                    <option value="ollama">Ollama</option>
                    <option value="lmstudio">LM Studio</option>
                    <option value="openai-compatible">OpenAI-compatible</option>
                  </select>
                ) : (
                  <input
                    className="sn-input"
                    value={form[key]}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  />
                )}
              </label>
            ))}
            <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, alignItems: "center" }}>
              <button
                className="sn-btn sn-btn-primary"
                onClick={async () => {
                  if (!form.label.trim() || !form.baseUrl.trim()) {
                    props.notify("A label and a base URL are required");
                    return;
                  }
                  const config: ProviderConfig = {
                    id: `${form.kind}-${Math.random().toString(36).slice(2, 8)}`,
                    label: form.label.trim(),
                    kind: form.kind,
                    baseUrl: form.baseUrl.trim(),
                    model: form.model.trim(),
                    embedModel: form.embedModel.trim() || undefined,
                    apiKeyRef: form.apiKeyRef.trim() || undefined,
                    enabled: true,
                  };
                  try {
                    const next = await api.addProvider(config);
                    setProviders(next ?? []);
                    setSelected(config.id);
                    setForm({ ...form, open: false, label: "" });
                    props.notify(`${config.label} added`);
                    void testOne(config.id);
                  } catch (err) {
                    props.notify(`Add failed: ${(err as Error).message}`);
                  }
                }}
              >
                <Plus size={13} strokeWidth={1.5} />
                Add provider
              </button>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
                keys are stored as a reference and resolved at request time — never written to the database
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── index + usage ─────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
        <button
          className="sn-btn sn-btn-sm"
          disabled={rebuilding}
          onClick={async () => {
            setRebuilding(true);
            setRebuildNote("");
            try {
              const r = (await api.aiRebuild()) as { chunks: number; ms: number; pages?: number; model?: string; skipped?: string };
              if (r.skipped) setRebuildNote(r.skipped);
              else setRebuildNote(`Indexed ${r.chunks} chunks across ${r.pages ?? 0} pages in ${(r.ms / 1000).toFixed(1)}s`);
              props.notify(r.skipped ? "No embedding provider" : `Indexed ${r.chunks} chunks`);
            } catch (err) {
              setRebuildNote((err as Error).message);
            } finally {
              setRebuilding(false);
            }
          }}
        >
          {rebuilding ? <Loader2 size={12} strokeWidth={1.5} /> : <RefreshCw size={12} strokeWidth={1.5} />}
          Rebuild search index
        </button>
        {rebuildNote && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{rebuildNote}</span>}
      </div>

      {usage && usage.calls > 0 && (
        <div className="sn-card" style={{ padding: 12, marginTop: 8 }}>
          <div className="sn-eyebrow" style={{ marginBottom: 8 }}>Recent AI calls</div>
          <div style={{ display: "flex", gap: 16, fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginBottom: 8, flexWrap: "wrap" }}>
            <span>{usage.calls} calls</span>
            <span>{usage.failed} failed</span>
            <span>avg {usage.avgMs} ms</span>
            <span>{usage.chars.toLocaleString()} chars generated</span>
            {(usage.promptTokens !== null || usage.completionTokens !== null) && (
              <span>
                {usage.promptTokens ?? 0} in / {usage.completionTokens ?? 0} out tokens
              </span>
            )}
          </div>
          {usage.recent.slice(0, 8).map((c, i) => (
            <div
              key={`${c.created_at}-${i}`}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                padding: "3px 0",
                borderTop: "1px solid var(--border-subtle)",
                fontSize: "var(--text-xs)",
              }}
            >
              <span className="sn-dot" style={{ background: c.ok ? "var(--status-success)" : "var(--status-error)" }} />
              <span style={{ width: 90, color: "var(--text-primary)" }}>{c.action}</span>
              <span style={{ width: 70, color: "var(--text-tertiary)" }}>{c.provider}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-tertiary)" }}>
                {c.ok ? `${c.chars.toLocaleString()} chars` : (c.error ?? "failed")}
              </span>
              <span style={{ color: "var(--text-tertiary)" }}>{c.ms} ms</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
