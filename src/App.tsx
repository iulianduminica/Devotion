/**
 * App shell: titlebar + sidebar + main + inspector + statusbar.
 *
 * Routing is a hash (`#/page/<id>`, `#/trash`, `#/settings`, …) so deep links
 * work with no server routing and a page refresh keeps its place.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlignLeft,
  Clock,
  Database,
  FilePlus2,
  FileText,
  Folder,
  Link2,
  ListTree,
  Monitor,
  Moon,
  PanelLeft,
  Plus,
  Redo2,
  Search,
  Settings as SettingsIcon,
  Sun,
  Trash2,
  Undo2,
  X,
} from "lucide-react";

import { api, type NodeDetail } from "./api.ts";
import type { NodeRow, NodeTree, SearchHit, WorkspaceInfo } from "../shared/types.ts";
import { PageEditor } from "./editor/PageEditor.tsx";
import { editorHost } from "./editor/blocks.tsx";
import { DatabaseView } from "./db/DatabaseView.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { TrashPanel } from "./components/TrashPanel.tsx";
import { TemplatesPanel } from "./components/TemplatesPanel.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import { EmojiPicker } from "./components/EmojiPicker.tsx";

export type Route =
  | { kind: "page"; id: string }
  | { kind: "trash" }
  | { kind: "templates" }
  | { kind: "settings" }
  | { kind: "home" };

/** A row's title text — NodeRow stores it in `body`, not a title column. */
function nodeTitleOf(n: NodeRow | undefined): string | undefined {
  if (!n) return undefined;
  return Array.isArray(n.body)
    ? n.body.map((i) => ("text" in i ? (i.text ?? "") : "")).join("")
    : undefined;
}

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  if (!h) return { kind: "home" };
  const [head, id] = h.split("/");
  if (head === "page" && id) return { kind: "page", id };
  if (head === "trash") return { kind: "trash" };
  if (head === "templates") return { kind: "templates" };
  if (head === "settings") return { kind: "settings" };
  return { kind: "home" };
}

type ThemeMode = "light" | "dark" | "system";

function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return mode;
}

export function App(): ReactNode {
  const [route, setRoute] = useState<Route>(parseHash());
  const [tree, setTree] = useState<NodeTree[]>([]);
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [health, setHealth] = useState<{ sqlite: string; nodes: number } | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebar, setSidebar] = useState<"expanded" | "collapsed">("expanded");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(
    // dark is the product default; "system" is an explicit opt-in
    (localStorage.getItem("strata-theme") as ThemeMode) ?? "dark",
  );
  const [toast, setToast] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ nodeId: string; kind: "icon" | "cover" } | null>(null);
  const [dirty, setDirty] = useState(false);
  /** words/blocks of the open page, for the statusbar */
  const [stats, setStats] = useState<{ words: number; blocks: number } | null>(null);
  const toastTimer = useRef<number | null>(null);

  const notify = useCallback((message: string): void => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  // ── routing ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onHash = (): void => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = useCallback((id: string): void => {
    window.location.hash = `/page/${id}`;
  }, []);

  // ── data ───────────────────────────────────────────────────────────────────
  const refreshTree = useCallback(async (): Promise<void> => {
    try {
      setTree(await api.tree());
      setInfo(await api.workspace());
    } catch (err) {
      notify(`Tree failed: ${(err as Error).message}`);
    }
  }, [notify]);

  // ── history: the server op log, not the editor's local stack ───────────────
  const [undoState, setUndoState] = useState<{ canUndo: boolean; canRedo: boolean }>({
    canUndo: false,
    canRedo: false,
  });
  /** bumped after an undo/redo so the editor re-reads the tree from the server */
  const [revision, setRevision] = useState(0);

  const loadUndo = useCallback(async (): Promise<void> => {
    try {
      setUndoState(await api.undoState());
    } catch {
      // the buttons simply stay disabled if the probe fails
    }
  }, []);

  const afterHistory = useCallback(async (): Promise<void> => {
    await refreshTree();
    if (route.kind === "page") {
      try {
        setDetail(await api.node(route.id));
      } catch {
        // an undo can remove the page we are looking at; the tree refresh covers it
      }
    }
    setDirty(false);
    setRevision((r) => r + 1);
    await loadUndo();
  }, [refreshTree, route, loadUndo]);

  const runUndo = useCallback(async (): Promise<void> => {
    try {
      const r = await api.undo();
      if (r.tx == null) {
        notify("Nothing to undo");
        return;
      }
      notify("Undid one change");
      await afterHistory();
    } catch (err) {
      notify(`Undo failed: ${(err as Error).message}`);
    }
  }, [notify, afterHistory]);

  const runRedo = useCallback(async (): Promise<void> => {
    try {
      const r = await api.redo();
      if (r.tx == null) {
        notify("Nothing to redo");
        return;
      }
      notify("Redid one change");
      await afterHistory();
    } catch (err) {
      notify(`Redo failed: ${(err as Error).message}`);
    }
  }, [notify, afterHistory]);

  // Registered after the handlers it closes over — declaring it above them is a
  // real TDZ crash, not a lint nit.
  useEffect(() => {
    void loadUndo();
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      // Ctrl+Z is left to the editor's own undo; the persisted history is
      // Ctrl+Shift+Z / Ctrl+Y so the two stacks never fight.
      if (e.shiftKey && k === "z") {
        e.preventDefault();
        void runUndo();
      } else if (k === "y") {
        e.preventDefault();
        void runRedo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `dirty` settling means a save landed, which changes what can be undone
  }, [loadUndo, runUndo, runRedo, dirty]);

  // Registered after refreshTree: the effect closes over it, so declaring it
  // earlier would hit a temporal dead zone on first render.
  useEffect(() => {
    editorHost.setNavigate(navigate);
    editorHost.setPicker((nodeId, kind) => setPicker({ nodeId, kind }));
    editorHost.registerPicker((nodeId, kind) => setPicker({ nodeId, kind }));
    editorHost.setDatabaseRenderer(({ databaseId, nodeId }) => (
      <DatabaseView key={databaseId} databaseId={databaseId} nodeId={nodeId} onChanged={refreshTree} notify={notify} />
    ));
  }, [navigate, refreshTree, notify]);

  useEffect(() => {
    void refreshTree();
    void api.health().then(setHealth).catch(() => setHealth(null));
  }, [refreshTree]);

  useEffect(() => {
    if (route.kind !== "page") {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void api
      .node(route.id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [route]);

  // ── theme ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    localStorage.setItem("strata-theme", theme);
    document.documentElement.setAttribute("data-theme", resolveTheme(theme));
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (): void => {
      if (theme === "system") document.documentElement.setAttribute("data-theme", resolveTheme("system"));
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  // ── shortcuts ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key === "Escape") {
        setPaletteOpen(false);
        setPicker(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const t = window.setTimeout(() => {
      void api
        .search(query, 12)
        .then(setResults)
        .catch(() => setResults([]));
    }, 180);
    return () => window.clearTimeout(t);
  }, [query]);

  // ── actions ────────────────────────────────────────────────────────────────
  const newPage = useCallback(
    async (parentId: string | null): Promise<void> => {
      const { id } = await api.createPage(parentId, "");
      await refreshTree();
      navigate(id);
    },
    [navigate, refreshTree],
  );

  const removePage = useCallback(
    async (id: string): Promise<void> => {
      await api.trash(id);
      notify("Moved to trash");
      await refreshTree();
      if (route.kind === "page" && route.id === id) window.location.hash = "";
    },
    [notify, refreshTree, route],
  );

  const isMobile = useMemo(() => window.innerWidth <= 768, []);

  const sidebarExpanded = sidebar === "expanded";

  return (
    <>
      <div
        className="sn-shell"
        data-sidebar={sidebarExpanded ? "expanded" : "collapsed"}
        data-inspector={inspectorOpen ? "open" : "closed"}
      >
        {/* ── titlebar ─────────────────────────────────────────────── */}
        <header className="sn-titlebar">
          <button
            className="sn-btn sn-btn-ghost sn-btn-icon"
            aria-label="Toggle sidebar"
            onClick={() => setSidebar(sidebarExpanded ? "collapsed" : "expanded")}
          >
            <PanelLeft size={16} strokeWidth={1.5} />
          </button>

          {route.kind === "page" && detail && (
            <nav className="sn-breadcrumbs" aria-label="Breadcrumb">
              {detail.breadcrumbs.slice(0, -1).map((c, i, arr) => (
                <span key={c.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <button className="sn-crumb" onClick={() => navigate(c.id)}>
                    {c.icon ? `${c.icon} ` : ""}
                    {c.title}
                  </button>
                  <span style={{ color: "var(--text-ghost)" }}>/</span>
                  {i === arr.length - 1 ? null : null}
                </span>
              ))}
              <span style={{ color: "var(--text-primary)" }}>
                {detail.node.meta?.icon ? `${detail.node.meta.icon} ` : ""}
                {detail.breadcrumbs.at(-1)?.title ?? "Untitled"}
              </span>
            </nav>
          )}

          <div style={{ flex: 1 }} />

          <button
            className="sn-btn sn-btn-ghost sn-btn-icon"
            aria-label="Undo last saved change"
            title="Undo the last persisted change (Ctrl+Shift+Z). Ctrl+Z stays with the editor."
            disabled={!undoState.canUndo}
            style={{ opacity: undoState.canUndo ? 1 : 0.35 }}
            onClick={() => void runUndo()}
          >
            <Undo2 size={16} strokeWidth={1.5} />
          </button>

          <button
            className="sn-btn sn-btn-ghost sn-btn-icon"
            aria-label="Redo last undone change"
            title="Redo (Ctrl+Y)"
            disabled={!undoState.canRedo}
            style={{ opacity: undoState.canRedo ? 1 : 0.35 }}
            onClick={() => void runRedo()}
          >
            <Redo2 size={16} strokeWidth={1.5} />
          </button>

          <button
            className="sn-btn sn-btn-ghost sn-btn-icon"
            aria-label="Open command palette (Ctrl+K)"
            onClick={() => setPaletteOpen(true)}
          >
            <Search size={16} strokeWidth={1.5} />
          </button>

          <button
            className="sn-btn sn-btn-ghost sn-btn-icon"
            aria-label="Toggle inspector"
            onClick={() => setInspectorOpen((v) => !v)}
          >
            <ListTree size={16} strokeWidth={1.5} />
          </button>

          <button
            className="sn-btn sn-btn-ghost sn-btn-icon"
            aria-label="Theme"
            onClick={() =>
              setTheme(theme === "dark" ? "light" : theme === "light" ? "system" : "dark")
            }
            title={`Theme: ${theme}`}
          >
            {theme === "light" ? (
              <Sun size={16} strokeWidth={1.5} />
            ) : theme === "system" ? (
              <Monitor size={16} strokeWidth={1.5} />
            ) : (
              <Moon size={16} strokeWidth={1.5} />
            )}
          </button>
        </header>

        {/* ── sidebar ──────────────────────────────────────────────── */}
        <aside className="sn-sidebar">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 6px 2px",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 16,
                height: 16,
                borderRadius: 4,
                background: "var(--surface-raised)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
                fontSize: 10,
                fontWeight: 600,
                lineHeight: "14px",
                textAlign: "center",
                flex: "none",
              }}
            >
              D
            </span>
            <span style={{ fontSize: "var(--text-sm)", fontWeight: 600, letterSpacing: "0.01em" }}>Devotion</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px" }}>
            {/* the workspace name is not shown here: the wordmark above already
                says what this is, and a second label is just noise */}
            <span style={{ flex: 1 }} />
            <button
              className="sn-btn sn-btn-ghost sn-btn-sm"
              aria-label="New page"
              onClick={() => void newPage(null)}
            >
              <FilePlus2 size={14} strokeWidth={1.5} />
            </button>
          </div>

          <div style={{ padding: "4px 6px 8px" }}>
            <input
              className="sn-input"
              placeholder="Search workspace"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {results.length > 0 && (
              <div style={{ marginTop: 4 }}>
                {results.map((r) => (
                  <button key={r.node_id} className="sn-nav-item" onClick={() => navigate(r.node_id)}>
                    <FileText size={14} strokeWidth={1.5} />
                    <span className="sn-nav-label">{r.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <nav>
            <div className="sn-nav-group">Pages</div>
            {tree.map((node) => (
              <TreeItem
                key={node.id}
                node={node}
                depth={0}
                activeId={route.kind === "page" ? route.id : null}
                onOpen={navigate}
                onNewChild={async (id) => {
                  await newPage(id);
                }}
              />
            ))}
            {tree.length === 0 && (
              <div className="sn-empty" style={{ padding: "12px 6px" }}>
                No pages yet
              </div>
            )}
          </nav>

          <div style={{ marginTop: 8, borderTop: "1px solid var(--border-subtle)", paddingTop: 8 }}>
            <SideLink icon={<Database size={14} strokeWidth={1.5} />} label="Templates" hash="#/templates" active={route.kind === "templates"} />
            <SideLink icon={<Trash2 size={14} strokeWidth={1.5} />} label="Trash" hash="#/trash" active={route.kind === "trash"} />
            <SideLink icon={<SettingsIcon size={14} strokeWidth={1.5} />} label="Settings" hash="#/settings" active={route.kind === "settings"} />
          </div>
        </aside>

        {/* ── main ─────────────────────────────────────────────────── */}
        <main className="sn-main">
          {route.kind === "home" && (
            <HomePanel
              onNew={() => void newPage(null)}
              onOpen={navigate}
              tree={tree}
            />
          )}
          {route.kind === "trash" && <TrashPanel onChanged={refreshTree} notify={notify} />}
          {route.kind === "templates" && (
            <TemplatesPanel
              onApply={async (id, parentId) => {
                const r = await api.applyTemplate(id, parentId);
                if (r.id) {
                  await refreshTree();
                  navigate(r.id);
                }
              }}
              tree={tree}
            />
          )}
          {route.kind === "settings" && (
            <SettingsPanel notify={notify} theme={theme} setTheme={setTheme} />
          )}
          {route.kind === "page" && !detail && (
            <div className="sn-empty">Page not found</div>
          )}
          {route.kind === "page" && detail && (
            <PageEditor
              key={detail.node.id}
              node={detail.node}
              revision={revision}
              children_={detail.children}
              onChanged={async () => {
                const d = await api.node(detail.node.id);
                setDetail(d);
                setDirty(false);
              }}
              onTreeChanged={refreshTree}
              onNavigate={navigate}
              notify={notify}
              setDirty={setDirty}
              onSetMeta={async (patch) => {
                await api.setMeta(detail.node.id, patch);
                const d = await api.node(detail.node.id);
                setDetail(d);
                await refreshTree();
              }}
              onTrash={() => void removePage(detail.node.id)}
              onStats={setStats}
            />
          )}
        </main>

        {/* ── inspector ────────────────────────────────────────────── */}
        {inspectorOpen && route.kind === "page" && detail && (
          <Inspector
            node={detail.node}
            onNavigate={navigate}
            onClose={() => setInspectorOpen(false)}
            notify={notify}
            onChanged={() => void refreshTree()}
            onTrashed={() => {
              // the page on screen no longer exists: refresh the tree and leave
              void refreshTree();
              const root = tree[0];
              if (root) navigate(root.id);
            }}
          />
        )}

        {/* ── statusbar ────────────────────────────────────────────── */}
        <footer className="sn-statusbar">
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className={`sn-dot ${dirty ? "is-pulse" : ""}`} style={{ background: dirty ? "var(--status-warning)" : "var(--status-success)" }} />
            {dirty ? "Saving" : "Saved"}
          </span>
          <span>{(info?.nodeCount ?? 0).toLocaleString()} blocks</span>
          <span>{(info?.dbCount ?? 0).toLocaleString()} databases</span>
          {stats && route.kind === "page" && stats.words > 0 && (
            <span>
              {stats.words.toLocaleString()} words · {Math.max(1, Math.round(stats.words / 220))} min read
            </span>
          )}
          {health && <span>SQLite {health.sqlite}</span>}
          <span style={{ flex: 1 }} />
          <span>Local · {isMobile ? "mobile" : "desktop"}</span>
        </footer>
      </div>

      {isMobile && sidebarExpanded && (
        <div className="sn-backdrop" onClick={() => setSidebar("collapsed")} />
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={navigate}
        onNewPage={() => void newPage(null)}
        onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        pageId={route.kind === "page" ? route.id : null}
        pageTitle={nodeTitleOf(detail?.node)}
      />

      {picker && (
        <EmojiPicker
          onPick={(emoji) => {
            void api.setMeta(picker.nodeId, { icon: emoji });
            setPicker(null);
            if (route.kind === "page") void api.node(route.id).then(setDetail);
            void refreshTree();
          }}
          onClose={() => setPicker(null)}
        />
      )}

      {toast && <div className="sn-toast">{toast}</div>}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function SideLink(props: { icon: ReactNode; label: string; hash: string; active: boolean }): ReactNode {
  return (
    <a href={props.hash} style={{ textDecoration: "none", display: "block" }}>
      <button className={`sn-nav-item ${props.active ? "is-active" : ""}`}>
        {props.icon}
        <span className="sn-nav-label">{props.label}</span>
      </button>
    </a>
  );
}

function TreeItem(props: {
  node: NodeTree;
  depth: number;
  activeId: string | null;
  onOpen: (id: string) => void;
  onNewChild: (id: string) => void;
}): ReactNode {
  const { node, depth, activeId, onOpen, onNewChild } = props;
  const [open, setOpen] = useState(depth < 1);
  const title = (Array.isArray(node.body) ? node.body.map((i) => i.text).join("") : "") || "Untitled";
  const isDb = node.type === "child_database";
  const hasChildren = node.children.length > 0;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", paddingLeft: depth * 12 }}>
        <button
          className={`sn-nav-item ${activeId === node.id ? "is-active" : ""}`}
          onClick={() => onOpen(node.id)}
          style={{ paddingLeft: hasChildren ? 4 : 18 }}
        >
          <span
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
            style={{ width: 14, flex: "none", display: "inline-flex", justifyContent: "center", opacity: hasChildren ? 0.7 : 0 }}
          >
            {hasChildren ? <Folder size={11} strokeWidth={1.5} /> : null}
          </span>
          {node.meta?.icon ? (
            <span style={{ fontSize: 13, flex: "none" }}>{node.meta.icon}</span>
          ) : isDb ? (
            <Database size={13} strokeWidth={1.5} />
          ) : (
            <FileText size={13} strokeWidth={1.5} />
          )}
          <span className="sn-nav-label">{title}</span>
        </button>
        <button
          className="sn-btn sn-btn-ghost sn-btn-icon"
          style={{ width: 20, height: 20 }}
          aria-label="Add page inside"
          title="Add page inside"
          onClick={() => void onNewChild(node.id)}
        >
          <Plus size={12} strokeWidth={1.5} />
        </button>
      </div>
      {open &&
        node.children.map((c) => (
          <TreeItem key={c.id} node={c} depth={depth + 1} activeId={activeId} onOpen={onOpen} onNewChild={onNewChild} />
        ))}
    </>
  );
}

function HomePanel(props: { tree: NodeTree[]; onNew: () => void; onOpen: (id: string) => void }): ReactNode {
  const { tree, onNew, onOpen } = props;
  return (
    <div className="sn-page">
      <div style={{ fontSize: "var(--text-2xl)", fontWeight: 600, marginBottom: 4 }}>Home</div>
      <div className="sn-muted" style={{ marginBottom: 24 }}>
        Local-first workspace. Everything is stored in one folder on this machine.
      </div>

      <div className="sn-panel-header" style={{ padding: 0, border: 0 }}>
        Pages
      </div>
      <div>
        {tree.map((n) => {
          const title = (Array.isArray(n.body) ? n.body.map((i) => i.text).join("") : "") || "Untitled";
          return (
            <button key={n.id} className="sn-nav-item" style={{ height: 30 }} onClick={() => onOpen(n.id)}>
              {n.meta?.icon ? <span style={{ fontSize: 14 }}>{n.meta.icon}</span> : <FileText size={14} strokeWidth={1.5} />}
              <span className="sn-nav-label">{title}</span>
              <span className="sn-badge">{n.children.length}</span>
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
        <button className="sn-btn sn-btn-primary" onClick={onNew}>
          <FilePlus2 size={14} strokeWidth={1.5} />
          New page
        </button>
        <a href="#/templates">
          <button className="sn-btn">
            <AlignLeft size={14} strokeWidth={1.5} />
            Templates
          </button>
        </a>
      </div>

      {tree.length === 0 && (
        <div className="sn-empty">
          <FileText size={24} strokeWidth={1.5} style={{ opacity: 0.4 }} />
          <div style={{ marginTop: 8 }}>Create your first page to start writing.</div>
        </div>
      )}
    </div>
  );
}
