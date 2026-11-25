/**
 * Inspector: the 296px right panel for the open page.
 *
 * Metadata, linked mentions, version history, and the destructive row. The
 * parent (App) owns grid sizing, so this renders content only.
 */

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { format, formatRelative } from "date-fns";
import {
  CalendarClock,
  FileClock,
  FileText,
  Layers,
  Link2,
  MoveRight,
  ScrollText,
  Trash2,
  UserRound,
  X,
} from "lucide-react";

import { api } from "../api.ts";
import type { BacklinkEntry, NodeRow, SnapshotEntry } from "../../shared/types.ts";
import { bodyToPlainText } from "../../shared/types.ts";

interface InspectorData {
  blocks: number;
  backlinks: BacklinkEntry[];
  outgoing: { dst: string; title: string }[];
  snapshots: SnapshotEntry[];
  ops: { seq: number; ts: number; actor: string; op: string; tx: number }[];
}

const LABEL: CSSProperties = {
  fontSize: "var(--text-xs)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--text-tertiary)",
};

const VALUE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--text-primary)",
  minWidth: 0,
  overflowWrap: "anywhere",
};

function relative(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "Not recorded";
  return formatRelative(new Date(ts), new Date());
}

function stamp(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "Not recorded";
  return format(new Date(ts), "d MMM yyyy, HH:mm");
}

function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const unit = units[i] ?? "B";
  const shown = i === 0 ? String(Math.round(value)) : value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${shown} ${unit}`;
}

function actorName(actor: string): string {
  const trimmed = actor.trim();
  if (!trimmed) return "Unknown";
  return trimmed.replace(/^dev-/, "Device ");
}

function Row(props: { label: string; value: string; icon?: ReactNode }): ReactNode {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "20px 76px 1fr",
        alignItems: "baseline",
        gap: "var(--space-1)",
        minHeight: "var(--h-row)",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", color: "var(--text-tertiary)" }}>
        {props.icon}
      </span>
      <span style={LABEL}>{props.label}</span>
      <span style={VALUE}>{props.value}</span>
    </div>
  );
}

function Section(props: { title: string; children: ReactNode; action?: ReactNode }): ReactNode {
  return (
    <>
      <div
        className="sn-nav-group"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          paddingRight: "var(--space-3)",
        }}
      >
        <span style={{ flex: 1 }}>{props.title}</span>
        {props.action}
      </div>
      <div style={{ padding: "0 var(--space-3) var(--space-3)" }}>{props.children}</div>
    </>
  );
}

export function Inspector(props: {
  node: NodeRow;
  onNavigate: (id: string) => void;
  onClose: () => void;
  notify: (message: string) => void;
  /**
   * Called after anything that changes the tree (trash, restore). Without it
   * the sidebar keeps showing a page that has just been trashed.
   */
  onChanged?: () => void;
  /** The page currently being viewed was trashed — the shell should leave it. */
  onTrashed?: () => void;
}): ReactNode {
  const { node, onNavigate, onClose, notify, onChanged, onTrashed } = props;
  const [data, setData] = useState<InspectorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [detail, links, history] = await Promise.all([
        api.node(node.id),
        api.backlinks(node.id),
        api.history(node.id),
      ]);
      setData({
        blocks: detail.children.length,
        backlinks: links.backlinks,
        outgoing: links.outgoing,
        snapshots: history.snapshots,
        ops: history.ops,
      });
    } catch (err) {
      notify(`Page info failed: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [node.id, notify]);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoading(true);
    void (async () => {
      try {
        const [detail, links, history] = await Promise.all([
          api.node(node.id),
          api.backlinks(node.id),
          api.history(node.id),
        ]);
        if (cancelled) return;
        setData({
          blocks: detail.children.length,
          backlinks: links.backlinks,
          outgoing: links.outgoing,
          snapshots: history.snapshots,
          ops: history.ops,
        });
      } catch (err) {
        if (!cancelled) notify(`Page info failed: ${(err as Error).message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [node.id, notify]);

  const snapshotNow = useCallback(async (): Promise<void> => {
    setBusy("snapshot");
    try {
      await api.snapshot(node.id, "manual");
      notify("Snapshot created");
      await reload();
    } catch (err) {
      notify(`Snapshot failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [node.id, notify, reload]);

  const restore = useCallback(
    async (snapshotId: string): Promise<void> => {
      setBusy(snapshotId);
      try {
        await api.restoreSnapshot(snapshotId);
        notify("Page restored");
        await reload();
        // a restore rewrites the subtree: the sidebar tree must re-read it
        onChanged?.();
      } catch (err) {
        notify(`Restore failed: ${(err as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [notify, reload, onChanged],
  );

  const moveToTrash = useCallback(async (): Promise<void> => {
    setBusy("trash");
    try {
      await api.trash(node.id);
      notify("Moved to trash");
      onChanged?.();
      onTrashed?.();
      onClose();
    } catch (err) {
      notify(`Move to trash failed: ${(err as Error).message}`);
      setBusy(null);
    }
  }, [node.id, notify, onClose, onChanged, onTrashed]);

  const title = bodyToPlainText(node.body).trim() || "Untitled";
  const mentionCount = (data?.backlinks.length ?? 0) + (data?.outgoing.length ?? 0);

  return (
    <aside className="sn-inspector" aria-label={`Page info for ${title}`}>
      <div className="sn-panel-header">
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>Page info</span>
        <button
          className="sn-btn sn-btn-ghost sn-btn-icon"
          style={{ width: "var(--h-row)", height: "var(--h-row)" }}
          aria-label="Close page info"
          onClick={onClose}
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>

      <Section title="Details">
        <Row label="Created" value={stamp(node.created_at)} icon={<CalendarClock size={14} strokeWidth={1.5} />} />
        <Row label="Last edited" value={relative(node.updated_at)} icon={<FileClock size={14} strokeWidth={1.5} />} />
        <Row label="Created by" value={actorName(node.created_by)} icon={<UserRound size={14} strokeWidth={1.5} />} />
        <Row label="Edited by" value={actorName(node.updated_by)} icon={<UserRound size={14} strokeWidth={1.5} />} />
        <Row
          label="Blocks"
          value={data ? String(data.blocks) : loading ? "Loading" : "Unknown"}
          icon={<Layers size={14} strokeWidth={1.5} />}
        />
      </Section>

      <div className="sn-divider" />

      <Section title="Linked mentions">
        {!data && loading && <div className="sn-muted" style={{ fontSize: "var(--text-sm)" }}>Loading</div>}
        {data && mentionCount === 0 && <div className="sn-empty">No linked mentions</div>}
        {data && data.backlinks.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-0h)" }}>
            {data.backlinks.map((entry) => (
              <button
                key={`${entry.src}-${entry.prop_id}`}
                className="sn-nav-item"
                style={{ height: "auto", alignItems: "flex-start", padding: "var(--space-1) var(--space-1h)" }}
                onClick={() => onNavigate(entry.src)}
                title={entry.context || entry.srcTitle}
              >
                <span style={{ display: "inline-flex", alignItems: "center", paddingTop: 2 }}>
                  {entry.srcIcon ? (
                    <span style={{ fontSize: "var(--text-sm)" }}>{entry.srcIcon}</span>
                  ) : (
                    <Link2 size={14} strokeWidth={1.5} />
                  )}
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span
                    style={{
                      display: "block",
                      color: "var(--text-primary)",
                      fontSize: "var(--text-sm)",
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {entry.srcTitle || "Untitled"}
                  </span>
                  <span
                    style={{
                      display: "block",
                      color: "var(--text-tertiary)",
                      fontSize: "var(--text-xs)",
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {entry.context || (entry.kind === "relation" ? "Relation" : "Mention")}
                  </span>
                </span>
                <span className="sn-badge">{entry.kind}</span>
              </button>
            ))}
          </div>
        )}
        {data && data.outgoing.length > 0 && (
          <div style={{ marginTop: "var(--space-2)" }}>
            <div className="sn-eyebrow" style={{ marginBottom: "var(--space-1)" }}>
              Outgoing
            </div>
            {data.outgoing.map((entry) => (
              <button
                key={entry.dst}
                className="sn-nav-item"
                style={{ height: "var(--h-row)" }}
                onClick={() => onNavigate(entry.dst)}
              >
                <MoveRight size={14} strokeWidth={1.5} />
                <span className="sn-nav-label">{entry.title || "Untitled"}</span>
              </button>
            ))}
          </div>
        )}
      </Section>

      <div className="sn-divider" />

      <Section
        title="Version history"
        action={
          <button
            className="sn-btn sn-btn-sm"
            onClick={() => void snapshotNow()}
            disabled={busy !== null}
            title="Save a snapshot of this page now"
          >
            Snapshot now
          </button>
        }
      >
        {!data && loading && <div className="sn-muted" style={{ fontSize: "var(--text-sm)" }}>Loading</div>}
        {data && data.snapshots.length === 0 && <div className="sn-empty">No snapshots yet</div>}
        {data && data.snapshots.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
            {data.snapshots.slice(0, 12).map((snap) => (
              <div
                key={snap.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                  minHeight: "var(--h-row)",
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: "var(--text-sm)",
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    textOverflow: "ellipsis",
                  }}
                >
                  {relative(snap.ts)}
                  <span className="sn-muted">{` · ${bytes(snap.bytes)}`}</span>
                  {snap.label ? <span className="sn-muted">{` · ${snap.label}`}</span> : null}
                </span>
                <button
                  className="sn-btn sn-btn-sm"
                  onClick={() => void restore(snap.id)}
                  disabled={busy !== null}
                  title="Restore this snapshot"
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        )}

        {data && data.ops.length > 0 && (
          <div style={{ marginTop: "var(--space-3)" }}>
            <div className="sn-eyebrow" style={{ marginBottom: "var(--space-1)" }}>Recent ops</div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              {data.ops.slice(0, 8).map((op) => (
                <div
                  key={op.seq}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-2)",
                    minHeight: "var(--h-row)",
                    fontSize: "var(--text-xs)",
                  }}
                >
                  <ScrollText size={14} strokeWidth={1.5} style={{ color: "var(--text-tertiary)", flex: "none" }} />
                  <span style={{ width: 56, flex: "none" }}>{op.op}</span>
                  <span className="sn-muted" style={{ flex: "none" }}>
                    {relative(op.ts)}
                  </span>
                  <span
                    className="sn-muted"
                    style={{ minWidth: 0, flex: 1, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}
                  >
                    {actorName(op.actor)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>

      <div className="sn-divider" />

      <div style={{ padding: "0 var(--space-3) var(--space-6)" }}>
        <button
          className="sn-btn sn-btn-destructive"
          style={{ width: "100%" }}
          onClick={() => void moveToTrash()}
          disabled={busy !== null}
        >
          {busy === "trash" ? <FileText size={14} strokeWidth={1.5} /> : <Trash2 size={14} strokeWidth={1.5} />}
          Move to trash
        </button>
      </div>
    </aside>
  );
}
