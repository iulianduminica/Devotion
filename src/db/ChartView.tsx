/**
 * Chart view: bar / line / pie as hand-written inline SVG.
 *
 * No chart library. `viewLogic.ts` buckets the rows and aggregates the y
 * property; this component turns that into paths, axis labels, hover titles and
 * a pie legend. The control bar writes `spec.chart` through the same
 * `api.patchView` path the other view controls use.
 */

import { useMemo, useState } from "react";
import { BarChart3, PieChart, Settings2, TrendingUp } from "lucide-react";

import type { AggregateFunction, PropertyDef, RowView, ViewSpec } from "../../shared/types.ts";
import {
  CHART_OTHER_LABEL,
  CHART_TOP_N,
  buildChartData,
  chartAxis,
  formatChartNumber,
  linePoints,
  pieSlices,
  seriesColor,
  slotCenterX,
  valueToY,
} from "./viewLogic.ts";

const KINDS: { value: "bar" | "line" | "pie"; label: string; icon: React.ReactNode }[] = [
  { value: "bar", label: "Bar", icon: <BarChart3 size={13} strokeWidth={1.5} /> },
  { value: "line", label: "Line", icon: <TrendingUp size={13} strokeWidth={1.5} /> },
  { value: "pie", label: "Pie", icon: <PieChart size={13} strokeWidth={1.5} /> },
];

const AGGS: { value: AggregateFunction; label: string }[] = [
  { value: "count", label: "Count of values" },
  { value: "countAll", label: "Count of rows" },
  { value: "countUnique", label: "Count unique" },
  { value: "countChecked", label: "Count checked" },
  { value: "percentChecked", label: "% checked" },
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "median", label: "Median" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
  { value: "range", label: "Range" },
];

const NUMERIC_TYPES = ["number", "checkbox", "date", "created_time", "last_edited_time", "unique_id", "formula", "rollup"];

const W = 720;
const H = 300;
const PAD = { top: 16, right: 16, bottom: 44, left: 52 };

export interface ChartViewProps {
  rows: RowView[];
  properties: PropertyDef[];
  allProperties: PropertyDef[];
  dbId: string;
  spec: ViewSpec;
  viewId: string;
  onOpen: (id: string) => void;
  onRowChanged: () => void;
  onSpecChange: (patch: Partial<ViewSpec>) => void;
  notify: (m: string) => void;
}

export function ChartView(p: ChartViewProps): React.ReactNode {
  const { spec, allProperties } = p;
  const [hover, setHover] = useState<number | null>(null);

  const xProp = spec.chart?.x ?? allProperties[0]?.id ?? "";
  const yProp =
    spec.chart?.y ??
    allProperties.find((x) => NUMERIC_TYPES.includes(x.type))?.id ??
    allProperties[0]?.id ??
    "";
  const kind = spec.chart?.kind ?? "bar";
  const agg: AggregateFunction = spec.chart?.agg ?? "count";

  const data = useMemo(
    () =>
      buildChartData({
        rows: p.rows,
        properties: allProperties,
        xProp,
        yProp,
        agg,
      }),
    [p.rows, allProperties, xProp, yProp, agg],
  );

  const xDef = allProperties.find((x) => x.id === xProp);
  const yDef = allProperties.find((x) => x.id === yProp);

  return (
    <div>
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
        <div style={{ display: "inline-flex", gap: 2 }}>
          {KINDS.map((k) => (
            <button
              key={k.value}
              className={`sn-btn sn-btn-sm ${kind === k.value ? "sn-btn-primary" : "sn-btn-ghost"}`}
              style={{ height: 22 }}
              onClick={() => p.onSpecChange({ chart: { kind: k.value, x: xProp, y: yProp, agg } })}
            >
              {k.icon}
              {k.label}
            </button>
          ))}
        </div>

        <Field label="X axis">
          <select
            className="sn-input"
            style={{ width: 150, height: 22 }}
            value={xProp}
            onChange={(e) => p.onSpecChange({ chart: { kind, x: e.target.value, y: yProp, agg } })}
          >
            {allProperties.map((prop) => (
              <option key={prop.id} value={prop.id}>
                {prop.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Y axis">
          <select
            className="sn-input"
            style={{ width: 150, height: 22 }}
            value={yProp}
            onChange={(e) => p.onSpecChange({ chart: { kind, x: xProp, y: e.target.value, agg } })}
          >
            {allProperties.map((prop) => (
              <option key={prop.id} value={prop.id}>
                {prop.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Calculate">
          <select
            className="sn-input"
            style={{ width: 130, height: 22 }}
            value={agg}
            onChange={(e) => p.onSpecChange({ chart: { kind, x: xProp, y: yProp, agg: e.target.value as AggregateFunction } })}
          >
            {AGGS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </Field>

        <span style={{ flex: 1 }} />
        <span className="sn-muted" style={{ fontSize: "var(--text-xs)" }}>
          {data.bucketCount} {data.bucketCount === 1 ? "bucket" : "buckets"}
          {data.bucketCount > CHART_TOP_N ? ` · top ${CHART_TOP_N}` : ""}
          {data.emptyCount ? ` · ${data.emptyCount} empty` : ""}
        </span>
      </div>

      {allProperties.length === 0 ? (
        <div className="sn-empty">This database has no properties to chart</div>
      ) : data.kind === "empty" ? (
        <div className="sn-empty">
          No data to chart
          <div className="sn-muted" style={{ fontSize: "var(--text-xs)", marginTop: 4 }}>
            {p.rows.length
              ? `Every row is empty for ${xDef?.name ?? "the x property"}.`
              : "No rows match this view."}
          </div>
        </div>
      ) : (
        <div style={{ padding: 8, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 420px", minWidth: 280 }}>
            {kind === "pie" ? (
              <PieChartSvg data={data} hover={hover} onHover={setHover} />
            ) : (
              <AxisChartSvg data={data} kind={kind} hover={hover} onHover={setHover} yLabel={yDef?.name ?? ""} />
            )}
          </div>

          <Legend
            data={data}
            kind={kind}
            hover={hover}
            onHover={setHover}
            xLabel={xDef?.name ?? "x"}
            yLabel={`${aggLabel(agg)} ${yDef?.name ?? ""}`.trim()}
          />
        </div>
      )}
    </div>
  );
}

function Field(props: { label: string; children: React.ReactNode }): React.ReactNode {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: "var(--text-xs)",
        color: "var(--text-tertiary)",
      }}
    >
      <Settings2 size={12} strokeWidth={1.5} />
      {props.label}
      {props.children}
    </label>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bar / line
// ─────────────────────────────────────────────────────────────────────────────

function AxisChartSvg(props: {
  data: ReturnType<typeof buildChartData>;
  kind: "bar" | "line";
  hover: number | null;
  onHover: (i: number | null) => void;
  yLabel: string;
}): React.ReactNode {
  const { data, kind, hover, onHover } = props;
  const axis = chartAxis(data.minValue, data.maxValue);
  const top = PAD.top;
  const bottom = H - PAD.bottom;
  const left = PAD.left;
  const right = W - PAD.right;
  const zeroY = valueToY(0, axis.lo, axis.hi, top, bottom);
  const n = data.values.length;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      style={{ display: "block", maxHeight: 360, overflow: "visible" }}
      role="img"
      aria-label={`${kind} chart of ${data.labels.length} buckets`}
      onPointerLeave={() => onHover(null)}
    >
      {/* gridlines + y labels */}
      {axis.ticks.map((t) => {
        const y = valueToY(t, axis.lo, axis.hi, top, bottom);
        return (
          <g key={t}>
            <line
              x1={left}
              x2={right}
              y1={y}
              y2={y}
              stroke={t === 0 ? "var(--border-strong)" : "var(--border-subtle)"}
              strokeWidth={1}
            />
            <text
              x={left - 6}
              y={y + 3}
              textAnchor="end"
              fontSize={9}
              fill="var(--text-tertiary)"
              fontFamily="var(--font-mono, monospace)"
            >
              {formatChartNumber(t)}
            </text>
          </g>
        );
      })}

      {/* bars */}
      {kind === "bar" &&
        data.values.map((v, i) => {
          const cx = slotCenterX(i, n, left, right);
          const slot = (right - left) / n;
          const bw = Math.max(3, Math.min(40, slot * 0.62));
          const y = valueToY(v, axis.lo, axis.hi, top, bottom);
          const topY = Math.min(y, zeroY);
          const height = Math.max(1, Math.abs(zeroY - y));
          const on = hover === i;
          return (
            <g key={i} onPointerEnter={() => onHover(i)}>
              <title>{`${data.labels[i]}: ${formatChartNumber(v)}`}</title>
              <rect
                x={cx - bw / 2}
                y={topY}
                width={bw}
                height={height}
                rx={2}
                fill={on ? "var(--accent-highlight-hover)" : "var(--accent-highlight)"}
                opacity={on ? 1 : 0.82}
              />
              {v < 0 && (
                <rect x={cx - bw / 2} y={topY} width={bw} height={2} fill="var(--status-error)" opacity={0.9} />
              )}
            </g>
          );
        })}

      {/* line */}
      {kind === "line" && (
        <g onPointerEnter={() => onHover(null)}>
          <polyline
            points={linePoints(data.values, axis.lo, axis.hi, top, bottom, left, right)}
            fill="none"
            stroke="var(--accent-highlight)"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <polygon
            points={`${left},${zeroY} ${linePoints(data.values, axis.lo, axis.hi, top, bottom, left, right)} ${right},${zeroY}`}
            fill="var(--accent-highlight)"
            opacity={0.08}
          />
          {data.values.map((v, i) => {
            const cx = slotCenterX(i, n, left, right);
            const y = valueToY(v, axis.lo, axis.hi, top, bottom);
            const on = hover === i;
            return (
              <g key={i} onPointerEnter={() => onHover(i)}>
                <title>{`${data.labels[i]}: ${formatChartNumber(v)}`}</title>
                <circle
                  cx={cx}
                  cy={y}
                  r={on ? 4 : 2.5}
                  fill={v < 0 ? "var(--status-error)" : "var(--accent-highlight)"}
                  stroke="var(--bg-base)"
                  strokeWidth={1}
                />
                <rect
                  x={cx - (right - left) / n / 2}
                  y={top}
                  width={(right - left) / n}
                  height={bottom - top}
                  fill="transparent"
                />
              </g>
            );
          })}
        </g>
      )}

      {/* x labels */}
      {data.labels.map((label, i) => {
        const cx = slotCenterX(i, n, left, right);
        const on = hover === i;
        return (
          <text
            key={i}
            x={cx}
            y={bottom + 12}
            textAnchor={n > 8 ? "end" : "middle"}
            fontSize={9}
            fill={on ? "var(--text-primary)" : "var(--text-tertiary)"}
            transform={n > 8 ? `rotate(-35 ${cx} ${bottom + 12})` : undefined}
          >
            {truncate(label, n > 6 ? 10 : 16)}
          </text>
        );
      })}

      <line x1={left} x2={left} y1={top} y2={bottom} stroke="var(--border-default)" strokeWidth={1} />
      <line x1={left} x2={right} y1={bottom} y2={bottom} stroke="var(--border-default)" strokeWidth={1} />

      {hover !== null && data.labels[hover] !== undefined && (
        <HoverTag
          x={slotCenterX(hover, n, left, right)}
          y={valueToY(data.values[hover] ?? 0, axis.lo, axis.hi, top, bottom)}
          label={data.labels[hover] ?? ""}
          value={formatChartNumber(data.values[hover] ?? 0)}
          left={left}
          right={right}
        />
      )}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pie
// ─────────────────────────────────────────────────────────────────────────────

function PieChartSvg(props: {
  data: ReturnType<typeof buildChartData>;
  hover: number | null;
  onHover: (i: number | null) => void;
}): React.ReactNode {
  const { data, hover, onHover } = props;
  const r = 108;
  const size = r * 2;
  const slices = useMemo(() => pieSlices(data.labels, data.values, r), [data.labels, data.values]);
  const positive = data.values.filter((v) => v > 0).length;
  const zeroTotal = data.total === 0;

  if (!slices.length) {
    return (
      <div className="sn-empty" style={{ border: "1px solid var(--border-default)", borderRadius: "var(--radius-lg)" }}>
        Every bucket is zero
        <div className="sn-muted" style={{ fontSize: "var(--text-xs)", marginTop: 4 }}>
          A pie needs a positive total. Switch to a bar chart, or check the calculation.
        </div>
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      style={{ maxWidth: "100%", display: "block", margin: "0 auto" }}
      role="img"
      aria-label={`pie chart of ${slices.length} slices`}
      onPointerLeave={() => onHover(null)}
    >
      {slices.map((s) => {
        const on = hover === s.index;
        return (
          <path
            key={s.index}
            d={s.path}
            fill={seriesColor(s.index)}
            opacity={on ? 1 : 0.82}
            stroke="var(--bg-base)"
            strokeWidth={on ? 2 : 1}
            onPointerEnter={() => onHover(s.index)}
          >
            <title>{`${s.label}: ${formatChartNumber(s.value)} · ${s.pct.toFixed(1)}%`}</title>
          </path>
        );
      })}
      <text
        x={r}
        y={r}
        textAnchor="middle"
        fontSize={11}
        fill="var(--text-tertiary)"
        style={{ pointerEvents: "none" }}
      >
        {hover !== null && slices[hover]
          ? `${slices[hover]!.pct.toFixed(0)}%`
          : zeroTotal
            ? "0 total"
            : positive === 1 && slices.length > 1
              ? "1 positive"
              : ""}
      </text>
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Legend
// ─────────────────────────────────────────────────────────────────────────────

function Legend(props: {
  data: ReturnType<typeof buildChartData>;
  kind: "bar" | "line" | "pie";
  hover: number | null;
  onHover: (i: number | null) => void;
  xLabel: string;
  yLabel: string;
}): React.ReactNode {
  const { data, kind, hover, onHover } = props;
  const maxAbs = Math.max(...data.values.map((v) => Math.abs(v)), 1);

  return (
    <div
      className="sn-card"
      style={{ flex: "0 1 232px", padding: 8, maxHeight: 320, overflowY: "auto" }}
      onPointerLeave={() => onHover(null)}
    >
      <div className="sn-eyebrow" style={{ marginBottom: 6 }}>
        {props.xLabel} → {props.yLabel}
      </div>
      {data.labels.map((label, i) => {
        const v = data.values[i] ?? 0;
        const on = hover === i;
        return (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 20,
              padding: "0 2px",
              borderRadius: "var(--radius-sm)",
              background: on ? "var(--bg-selected)" : undefined,
              fontSize: "var(--text-xs)",
            }}
            onPointerEnter={() => onHover(i)}
          >
            <span
              className="sn-dot"
              style={{ background: kind === "pie" ? seriesColor(i) : "var(--accent-highlight)" }}
            />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: label === CHART_OTHER_LABEL ? "var(--text-secondary)" : "var(--text-primary)",
              }}
              title={label}
            >
              {label}
            </span>
            <span style={{ fontFamily: "var(--font-mono, monospace)", color: "var(--text-secondary)" }}>
              {formatChartNumber(v)}
            </span>
            <span
              style={{
                width: 28,
                height: 3,
                flex: "none",
                borderRadius: "var(--radius-full)",
                background: v < 0 ? "var(--status-error)" : "var(--accent-highlight)",
                opacity: 0.5 + (Math.abs(v) / maxAbs) * 0.5,
              }}
            />
          </div>
        );
      })}
      <div className="sn-divider" />
      <div style={{ display: "flex", gap: 6, fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
        <span>Total</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{formatChartNumber(data.total)}</span>
      </div>
      {data.nonNumeric > 0 && (
        <div className="sn-muted" style={{ fontSize: "var(--text-xxs)", marginTop: 4 }}>
          {data.nonNumeric} rows have no number in {props.yLabel.replace(/^[^\s]+ /, "")}
        </div>
      )}
    </div>
  );
}

function HoverTag(props: {
  x: number;
  y: number;
  label: string;
  value: string;
  left: number;
  right: number;
}): React.ReactNode {
  const w = Math.max(64, Math.min(180, props.label.length * 6 + 44));
  const x = Math.max(props.left, Math.min(props.right - w, props.x - w / 2));
  const y = Math.max(2, props.y - 30);
  return (
    <g style={{ pointerEvents: "none" }}>
      <rect
        x={x}
        y={y}
        width={w}
        height={20}
        rx={3}
        fill="var(--bg-overlay)"
        stroke="var(--border-default)"
        strokeWidth={1}
      />
      <text x={x + 6} y={y + 13} fontSize={9} fill="var(--text-primary)">
        {truncate(props.label, 22)}
      </text>
      <text x={x + w - 6} y={y + 13} fontSize={9} textAnchor="end" fill="var(--accent-highlight)">
        {props.value}
      </text>
    </g>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function aggLabel(fn: AggregateFunction): string {
  return AGGS.find((a) => a.value === fn)?.label ?? fn;
}
