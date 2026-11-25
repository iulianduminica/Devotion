/**
 * Timeline view: one bar per row, positioned by a date property.
 *
 * All the geometry lives in `viewLogic.ts` (pure, UTC ms). This component only
 * measures the scale, paints it, and writes drags back through the same
 * `api.patchRow` call the Table view's property cells use.
 *
 * Zoom changes the pixels-per-day scale and nothing else — the row set, the
 * grouping and the bar spans are untouched by it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarRange, ChevronLeft, ChevronRight, Crosshair, Settings2, ZoomIn, ZoomOut } from "lucide-react";

import { api } from "../api.ts";
import type { PropertyDef, RowView, ViewSpec } from "../../shared/types.ts";
import {
  DAY_MS,
  TIMELINE_LABEL_W,
  TIMELINE_LANE_H,
  ZOOM_PX_PER_DAY,
  pxToDayOffset,
  resizeSpanEnd,
  rowSpan,
  shiftSpan,
  shortDate,
  ticksForZoom,
  todayOffsetPct,
  type TimelineBar,
  type TimelineZoom,
} from "./viewLogic.ts";

const ZOOM_ORDER: TimelineZoom[] = ["day", "week", "month", "quarter"];

/** Viewport width per zoom, in days. */
const ZOOM_WINDOW_DAYS: Record<TimelineZoom, number> = {
  day: 45,
  week: 90,
  month: 365,
  quarter: 1096,
};

export interface TimelineViewProps {
  rows: RowView[];
  properties: PropertyDef[];
  allProperties: PropertyDef[];
  dbId: string;
  spec: ViewSpec;
  viewId: string;
  groupProp?: string;
  buckets?: { key: string; label: string; color: string; rows: RowView[] }[];
  onOpen: (id: string) => void;
  onRowChanged: () => void;
  onSpecChange: (patch: Partial<ViewSpec>) => void;
  notify: (m: string) => void;
}

export function TimelineView(p: TimelineViewProps): React.ReactNode {
  const { rows, spec, allProperties } = p;

  const dateProps = useMemo(
    () => allProperties.filter((x) => x.type === "date" || x.type === "created_time" || x.type === "last_edited_time"),
    [allProperties],
  );

  const startProp = spec.timelineBy?.start ?? dateProps[0]?.id ?? "";
  const endProp = spec.timelineBy?.end ?? "";
  const configured = Boolean(spec.timelineBy?.start);
  const startDef = allProperties.find((x) => x.id === startProp);
  const endDef = allProperties.find((x) => x.id === endProp);

  const [zoom, setZoom] = useState<TimelineZoom>("month");
  const [anchor, setAnchor] = useState<number>(() => startOfToday());
  const [pxPerDay, setPxPerDay] = useState<number>(ZOOM_PX_PER_DAY.month);
  const [drag, setDrag] = useState<DragState | null>(null);

  const rangeDays = ZOOM_WINDOW_DAYS[zoom];
  const rangeStart = anchor;

  // The scale is a deterministic pixel width, so drag math needs no measuring:
  // one day is exactly pxPerDay, and the container scrolls horizontally.
  const dayPx = pxPerDay;
  const widthPx = rangeDays * pxPerDay;

  const model = useMemo(
    () => buildModel(rows, startProp, endProp, rangeStart, rangeDays, p.groupProp, p.buckets),
    [rows, startProp, endProp, rangeStart, rangeDays, p.groupProp, p.buckets],
  );

  const ticks = useMemo(() => ticksForZoom(rangeStart, rangeDays, zoom), [rangeStart, rangeDays, zoom]);
  const todayPct = useMemo(() => todayOffsetPct(rangeStart, rangeDays, Date.now()), [rangeStart, rangeDays]);

  const commit = useCallback(
    async (rowId: string, next: { start: number; end: number }): Promise<void> => {
      try {
        await api.patchRow(rowId, {
          [startProp]: { start: next.start, end: next.end, allDay: true },
        });
        p.onRowChanged();
      } catch (err) {
        p.notify(`Update failed: ${(err as Error).message}`);
      }
    },
    [startProp, p],
  );

  const onBarPointerDown = (e: React.PointerEvent, bar: TimelineBar, edge: "move" | "end"): void => {
    if (!configured) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({
      rowId: bar.rowId,
      edge,
      originX: e.clientX,
      originStart: bar.start,
      originEnd: bar.end,
      startX: bar.start,
      endX: bar.end,
      label: bar.label,
    });
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drag) return;
    const days = pxToDayOffset(e.clientX - drag.originX, dayPx);
    const next =
      drag.edge === "move"
        ? shiftSpan(drag.originStart, drag.originEnd, days)
        : { start: drag.originStart, end: resizeSpanEnd(drag.originEnd, drag.originStart, days) };
    setDrag({
      ...drag,
      startX: next.start,
      endX: next.end,
      label: `${shortDate(next.start)} → ${shortDate(next.end)} · ${
        Math.round((next.end - next.start) / DAY_MS) + 1
      }d`,
    });
  };

  const endDrag = (e: React.PointerEvent): void => {
    if (!drag) return;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    const moved = drag.startX !== drag.originStart || drag.endX !== drag.originEnd;
    const target = drag.rowId;
    const next = { start: drag.startX, end: drag.endX };
    setDrag(null);
    if (moved) void commit(target, next);
  };

  const step = (dir: number): void => {
    setAnchor((a) => a + dir * Math.round(rangeDays / 4) * DAY_MS);
  };

  const zoomBy = (dir: number): void => {
    const i = ZOOM_ORDER.indexOf(zoom);
    const next = ZOOM_ORDER[Math.min(ZOOM_ORDER.length - 1, Math.max(0, i + dir))];
    if (!next) return;
    setZoom(next);
    setPxPerDay(ZOOM_PX_PER_DAY[next]);
  };

  // Centre the viewport on the first bar, once the data arrives.
  const centred = useRef(false);
  useEffect(() => {
    if (centred.current || !model.bars.length) return;
    centred.current = true;
    const first = model.bars.reduce((a, b) => (a.start < b.start ? a : b));
    setAnchor(first.start - Math.round(rangeDays / 6) * DAY_MS);
  }, [model.bars, rangeDays]);

  if (!dateProps.length) {
    return (
      <div className="sn-empty">
        A timeline needs a Date property.
        <div className="sn-muted" style={{ fontSize: "var(--text-xs)", marginTop: 4 }}>
          Add one to this database, then pick it here.
        </div>
      </div>
    );
  }

  if (!configured) {
    return (
      <div className="sn-empty">
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <CalendarRange size={14} strokeWidth={1.5} />
          <span>Choose the date property to lay rows out on</span>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
          <PropPicker
            label="Start"
            properties={dateProps}
            value={startProp}
            onChange={(id) => p.onSpecChange({ timelineBy: { start: id, ...(endProp ? { end: endProp } : {}) } })}
          />
          <PropPicker
            label="End"
            properties={dateProps}
            value={endProp}
            allowEmpty
            onChange={(id) =>
              p.onSpecChange({ timelineBy: { start: startProp, ...(id ? { end: id } : {}) } })
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div
      style={{ display: "flex", flexDirection: "column" }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* control bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "4px 8px",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-raised)",
          flexWrap: "wrap",
        }}
      >
        <PropPicker
          label="Start"
          properties={dateProps}
          value={startProp}
          onChange={(id) => p.onSpecChange({ timelineBy: { start: id, ...(endProp ? { end: endProp } : {}) } })}
        />
        <PropPicker
          label="End"
          properties={dateProps}
          value={endProp}
          allowEmpty
          onChange={(id) => p.onSpecChange({ timelineBy: { start: startProp, ...(id ? { end: id } : {}) } })}
        />

        <span style={{ flex: 1 }} />

        <button className="sn-btn sn-btn-ghost sn-btn-sm" onClick={() => step(-1)} aria-label="Earlier">
          <ChevronLeft size={13} strokeWidth={1.5} />
        </button>
        <button className="sn-btn sn-btn-ghost sn-btn-sm" onClick={() => setAnchor(startOfToday())}>
          <Crosshair size={13} strokeWidth={1.5} />
          Today
        </button>
        <button className="sn-btn sn-btn-ghost sn-btn-sm" onClick={() => step(1)} aria-label="Later">
          <ChevronRight size={13} strokeWidth={1.5} />
        </button>

        <span className="sn-divider" style={{ width: 1, height: 16, margin: "0 4px", background: "var(--border-default)" }} />

        <button className="sn-btn sn-btn-ghost sn-btn-sm" onClick={() => zoomBy(-1)} aria-label="Zoom out">
          <ZoomOut size={13} strokeWidth={1.5} />
        </button>
        <span className="sn-badge" style={{ textTransform: "capitalize" }}>
          {zoom}
        </span>
        <button className="sn-btn sn-btn-ghost sn-btn-sm" onClick={() => zoomBy(1)} aria-label="Zoom in">
          <ZoomIn size={13} strokeWidth={1.5} />
        </button>
      </div>

      {drag && (
        <div
          className="sn-badge"
          style={{
            position: "fixed",
            left: 12,
            bottom: 12,
            zIndex: 400,
            background: "var(--bg-overlay)",
            border: "1px solid var(--border-default)",
          }}
        >
          {drag.label}
        </div>
      )}

      <div style={{ overflowX: "auto", overflowY: "auto" }}>
        <div style={{ width: TIMELINE_LABEL_W + widthPx, minWidth: "100%" }}>
          {/* header: month / week / day scale */}
          <div
            style={{
              display: "flex",
              position: "sticky",
              top: 0,
              zIndex: 2,
              background: "var(--bg-raised)",
              borderBottom: "1px solid var(--border-default)",
            }}
          >
            <div
              style={{
                width: TIMELINE_LABEL_W,
                flex: "none",
                padding: "4px 8px",
                fontSize: "var(--text-xs)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--text-tertiary)",
                borderRight: "1px solid var(--border-subtle)",
              }}
            >
              {p.groupProp ? "Group / Task" : "Task"}
            </div>
            <div style={{ position: "relative", height: 36, flex: "none", width: widthPx }}>
              {ticks.map((t, i) => {
                // Each label is clipped to the gap before the next tick. Without
                // a width, "September 2026" runs straight into the next label.
                const next = ticks[i + 1];
                const gapPct = Math.max(0, (next ? next.xPct : 100) - t.xPct);
                return (
                  <div
                    key={t.at}
                    style={{
                      position: "absolute",
                      left: `${t.xPct}%`,
                      top: 0,
                      bottom: 0,
                      width: `calc(${gapPct}% - 5px)`,
                      borderLeft: "1px solid var(--border-subtle)",
                      paddingLeft: 4,
                      boxSizing: "border-box",
                      fontSize: "var(--text-xxs)",
                      color: "var(--text-tertiary)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {t.label}
                  </div>
                );
              })}
              {todayPct !== null && (
                <div
                  style={{
                    position: "absolute",
                    left: `${todayPct}%`,
                    top: 0,
                    bottom: 0,
                    width: 1,
                    background: "var(--accent-highlight)",
                  }}
                />
              )}
            </div>
          </div>

          {/* lanes */}
          {model.sections.map((section) => (
            <div key={section.key}>
              {section.label && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    height: 24,
                    paddingLeft: 8,
                    background: "var(--bg-raised)",
                    borderBottom: "1px solid var(--border-subtle)",
                    fontSize: "var(--text-xs)",
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "var(--text-tertiary)",
                  }}
                >
                  <span className="sn-dot" style={{ background: section.color }} />
                  {section.label}
                  <span className="sn-badge">{section.bars.length}</span>
                </div>
              )}
              <div style={{ display: "flex", borderBottom: "1px solid var(--border-subtle)" }}>
                <div style={{ width: TIMELINE_LABEL_W, flex: "none", borderRight: "1px solid var(--border-subtle)" }}>
                  {section.rows.map((row) => (
                    <div
                      key={row.rowId}
                      style={{
                        height: TIMELINE_LANE_H,
                        display: "flex",
                        alignItems: "center",
                        padding: "0 8px",
                        gap: 4,
                        borderTop: "1px solid var(--border-subtle)",
                      }}
                    >
                      <button
                        className="sn-btn sn-btn-ghost"
                        style={{
                          height: "auto",
                          padding: 0,
                          border: 0,
                          fontSize: "var(--text-sm)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={row.title}
                        onClick={() => p.onOpen(row.rowId)}
                      >
                        {row.title}
                      </button>
                    </div>
                  ))}
                </div>
                <div style={{ position: "relative", flex: "none", width: widthPx }}>
                  {/* gridlines */}
                  {ticks.map((t) => (
                    <div
                      key={`g${t.at}`}
                      style={{
                        position: "absolute",
                        left: `${t.xPct}%`,
                        top: 0,
                        bottom: 0,
                        width: 1,
                        background: "var(--border-subtle)",
                        pointerEvents: "none",
                      }}
                    />
                  ))}
                  {todayPct !== null && (
                    <div
                      style={{
                        position: "absolute",
                        left: `${todayPct}%`,
                        top: 0,
                        bottom: 0,
                        width: 1,
                        background: "var(--accent-highlight)",
                        opacity: 0.7,
                        pointerEvents: "none",
                      }}
                    />
                  )}
                  {section.rows.map((row) => {
                    const active = drag?.rowId === row.rowId;
                    const left = active ? pct(row.startX, rangeStart, rangeDays) : row.bar.xPct;
                    const width = active
                      ? pct(row.endX, rangeStart, rangeDays) - left
                      : row.bar.widthPct;
                    return (
                      <div
                        key={row.rowId}
                        style={{
                          position: "absolute",
                          top: row.lane * TIMELINE_LANE_H + 4,
                          left: `${left}%`,
                          width: `max(6px, ${Math.max(0.5, width)}%)`,
                          height: TIMELINE_LANE_H - 8,
                          display: "flex",
                          alignItems: "center",
                          background: active ? "var(--accent-highlight)" : "var(--accent-highlight-muted)",
                          border: `1px solid ${active ? "var(--accent-highlight-hover)" : "var(--accent-highlight)"}`,
                          borderRadius: "var(--radius-sm)",
                          color: active ? "#fff" : "var(--text-primary)",
                          fontSize: "var(--text-xxs)",
                          padding: "0 4px",
                          overflow: "hidden",
                          whiteSpace: "nowrap",
                          textOverflow: "ellipsis",
                          cursor: "grab",
                          touchAction: "none",
                          zIndex: active ? 3 : 1,
                        }}
                        title={`${row.title} · ${row.bar.label}`}
                        onPointerDown={(e) => onBarPointerDown(e, row.bar, "move")}
                      >
                        <span style={{ pointerEvents: "none", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                          {row.title}
                        </span>
                        <span
                          style={{
                            width: 6,
                            height: "100%",
                            flex: "none",
                            cursor: "ew-resize",
                            background: "var(--accent-highlight-hover)",
                            opacity: 0.5,
                            touchAction: "none",
                          }}
                          title="Drag to change duration"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            onBarPointerDown(e, row.bar, "end");
                          }}
                        />
                      </div>
                    );
                  })}
                  <div style={{ height: section.lanes * TIMELINE_LANE_H + 4 }} />
                </div>
              </div>
            </div>
          ))}

          {model.undated > 0 && (
            <div
              className="sn-muted"
              style={{
                padding: "4px 8px",
                fontSize: "var(--text-xs)",
                borderTop: "1px solid var(--border-subtle)",
              }}
            >
              {model.undated} {model.undated === 1 ? "entry has" : "entries have"} no {startDef?.name ?? "start"} date
            </div>
          )}

          {!model.bars.length && (
            <div className="sn-empty">
              Nothing falls in this range
              {model.undated ? ` · ${model.undated} entries have no ${startDef?.name ?? "start"} date` : ""}
              <div style={{ marginTop: 6, fontSize: "var(--text-xs)" }}>
                {endDef ? `${startDef?.name} → ${endDef.name}` : `Single-day bars from ${startDef?.name ?? "the date property"}`}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface DragState {
  rowId: string;
  edge: "move" | "end";
  originX: number;
  originStart: number;
  originEnd: number;
  startX: number;
  endX: number;
  label: string;
}

interface SectionRow {
  rowId: string;
  title: string;
  lane: number;
  bar: TimelineBar;
  startX: number;
  endX: number;
}

interface Section {
  key: string;
  label: string;
  color: string;
  bars: TimelineBar[];
  rows: SectionRow[];
  lanes: number;
}

function buildModel(
  rows: RowView[],
  startProp: string,
  endProp: string,
  rangeStart: number,
  rangeDays: number,
  groupProp?: string,
  buckets?: { key: string; label: string; color: string; rows: RowView[] }[],
): { bars: TimelineBar[]; sections: Section[]; undated: number } {
  const barOf = (row: RowView): TimelineBar | null => {
    const span = rowSpan(row, startProp, endProp);
    if (!span) return null;
    const first = Math.floor(rangeStart / DAY_MS);
    const s = Math.floor(span.start / DAY_MS);
    const e = Math.floor(span.end / DAY_MS);
    const left = Math.max(0, s - first);
    const spanDays = Math.max(1, e - s + 1);
    const visible = Math.min(left + spanDays, rangeDays) - left;
    return {
      rowId: row.node.id,
      title: row.title,
      start: span.start,
      end: span.end,
      days: span.days,
      xPct: (left / rangeDays) * 100,
      widthPct: (Math.max(1, visible) / rangeDays) * 100,
      lane: 0,
      lanes: 1,
      offscreen: e < first || s >= first + rangeDays,
      label: span.days <= 1 ? shortDate(span.start) : `${shortDate(span.start)} → ${shortDate(span.end)} · ${span.days}d`,
    };
  };

  const sections: Section[] = [];
  const groups =
    groupProp && buckets?.length
      ? buckets.map((b) => ({ key: b.key, label: b.label, color: b.color, rows: b.rows }))
      : [{ key: "__all", label: "", color: "var(--text-tertiary)", rows }];

  let undated = 0;
  const allBars: TimelineBar[] = [];
  for (const g of groups) {
    const bars = g.rows
      .map((r) => barOf(r))
      .filter((b): b is TimelineBar => b !== null)
      .sort((a, b) => a.start - b.start || b.end - a.end);
    undated += g.rows.length - bars.length;
    allBars.push(...bars);

    // pack lanes, then keep the row order the query returned
    const freeAt: number[] = [];
    const laneOf = new Map<string, number>();
    for (const bar of bars) {
      let lane = -1;
      for (let l = 0; l < freeAt.length; l++) {
        if ((freeAt[l] ?? 0) <= bar.start) {
          lane = l;
          break;
        }
      }
      if (lane === -1) lane = freeAt.length;
      freeAt[lane] = bar.end + DAY_MS;
      laneOf.set(bar.rowId, lane);
    }
    const lanes = Math.max(1, freeAt.length);
    const ordered = bars.map((bar) => {
      bar.lanes = lanes;
      return {
        rowId: bar.rowId,
        title: bar.title,
        lane: laneOf.get(bar.rowId) ?? 0,
        bar,
        startX: bar.start,
        endX: bar.end,
      };
    });
    sections.push({
      key: g.key,
      label: g.label,
      color: g.color,
      bars,
      rows: ordered,
      lanes,
    });
  }

  return { bars: allBars, sections: sections.filter((s) => s.rows.length > 0 || !groupProp), undated };
}

function pct(ms: number, rangeStart: number, rangeDays: number): number {
  const first = Math.floor(rangeStart / DAY_MS);
  const d = Math.floor(ms / DAY_MS);
  return ((d - first) / rangeDays) * 100;
}

function startOfToday(): number {
  const now = Date.now();
  return Math.floor(now / DAY_MS) * DAY_MS;
}

function PropPicker(props: {
  label: string;
  properties: PropertyDef[];
  value: string;
  allowEmpty?: boolean;
  onChange: (id: string) => void;
}): React.ReactNode {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>
      <Settings2 size={12} strokeWidth={1.5} />
      {props.label}
      <select
        className="sn-input"
        style={{ width: 140, height: 22 }}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {props.allowEmpty && <option value="">None</option>}
        {props.properties.map((prop) => (
          <option key={prop.id} value={prop.id}>
            {prop.name}
          </option>
        ))}
      </select>
    </label>
  );
}
