/**
 * Model picker.
 *
 * The settings screen used to make the user type a model name from memory, and
 * the editor's AI bar showed a provider with no way to change the model. Every
 * app in this space offers a list of what the server actually has; this is that
 * list, fetched from the provider.
 *
 * Two behaviours that are not optional:
 *
 *   - **A typed fallback.** Not every OpenAI-compatible server implements
 *     `/v1/models` (many single-model servers return 404). Failing to list is
 *     not a reason to block the user, so the popover keeps a free-text field
 *     and says why it is showing one.
 *   - **Keyboard parity.** Arrow keys, Enter, Escape and a filter box. The
 *     model switcher sits in the editor, where people are already holding
 *     Ctrl/Cmd and do not want to reach for the mouse.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Search, XCircle } from "lucide-react";

import { api } from "../api.ts";
import type { ModelInfo } from "../../shared/types.ts";

export interface ModelPickerProps {
  providerId: string;
  value: string;
  onPick: (model: string) => void;
  notify: (message: string) => void;
  /** `embed` filters the list to models that look like embedding models */
  kind?: "model" | "embed";
  placeholder?: string;
  /** open upward: the editor bar sits near the bottom of the viewport */
  drop?: "up" | "down";
  width?: number;
}

const EMBED_HINTS = ["embed", "bge", "nomic", "minilm", "mxbai", "gte", "snowflake", "jina", "text2vec"];

function looksLikeEmbedding(id: string): boolean {
  const lower = id.toLowerCase();
  return EMBED_HINTS.some((h) => lower.includes(h));
}

function contextLabel(m: ModelInfo): string {
  if (!m.contextLength) return "";
  const k = m.contextLength / 1024;
  return k >= 1 ? `${Math.round(k)}k ctx` : String(m.contextLength);
}

export function ModelPicker(props: ModelPickerProps): React.ReactNode {
  const { providerId, value, onPick, notify } = props;
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const loadedFor = useRef<string | null>(null);

  const load = async (): Promise<void> => {
    if (loadedFor.current === providerId && models !== null) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.aiModels(providerId);
      setModels(res.models ?? []);
      loadedFor.current = providerId;
    } catch (err) {
      // A server without /models is normal, not fatal: the typed fallback below.
      setError((err as Error).message);
      setModels([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadedFor.current = null;
    setModels(null);
  }, [providerId]);

  useEffect(() => {
    if (!open) return;
    void load();
    const focus = requestAnimationFrame(() => searchRef.current?.focus());
    const close = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => {
      cancelAnimationFrame(focus);
      document.removeEventListener("mousedown", close);
    };
    // load is stable enough for this effect; re-running it on every render
    // would re-fetch the model list on each keystroke in the filter box
  }, [open, providerId]);

  const list = useMemo(() => {
    const all = models ?? [];
    const scoped = props.kind === "embed" ? all.filter((m) => looksLikeEmbedding(m.id)) : all;
    const q = filter.trim().toLowerCase();
    return q ? scoped.filter((m) => m.id.toLowerCase().includes(q)) : scoped;
  }, [models, filter, props.kind]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, list.length - 1)));
  }, [list.length]);

  const pick = (id: string): void => {
    onPick(id);
    setOpen(false);
    setFilter("");
  };

  const onKeys = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(list.length - 1, c + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const typed = filter.trim();
      const hit = list[cursor];
      if (hit) pick(hit.id);
      else if (typed) pick(typed); // the typed fallback, straight from the filter box
    }
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-block", minWidth: props.width ?? 220 }}>
      <button
        type="button"
        className="sn-ai-chip"
        style={{ width: "100%", justifyContent: "space-between" }}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: value ? "var(--text-primary)" : "var(--text-tertiary)",
          }}
        >
          {value || props.placeholder || "Choose a model"}
        </span>
        <ChevronDown size={12} strokeWidth={1.5} />
      </button>

      {open && (
        <div
          className="sn-pop is-open"
          style={{
            left: 0,
            width: Math.max(280, props.width ?? 220),
            ...(props.drop === "up" ? { bottom: "calc(100% + 4px)" } : { top: "calc(100% + 4px)" }),
          }}
          role="listbox"
        >
          <div className="sn-pop-search">
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Search size={12} strokeWidth={1.5} />
              <input
                ref={searchRef}
                className="sn-input"
                style={{ border: 0, background: "transparent", padding: 0, height: 22 }}
                placeholder="Filter models"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={onKeys}
              />
            </div>
          </div>

          <div className="sn-pop-list">
            {loading && (
              <div style={{ display: "flex", gap: 6, padding: 8, color: "var(--text-tertiary)", fontSize: "var(--text-xs)" }}>
                <Loader2 size={12} strokeWidth={1.5} />
                reading the model list…
              </div>
            )}

            {!loading && error && (
              <div style={{ padding: 8, fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--status-warning)" }}>
                  <XCircle size={12} strokeWidth={1.5} />
                  this provider does not list models
                </div>
                <div style={{ color: "var(--text-tertiary)", marginTop: 4 }}>{error}</div>
                <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                  <input
                    className="sn-input"
                    style={{ flex: 1 }}
                    placeholder="Type a model name"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    onKeyDown={onKeys}
                  />
                  <button
                    className="sn-btn sn-btn-primary sn-btn-sm"
                    disabled={!filter.trim()}
                    onClick={() => pick(filter.trim())}
                  >
                    Use
                  </button>
                </div>
              </div>
            )}

            {!loading && !error && list.length === 0 && (
              <div style={{ padding: 8, fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
                {props.kind === "embed"
                  ? "no embedding models on this server — pull one, e.g. `ollama pull nomic-embed-text`"
                  : "no models on this server — pull one, e.g. `ollama pull llama3.1`"}
              </div>
            )}

            {list.map((m, i) => (
              <button
                key={m.id}
                type="button"
                className={`sn-opt${i === cursor ? " is-cursor" : ""}${m.id === value ? " is-active" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(m.id)}
              >
                <span style={{ width: 12, flex: "none", display: "inline-flex" }}>
                  {m.id === value && <Check size={12} strokeWidth={1.5} />}
                </span>
                <span className="sn-opt-main">
                  <span className="sn-opt-title">{m.id}</span>
                  {(contextLabel(m) || m.ownedBy) && (
                    <span className="sn-opt-sub">
                      {[contextLabel(m), m.ownedBy].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
