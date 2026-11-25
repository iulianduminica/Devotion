/**
 * Templates: reusable page skeletons.
 *
 * Every card applies under the parent chosen in the "Apply under" select, so one
 * choice drives the whole grid.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { format } from "date-fns";
import { LayoutTemplate, Plus, Trash2 } from "lucide-react";

import { api } from "../api.ts";
import type { NodeTree } from "../../shared/types.ts";
import { bodyToPlainText } from "../../shared/types.ts";

interface TemplateRow {
  id: string;
  name: string;
  scope: "page" | "database";
  icon: string | null;
  created_at: number;
}

const TOP_LEVEL = "";

const LABEL: CSSProperties = {
  fontSize: "var(--text-xs)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--text-tertiary)",
};

function pageTitle(node: NodeTree): string {
  return bodyToPlainText(node.body).trim() || "Untitled";
}

function createdLabel(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "Unknown";
  return format(new Date(ts), "d MMM yyyy");
}

function flatten(nodes: NodeTree[], depth = 0): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (const node of nodes) {
    out.push({ id: node.id, label: `${"\u00A0".repeat(depth * 2)}${pageTitle(node)}` });
    if (node.children.length > 0) out.push(...flatten(node.children, depth + 1));
  }
  return out;
}

export function TemplatesPanel(props: {
  onApply: (id: string, parentId: string | null) => Promise<void>;
  tree: NodeTree[];
}): ReactNode {
  const { onApply, tree } = props;
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [parentId, setParentId] = useState<string>(TOP_LEVEL);
  const [sourceId, setSourceId] = useState<string>("");
  const [newName, setNewName] = useState("");

  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const rows = await api.templates();
      setTemplates(rows);
    } catch (err) {
      setNotice(`Templates failed: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const rows = await api.templates();
        if (!cancelled) setTemplates(rows);
      } catch (err) {
        if (!cancelled) setNotice(`Templates failed: ${(err as Error).message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pages = useMemo(() => flatten(tree), [tree]);
  const topLevel = useMemo(
    () => tree.map((node) => ({ id: node.id, label: pageTitle(node) })),
    [tree],
  );

  const use = useCallback(
    async (id: string): Promise<void> => {
      setBusyId(id);
      try {
        await onApply(id, parentId === TOP_LEVEL ? null : parentId);
        setNotice("Template applied");
      } catch (err) {
        setNotice(`Apply failed: ${(err as Error).message}`);
      } finally {
        setBusyId(null);
      }
    },
    [onApply, parentId],
  );

  const remove = useCallback(async (id: string, name: string): Promise<void> => {
    setBusyId(id);
    try {
      await api.deleteTemplate(id);
      setTemplates((rows) => rows.filter((row) => row.id !== id));
      setNotice(`Deleted ${name}`);
    } catch (err) {
      setNotice(`Delete failed: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }, []);

  const installLibrary = useCallback(async (): Promise<void> => {
    setBusyId("library");
    try {
      const r = await api.seedFirstPartyTemplates();
      setNotice(`Installed ${r.seeded} templates`);
      setTemplates(await api.templates());
    } catch (err) {
      setNotice(`Install failed: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }, []);

  const create = useCallback(async (): Promise<void> => {
    const name = newName.trim();
    if (!name || !sourceId) {
      setNotice("Pick a page and name the template");
      return;
    }
    setBusyId("create");
    try {
      await api.saveTemplate(name, sourceId, "page");
      setNewName("");
      setNotice(`Saved ${name}`);
      await load();
    } catch (err) {
      setNotice(`Save template failed: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }, [load, newName, sourceId]);

  return (
    <div className="sn-page" data-width="full">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          minHeight: "var(--h-panel-header)",
          marginBottom: "var(--space-3)",
          flexWrap: "wrap",
        }}
      >
        <LayoutTemplate size={16} strokeWidth={1.5} style={{ color: "var(--text-secondary)", flex: "none" }} />
        <span style={{ fontSize: "var(--text-md)", fontWeight: 600 }}>Templates</span>
        <span className="sn-badge">{templates.length}</span>
        <button
          className="sn-btn sn-btn-sm"
          style={{ marginLeft: "var(--space-2)" }}
          onClick={() => void installLibrary()}
          disabled={busyId === "library"}
          title="Installs the 15 built-in templates: meeting notes, project brief, bug tracker, OKRs, habit tracker and more. Safe to press twice."
        >
          {busyId === "library" ? "Installing…" : "Install first-party library"}
        </button>
        <span style={{ flex: 1 }} />
        <label style={{ ...LABEL, display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
          Apply under
          <select
            className="sn-input"
            style={{ width: 200 }}
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            aria-label="Apply under"
          >
            <option value={TOP_LEVEL}>Top level</option>
            {topLevel.map((page) => (
              <option key={page.id} value={page.id}>
                {page.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="sn-card" style={{ padding: "var(--space-3)", marginBottom: "var(--space-4)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <Plus size={16} strokeWidth={1.5} style={{ color: "var(--text-secondary)", flex: "none" }} />
          <span style={{ fontSize: "var(--text-sm)", fontWeight: 500 }}>Create template from page</span>
          <select
            className="sn-input"
            style={{ width: 220 }}
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            aria-label="Source page"
          >
            <option value="">Select a page</option>
            {pages.map((page) => (
              <option key={page.id} value={page.id}>
                {page.label}
              </option>
            ))}
          </select>
          <input
            className="sn-input"
            style={{ width: 200 }}
            placeholder="Template name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="Template name"
          />
          <button
            className="sn-btn sn-btn-primary sn-btn-sm"
            onClick={() => void create()}
            disabled={busyId !== null}
          >
            Save template
          </button>
          {notice && <span className="sn-muted" style={{ fontSize: "var(--text-xs)" }}>{notice}</span>}
        </div>
      </div>

      {loading && <div className="sn-muted" style={{ padding: "var(--space-3) 0" }}>Loading</div>}

      {!loading && templates.length === 0 && (
        <div className="sn-empty">
          <LayoutTemplate size={24} strokeWidth={1.5} style={{ opacity: 0.4 }} />
          <div style={{ marginTop: "var(--space-2)" }}>No templates yet. Save one from any page above.</div>
        </div>
      )}

      {templates.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: "var(--space-3)",
          }}
        >
          {templates.map((template) => (
            <div key={template.id} className="sn-card" style={{ padding: "var(--space-3)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
                {template.icon ? <span style={{ fontSize: "var(--text-md)" }}>{template.icon}</span> : null}
                <span style={{ fontSize: "var(--text-base)", fontWeight: 500, minWidth: 0, flex: 1 }}>
                  {template.name}
                </span>
                <span className="sn-badge">{template.scope}</span>
              </div>
              <div style={{ ...LABEL, marginTop: "var(--space-1)" }}>Created {createdLabel(template.created_at)}</div>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", marginTop: "var(--space-2)" }}>
                <button
                  className="sn-btn sn-btn-primary sn-btn-sm"
                  onClick={() => void use(template.id)}
                  disabled={busyId !== null}
                >
                  Use
                </button>
                <span style={{ flex: 1 }} />
                <button
                  className="sn-btn sn-btn-ghost sn-btn-icon sn-btn-sm"
                  style={{ width: 22 }}
                  aria-label={`Delete ${template.name}`}
                  title="Delete template"
                  onClick={() => void remove(template.id, template.name)}
                  disabled={busyId !== null}
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
