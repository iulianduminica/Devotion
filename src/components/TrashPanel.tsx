/**
 * Trash: soft-deleted nodes, with restore, purge, and empty-trash.
 *
 * Destructive confirmations are inline two-click buttons — no window.confirm.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { formatRelative } from "date-fns";
import { Database, FileText, RotateCcw, Trash2, X } from "lucide-react";

import { api } from "../api.ts";
import type { TrashEntry } from "../../shared/types.ts";

const HEAD: CSSProperties = {
  fontSize: "var(--text-xs)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--text-tertiary)",
  fontWeight: 500,
};

function deletedLabel(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "Unknown";
  return formatRelative(new Date(ts), new Date());
}

function pathText(path: TrashEntry["path"]): string {
  if (path.length === 0) return "Top level";
  return path.map((c) => c.title || "Untitled").join(" / ");
}

export function TrashPanel(props: {
  onChanged: () => void;
  notify: (message: string) => void;
}): ReactNode {
  const { onChanged, notify } = props;
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef<number | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const rows = await api.trashList();
      setEntries(rows);
    } catch (err) {
      notify(`Trash failed: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const rows = await api.trashList();
        if (!cancelled) setEntries(rows);
      } catch (err) {
        if (!cancelled) notify(`Trash failed: ${(err as Error).message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notify]);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    };
  }, []);

  const afterMutation = useCallback(async (): Promise<void> => {
    onChanged();
    await load();
  }, [load, onChanged]);

  const restore = useCallback(
    async (entry: TrashEntry): Promise<void> => {
      setBusyId(entry.node_id);
      try {
        await api.restore(entry.node_id);
        notify(`Restored ${entry.title || "Untitled"}`);
        await afterMutation();
      } catch (err) {
        notify(`Restore failed: ${(err as Error).message}`);
      } finally {
        setBusyId(null);
      }
    },
    [afterMutation, notify],
  );

  const purge = useCallback(
    async (entry: TrashEntry): Promise<void> => {
      setBusyId(entry.node_id);
      try {
        await api.purge(entry.node_id);
        notify(`Deleted ${entry.title || "Untitled"} forever`);
        await afterMutation();
      } catch (err) {
        notify(`Delete failed: ${(err as Error).message}`);
      } finally {
        setBusyId(null);
      }
    },
    [afterMutation, notify],
  );

  const emptyTrash = useCallback(async (): Promise<void> => {
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    if (!confirming) {
      setConfirming(true);
      confirmTimer.current = window.setTimeout(() => setConfirming(false), 3000);
      return;
    }
    setConfirming(false);
    setBusyId("empty");
    try {
      const result = await api.emptyTrash();
      notify(`Emptied trash, removed ${result.removed}`);
      await afterMutation();
    } catch (err) {
      notify(`Empty trash failed: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }, [afterMutation, confirming, notify]);

  return (
    <div className="sn-page" data-width="full">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          minHeight: "var(--h-panel-header)",
          marginBottom: "var(--space-3)",
        }}
      >
        <Trash2 size={16} strokeWidth={1.5} style={{ color: "var(--text-secondary)", flex: "none" }} />
        <span style={{ fontSize: "var(--text-md)", fontWeight: 600 }}>Trash</span>
        <span className="sn-badge">{entries.length}</span>
        <span style={{ flex: 1 }} />
        <button
          className="sn-btn sn-btn-sm sn-btn-destructive"
          onClick={() => void emptyTrash()}
          disabled={entries.length === 0 || busyId !== null}
          title="Permanently delete every item in the trash"
        >
          {confirming ? "Confirm" : "Empty trash"}
        </button>
      </div>

      {loading && <div className="sn-muted" style={{ padding: "var(--space-3) 0" }}>Loading</div>}

      {!loading && entries.length === 0 && (
        <div className="sn-empty">
          <Trash2 size={24} strokeWidth={1.5} style={{ opacity: 0.4 }} />
          <div style={{ marginTop: "var(--space-2)" }}>Trash is empty</div>
        </div>
      )}

      {entries.length > 0 && (
        <div className="sn-table-wrap">
          <table className="sn-table">
            <thead>
              <tr>
                <th style={HEAD}>Title</th>
                <th style={HEAD}>Path</th>
                <th style={HEAD}>Deleted</th>
                <th style={{ ...HEAD, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.node_id}>
                  <td>
                    <span style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
                      <span style={{ display: "inline-flex", flex: "none", color: "var(--text-tertiary)" }}>
                        {entry.icon ? (
                          <span style={{ fontSize: "var(--text-sm)" }}>{entry.icon}</span>
                        ) : entry.type === "child_database" ? (
                          <Database size={14} strokeWidth={1.5} />
                        ) : (
                          <FileText size={14} strokeWidth={1.5} />
                        )}
                      </span>
                      <span className="sn-cell-title">{entry.title || "Untitled"}</span>
                    </span>
                  </td>
                  <td style={{ color: "var(--text-tertiary)" }}>{pathText(entry.path)}</td>
                  <td style={{ color: "var(--text-tertiary)" }}>{deletedLabel(entry.deleted_at)}</td>
                  <td>
                    <span style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-1)" }}>
                      <button
                        className="sn-btn sn-btn-sm"
                        onClick={() => void restore(entry)}
                        disabled={busyId === entry.node_id}
                      >
                        <RotateCcw size={14} strokeWidth={1.5} />
                        Restore
                      </button>
                      <button
                        className="sn-btn sn-btn-sm sn-btn-destructive"
                        onClick={() => void purge(entry)}
                        disabled={busyId === entry.node_id}
                      >
                        <X size={14} strokeWidth={1.5} />
                        Delete forever
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
