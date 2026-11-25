/**
 * Database block: view tabs, the five v1 views, property editing, and the
 * filter / sort / group / hide / aggregate controls.
 *
 * All views read through the same server-side query builder, so a filter
 * defined on the Table view behaves identically on Board, List, Gallery and
 * Calendar.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  Calendar,
  ChevronDown,
  Columns3,
  Filter,
  GripVertical,
  Image as ImageIcon,
  LayoutGrid,
  List as ListIcon,
  Plus,
  Rows3,
  Settings2,
  SortAsc,
  Table as TableIcon,
  Trash2,
  X,
} from "lucide-react";
import { format } from "date-fns";

import { TimelineView } from "./TimelineView.tsx";
import { ChartView } from "./ChartView.tsx";
import { FormView } from "./FormView.tsx";
import { columnWidthForType, fitColumns, tableScrolls, tableWidth } from "./tableLayout.ts";

import { api, mediaSrc, type DatabaseFull, type QueryResponse } from "../api.ts";
import type {
  AggregateFunction,
  FilterRule,
  GroupRule,
  PropertyDef,
  PropertyValueInput,
  RowView,
  SelectOption,
  SortRule,
  ViewSpec,
  ViewType,
} from "../../shared/types.ts";
import type { GroupBucket } from "../../server/databases.ts";
import { defaultViewSpec } from "../../shared/types.ts";

const VIEW_ICONS: Record<ViewType, React.ReactNode> = {
  table: <TableIcon size={13} strokeWidth={1.5} />,
  board: <Columns3 size={13} strokeWidth={1.5} />,
  list: <ListIcon size={13} strokeWidth={1.5} />,
  gallery: <LayoutGrid size={13} strokeWidth={1.5} />,
  calendar: <Calendar size={13} strokeWidth={1.5} />,
  timeline: <Rows3 size={13} strokeWidth={1.5} />,
  chart: <SortAsc size={13} strokeWidth={1.5} />,
  form: <Settings2 size={13} strokeWidth={1.5} />,
};

const V1_VIEWS: ViewType[] = ["table", "board", "list", "gallery", "calendar", "timeline", "chart", "form"];

export interface DatabaseViewProps {
  databaseId: string;
  nodeId: string;
  onChanged: () => void;
  notify: (message: string) => void;
}

export function DatabaseView(props: DatabaseViewProps): React.ReactNode {
  const { databaseId, notify } = props;
  const [db, setDb] = useState<DatabaseFull | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const [spec, setSpec] = useState<ViewSpec>(defaultViewSpec());
  const [data, setData] = useState<QueryResponse | null>(null);
  const [buckets, setBuckets] = useState<GroupBucket[]>([]);
  const [loading, setLoading] = useState(true);
  /** bumped when relation titles arrive, so the pills re-render with names */
  const [tick, setTick] = useState(0);
  const [panel, setPanel] = useState<null | "filter" | "sort" | "group" | "aggregate">(null);

  const load = useCallback(async (): Promise<void> => {
    const full = await api.database(databaseId);
    setDb(full);
    const active = full.views[0];
    if (active) {
      setViewId(active.id);
      setSpec(active.spec ?? defaultViewSpec());
    }
  }, [databaseId]);

  useEffect(() => {
    void load().catch((err: Error) => notify(`Database load failed: ${err.message}`));
  }, [load, notify]);

  const runQuery = useCallback(async (): Promise<void> => {
    if (!viewId) return;
    setLoading(true);
    try {
      const res = await api.query(viewId);
      setData(res);

      // Relation cells render titles, so prime the cache for every linked row
      // in one batch — otherwise the pills show raw ULIDs.
      const linked = new Set<string>();
      for (const row of res.rows) {
        for (const prop of res.properties) {
          if (prop.type !== "relation") continue;
          const rowsV = (row.values[prop.id] as { rows?: string[] } | undefined)?.rows ?? [];
          for (const id of rowsV) linked.add(id);
        }
      }
      if (linked.size) {
        try {
          for (const t of await api.titles([...linked])) primeRowTitle(t.id, t.title);
          setTick((n) => n + 1);
        } catch {
          // titles are cosmetic; the relation pills keep their ids
        }
      }

      const groupProp = res.spec.group[0]?.prop;
      if (groupProp) {
        const g = await api.grouped(viewId, groupProp, res.spec, res.spec.group[1]?.prop);
        setBuckets(g.buckets);
      } else {
        setBuckets([]);
      }
    } catch (err) {
      notify(`Query failed: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [viewId, notify]);

  useEffect(() => {
    void runQuery();
  }, [runQuery]);

  const activeView = db?.views.find((v) => v.id === viewId);

  const patchSpec = async (next: Partial<ViewSpec>): Promise<void> => {
    const merged = { ...spec, ...next };
    setSpec(merged);
    if (!viewId) return;
    try {
      await api.patchView(viewId, { spec: merged });
      await runQuery();
    } catch (err) {
      notify(`View update failed: ${(err as Error).message}`);
    }
  };

  if (!db) {
    return (
      <div className="sn-muted" style={{ padding: 12, border: "1px solid var(--border-default)", borderRadius: 6 }}>
        Loading database…
      </div>
    );
  }

  const visibleProps = (db.properties ?? []).filter((p) => !spec.hidden.includes(p.id));
  const titleProp = db.properties.find((p) => p.type === "title") ?? db.properties[0];

  return (
    <div
      style={{
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
        margin: "12px 0",
      }}
    >
      {/* header: tabs + controls */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          height: "var(--h-tabbar)",
          padding: "0 8px",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-raised)",
          flexWrap: "nowrap",
          overflowX: "auto",
        }}
      >
        {db.views.map((v) => (
          <button
            key={v.id}
            className={`sn-btn sn-btn-sm ${v.id === viewId ? "sn-btn-primary" : "sn-btn-ghost"}`}
            onClick={() => {
              setViewId(v.id);
              setSpec(v.spec ?? defaultViewSpec());
            }}
            style={{ height: 22 }}
          >
            {VIEW_ICONS[v.type]}
            {v.name}
          </button>
        ))}

        <AddViewMenu
          dbId={db.databaseId}
          onCreated={(id, spec2) => {
            setViewId(id);
            setSpec(spec2);
            void load();
          }}
        />

        <div style={{ flex: 1 }} />

        <ControlButton
          icon={<Filter size={13} strokeWidth={1.5} />}
          label={`Filter${spec.filter.rules.length ? ` (${spec.filter.rules.length})` : ""}`}
          active={panel === "filter"}
          onClick={() => setPanel(panel === "filter" ? null : "filter")}
        />
        <ControlButton
          icon={<SortAsc size={13} strokeWidth={1.5} />}
          label={`Sort${spec.sort.length ? ` (${spec.sort.length})` : ""}`}
          active={panel === "sort"}
          onClick={() => setPanel(panel === "sort" ? null : "sort")}
        />
        <ControlButton
          icon={<Columns3 size={13} strokeWidth={1.5} />}
          label={`Group${spec.group.length ? ` (${spec.group.length})` : ""}`}
          active={panel === "group"}
          onClick={() => setPanel(panel === "group" ? null : "group")}
        />
        <ControlButton
          icon={<Settings2 size={13} strokeWidth={1.5} />}
          label="Properties"
          onClick={() => setPanel(panel === "aggregate" ? null : "aggregate")}
        />
      </div>

      {panel && (
        <SpecPanel
          kind={panel}
          properties={db.properties}
          spec={spec}
          onApply={patchSpec}
          onClose={() => setPanel(null)}
        />
      )}

      {/* body */}
      <div style={{ maxHeight: 640, overflow: "auto", background: "var(--bg-base)" }}>
        {loading && <div className="sn-empty">Loading…</div>}
        {!loading && data && activeView && (
          <>
            {activeView.type === "table" && (
              <TableView
                rows={data.rows}
                properties={visibleProps}
                allProperties={db.properties}
                dbId={db.databaseId}
                spec={spec}
                onOpen={(id) => (window.location.hash = `/page/${id}`)}
                onRowChanged={runQuery}
                notify={notify}
              />
            )}
            {activeView.type === "board" && (
              <BoardView
                buckets={spec.group[0] ? buckets : fallbackBoard(db.properties, data.rows)}
                rows={data.rows}
                properties={visibleProps}
                allProperties={db.properties}
                dbId={db.databaseId}
                groupProp={spec.group[0]?.prop ?? groupableProps(db.properties)[0]?.id}
                onOpen={(id) => (window.location.hash = `/page/${id}`)}
                onRowChanged={runQuery}
                notify={notify}
              />
            )}
            {activeView.type === "list" && (
              <ListView
                rows={data.rows}
                properties={visibleProps}
                allProperties={db.properties}
                dbId={db.databaseId}
                titleProp={titleProp}
                onOpen={(id) => (window.location.hash = `/page/${id}`)}
                onRowChanged={runQuery}
                notify={notify}
              />
            )}
            {activeView.type === "gallery" && (
              <GalleryView
                rows={data.rows}
                properties={visibleProps}
                allProperties={db.properties}
                dbId={db.databaseId}
                spec={spec}
                onOpen={(id) => (window.location.hash = `/page/${id}`)}
                onRowChanged={runQuery}
                notify={notify}
              />
            )}
            {activeView.type === "calendar" && (
              <CalendarView
                rows={data.rows}
                properties={visibleProps}
                allProperties={db.properties}
                dbId={db.databaseId}
                dateProp={spec.calendarBy ?? dateProps(db.properties)[0]?.id}
                titleProp={titleProp}
                onOpen={(id) => (window.location.hash = `/page/${id}`)}
                onRowChanged={runQuery}
                notify={notify}
              />
            )}
            {activeView.type === "timeline" && (
              <TimelineView
                rows={data.rows}
                properties={visibleProps}
                allProperties={db.properties}
                dbId={db.databaseId}
                spec={spec}
                viewId={viewId ?? ""}
                groupProp={spec.group[0]?.prop}
                buckets={buckets}
                onOpen={(id) => (window.location.hash = `/page/${id}`)}
                onRowChanged={runQuery}
                onSpecChange={patchSpec}
                notify={notify}
              />
            )}
            {activeView.type === "chart" && (
              <ChartView
                rows={data.rows}
                properties={visibleProps}
                allProperties={db.properties}
                dbId={db.databaseId}
                spec={spec}
                viewId={viewId ?? ""}
                onOpen={(id) => (window.location.hash = `/page/${id}`)}
                onRowChanged={runQuery}
                onSpecChange={patchSpec}
                notify={notify}
              />
            )}
            {activeView.type === "form" && (
              <FormView
                rows={data.rows}
                properties={visibleProps}
                allProperties={db.properties}
                dbId={db.databaseId}
                dbTitle={db.title}
                spec={spec}
                viewId={viewId ?? ""}
                onOpen={(id) => (window.location.hash = `/page/${id}`)}
                onRowChanged={runQuery}
                onSpecChange={patchSpec}
                notify={notify}
              />
            )}
          </>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          borderTop: "1px solid var(--border-subtle)",
          background: "var(--bg-raised)",
        }}
      >
        <button
          className="sn-btn sn-btn-ghost sn-btn-sm"
          onClick={async () => {
            await api.createRow(db.databaseId, {});
            await runQuery();
            props.onChanged();
          }}
        >
          <Plus size={13} strokeWidth={1.5} />
          New
        </button>
        <span className="sn-muted" style={{ fontSize: "var(--text-xs)" }}>
          {data?.total ?? 0} {data?.total === 1 ? "entry" : "entries"}
          {spec.filter.rules.length > 0 ? " · filtered" : ""}
          {spec.sort.length > 0 ? ` · sorted by ${spec.sort.length}` : ""}
        </span>
        <div style={{ flex: 1 }} />
        <button
          className="sn-btn sn-btn-ghost sn-btn-sm"
          onClick={async () => {
            if (!viewId) return;
            try {
              const text = await api.exportCsv(viewId);
              const a = document.createElement("a");
              a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
              a.download = `${db.title || "view"}.csv`;
              a.click();
              URL.revokeObjectURL(a.href);
            } catch (err) {
              notify(`Export failed: ${(err as Error).message}`);
            }
          }}
        >
          Export CSV
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Controls
// ─────────────────────────────────────────────────────────────────────────────

function ControlButton(props: { icon: React.ReactNode; label: string; active?: boolean; onClick: () => void }): React.ReactNode {
  return (
    <button
      className={`sn-btn sn-btn-ghost sn-btn-sm ${props.active ? "is-active" : ""}`}
      style={{ height: 22, background: props.active ? "var(--bg-selected)" : undefined }}
      onClick={props.onClick}
    >
      {props.icon}
      {props.label}
    </button>
  );
}

function AddViewMenu(props: { dbId: string; onCreated: (id: string, spec: ViewSpec) => void }): React.ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button className="sn-btn sn-btn-ghost sn-btn-sm" style={{ height: 22 }} onClick={() => setOpen((v) => !v)} aria-label="Add view">
        <Plus size={13} strokeWidth={1.5} />
      </button>
      {open && (
        <div className="sn-menu" style={{ top: 26, left: 0 }} onMouseLeave={() => setOpen(false)}>
          {V1_VIEWS.map((t) => (
            <button
              key={t}
              className="sn-menu-item"
              onClick={async () => {
                setOpen(false);
                const v = await api.createView(props.dbId, t[0]!.toUpperCase() + t.slice(1), t);
                if (v.id) props.onCreated(v.id, defaultViewSpec());
              }}
            >
              {VIEW_ICONS[t]}
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SpecPanel(props: {
  kind: "filter" | "sort" | "group" | "aggregate";
  properties: PropertyDef[];
  spec: ViewSpec;
  onApply: (patch: Partial<ViewSpec>) => void;
  onClose: () => void;
}): React.ReactNode {
  const { kind, properties, spec } = props;
  const groupable = groupableProps(properties);

  return (
    <div style={{ padding: 8, borderBottom: "1px solid var(--border-subtle)", background: "var(--bg-raised)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span className="sn-eyebrow">{kind}</span>
        <div style={{ flex: 1 }} />
        <button className="sn-btn sn-btn-ghost sn-btn-icon" style={{ width: 20, height: 20 }} onClick={props.onClose} aria-label="Close">
          <X size={12} strokeWidth={1.5} />
        </button>
      </div>

      {kind === "filter" && (
        <>
          {spec.filter.rules.map((rule, i) => (
            <RuleRow
              key={i}
              rule={rule}
              properties={properties}
              onChange={(next) => {
                const rules = [...spec.filter.rules];
                rules[i] = next;
                props.onApply({ filter: { ...spec.filter, rules } });
              }}
              onRemove={() => {
                props.onApply({ filter: { ...spec.filter, rules: spec.filter.rules.filter((_, j) => j !== i) } });
              }}
            />
          ))}
          <button
            className="sn-btn sn-btn-ghost sn-btn-sm"
            onClick={() => {
              const first = properties[0];
              if (!first) return;
              props.onApply({
                filter: { ...spec.filter, rules: [...spec.filter.rules, { prop: first.id, operator: "isNotEmpty" }] },
              });
            }}
          >
            <Plus size={13} strokeWidth={1.5} />
            Add filter
          </button>
          <label style={{ display: "inline-flex", gap: 4, alignItems: "center", marginLeft: 12, fontSize: "var(--text-xs)" }}>
            <input
              type="checkbox"
              checked={spec.filter.and}
              onChange={(e) => props.onApply({ filter: { ...spec.filter, and: e.target.checked } })}
            />
            Match all
          </label>
        </>
      )}

      {kind === "sort" && (
        <>
          {spec.sort.map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 4 }}>
              <select
                className="sn-input"
                style={{ width: 160 }}
                value={s.prop}
                onChange={(e) => {
                  const sort = [...spec.sort];
                  sort[i] = { ...s, prop: e.target.value };
                  props.onApply({ sort });
                }}
              >
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                className="sn-btn sn-btn-ghost sn-btn-icon"
                onClick={() => {
                  const sort = [...spec.sort];
                  sort[i] = { ...s, direction: s.direction === "ascending" ? "descending" : "ascending" };
                  props.onApply({ sort });
                }}
                title={s.direction}
              >
                <ArrowDown size={13} strokeWidth={1.5} style={{ transform: s.direction === "ascending" ? "none" : "rotate(180deg)" }} />
              </button>
              <button
                className="sn-btn sn-btn-ghost sn-btn-icon"
                onClick={() => props.onApply({ sort: spec.sort.filter((_, j) => j !== i) })}
              >
                <Trash2 size={13} strokeWidth={1.5} />
              </button>
            </div>
          ))}
          <button
            className="sn-btn sn-btn-ghost sn-btn-sm"
            onClick={() => {
              const first = properties[0];
              if (!first) return;
              props.onApply({ sort: [...spec.sort, { prop: first.id, direction: "ascending" }] });
            }}
          >
            <Plus size={13} strokeWidth={1.5} />
            Add sort
          </button>
        </>
      )}

      {kind === "group" && (
        <>
          {spec.group.map((g, i) => (
            <div key={i} style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 4 }}>
              <select
                className="sn-input"
                style={{ width: 180 }}
                value={g.prop}
                onChange={(e) => {
                  const group = [...spec.group];
                  group[i] = { ...g, prop: e.target.value };
                  props.onApply({ group });
                }}
              >
                {groupable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                className="sn-btn sn-btn-ghost sn-btn-icon"
                onClick={() => props.onApply({ group: spec.group.filter((_, j) => j !== i) })}
              >
                <Trash2 size={13} strokeWidth={1.5} />
              </button>
            </div>
          ))}
          <button
            className="sn-btn sn-btn-ghost sn-btn-sm"
            onClick={() => {
              const first = groupable[0];
              if (!first) return;
              props.onApply({ group: [...spec.group, { prop: first.id } as GroupRule] });
            }}
          >
            <Plus size={13} strokeWidth={1.5} />
            Add grouping
          </button>
        </>
      )}

      {kind === "aggregate" && (
        <div>
          {properties.map((p) => (
            <label key={p.id} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "var(--text-sm)", padding: "2px 0" }}>
              <input
                type="checkbox"
                checked={!spec.hidden.includes(p.id)}
                onChange={(e) =>
                  props.onApply({
                    hidden: e.target.checked ? spec.hidden.filter((h) => h !== p.id) : [...spec.hidden, p.id],
                  })
                }
              />
              {p.name}
              <span className="sn-badge">{p.type}</span>
              <select
                className="sn-input"
                style={{ width: 110, marginLeft: "auto" }}
                value={spec.aggregates[p.id] ?? ""}
                onChange={(e) => {
                  const aggregates = { ...spec.aggregates };
                  if (e.target.value) aggregates[p.id] = e.target.value as AggregateFunction;
                  else delete aggregates[p.id];
                  props.onApply({ aggregates });
                }}
              >
                <option value="">No calculation</option>
                {AGGREGATES.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

const AGGREGATES: { value: AggregateFunction; label: string }[] = [
  { value: "count", label: "Count" },
  { value: "countAll", label: "Count all" },
  { value: "countUnique", label: "Count unique" },
  { value: "countChecked", label: "Count checked" },
  { value: "percentChecked", label: "% checked" },
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "median", label: "Median" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
  { value: "range", label: "Range" },
  { value: "showOriginal", label: "Show original" },
];

function RuleRow(props: {
  rule: FilterRule;
  properties: PropertyDef[];
  onChange: (rule: FilterRule) => void;
  onRemove: () => void;
}): React.ReactNode {
  const prop = props.properties.find((p) => p.id === props.rule.prop);
  const operators = operatorsFor(prop?.type ?? "text");

  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
      <select
        className="sn-input"
        style={{ width: 140 }}
        value={props.rule.prop}
        onChange={(e) => {
          const nextPropId = e.target.value;
          const nextProp = props.properties.find((p) => p.id === nextPropId);
          props.onChange({
            ...props.rule,
            prop: nextPropId,
            // switching property invalidates the old operator: pick that
            // property's default so the rule never sends an impossible filter
            operator: operatorsFor(nextProp?.type ?? "text")[0]!
              .value as FilterRule["operator"],
          });
        }}
      >
        {props.properties.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select
        className="sn-input"
        style={{ width: 150 }}
        value={props.rule.operator}
        onChange={(e) => props.onChange({ ...props.rule, operator: e.target.value as FilterRule["operator"] })}
      >
        {operators.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {!["isEmpty", "isNotEmpty", "checked", "unchecked"].includes(props.rule.operator) && (
        <ValueInput
          prop={prop}
          value={props.rule.value}
          onChange={(v) => props.onChange({ ...props.rule, value: v })}
        />
      )}
      <button className="sn-btn sn-btn-ghost sn-btn-icon" onClick={props.onRemove} aria-label="Remove filter">
        <Trash2 size={13} strokeWidth={1.5} />
      </button>
    </div>
  );
}

function operatorsFor(type: string): { value: string; label: string }[] {
  const base = { value: "isEmpty", label: "Is empty" };
  const notEmpty = { value: "isNotEmpty", label: "Is not empty" };
  switch (type) {
    case "number":
    case "unique_id":
      return [
        { value: "is", label: "Is" },
        { value: "isNot", label: "Is not" },
        { value: "greaterThan", label: ">" },
        { value: "lessThan", label: "<" },
        { value: "greaterThanOrEqualTo", label: "≥" },
        { value: "lessThanOrEqualTo", label: "≤" },
        base,
        notEmpty,
      ];
    case "date":
    case "created_time":
    case "last_edited_time":
      return [
        { value: "on", label: "On" },
        { value: "before", label: "Before" },
        { value: "after", label: "After" },
        base,
        notEmpty,
      ];
    case "checkbox":
      return [
        { value: "checked", label: "Checked" },
        { value: "unchecked", label: "Unchecked" },
      ];
    case "select":
    case "status":
      return [
        { value: "is", label: "Is" },
        { value: "isNot", label: "Is not" },
        base,
        notEmpty,
      ];
    case "multi_select":
    case "relation":
      return [
        { value: "contains", label: "Contains" },
        { value: "doesNotContain", label: "Does not contain" },
        base,
        notEmpty,
      ];
    default:
      return [
        { value: "contains", label: "Contains" },
        { value: "doesNotContain", label: "Does not contain" },
        { value: "is", label: "Is" },
        { value: "isNot", label: "Is not" },
        { value: "startsWith", label: "Starts with" },
        { value: "endsWith", label: "Ends with" },
        base,
        notEmpty,
      ];
  }
}

function ValueInput(props: { prop?: PropertyDef; value?: PropertyValueInput; onChange: (v: PropertyValueInput) => void }): React.ReactNode {
  const p = props.prop;
  if (!p) return null;

  if (p.type === "checkbox") {
    return (
      <select
        className="sn-input"
        style={{ width: 90 }}
        value={props.value === true ? "1" : "0"}
        // a <select> has no `checked` property: reading it yields undefined, so
        // every checkbox filter value collapsed to false
        onChange={(e) => props.onChange(e.target.value === "1")}
      >
        <option value="1">True</option>
        <option value="0">False</option>
      </select>
    );
  }
  if (p.type === "number" || p.type === "unique_id") {
    return (
      <input
        className="sn-input"
        style={{ width: 90 }}
        type="number"
        value={typeof props.value === "number" ? props.value : 0}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    );
  }
  if (p.type === "date") {
    const v = (props.value as { start?: number }) ?? {};
    return (
      <input
        className="sn-input"
        style={{ width: 150 }}
        type="date"
        value={v.start ? format(new Date(v.start), "yyyy-MM-dd") : ""}
        onChange={(e) => {
          const t = e.target.value ? Date.parse(e.target.value) : null;
          props.onChange({ start: t, end: t, allDay: true });
        }}
      />
    );
  }
  if (p.type === "select" || p.type === "multi_select" || p.type === "status") {
    const options = optionsOfProp(p);
    return (
      <select
        className="sn-input"
        style={{ width: 140 }}
        value={Array.isArray(props.value) ? (props.value[0] ?? "") : ""}
        onChange={(e) => props.onChange([e.target.value])}
      >
        <option value="">Select…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      className="sn-input"
      style={{ width: 140 }}
      value={typeof props.value === "string" ? props.value : ""}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Views
// ─────────────────────────────────────────────────────────────────────────────

interface ViewCommon {
  rows: RowView[];
  properties: PropertyDef[];
  allProperties: PropertyDef[];
  dbId: string;
  onOpen: (id: string) => void;
  onRowChanged: () => void;
  notify: (m: string) => void;
}

function TableView(p: ViewCommon & { spec: ViewSpec }): React.ReactNode {
  const { rows, properties, spec, allProperties } = p;

  // Measure the space the table can occupy.
  //
  // The wrapper cannot simply be measured: it is sized by its own content, so
  // measuring it returns the table's width (2008px) and the fit never
  // constrains anything. The bound is the narrowest enclosing box — walking up
  // from the parent finds the editor's reading column (~836px), which is what
  // the table must actually fit inside. A database with more columns than that
  // scrolls within its own frame, where the scrollbar and the hint are visible,
  // instead of widening the page.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [avail, setAvail] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = (): void => {
      const rect = el.getBoundingClientRect();
      let bound = window.innerWidth - rect.left - 16;
      let node: HTMLElement | null = el.parentElement;
      while (node) {
        const w = node.clientWidth;
        if (w > 0) bound = Math.min(bound, w);
        node = node.parentElement;
      }
      const next = Math.max(280, bound);
      setAvail((prev) => (Math.abs(prev - next) > 2 ? next : prev));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [properties.length]);

  const widths = useMemo(
    () => fitColumns(properties.map((x) => x.type), avail),
    [properties, avail],
  );
  const total = tableWidth(widths);
  const scrolls = tableScrolls(widths, avail);

  return (
    <div className="sn-table-wrap" style={{ border: 0, borderRadius: 0 }} ref={wrapRef}>
      {scrolls && (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            fontSize: "var(--text-xxs)",
            color: "var(--text-tertiary)",
            padding: "3px 8px",
            borderBottom: "1px solid var(--border-subtle)",
            position: "sticky",
            left: 0,
          }}
        >
          {properties.length} columns · scroll sideways for the rest
        </div>
      )}
      <table className="sn-table" style={{ width: total }}>
        <colgroup>
          <col style={{ width: 28 }} />
          {properties.map((prop, i) => (
            <col key={prop.id} style={{ width: widths[i] ?? columnWidthForType(prop.type) }} />
          ))}
          <col style={{ width: 40 }} />
        </colgroup>
        <thead>
          <tr>
            <th style={{ width: 28 }} />
            {properties.map((prop) => (
              <th key={prop.id} title={`${prop.name} · ${prop.type}`}>
                <span style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{prop.name}</span>
                  <span className="sn-badge" style={{ flex: "none" }}>
                    {prop.type}
                  </span>
                </span>
              </th>
            ))}
            <th style={{ width: 40 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.node.id}>
              <td>
                <GripVertical size={12} strokeWidth={1.5} style={{ opacity: 0.35 }} />
              </td>
              {properties.map((prop) => (
                <td key={prop.id}>
                  <PropertyCell
                    row={row}
                    prop={prop}
                    allProperties={allProperties}
                    dbId={p.dbId}
                    onOpen={p.onOpen}
                    onChanged={p.onRowChanged}
                    notify={p.notify}
                  />
                </td>
              ))}
              <td>
                <button
                  className="sn-btn sn-btn-ghost sn-btn-icon"
                  style={{ width: 20, height: 20 }}
                  aria-label="Delete row"
                  onClick={async () => {
                    await api.deleteRow(row.node.id);
                    p.onRowChanged();
                    p.notify("Row moved to trash");
                  }}
                >
                  <Trash2 size={12} strokeWidth={1.5} />
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={properties.length + 2}>
                <div className="sn-empty">No entries match this view</div>
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td />
            {properties.map((prop) => (
              <td key={prop.id}>
                <FooterCell dbId={p.dbId} prop={prop} fn={spec.aggregates[prop.id]} />
              </td>
            ))}
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function FooterCell(props: { dbId: string; prop: PropertyDef; fn?: AggregateFunction }): React.ReactNode {
  const [value, setValue] = useState<number | string | null>(null);
  useEffect(() => {
    if (!props.fn) {
      setValue(null);
      return;
    }
    void api
      .aggregate(props.dbId, props.prop.id, props.fn)
      .then((r) => setValue(r.value))
      .catch(() => setValue(null));
  }, [props.dbId, props.prop.id, props.fn]);

  if (!props.fn) return <span style={{ opacity: 0.35 }}>—</span>;
  const n = typeof value === "number";
  return <span>{n ? formatNumber(value as number, props.prop) : (value ?? "—")}</span>;
}

function formatNumber(n: number, prop: PropertyDef): string {
  const config = prop.config as { format?: string; precision?: number; prefix?: string; suffix?: string };
  const digits = config.precision ?? (Number.isInteger(n) ? 0 : 2);
  const s = n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (config.format === "percent") return `${s}%`;
  if (config.format === "currency" || config.format === "dollar") return `$${s}`;
  if (config.format === "euro") return `€${s}`;
  return `${config.prefix ?? ""}${s}${config.suffix ?? ""}`;
}

function BoardView(p: ViewCommon & { buckets: GroupBucket[]; groupProp?: string }): React.ReactNode {
  const { buckets, properties, allProperties } = p;
  if (!p.groupProp) {
    return (
      <div className="sn-empty">
        Group this board by a Select, Status, Person or Relation property.
        <div style={{ marginTop: 8, fontSize: "var(--text-xs)" }}>Use the Group control in the view bar.</div>
      </div>
    );
  }
  return (
    <div className="sn-board">
      {buckets.map((bucket) => (
        <div key={bucket.key} className="sn-board-col">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "8px",
              borderBottom: "1px solid var(--border-subtle)",
              fontSize: "var(--text-xs)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--text-secondary)",
            }}
          >
            <span className="sn-dot" style={{ background: colorVar(bucket.color) }} />
            {bucket.label}
            <span className="sn-badge">{bucket.rows.length}</span>
          </div>
          <div className="sn-board-cards">
            {bucket.rows.map((row) => (
              <div
                key={row.node.id}
                className="sn-card-tile"
                onClick={() => p.onOpen(row.node.id)}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("text/plain", row.node.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={async (e) => {
                  e.preventDefault();
                  const id = e.dataTransfer.getData("text/plain");
                  if (!id) return;
                  const option = optionForGroup(p.allProperties, p.groupProp!, bucket.key);
                  if (option) {
                    await api.patchRow(id, { [p.groupProp!]: [option] });
                  }
                  await api.moveRow(id, { before: row.node.id });
                  p.onRowChanged();
                }}
              >
                <div style={{ fontWeight: 500, marginBottom: 4 }}>{row.title}</div>
                {properties
                  .filter((prop) => prop.type !== "title")
                  .slice(0, 3)
                  .map((prop) => (
                    <div key={prop.id} style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", display: "flex", gap: 4 }}>
                      <span style={{ opacity: 0.7 }}>{prop.name}:</span>
                      <CellValue prop={prop} value={row.values[prop.id]} />
                    </div>
                  ))}
              </div>
            ))}
            {bucket.rows.length === 0 && <div className="sn-empty" style={{ padding: 12 }}>No cards</div>}
          </div>
        </div>
      ))}
      {buckets.length === 0 && <div className="sn-empty">Nothing to group</div>}
    </div>
  );
}

function ListView(p: ViewCommon & { titleProp?: PropertyDef }): React.ReactNode {
  const { rows, properties, allProperties, titleProp } = p;
  return (
    <div>
      {rows.map((row) => (
        <div
          key={row.node.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          <button
            className="sn-btn sn-btn-ghost"
            style={{ height: 22, border: 0, padding: 0, fontWeight: 500 }}
            onClick={() => p.onOpen(row.node.id)}
          >
            {row.title}
          </button>
          <span style={{ flex: 1 }} />
          {properties
            .filter((prop) => prop.id !== titleProp?.id)
            .slice(0, 4)
            .map((prop) => (
              <span key={prop.id} style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                <CellValue prop={prop} value={row.values[prop.id]} />
              </span>
            ))}
          <PropertyCell
            row={row}
            prop={p.properties.find((x) => x.type === "checkbox") ?? p.properties[0]!}
            allProperties={allProperties}
            dbId={p.dbId}
            onOpen={p.onOpen}
            onChanged={p.onRowChanged}
            notify={p.notify}
            compact
          />
        </div>
      ))}
      {rows.length === 0 && <div className="sn-empty">No entries</div>}
    </div>
  );
}

function GalleryView(p: ViewCommon & { spec: ViewSpec }): React.ReactNode {
  const { rows, spec, allProperties } = p;
  const coverProp = spec.card.cover ? p.allProperties.find((x) => x.id === spec.card.cover) : undefined;
  return (
    <div className="sn-gallery">
      {rows.map((row) => {
        const cover = coverProp ? (row.values[coverProp.id] as { mediaIds?: string[] }) : undefined;
        const url = cover?.mediaIds?.[0] ? mediaSrc(cover.mediaIds[0]) : undefined;
        return (
          <div key={row.node.id} className="sn-card" style={{ overflow: "hidden" }}>
            <div
              style={{
                height: 120,
                background: url ? `center/cover url(${url})` : "var(--bg-raised)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-ghost)",
              }}
            >
              {!url && <ImageIcon size={24} strokeWidth={1.5} />}
            </div>
            <div style={{ padding: 10 }}>
              <button
                className="sn-btn sn-btn-ghost"
                style={{ border: 0, padding: 0, fontWeight: 600, height: "auto" }}
                onClick={() => p.onOpen(row.node.id)}
              >
                {row.title}
              </button>
              {(spec.card.properties.length
                ? spec.card.properties.map((id) => allProperties.find((x) => x.id === id)).filter(Boolean)
                : p.properties.filter((x) => x.type !== "title").slice(0, 2)
              ).map((prop) => (
                <div key={prop!.id} style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", marginTop: 4 }}>
                  {prop!.name}: <CellValue prop={prop!} value={row.values[prop!.id]} />
                </div>
              ))}
              <PropertyCell
                row={row}
                prop={p.properties.find((x) => x.type === "checkbox") ?? p.properties[0]!}
                allProperties={allProperties}
                dbId={p.dbId}
                onOpen={p.onOpen}
                onChanged={p.onRowChanged}
                notify={p.notify}
                compact
              />
            </div>
          </div>
        );
      })}
      {rows.length === 0 && <div className="sn-empty">No cards</div>}
    </div>
  );
}

function CalendarView(p: ViewCommon & { dateProp?: string; titleProp?: PropertyDef }): React.ReactNode {
  const [cursor, setCursor] = useState(() => new Date());
  const rows = p.rows;

  const cells = useMemo(() => buildMonth(cursor), [cursor]);

  const byDay = useMemo(() => {
    const map = new Map<string, RowView[]>();
    for (const row of rows) {
      const v = row.values[p.dateProp ?? ""] as { start: number | null } | undefined;
      if (!v?.start) continue;
      const key = format(new Date(v.start), "yyyy-MM-dd");
      const list = map.get(key) ?? [];
      list.push(row);
      map.set(key, list);
    }
    return map;
  }, [rows, p.dateProp]);

  return (
    <div style={{ padding: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <button className="sn-btn sn-btn-sm" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
          ←
        </button>
        <strong>{format(cursor, "MMMM yyyy")}</strong>
        <button className="sn-btn sn-btn-sm" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
          →
        </button>
        <span style={{ flex: 1 }} />
        <button className="sn-btn sn-btn-sm" onClick={() => setCursor(new Date())}>
          Today
        </button>
      </div>

      <div className="sn-cal-grid">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} style={{ background: "var(--bg-raised)", padding: 4, fontSize: "var(--text-xxs)", color: "var(--text-tertiary)" }}>
            {d}
          </div>
        ))}
        {cells.map((day) => {
          const key = format(day, "yyyy-MM-dd");
          const items = byDay.get(key) ?? [];
          const inMonth = day.getMonth() === cursor.getMonth();
          return (
            <div key={key} className="sn-cal-cell" style={{ opacity: inMonth ? 1 : 0.4 }}>
              <div style={{ fontSize: "var(--text-xxs)", color: "var(--text-tertiary)", marginBottom: 4 }}>{format(day, "d")}</div>
              {items.slice(0, 4).map((row) => (
                <button key={row.node.id} className="sn-cal-chip" onClick={() => p.onOpen(row.node.id)}>
                  {row.title}
                </button>
              ))}
              {items.length > 4 && <div style={{ fontSize: "var(--text-xxs)", color: "var(--text-tertiary)" }}>+{items.length - 4} more</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function buildMonth(cursor: Date): Date[] {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7; // Monday-first
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Property cell
// ─────────────────────────────────────────────────────────────────────────────

export function PropertyCell(props: {
  row: RowView;
  prop: PropertyDef;
  allProperties: PropertyDef[];
  dbId: string;
  onOpen: (id: string) => void;
  onChanged: () => void;
  notify: (m: string) => void;
  compact?: boolean;
}): React.ReactNode {
  const { row, prop } = props;
  const value = row.values[prop.id];
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);

  const commit = async (next: PropertyValueInput): Promise<void> => {
    try {
      await api.patchRow(row.node.id, { [prop.id]: next });
      props.onChanged();
    } catch (err) {
      props.notify(`Update failed: ${(err as Error).message}`);
    }
  };

  const commitDebounced = (next: PropertyValueInput): void => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void commit(next), 400);
  };

  const readOnly = ["created_time", "last_edited_time", "created_by", "last_edited_by", "formula", "rollup", "unique_id"].includes(prop.type);

  if (readOnly) {
    return <CellValue prop={prop} value={value} />;
  }

  switch (prop.type) {
    case "title":
      return (
        <input
          className="sn-input"
          style={{ height: 24, border: "1px solid transparent", background: "transparent", fontWeight: 500 }}
          value={typeof value === "string" ? value : ""}
          placeholder="Untitled"
          onChange={(e) => commitDebounced(e.target.value)}
          onBlur={(e) => void commit(e.target.value)}
        />
      );

    case "checkbox":
      return (
        <input
          type="checkbox"
          style={{ accentColor: "var(--accent-highlight)", cursor: "pointer" }}
          checked={value === true}
          onChange={(e) => void commit(e.target.checked)}
        />
      );

    case "number":
      return (
        <input
          className="sn-input"
          style={{ height: 24, border: "1px solid transparent", background: "transparent" }}
          type="number"
          value={typeof value === "number" ? value : ""}
          onChange={(e) => commitDebounced(e.target.value === "" ? null : Number(e.target.value))}
          onBlur={(e) => void commit(e.target.value === "" ? null : Number(e.target.value))}
        />
      );

    case "date": {
      const v = (value as { start: number | null; allDay: boolean }) ?? { start: null, allDay: true };
      return (
        <input
          className="sn-input"
          style={{ height: 24 }}
          type="date"
          value={v.start ? format(new Date(v.start), "yyyy-MM-dd") : ""}
          onChange={(e) => {
            const t = e.target.value ? Date.parse(e.target.value) : null;
            void commit({ start: t, end: t, allDay: true });
          }}
        />
      );
    }

    case "select":
    case "status":
    case "multi_select":
      return (
        <div style={{ position: "relative" }}>
          <button className="sn-pill" onClick={() => setOpen((v) => !v)}>
            {(value as string[] | undefined)?.length
              ? (value as string[]).map((id) => optionName(prop, id)).join(", ")
              : prop.type === "multi_select"
                ? "Empty"
                : "Empty"}
          </button>
          {open && (
            <OptionMenu
              prop={prop}
              selected={(value as string[]) ?? []}
              multi={prop.type === "multi_select"}
              onPick={async (ids) => {
                setOpen(false);
                await commit(ids);
              }}
              onClose={() => setOpen(false)}
              dbId={props.dbId}
              onChanged={props.onChanged}
            />
          )}
        </div>
      );

    case "relation": {
      const rowsV = (value as { rows: string[] })?.rows ?? [];
      return (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
          {rowsV.map((id) => (
            <button key={id} className="sn-pill" onClick={() => props.onOpen(id)}>
              {rowTitle(props.allProperties, id)}
            </button>
          ))}
          <RelationPicker
            prop={prop}
            current={rowsV}
            onPick={async (rows2) => void commit({ rows: rows2 })}
          />
        </div>
      );
    }

    case "files": {
      const ids = (value as { mediaIds: string[] })?.mediaIds ?? [];
      return (
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {ids.map((id) => (
            <a key={id} className="sn-pill" href={mediaSrc(id)} target="_blank" rel="noreferrer">
              file
            </a>
          ))}
          <button
            className="sn-pill"
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.multiple = true;
              input.onchange = async () => {
                const files = Array.from(input.files ?? []);
                const uploaded = await Promise.all(files.map((f) => api.uploadMedia(f)));
                await commit({ mediaIds: [...ids, ...uploaded.map((u) => u.id)] });
              };
              input.click();
            }}
          >
            <Plus size={11} strokeWidth={1.5} />
            Add
          </button>
        </div>
      );
    }

    case "button": {
      const config = prop.config as { label?: string; action?: string; set?: Record<string, unknown> };
      return (
        <button
          className="sn-btn sn-btn-sm"
          onClick={async () => {
            if (config.set) {
              await api.patchRow(row.node.id, config.set as Record<string, PropertyValueInput>);
              props.onChanged();
              props.notify("Button applied");
            } else if (config.action === "openPage") {
              props.onOpen(row.node.id);
            }
          }}
        >
          {config.label ?? "Button"}
        </button>
      );
    }

    default:
      return (
        <input
          className="sn-input"
          style={{ height: 24, border: "1px solid transparent", background: "transparent" }}
          type={prop.type === "url" || prop.type === "email" ? prop.type : "text"}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => commitDebounced(e.target.value)}
          onBlur={(e) => void commit(e.target.value)}
        />
      );
  }
}

function CellValue(props: { prop: PropertyDef; value?: PropertyValueInput }): React.ReactNode {
  const { prop, value } = props;
  if (value === null || value === undefined) return <span style={{ color: "var(--text-ghost)" }}>—</span>;

  switch (prop.type) {
    case "checkbox":
      return <span>{value === true ? "Checked" : "Unchecked"}</span>;
    case "date":
    case "created_time":
    case "last_edited_time": {
      const v = value as { start: number | null; end: number | null };
      if (!v?.start) return <span style={{ color: "var(--text-ghost)" }}>—</span>;
      const s = format(new Date(v.start), "d MMM yyyy");
      return <span>{v.end ? `${s} → ${format(new Date(v.end), "d MMM yyyy")}` : s}</span>;
    }
    case "select":
    case "status":
    case "multi_select": {
      const ids = (value as string[]) ?? [];
      if (!ids.length) return <span style={{ color: "var(--text-ghost)" }}>—</span>;
      return (
        <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
          {ids.map((id) => (
            <span key={id} className="sn-badge" style={{ background: colorVar(optionColor(prop, id)) }}>
              {optionName(prop, id)}
            </span>
          ))}
        </span>
      );
    }
    case "number":
    case "unique_id":
      return <span>{formatNumber(Number(value), prop)}</span>;
    case "relation": {
      const rows = (value as { rows: string[] })?.rows ?? [];
      return <span>{rows.length ? `${rows.length} related` : "—"}</span>;
    }
    case "url":
      return typeof value === "string" && value ? (
        <a href={value} target="_blank" rel="noreferrer" style={{ color: "var(--accent-highlight)" }}>
          {value}
        </a>
      ) : (
        <span style={{ color: "var(--text-ghost)" }}>—</span>
      );
    default:
      return <span>{String(value)}</span>;
  }
}

function OptionMenu(props: {
  prop: PropertyDef;
  selected: string[];
  multi: boolean;
  onPick: (ids: string[]) => void;
  onClose: () => void;
  dbId: string;
  onChanged: () => void;
}): React.ReactNode {
  const [newName, setNewName] = useState("");
  const options = optionsOfProp(props.prop);

  const toggle = (id: string): void => {
    if (!props.multi) {
      props.onPick([id]);
      return;
    }
    props.onPick(props.selected.includes(id) ? props.selected.filter((x) => x !== id) : [...props.selected, id]);
  };

  return (
    <>
      <div className="sn-menu" style={{ top: 26, left: 0, maxHeight: 260, overflowY: "auto" }} onMouseLeave={props.onClose}>
        {options.map((o) => (
          <button key={o.id} className="sn-menu-item" onClick={() => toggle(o.id)}>
            <span className="sn-dot" style={{ background: colorVar(o.color) }} />
            <span style={{ flex: 1 }}>{o.name}</span>
            {props.selected.includes(o.id) && <span style={{ color: "var(--accent-highlight)" }}>•</span>}
          </button>
        ))}
        <div className="sn-divider" />
        <div style={{ display: "flex", gap: 4, padding: 4 }}>
          <input
            className="sn-input"
            placeholder="New option"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === "Enter" && newName.trim()) {
                const created = await api.addOption(props.prop.id, newName.trim());
                props.onPick([...props.selected, created.id]);
                props.onChanged();
              }
            }}
          />
          <button
            className="sn-btn sn-btn-sm"
            onClick={async () => {
              if (!newName.trim()) return;
              const created = await api.addOption(props.prop.id, newName.trim());
              props.onPick([...props.selected, created.id]);
              props.onChanged();
            }}
          >
            <Plus size={12} strokeWidth={1.5} />
          </button>
        </div>
      </div>
      <div style={{ position: "fixed", inset: 0, zIndex: -1 }} onClick={props.onClose} />
    </>
  );
}

function RelationPicker(props: { prop: PropertyDef; current: string[]; onPick: (rows: string[]) => void }): React.ReactNode {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<{ id: string; title: string }[]>([]);
  const config = props.prop.config as { targetDb?: string };

  useEffect(() => {
    if (!open || !config.targetDb) return;
    void api.database(config.targetDb).then((target) => {
      const view = target.views[0];
      if (!view) return;
      return api.query(view.id).then((res) => setOptions(res.rows.map((r) => ({ id: r.node.id, title: r.title }))));
    });
  }, [open, config.targetDb]);

  return (
    <div style={{ position: "relative" }}>
      <button className="sn-pill" onClick={() => setOpen((v) => !v)}>
        <Plus size={11} strokeWidth={1.5} />
        Link
      </button>
      {open && (
        <>
          <div className="sn-menu" style={{ top: 26, left: 0, maxHeight: 240, overflowY: "auto" }}>
            {options.map((o) => (
              <button
                key={o.id}
                className="sn-menu-item"
                onClick={() => {
                  const next = props.current.includes(o.id)
                    ? props.current.filter((x) => x !== o.id)
                    : [...props.current, o.id];
                  props.onPick(next);
                  setOpen(false);
                }}
              >
                <span style={{ flex: 1 }}>{o.title}</span>
                {props.current.includes(o.id) && <span style={{ color: "var(--accent-highlight)" }}>•</span>}
              </button>
            ))}
            {options.length === 0 && <div className="sn-empty">No target rows</div>}
          </div>
          <div style={{ position: "fixed", inset: 0, zIndex: -1 }} onClick={() => setOpen(false)} />
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function optionsOfProp(prop: PropertyDef): SelectOption[] {
  if (prop.type === "status") {
    const groups = (prop.config as { groups?: { options: SelectOption[] }[] }).groups ?? [];
    return groups.flatMap((g) => g.options);
  }
  return (prop.config as { options?: SelectOption[] }).options ?? [];
}

function optionName(prop: PropertyDef, id: string): string {
  return optionsOfProp(prop).find((o) => o.id === id)?.name ?? id;
}
function optionColor(prop: PropertyDef, id: string): string {
  return optionsOfProp(prop).find((o) => o.id === id)?.color ?? "default";
}
function optionForGroup(all: PropertyDef[], propId: string, key: string): string | undefined {
  const prop = all.find((p) => p.id === propId);
  if (!prop) return undefined;
  if (prop.type === "checkbox") return undefined;
  return optionsOfProp(prop).find((o) => o.id === key)?.id;
}

function colorVar(color: string): string {
  const map: Record<string, string> = {
    default: "var(--text-tertiary)",
    gray: "var(--text-tertiary)",
    brown: "#8c6450",
    orange: "#d2823c",
    yellow: "#c8a53c",
    green: "#50a55a",
    blue: "#3c7dcd",
    purple: "#8c5ac8",
    pink: "#c85a91",
    red: "#d75050",
  };
  return map[color] ?? "var(--text-tertiary)";
}

function groupableProps(properties: PropertyDef[]): PropertyDef[] {
  return properties.filter((p) =>
    ["select", "multi_select", "status", "relation", "checkbox", "date"].includes(p.type),
  );
}

function dateProps(properties: PropertyDef[]): PropertyDef[] {
  return properties.filter((p) => p.type === "date" || p.type === "created_time");
}

function fallbackBoard(properties: PropertyDef[], rows: RowView[]): GroupBucket[] {
  const first = groupableProps(properties)[0];
  if (!first) return [];
  const buckets = new Map<string, GroupBucket>();
  for (const row of rows) {
    const ids = (row.values[first.id] as string[]) ?? [];
    const key = ids[0] ?? "__empty";
    const bucket = buckets.get(key) ?? {
      key,
      label: key === "__empty" ? "Empty" : optionName(first, key),
      color: key === "__empty" ? "gray" : optionColor(first, key),
      rows: [],
    };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }
  return [...buckets.values()];
}

const titleCache = new Map<string, string>();
function rowTitle(_props: PropertyDef[], id: string): string {
  return titleCache.get(id) ?? id.slice(0, 8);
}
export function primeRowTitle(id: string, title: string): void {
  titleCache.set(id, title);
}

export { ChevronDown };
