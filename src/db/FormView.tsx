/**
 * Form view: a fillable form for adding rows.
 *
 * The field list, required-ness, coercion and validation all come from
 * `viewLogic.ts`; this component renders one input per property type and hands
 * the validated `PropertyValueInput` map to `api.createRow`. Field visibility
 * and the heading are persisted in `spec.form` through the same view-spec patch
 * the other views' controls use.
 */

import { useMemo, useState } from "react";
import { Check, ListChecks, Plus, Send, Settings2, X } from "lucide-react";

import { api } from "../api.ts";
import type { PropertyDef, RowView, ViewSpec } from "../../shared/types.ts";
import {
  coerceFormValues,
  formFields,
  formTitle,
  initialFormValues,
  isFieldRequired,
  issuesByProp,
  optionName,
  optionsOf,
  validateForm,
  type FieldIssue,
} from "./viewLogic.ts";

/**
 * Raw form state: what the inputs hold before coercion.
 *
 * A date field is carried as a `YYYY-MM-DD` string here and turned into the
 * `{start,end,allDay}` value by `coerceFormValues`, so this type stays a subset
 * of what `validateForm` and `coerceFormValues` accept.
 */
type RawValue = string | boolean | number | string[] | null;
type RawValues = Record<string, RawValue>;

export interface FormViewProps {
  rows: RowView[];
  properties: PropertyDef[];
  allProperties: PropertyDef[];
  dbId: string;
  dbTitle: string;
  spec: ViewSpec;
  viewId: string;
  /** ids of properties that hold a 0–5 rating; `PropertyType` has no rating type */
  ratingPropIds?: string[];
  onOpen: (id: string) => void;
  onRowChanged: () => void;
  onSpecChange: (patch: Partial<ViewSpec>) => void;
  notify: (m: string) => void;
}

export function FormView(p: FormViewProps): React.ReactNode {
  const { allProperties, spec } = p;

  const fields = useMemo(
    () => formFields(allProperties, spec.form?.fields, { ratingPropIds: p.ratingPropIds }),
    [allProperties, spec.form?.fields, p.ratingPropIds],
  );

  const [raw, setRaw] = useState<RawValues>(() => initialFormValues(fields));
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [last, setLast] = useState<string | null>(null);

  const setField = (id: string, value: RawValue): void => {
    setRaw((prev) => ({ ...prev, [id]: value }));
    setIssues((prev) => prev.filter((i) => i.propId !== id));
  };

  const reset = (): void => {
    setRaw(initialFormValues(fields));
    setIssues([]);
  };

  const submit = async (): Promise<void> => {
    if (busy) return;
    const found = validateForm(fields, raw, {
      required: (prop) => isFieldRequired(prop, { timelineStartProp: spec.timelineBy?.start }),
      ratingPropIds: p.ratingPropIds,
    });
    if (found.length) {
      setIssues(found);
      p.notify(`${found.length} ${found.length === 1 ? "field needs" : "fields need"} attention`);
      return;
    }
    setIssues([]);
    setBusy(true);
    try {
      const values = coerceFormValues(fields, raw);
      const created = await api.createRow(p.dbId, values);
      p.onRowChanged();
      p.notify(`Added ${created.row.title || "untitled"}`);
      setLast(created.row.title || "Untitled");
      // `allowMore` keeps the form open for the next entry; either way the
      // fields clear, so a submitted form never shows stale input.
      reset();
    } catch (err) {
      p.notify(`Create failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const byProp = issuesByProp(issues);
  const title = formTitle(spec.form?.title, p.dbTitle);

  if (!fields.length) {
    return (
      <div className="sn-empty">
        This database has no editable properties to put in a form.
        <div className="sn-muted" style={{ fontSize: "var(--text-xs)", marginTop: 4 }}>
          Add a Title, Text, Number, Select or Date property first.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
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
        <input
          className="sn-input"
          style={{ width: 220, height: 22 }}
          value={spec.form?.title ?? ""}
          placeholder={p.dbTitle || "Form title"}
          onChange={(e) =>
            p.onSpecChange({ form: { title: e.target.value, allowMore: spec.form?.allowMore ?? true, fields: spec.form?.fields ?? [] } })
          }
        />
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: "var(--text-xs)",
            color: "var(--text-secondary)",
          }}
        >
          <input
            type="checkbox"
            style={{ accentColor: "var(--accent-highlight)" }}
            checked={spec.form?.allowMore ?? false}
            onChange={(e) =>
              p.onSpecChange({
                form: {
                  title: spec.form?.title ?? "",
                  allowMore: e.target.checked,
                  fields: spec.form?.fields ?? [],
                },
              })
            }
          />
          Allow multiple entries
        </label>
        <span style={{ flex: 1 }} />
        <button
          className={`sn-btn sn-btn-sm ${editing ? "sn-btn-primary" : "sn-btn-ghost"}`}
          style={{ height: 22 }}
          onClick={() => setEditing((v) => !v)}
        >
          <ListChecks size={13} strokeWidth={1.5} />
          Edit fields
        </button>
      </div>

      {editing && (
        <FieldEditor
          allProperties={allProperties}
          fields={fields}
          onToggle={(propId, on) => {
            const ids = fields.map((f) => f.id);
            const next = on ? [...ids, propId] : ids.filter((id) => id !== propId);
            p.onSpecChange({
              form: {
                title: spec.form?.title ?? "",
                allowMore: spec.form?.allowMore ?? false,
                fields: next,
              },
            });
          }}
          onClose={() => setEditing(false)}
        />
      )}

      {/* the form */}
      <div style={{ padding: 12, display: "flex", justifyContent: "center" }}>
        <div
          className="sn-card"
          style={{ width: "min(560px, 100%)", padding: 16, background: "var(--bg-base)" }}
        >
          <div style={{ fontSize: "var(--text-lg)", fontWeight: 600, marginBottom: 2 }}>{title}</div>
          <div className="sn-muted" style={{ fontSize: "var(--text-xs)", marginBottom: 12 }}>
            {fields.length} {fields.length === 1 ? "field" : "fields"} · * required
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {fields.map((prop) => (
              <FormField
                key={prop.id}
                prop={prop}
                value={raw[prop.id] ?? null}
                isRating={(p.ratingPropIds ?? []).includes(prop.id)}
                required={isFieldRequired(prop, { timelineStartProp: spec.timelineBy?.start })}
                error={byProp[prop.id]}
                onChange={(v) => setField(prop.id, v)}
              />
            ))}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16 }}>
            <button className="sn-btn sn-btn-primary" disabled={busy} onClick={() => void submit()}>
              {busy ? <Plus size={13} strokeWidth={1.5} /> : <Send size={13} strokeWidth={1.5} />}
              {busy ? "Adding…" : "Add entry"}
            </button>
            <button className="sn-btn sn-btn-ghost" onClick={reset} disabled={busy}>
              <X size={13} strokeWidth={1.5} />
              Clear
            </button>
            <span style={{ flex: 1 }} />
            {last && (
              <span className="sn-muted" style={{ fontSize: "var(--text-xs)", display: "inline-flex", gap: 4, alignItems: "center" }}>
                <Check size={12} strokeWidth={1.5} />
                {last}
              </span>
            )}
          </div>

          {issues.length > 0 && (
            <div
              style={{
                marginTop: 8,
                padding: "4px 8px",
                border: "1px solid var(--status-error)",
                borderRadius: "var(--radius-md)",
                background: "var(--status-error-muted)",
                fontSize: "var(--text-xs)",
                color: "var(--text-primary)",
              }}
            >
              {issues.map((i) => (
                <div key={`${i.propId}-${i.message}`}>{i.message}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// One field
// ─────────────────────────────────────────────────────────────────────────────

function FormField(props: {
  prop: PropertyDef;
  value: RawValue;
  isRating: boolean;
  required: boolean;
  error?: string;
  onChange: (v: RawValue) => void;
}): React.ReactNode {
  const { prop, value, required, error } = props;
  const label = (
    <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
      <span style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--text-primary)" }}>{prop.name}</span>
      {required && <span style={{ color: "var(--status-error)", fontSize: "var(--text-xs)" }}>*</span>}
      <span className="sn-badge">{prop.type}</span>
    </div>
  );

  const body = (() => {
    switch (prop.type) {
      case "checkbox":
        return (
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "var(--text-sm)" }}>
            <input
              type="checkbox"
              style={{ accentColor: "var(--accent-highlight)", cursor: "pointer" }}
              checked={value === true}
              onChange={(e) => props.onChange(e.target.checked)}
            />
            {value === true ? "Checked" : "Unchecked"}
          </label>
        );

      case "number":
        if (props.isRating) {
          const current = Number(value) || 0;
          return (
            <div style={{ display: "inline-flex", gap: 2, alignItems: "center" }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  className="sn-btn sn-btn-ghost sn-btn-icon"
                  style={{
                    width: 22,
                    height: 22,
                    color: n <= current ? "var(--accent-highlight)" : "var(--text-ghost)",
                    borderColor: n <= current ? "var(--accent-highlight)" : "var(--border-default)",
                  }}
                  aria-label={`${n} of 5`}
                  onClick={() => props.onChange(n === current ? 0 : n)}
                >
                  <Check size={13} strokeWidth={1.5} />
                </button>
              ))}
              <span className="sn-muted" style={{ fontSize: "var(--text-xs)", marginLeft: 4 }}>
                {current}/5
              </span>
            </div>
          );
        }
        return (
          <input
            className="sn-input"
            type="number"
            inputMode="decimal"
            placeholder="0"
            value={typeof value === "number" ? String(value) : typeof value === "string" ? value : ""}
            onChange={(e) => props.onChange(e.target.value)}
          />
        );

      case "date":
        return (
          <input
            className="sn-input"
            type="date"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => props.onChange(e.target.value)}
          />
        );

      case "select":
      case "status":
      case "multi_select": {
        const options = optionsOf(prop);
        const selected = Array.isArray(value) ? value : [];
        const multi = prop.type === "multi_select";
        return (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {options.map((o) => {
              const on = selected.includes(o.id);
              return (
                <button
                  key={o.id}
                  className="sn-pill"
                  style={{
                    background: on ? "var(--accent-highlight-muted)" : undefined,
                    borderColor: on ? "var(--accent-highlight)" : undefined,
                    color: on ? "var(--text-primary)" : undefined,
                  }}
                  onClick={() =>
                    props.onChange(
                      multi
                        ? on
                          ? selected.filter((x) => x !== o.id)
                          : [...selected, o.id]
                        : on
                          ? []
                          : [o.id],
                    )
                  }
                >
                  {on && <Check size={10} strokeWidth={1.5} />}
                  {o.name}
                </button>
              );
            })}
            {!options.length && (
              <span className="sn-muted" style={{ fontSize: "var(--text-xs)" }}>
                No options defined for {prop.name}
              </span>
            )}
            {multi && selected.length > 1 && (
              <span className="sn-muted" style={{ fontSize: "var(--text-xxs)", alignSelf: "center" }}>
                {selected.map((id) => optionName(prop, id)).join(", ")}
              </span>
            )}
          </div>
        );
      }

      case "text":
        return (
          <textarea
            className="sn-input"
            rows={3}
            placeholder={prop.name}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => props.onChange(e.target.value)}
          />
        );

      case "relation":
        return <RelationField prop={prop} ids={Array.isArray(value) ? value : []} onChange={props.onChange} />;

      case "files": {
        const ids = Array.isArray(value) ? value : [];
        return (
          <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
            {ids.map((id) => (
              <span key={id} className="sn-pill" style={{ cursor: "default" }}>
                {api.mediaUrl(id).split("/").pop()?.slice(0, 8)}
                <button
                  className="sn-btn sn-btn-ghost sn-btn-icon"
                  style={{ width: 14, height: 14, padding: 0, border: 0 }}
                  aria-label="Remove attachment"
                  onClick={() => props.onChange(ids.filter((x) => x !== id))}
                >
                  <X size={10} strokeWidth={1.5} />
                </button>
              </span>
            ))}
            <button
              className="sn-pill"
              onClick={() => {
                const input = document.createElement("input");
                input.type = "file";
                input.multiple = true;
                input.onchange = async () => {
                  const files = Array.from(input.files ?? []);
                  if (!files.length) return;
                  try {
                    const uploaded = await Promise.all(files.map((f) => api.uploadMedia(f)));
                    props.onChange([...ids, ...uploaded.map((u) => u.id)]);
                  } catch {
                    // a failed upload leaves the field as it was
                  }
                };
                input.click();
              }}
            >
              <Plus size={11} strokeWidth={1.5} />
              Attach
            </button>
          </div>
        );
      }

      case "url":
      case "email":
      case "phone":
      case "title":
      default:
        return (
          <input
            className="sn-input"
            type={prop.type === "url" || prop.type === "email" ? prop.type : "text"}
            placeholder={prop.type === "title" ? "Untitled" : prop.name}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => props.onChange(e.target.value)}
          />
        );
    }
  })();

  return (
    <div>
      {label}
      {body}
      {error && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--status-error)", marginTop: 4 }}>{error}</div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Relation picker — same target-row query the Table view's picker runs
// ─────────────────────────────────────────────────────────────────────────────

function RelationField(props: {
  prop: PropertyDef;
  ids: string[];
  onChange: (v: RawValue) => void;
}): React.ReactNode {
  const config = props.prop.config as { targetDb?: string };
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<{ id: string; title: string }[]>([]);
  const [query, setQuery] = useState("");

  const load = async (): Promise<void> => {
    if (!config.targetDb) return;
    const target = await api.database(config.targetDb);
    const view = target.views[0];
    if (!view) return;
    const res = await api.query(view.id);
    setOptions(res.rows.map((r) => ({ id: r.node.id, title: r.title })));
  };

  const toggle = (id: string): void => {
    const rows = props.ids.includes(id)
      ? props.ids.filter((x) => x !== id)
      : [...props.ids, id];
    props.onChange(rows);
  };

  const shown = query.trim()
    ? options.filter((o) => o.title.toLowerCase().includes(query.trim().toLowerCase()))
    : options;

  return (
    <div style={{ position: "relative", display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
      {props.ids.map((id) => (
        <span key={id} className="sn-pill" style={{ cursor: "default" }}>
          {options.find((o) => o.id === id)?.title ?? id.slice(0, 8)}
          <button
            className="sn-btn sn-btn-ghost sn-btn-icon"
            style={{ width: 14, height: 14, padding: 0, border: 0 }}
            aria-label="Unlink"
            onClick={() => toggle(id)}
          >
            <X size={10} strokeWidth={1.5} />
          </button>
        </span>
      ))}
      <button
        className="sn-pill"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && !options.length) void load().catch(() => setOptions([]));
        }}
      >
        <Plus size={11} strokeWidth={1.5} />
        Link
      </button>
      {open && (
        <>
          <div className="sn-menu" style={{ top: 26, left: 0, maxHeight: 240, overflowY: "auto", width: 240 }}>
            <input
              className="sn-input"
              style={{ marginBottom: 4 }}
              placeholder="Search rows"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {shown.slice(0, 40).map((o) => (
              <button key={o.id} className="sn-menu-item" onClick={() => toggle(o.id)}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.title}</span>
                {props.ids.includes(o.id) && <span style={{ color: "var(--accent-highlight)" }}>•</span>}
              </button>
            ))}
            {!shown.length && <div className="sn-empty">No matching rows</div>}
          </div>
          <div style={{ position: "fixed", inset: 0, zIndex: -1 }} onClick={() => setOpen(false)} />
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Field editor
// ─────────────────────────────────────────────────────────────────────────────

function FieldEditor(props: {
  allProperties: PropertyDef[];
  fields: PropertyDef[];
  onToggle: (propId: string, on: boolean) => void;
  onClose: () => void;
}): React.ReactNode {
  return (
    <div
      style={{
        padding: 8,
        borderBottom: "1px solid var(--border-subtle)",
        background: "var(--bg-raised)",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
        gap: "2px 12px",
      }}
    >
      <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span className="sn-eyebrow">
          <Settings2 size={11} strokeWidth={1.5} style={{ verticalAlign: -1 }} /> Fields
        </span>
        <div style={{ flex: 1 }} />
        <button className="sn-btn sn-btn-ghost sn-btn-icon" style={{ width: 20, height: 20 }} onClick={props.onClose} aria-label="Close">
          <X size={12} strokeWidth={1.5} />
        </button>
      </div>
      {props.allProperties.map((prop) => {
        const on = props.fields.some((f) => f.id === prop.id);
        const locked = prop.type === "title";
        return (
          <label
            key={prop.id}
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              fontSize: "var(--text-sm)",
              padding: "2px 0",
              color: on ? "var(--text-primary)" : "var(--text-secondary)",
            }}
          >
            <input
              type="checkbox"
              style={{ accentColor: "var(--accent-highlight)" }}
              checked={on}
              disabled={locked}
              onChange={(e) => props.onToggle(prop.id, e.target.checked)}
            />
            {prop.name}
            <span className="sn-badge">{prop.type}</span>
          </label>
        );
      })}
      <div className="sn-muted" style={{ gridColumn: "1 / -1", fontSize: "var(--text-xxs)", marginTop: 4 }}>
        Computed properties (formula, rollup, created / last edited) never appear in a form.
      </div>
    </div>
  );
}
