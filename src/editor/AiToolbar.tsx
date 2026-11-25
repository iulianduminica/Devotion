/**
 * Inline AI toolbar.
 *
 * Rule: with no provider configured, this component renders nothing — AI is
 * hidden, not broken. Every write goes back through the normal block update
 * path with `x-strata-actor: ai:<provider>`, so an AI edit is one undo step and
 * shows up in page history attributed to the model.
 *
 * Three things this version adds, because a local-AI app that hides them reads
 * as a demo:
 *   - a model switcher in the bar, so changing provider or model is one click
 *     and the list comes from the server rather than from memory;
 *   - streaming with a Stop that really cancels the upstream request;
 *   - an explicit outcome step — insert below, replace the selection, or
 *     discard — because silently rewriting a person's paragraph is the fastest
 *     way to make them stop trusting the feature.
 *
 * The privacy line is not decoration: on a local-first app, "nothing leaves
 * your machine" is the claim, and the honest version of it names what is sent,
 * to which process, on which port.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Languages,
  Loader2,
  Sparkles,
  Star,
  StopCircle,
  Trash2,
  WandSparkles,
  Zap,
} from "lucide-react";

import { api } from "../api.ts";
import { ModelPicker } from "../components/ModelPicker.tsx";
import type { AiResult, ProviderConfig } from "../../shared/types.ts";

export interface AiToolbarProps {
  /** current selection as plain text */
  selection: string;
  nodeId: string;
  /** insert the answer below the selected block (non-destructive) */
  onInsert: (text: string) => void;
  /** replace the selected block with the answer */
  onReplace: (text: string) => void;
  notify: (message: string) => void;
}

const ACTIONS = [
  { key: "summarize", label: "Summarize", icon: Sparkles },
  { key: "fixGrammar", label: "Fix grammar", icon: WandSparkles },
  { key: "translate", label: "Translate", icon: Languages },
  { key: "changeTone", label: "Change tone", icon: Zap },
] as const;

type ActionKey = (typeof ACTIONS)[number]["key"];

interface Pending {
  action: ActionKey;
  text: string;
  stopped: boolean;
}

interface Meta {
  provider: string;
  model: string;
  ms?: number;
  usage?: AiResult["usage"];
}

function words(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function AiToolbar(props: AiToolbarProps): React.ReactNode {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [busy, setBusy] = useState<ActionKey | null>(null);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [switcher, setSwitcher] = useState(false);
  const [target, setTarget] = useState("English");
  const [tone, setTone] = useState("more formal");
  const abortRef = useRef<AbortController | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void api
      .aiProviders()
      .then((res) => {
        const enabled = (res.providers ?? []).filter((p) => p.enabled);
        setProviders(enabled);
        setDefaultId(res.defaultProvider ?? null);
        const chosen = enabled.find((p) => p.id === res.defaultProvider) ?? enabled[0];
        if (chosen) {
          setProviderId(chosen.id);
          setModel(chosen.model);
        }
      })
      .catch(() => setProviders([]));
  }, []);

  // Unmount during a stream: close the socket, so the model stops generating.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!switcher) return;
    const close = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setSwitcher(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [switcher]);

  const current = useMemo(() => providers.find((p) => p.id === providerId) ?? null, [providers, providerId]);

  /**
   * Mirror of the streamed text in a ref, so the Stop path can read the partial
   * answer from inside the event callback without a stale closure.
   */
  const streamingRef = useRef<string | null>(null);
  streamingRef.current = streaming;

  // No provider → render nothing (not a disabled, not-broken control).
  if (providers.length === 0) return null;

  const selectProvider = (p: ProviderConfig): void => {
    setProviderId(p.id);
    setModel(p.model);
    setSwitcher(false);
  };

  const run = async (action: ActionKey): Promise<void> => {
    const text = props.selection.trim();
    if (!text) {
      props.notify("Select some text first");
      return;
    }
    setBusy(action);
    setStreaming("");
    setPending(null);
    setMeta({ provider: current?.label ?? providerId, model });

    const controller = new AbortController();
    abortRef.current = controller;
    let stopped = false;

    try {
      await api.aiActionStream(
        {
          action,
          providerId,
          text,
          targetLang: action === "translate" ? target : undefined,
          tone: action === "changeTone" ? tone : undefined,
          nodeId: props.nodeId,
        },
        (event) => {
          if (event.type === "meta") {
            setMeta({ provider: event.provider, model: event.model });
            return;
          }
          if (event.type === "delta") {
            setStreaming((s) => (s ?? "") + event.text);
            return;
          }
          if (event.type === "done") {
            setMeta({ provider: event.result.provider, model: event.result.model, ms: event.result.ms, usage: event.result.usage });
            setStreaming(event.result.text ?? null);
            setPending({ action, text: (event.result.text ?? "").trim(), stopped: false });
            return;
          }
          // error
          const message = event.result.error ?? "the model returned nothing";
          setMeta({ provider: event.result.provider, model: event.result.model, ms: event.result.ms });
          if (/cancel/i.test(message)) {
            // Stop is a user decision, not a failure: keep what arrived.
            stopped = true;
            const partial = (streamingRef.current ?? "").trim();
            if (partial) setPending({ action, text: partial, stopped: true });
            return;
          }
          setStreaming(null);
          props.notify(message);
        },
        controller.signal,
      );
    } catch (err) {
      props.notify(`AI failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
      abortRef.current = null;
      if (stopped) props.notify("Stopped");
    }
  };

  const stop = (): void => {
    abortRef.current?.abort();
  };

  const accept = (mode: "insert" | "replace"): void => {
    if (!pending?.text) return;
    try {
      if (mode === "insert") props.onInsert(pending.text);
      else props.onReplace(pending.text);
      props.notify(mode === "insert" ? "Inserted below" : "Selection replaced");
    } catch (err) {
      props.notify(`Could not apply: ${(err as Error).message}`);
    }
    setPending(null);
    setStreaming(null);
  };

  const selectionWords = words(props.selection);

  return (
    <div style={{ position: "relative" }}>
      <div className="sn-ai-bar">
        <span className="sn-eyebrow" style={{ marginRight: 4 }}>
          AI
        </span>

        {ACTIONS.map((a) => {
          const Icon = a.icon;
          return (
            <button
              key={a.key}
              className="sn-btn sn-btn-ghost sn-btn-sm"
              disabled={busy !== null}
              onClick={() => void run(a.key)}
              title={selectionWords ? a.label : "Select text first"}
            >
              {busy === a.key ? <Loader2 size={12} strokeWidth={1.5} /> : <Icon size={12} strokeWidth={1.5} />}
              {a.label}
            </button>
          );
        })}

        {busy === "translate" && (
          <input className="sn-input" style={{ width: 110 }} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Language" />
        )}
        {busy === "changeTone" && (
          <input className="sn-input" style={{ width: 130 }} value={tone} onChange={(e) => setTone(e.target.value)} placeholder="Tone" />
        )}

        {busy !== null && (
          <button className="sn-btn sn-btn-sm" onClick={stop}>
            <StopCircle size={12} strokeWidth={1.5} />
            Stop
          </button>
        )}

        <div style={{ flex: 1 }} />

        {/* provider + model switcher */}
        <div ref={wrapRef} style={{ position: "relative" }}>
          <button
            className="sn-ai-chip"
            onClick={() => setSwitcher((s) => !s)}
            aria-haspopup="menu"
            aria-expanded={switcher}
            title="Change provider or model"
          >
            <Sparkles size={11} strokeWidth={1.5} />
            {current?.label ?? providerId}
            <span style={{ color: "var(--text-tertiary)" }}>·</span>
            <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {model || "no model"}
            </span>
          </button>

          {switcher && (
            <div className="sn-pop is-open" style={{ right: 0, bottom: "calc(100% + 4px)", minWidth: 300 }}>
              <div style={{ padding: "4px 8px" }} className="sn-eyebrow">
                Provider
              </div>
              {providers.map((p) => (
                <button key={p.id} type="button" className={`sn-opt${p.id === providerId ? " is-active" : ""}`} onClick={() => selectProvider(p)}>
                  <span style={{ width: 12, display: "inline-flex" }}>
                    {p.id === providerId && <Check size={12} strokeWidth={1.5} />}
                  </span>
                  <span className="sn-opt-main">
                    <span className="sn-opt-title">{p.label}</span>
                    <span className="sn-opt-sub">{hostOf(p.baseUrl)} · {p.model || "no model"}</span>
                  </span>
                  {p.id === defaultId && <Star size={11} strokeWidth={1.5} />}
                </button>
              ))}

              <div style={{ borderTop: "1px solid var(--border-subtle)", margin: "4px 0" }} />

              <div style={{ padding: "4px 8px" }} className="sn-eyebrow">
                Model
              </div>
              <div style={{ padding: "0 8px 8px" }}>
                <ModelPicker
                  providerId={providerId}
                  value={model}
                  drop="up"
                  width={260}
                  onPick={(m) => {
                    setModel(m);
                    setSwitcher(false);
                  }}
                  notify={props.notify}
                />
              </div>

              <div style={{ borderTop: "1px solid var(--border-subtle)", padding: 8, display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  className="sn-btn sn-btn-sm"
                  disabled={providerId === defaultId}
                  onClick={async () => {
                    await api.setDefaultProvider(providerId);
                    setDefaultId(providerId);
                    props.notify(`${current?.label ?? providerId} is now the default`);
                  }}
                >
                  <Star size={12} strokeWidth={1.5} />
                  {providerId === defaultId ? "Default provider" : "Set as default"}
                </button>
                <span style={{ fontSize: "var(--text-xxs)", color: "var(--text-tertiary)" }}>
                  {current?.embedModel ? `embeddings: ${current.embedModel}` : "no embeddings — Q&A is keyword-only"}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* what is about to be sent — the local-first promise, stated plainly */}
      {selectionWords > 0 && busy === null && (
        <div className="sn-ai-meta">
          <span>
            sends {selectionWords} word{selectionWords === 1 ? "" : "s"} from this page to {current?.label ?? providerId}
            {current ? ` at ${hostOf(current.baseUrl)}` : ""}
          </span>
        </div>
      )}

      {/* the answer, before it touches the document */}
      {(streaming !== null || pending) && (
        <>
          {streaming !== null && <div className="sn-ai-stream">{streaming}{busy !== null && <span style={{ color: "var(--text-tertiary)" }}> ▌</span>}</div>}
          <div className="sn-ai-meta">
            {pending ? (
              <>
                <button className="sn-btn sn-btn-primary sn-btn-sm" onClick={() => accept("insert")}>
                  Insert below
                </button>
                <button className="sn-btn sn-btn-sm" onClick={() => accept("replace")}>
                  Replace selection
                </button>
                <button
                  className="sn-btn sn-btn-ghost sn-btn-sm"
                  onClick={() => {
                    setPending(null);
                    setStreaming(null);
                  }}
                >
                  <Trash2 size={12} strokeWidth={1.5} />
                  Discard
                </button>
                {pending.stopped && <span style={{ color: "var(--status-warning)" }}>stopped early — partial answer</span>}
              </>
            ) : (
              <span>generating…</span>
            )}
            {meta?.ms != null && <span>{(meta.ms / 1000).toFixed(1)}s</span>}
            {meta?.usage && (
              <span>
                {meta.usage.promptTokens !== null ? `${meta.usage.promptTokens}+${meta.usage.completionTokens ?? 0} tokens` : `${meta.usage.chars.toLocaleString()} chars`}
              </span>
            )}
            {meta?.model && <span>{meta.provider} · {meta.model}</span>}
          </div>
        </>
      )}
    </div>
  );
}
