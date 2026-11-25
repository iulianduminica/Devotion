/**
 * Command palette (Ctrl/⌘+K).
 *
 * Two-stage mount so the overlay animates in AND out: `mounted` keeps the node
 * in the DOM long enough for the 260ms opacity/transform transition to play.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Download, FileText, LayoutTemplate, Moon, Plus, Search, Settings, Sparkles, Sun, Trash2 } from "lucide-react";

import { api } from "../api.ts";
import type { SearchHit } from "../../shared/types.ts";

type Command = {
  key: string;
  label: string;
  icon: ReactNode;
  run: () => void;
};

type Item =
  | { key: string; kind: "page"; title: string; path: string; id: string; icon: ReactNode }
  | { key: string; kind: "command"; label: string; path: string; icon: ReactNode; run: () => void };

const HINT: CSSProperties = {
  fontSize: "var(--text-xs)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--text-tertiary)",
};

function pathText(path: { title: string }[] | undefined): string {
  if (!path || path.length === 0) return "Top level";
  return path.map((c) => c.title || "Untitled").join(" / ");
}

export function CommandPalette(props: {
  open: boolean;
  onClose: () => void;
  onNavigate: (id: string) => void;
  onNewPage: () => void;
  onToggleTheme?: () => void;
  /** the page currently open, so export commands know what to export */
  pageId?: string | null;
  pageTitle?: string;
}): ReactNode {
  const { open, onClose, onNavigate, onNewPage, onToggleTheme, pageId, pageTitle } = props;

  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // ── two-stage mount: in on open, out 260ms after close ─────────────────────
  useEffect(() => {
    if (open) {
      setMounted(true);
      const outer = requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
      return () => cancelAnimationFrame(outer);
    }
    setVisible(false);
    const timer = window.setTimeout(() => setMounted(false), 260);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Reset the field each time the palette opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHits([]);
    setSel(0);
    setFailure(null);
    setSearching(false);
    const focus = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(focus);
  }, [open]);

  // ── debounced search ───────────────────────────────────────────────────────
  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setHits([]);
      setSearching(false);
      setFailure(null);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      void api
        .search(term, 20)
        .then((found) => {
          setHits(found);
          setSel(0);
          setFailure(null);
        })
        .catch((err: unknown) => {
          setHits([]);
          setFailure((err as Error).message || "Search failed");
        })
        .finally(() => setSearching(false));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  const commands = useMemo<Command[]>(
    () => [
      {
        key: "new-page",
        label: "New page",
        icon: <Plus size={14} strokeWidth={1.5} />,
        run: () => onNewPage(),
      },
      {
        key: "open-trash",
        label: "Open trash",
        icon: <Trash2 size={14} strokeWidth={1.5} />,
        run: () => {
          window.location.hash = "/trash";
        },
      },
      {
        key: "open-templates",
        label: "Open templates",
        icon: <LayoutTemplate size={14} strokeWidth={1.5} />,
        run: () => {
          window.location.hash = "/templates";
        },
      },
      {
        key: "open-settings",
        label: "Open settings",
        icon: <Settings size={14} strokeWidth={1.5} />,
        run: () => {
          window.location.hash = "/settings";
        },
      },
      {
        key: "ai-providers",
        label: "AI: providers and models",
        icon: <Sparkles size={14} strokeWidth={1.5} />,
        run: () => {
          window.location.hash = "/settings";
        },
      },
      {
        key: "ai-test",
        label: "AI: test connections",
        icon: <Sparkles size={14} strokeWidth={1.5} />,
        run: () => {
          // The panel probes every enabled provider as it opens, so navigating
          // there is the test — no separate screen to keep in sync.
          window.location.hash = "/settings";
        },
      },
      ...(onToggleTheme
        ? [
            {
              key: "toggle-theme",
              label: "Toggle theme (dark / light)",
              icon: <Moon size={14} strokeWidth={1.5} />,
              run: () => onToggleTheme(),
            },
          ]
        : []),
      ...(pageId
        ? [
            {
              key: "export-md",
              label: `Export "${pageTitle ?? "this page"}" as Markdown`,
              icon: <Download size={14} strokeWidth={1.5} />,
              run: () => downloadExport("markdown", pageId, pageTitle),
            },
            {
              key: "export-pdf",
              label: `Print / save "${pageTitle ?? "this page"}" as PDF`,
              icon: <Download size={14} strokeWidth={1.5} />,
              run: () => {
                void api.exportPdf(pageId, { page: "a4", toc: true }).catch((err: Error) => {
                  window.alert(err.message);
                });
              },
            },
            {
              key: "export-html",
              label: `Export "${pageTitle ?? "this page"}" as HTML`,
              icon: <Sun size={14} strokeWidth={1.5} />,
              run: () => downloadExport("html", pageId, pageTitle),
            },
          ]
        : []),
    ],
    [onNewPage, onToggleTheme, pageId, pageTitle],
  );

  /** Same-origin download of a server-rendered export. */
  function downloadExport(kind: "markdown" | "html", id: string, title?: string): void {
    const ext = kind === "markdown" ? "md" : "html";
    const safe = (title || "page").replace(/[\\/:*?"<>|]/g, "-").slice(0, 60);
    const a = document.createElement("a");
    a.href = api.exportUrl(kind, id);
    a.download = `${safe}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const items = useMemo<Item[]>(() => {
    const term = query.trim();
    if (!term) {
      return commands.map((c) => ({
        key: c.key,
        kind: "command" as const,
        label: c.label,
        path: "Command",
        icon: c.icon,
        run: c.run,
      }));
    }
    return hits.map((hit) => ({
      key: hit.node_id,
      kind: "page" as const,
      title: hit.title || "Untitled",
      path: pathText(hit.path),
      id: hit.node_id,
      icon: <FileText size={14} strokeWidth={1.5} />,
    }));
  }, [commands, hits, query]);

  useEffect(() => {
    if (items.length === 0) return;
    if (sel >= items.length) setSel(0);
  }, [items, sel]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [sel, items.length]);

  if (!mounted) return null;

  const runItem = (item: Item | undefined): void => {
    if (!item) return;
    if (item.kind === "page") {
      onNavigate(item.id);
      onClose();
      return;
    }
    item.run();
    onClose();
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length > 0) setSel((s) => (s + 1) % items.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length > 0) setSel((s) => (s - 1 + items.length) % items.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      runItem(items[sel]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const showResults = query.trim().length > 0;

  return (
    <div
      className={`sn-overlay ${visible ? "is-open" : ""}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sn-overlay-panel" role="dialog" aria-label="Command palette" aria-modal="true">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-2) var(--space-3)" }}>
          <Search size={16} strokeWidth={1.5} style={{ color: "var(--text-tertiary)", flex: "none" }} />
          <input
            ref={inputRef}
            className="sn-input"
            style={{
              border: "0",
              background: "transparent",
              height: "var(--h-button)",
              padding: "0 var(--space-1)",
              fontSize: "var(--text-base)",
            }}
            placeholder="Search pages"
            spellCheck={false}
            autoComplete="off"
            aria-label="Search pages"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
          />
          {searching && <span style={HINT}>Searching</span>}
        </div>

        <div className="sn-divider" style={{ margin: 0 }} />

        <div ref={listRef} style={{ maxHeight: 320, overflowY: "auto", padding: "var(--space-1)" }}>
          {showResults && items.length === 0 && !searching && (
            <div className="sn-empty" style={{ padding: "var(--space-6) var(--space-3)" }}>
              {failure ? `Search failed: ${failure}` : "No matches"}
            </div>
          )}
          {!showResults && commands.length === 0 && <div className="sn-empty">No commands</div>}
          {items.map((item, index) => (
            <button
              key={item.key}
              data-idx={index}
              className="sn-menu-item"
              style={{
                height: "auto",
                padding: "var(--space-1) var(--space-2)",
                background: sel === index ? "var(--accent-highlight-muted)" : undefined,
              }}
              onMouseEnter={() => setSel(index)}
              onClick={() => runItem(item)}
            >
              <span style={{ display: "inline-flex", flex: "none", color: sel === index ? "var(--accent-highlight)" : "var(--text-secondary)" }}>
                {item.icon}
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span
                  style={{
                    display: "block",
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    textOverflow: "ellipsis",
                  }}
                >
                  {item.kind === "page" ? item.title : item.label}
                </span>
                <span
                  style={{
                    display: "block",
                    fontSize: "var(--text-xs)",
                    color: "var(--text-tertiary)",
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    textOverflow: "ellipsis",
                  }}
                >
                  {item.path}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="sn-divider" style={{ margin: 0 }} />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-1)",
            padding: "var(--space-1) var(--space-2)",
          }}
        >
          {commands.map((command) => (
            <button
              key={command.key}
              className="sn-btn sn-btn-ghost sn-btn-sm"
              onClick={() => {
                command.run();
                onClose();
              }}
            >
              {command.icon}
              {command.label}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <span style={HINT}>Up Down select</span>
          <span style={HINT}>Enter open</span>
          <span style={HINT}>Esc close</span>
        </div>
      </div>
    </div>
  );
}
