/**
 * Settings: appearance, workspace, AI providers, import/export.
 *
 * The AI section lives in `AiSettings` — it is the largest part of this screen
 * and has its own state, probes and diagnostics.
 */

import { useCallback, useEffect, useState } from "react";
import { Download, Monitor, Moon, Sun, Upload } from "lucide-react";

import { api, bootstrap } from "../api.ts";
import { AiSettings } from "./AiSettings.tsx";
import type { WorkspaceInfo } from "../../shared/types.ts";

export function SettingsPanel(props: {
  notify: (m: string) => void;
  /** current theme mode; the shell owns persistence */
  theme?: "light" | "dark" | "system";
  setTheme?: (t: "light" | "dark" | "system") => void;
}): React.ReactNode {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [name, setName] = useState("");
  const [md, setMd] = useState("");
  const [pages, setPages] = useState<{ id: string; title: string }[]>([]);
  const [exportId, setExportId] = useState("");

  const load = useCallback(async (): Promise<void> => {
    try {
      const boot = await bootstrap();
      setInfo(boot.info);
      setName(boot.info?.name ?? "");
      const tree = await api.tree();
      const flat: { id: string; title: string }[] = [];
      const walk = (nodes: typeof tree, depth: number): void => {
        for (const n of nodes) {
          const title = (Array.isArray(n.body) ? n.body.map((i) => i.text).join("") : "") || "Untitled";
          flat.push({ id: n.id, title: `${"  ".repeat(depth)}${n.meta?.icon ?? ""} ${title}` });
          walk(n.children, depth + 1);
        }
      };
      walk(tree, 0);
      setPages(flat);
      if (flat[0]) setExportId(flat[0].id);
    } catch (err) {
      props.notify(`Settings load failed: ${(err as Error).message}`);
    }
  }, [props]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="sn-page" data-width="full">
      <div style={{ fontSize: "var(--text-xl)", fontWeight: 600, marginBottom: 16 }}>Settings</div>

      {/* ── appearance ────────────────────────────────────────────── */}
      {props.setTheme && (
        <section style={{ marginBottom: 28 }}>
          <div className="sn-eyebrow" style={{ marginBottom: 8 }}>Appearance</div>
          <div className="sn-card" style={{ padding: 12, maxWidth: 520 }}>
            <label
              style={{ display: "block", fontSize: "var(--text-xs)", color: "var(--text-tertiary)", marginBottom: 6 }}
            >
              Theme
            </label>
            <div
              style={{
                display: "inline-flex",
                border: "1px solid var(--border-default)",
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              {(
                [
                  { key: "dark", label: "Dark", Icon: Moon },
                  { key: "light", label: "Light", Icon: Sun },
                  { key: "system", label: "System", Icon: Monitor },
                ] as const
              ).map(({ key, label, Icon }) => {
                const active = props.theme === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => props.setTheme?.(key)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "6px 12px",
                      fontSize: "var(--text-sm)",
                      border: "0",
                      borderRight: key === "system" ? "0" : "1px solid var(--border-default)",
                      background: active ? "var(--surface-raised)" : "transparent",
                      color: active ? "var(--text-primary)" : "var(--text-secondary)",
                      cursor: "pointer",
                    }}
                  >
                    <Icon size={14} strokeWidth={1.5} />
                    {label}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", marginTop: 8 }}>
              Dark is the design default. System follows your OS setting and updates live.
            </div>
          </div>
        </section>
      )}

      {/* ── workspace ─────────────────────────────────────────────── */}
      <section style={{ marginBottom: 28 }}>
        <div className="sn-eyebrow" style={{ marginBottom: 8 }}>Workspace</div>
        <div className="sn-card" style={{ padding: 12, maxWidth: 520 }}>
          <label style={{ display: "block", fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>Name</label>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <input className="sn-input" value={name} onChange={(e) => setName(e.target.value)} />
            <button
              className="sn-btn sn-btn-primary"
              onClick={async () => {
                const updated = await api.renameWorkspace(name);
                setInfo(updated);
                props.notify("Workspace renamed");
              }}
            >
              Save
            </button>
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 12, fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
            <span>{(info?.nodeCount ?? 0).toLocaleString()} blocks</span>
            <span>{(info?.dbCount ?? 0).toLocaleString()} databases</span>
            <span>{((info?.bytes ?? 0) / 1024).toFixed(1)} KB media</span>
          </div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", marginTop: 6 }}>
            Workspace id {info?.id ?? "—"} · stored as one SQLite file plus a media folder
          </div>
        </div>
      </section>

      {/* ── AI providers ──────────────────────────────────────────── */}
      <section style={{ marginBottom: 28 }}>
        <AiSettings notify={props.notify} />
      </section>

      {/* ── import / export ───────────────────────────────────────── */}
      <section style={{ marginBottom: 28 }}>
        <div className="sn-eyebrow" style={{ marginBottom: 8 }}>Import</div>
        <div className="sn-card" style={{ padding: 12, maxWidth: 720 }}>
          <textarea
            className="sn-input"
            rows={8}
            placeholder="Paste Markdown. Notion exports, headings, lists, toggles, code fences, callouts and GFM tables all map to blocks; a table becomes a database."
            value={md}
            onChange={(e) => setMd(e.target.value)}
          />
          <button
            className="sn-btn sn-btn-primary"
            style={{ marginTop: 8 }}
            onClick={async () => {
              if (!md.trim()) {
                props.notify("Nothing to import");
                return;
              }
              try {
                const r = await api.importMarkdown(md, null);
                props.notify(
                  `Imported ${r.pages} page, ${r.blocks} blocks, ${r.databases ?? 0} databases, ${r.rows ?? 0} rows`,
                );
                setMd("");
                await load();
              } catch (err) {
                props.notify(`Import failed: ${(err as Error).message}`);
              }
            }}
          >
            <Upload size={13} strokeWidth={1.5} />
            Import Markdown
          </button>
        </div>

        <div className="sn-eyebrow" style={{ margin: "16px 0 8px" }}>Export</div>
        <div className="sn-card" style={{ padding: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", maxWidth: 720 }}>
          <select className="sn-input" style={{ width: 320 }} value={exportId} onChange={(e) => setExportId(e.target.value)}>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
          <a className="sn-btn" style={{ textDecoration: "none" }} href={api.exportUrl("markdown", exportId)}>
            <Download size={13} strokeWidth={1.5} />
            Markdown
          </a>
          <a className="sn-btn" style={{ textDecoration: "none" }} href={api.exportUrl("html", exportId)}>
            <Download size={13} strokeWidth={1.5} />
            HTML
          </a>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
            CSV is exported from a database view's footer.
          </span>
        </div>
      </section>
    </div>
  );
}
