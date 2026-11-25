/**
 * Shared types: the contract between the SQLite layer, the API, and the UI.
 *
 * Core model (mirrors Notion's, deliberately):
 *   - A `node` is a page, a block, or a database row. All three live in one tree.
 *   - A database row IS a page, so it can hold nested content blocks.
 *   - Pages nest via `parent_id`, giving the recursive wiki hierarchy.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Block types
// ─────────────────────────────────────────────────────────────────────────────

export type BlockType =
  // text & formatting
  | "paragraph"
  | "heading_1"
  | "heading_2"
  | "heading_3"
  | "bulleted_list_item"
  | "numbered_list_item"
  | "to_do"
  | "toggle"
  | "quote"
  | "callout"
  | "divider"
  // technical & media
  | "code"
  | "latex"
  | "image"
  | "audio"
  | "file"
  | "bookmark"
  | "link_preview"
  // layout
  | "column_list"
  | "column"
  | "toc"
  // wiki
  | "page"
  | "child_page"
  | "child_database"
  | "table_row";

/** Types that carry inline text in `body`. */
export const TEXT_BLOCK_TYPES: readonly BlockType[] = [
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "quote",
  "callout",
  "code",
  "child_page",
  "table_row",
  "page",
];

/** Types whose children are blocks (nesting). */
export const CONTAINER_BLOCK_TYPES: readonly BlockType[] = [
  "toggle",
  "callout",
  "column_list",
  "column",
  "page",
  "quote",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "heading_1",
  "heading_2",
  "heading_3",
  "child_database",
];

export type HeadingLevel = 1 | 2 | 3;

export type BlockColor =
  | "default"
  | "gray"
  | "brown"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "red"
  | "gray_background"
  | "brown_background"
  | "orange_background"
  | "yellow_background"
  | "green_background"
  | "blue_background"
  | "purple_background"
  | "pink_background"
  | "red_background";

// ─────────────────────────────────────────────────────────────────────────────
// Inline content
//
// Deliberately the same shape BlockNote uses, so mapping a node ↔ an editor
// block is a field copy and not a translation layer.
// ─────────────────────────────────────────────────────────────────────────────

export interface InlineStyles {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  color?: BlockColor;
  backgroundColor?: BlockColor;
  /** Set when the run is an @-mention of a page (drives backlinks). */
  mention?: string;
}

export interface InlineLink {
  url: string;
  /** "page" links are internal deep links and create backlink edges. */
  kind: "url" | "page" | "database";
}

export interface Inline {
  type: "text";
  text: string;
  styles: InlineStyles;
  links?: InlineLink[];
}

export type Body = Inline[];

export const emptyBody = (): Body => [{ type: "text", text: "", styles: {} }];

export function bodyToPlainText(body: Body | null | undefined): string {
  if (!body?.length) return "";
  return body.map((i) => i.text).join("");
}

export function plainTextToBody(text: string): Body {
  return [{ type: "text", text, styles: {} }];
}

// ─────────────────────────────────────────────────────────────────────────────
// Nodes
// ─────────────────────────────────────────────────────────────────────────────

export type NodeKind = "page" | "block" | "row";
export type ParentKind = "workspace" | "node" | "database";

export interface PageMeta {
  icon?: string;
  /** media id */
  cover?: string;
  coverFit?: "cover" | "contain";
  font?: "default" | "serif" | "mono";
  /** 0-100 width scaling, for wide pages */
  fullWidth?: boolean;
  pageWidth?: "default" | "full" | "wide";
  templateBadge?: boolean;
}

export interface NodeRow {
  id: string;
  ws: string;
  kind: NodeKind;
  type: BlockType;
  parent_id: string | null;
  parent_kind: ParentKind;
  pos: string;
  props: Record<string, unknown>;
  body: Body | null;
  meta: PageMeta;
  created_at: number;
  created_by: string;
  updated_at: number;
  updated_by: string;
  deleted_at: number | null;
  template_ref: string | null;
}

/** A node plus its children, recursively. Sent to the editor. */
export interface NodeTree extends NodeRow {
  children: NodeTree[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-type block props
// ─────────────────────────────────────────────────────────────────────────────

export interface ToDoProps {
  checked: boolean;
}
export interface ToggleProps {
  open: boolean;
  color?: BlockColor;
}
export interface CalloutProps {
  icon?: string;
  color?: BlockColor;
}
export interface CodeProps {
  language: string;
  captions?: Body;
  showLineNumbers?: boolean;
  wrap?: boolean;
}
export interface ColumnProps {
  /** percentage of the parent column_list, 0-100 */
  ratio: number;
}
export interface ImageProps {
  /** media id */
  mediaId?: string;
  url?: string;
  caption?: Body;
  name?: string;
  previewWidth?: number;
}
export interface FileProps {
  mediaId?: string;
  url?: string;
  caption?: Body;
  name?: string;
}
export interface AudioProps {
  mediaId?: string;
  url?: string;
  caption?: Body;
  name?: string;
}
export interface BookmarkProps {
  url: string;
  caption?: Body;
}
export interface LatexProps {
  latex: string;
  inlineMode?: boolean;
}
export interface LinkPreviewProps {
  url: string;
}
export interface ChildDatabaseProps {
  databaseId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Databases & properties
// ─────────────────────────────────────────────────────────────────────────────

export type PropertyType =
  | "title"
  | "text"
  | "number"
  | "date"
  | "checkbox"
  | "select"
  | "multi_select"
  | "status"
  | "url"
  | "email"
  | "phone"
  | "files"
  | "relation"
  | "rollup"
  | "formula"
  | "button"
  | "unique_id"
  | "created_time"
  | "created_by"
  | "last_edited_time"
  | "last_edited_by";

export const PROPERTY_TYPES: PropertyType[] = [
  "title",
  "text",
  "number",
  "date",
  "checkbox",
  "select",
  "multi_select",
  "status",
  "url",
  "email",
  "phone",
  "files",
  "relation",
  "rollup",
  "formula",
  "button",
  "unique_id",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
];

/** Types the user can edit directly. The rest are computed or auto-filled. */
export const EDITABLE_PROPERTY_TYPES: PropertyType[] = [
  "title",
  "text",
  "number",
  "date",
  "checkbox",
  "select",
  "multi_select",
  "status",
  "url",
  "email",
  "phone",
  "files",
  "relation",
  "formula",
  "rollup",
  "button",
  "unique_id",
];

export const READONLY_PROPERTY_TYPES: PropertyType[] = [
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
];

export interface SelectOption {
  id: string;
  name: string;
  color: BlockColor;
}

export interface StatusGroup {
  id: "to_do" | "in_progress" | "complete";
  name: string;
  color: BlockColor;
  options: SelectOption[];
}

export type NumberFormat = "number" | "currency" | "percent" | "progress" | "dollar" | "euro";

export interface NumberConfig {
  format: NumberFormat;
  precision?: number;
  prefix?: string;
  suffix?: string;
  showAsBar?: boolean;
}

export interface DateConfig {
  withTime?: boolean;
}

export interface SelectConfig {
  options: SelectOption[];
}

export interface StatusConfig {
  groups: StatusGroup[];
}

export interface RelationConfig {
  targetDb: string;
  /** create the mirrored relation property on the target db */
  bidirectional?: boolean;
  /** id of the mirrored property, once created */
  mirrorPropId?: string;
  selfRelation?: boolean;
}

export interface FormulaConfig {
  /** source text the user typed */
  source: string;
  /** parsed AST, stored so evaluation never re-parses */
  ast: FormulaNode;
  resultType?: "number" | "text" | "date" | "checkbox";
}

export interface RollupConfig {
  relationProp: string;
  targetProp: string;
  function: AggregateFunction;
}

export interface ButtonConfig {
  label: string;
  action: "setProperties" | "addRelation" | "openPage";
  /** property id -> literal value to apply */
  set?: Record<string, unknown>;
}

export interface UniqueIdConfig {
  prefix: string;
  next: number;
}

export type PropertyConfig =
  | Record<string, never>
  | NumberConfig
  | DateConfig
  | SelectConfig
  | StatusConfig
  | RelationConfig
  | FormulaConfig
  | RollupConfig
  | ButtonConfig
  | UniqueIdConfig;

export interface PropertyDef {
  id: string;
  db_id: string;
  name: string;
  type: PropertyType;
  pos: string;
  config: PropertyConfig;
}

/** A property value, spread across typed columns for fast SQL filtering. */
export interface PropertyValue {
  row_id: string;
  prop_id: string;
  text_v: string | null;
  num_v: number | null;
  date_v: number | null;
  bool_v: number | null;
  json_v: string | null;
}

/** The value as the UI sees it, per type. */
export type PropertyValueInput =
  | string // title, text, url, email, phone, formula(text)
  | number // number, unique_id
  | boolean // checkbox
  | string[] // select (1 id), multi_select (n ids)
  | { start: number | null; end: number | null; allDay: boolean } // date
  | { rows: string[] } // relation
  | { mediaIds: string[] } // files
  | null;

export interface RowWithProperties {
  node: NodeRow;
  values: Record<string, PropertyValueInput>;
}

/** A row plus its decoded values and title — what every view renders. */
export interface RowView {
  node: NodeRow;
  values: Record<string, PropertyValueInput>;
  title: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formula AST
// ─────────────────────────────────────────────────────────────────────────────

export type FormulaNode =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "prop"; name: string }
  | { k: "call"; name: string; args: FormulaNode[] }
  | { k: "bin"; op: string; left: FormulaNode; right: FormulaNode }
  | { k: "un"; op: string; operand: FormulaNode }
  | { k: "paren"; expr: FormulaNode };

// ─────────────────────────────────────────────────────────────────────────────
// Views
// ─────────────────────────────────────────────────────────────────────────────

export type ViewType =
  | "table"
  | "board"
  | "list"
  | "gallery"
  | "calendar"
  | "timeline"
  | "chart"
  | "form";

export type FilterOperator =
  | "is"
  | "isNot"
  | "contains"
  | "doesNotContain"
  | "startsWith"
  | "endsWith"
  | "isEmpty"
  | "isNotEmpty"
  | "greaterThan"
  | "lessThan"
  | "greaterThanOrEqualTo"
  | "lessThanOrEqualTo"
  | "checked"
  | "unchecked"
  | "on"
  | "before"
  | "after";

export interface FilterRule {
  prop: string;
  operator: FilterOperator;
  value?: PropertyValueInput;
}

export interface FilterGroup {
  and: boolean;
  rules: FilterRule[];
  groups?: FilterGroup[];
}

export interface SortRule {
  prop: string;
  direction: "ascending" | "descending";
}

export interface GroupRule {
  prop: string;
  order?: "ascending" | "descending";
}

export type AggregateFunction =
  | "count"
  | "countAll"
  | "countValues"
  | "countUnique"
  | "countChecked"
  | "percentChecked"
  | "sum"
  | "avg"
  | "median"
  | "min"
  | "max"
  | "range"
  | "showOriginal";

export interface ViewSpec {
  filter: FilterGroup;
  sort: SortRule[];
  group: GroupRule[];
  hidden: string[];
  aggregates: Record<string, AggregateFunction>;
  rowColors: { when: FilterGroup; color: BlockColor }[];
  card: {
    cover?: string;
    size: "small" | "medium" | "large";
    properties: string[];
  };
  calendarBy?: string;
  timelineBy?: { start: string; end?: string };
  chart?: { kind: "bar" | "line" | "pie"; x: string; y: string; agg: AggregateFunction };
  form?: { title: string; allowMore: boolean; fields: string[] };
}

export interface ViewDef {
  id: string;
  db_id: string;
  name: string;
  type: ViewType;
  spec: ViewSpec;
  pos: string;
}

export const emptyFilter = (): FilterGroup => ({ and: true, rules: [] });

export const defaultViewSpec = (): ViewSpec => ({
  filter: emptyFilter(),
  sort: [],
  group: [],
  hidden: [],
  aggregates: {},
  rowColors: [],
  card: { size: "medium", properties: [] },
});

// ─────────────────────────────────────────────────────────────────────────────
// Search / backlinks / history / trash
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchHit {
  node_id: string;
  title: string;
  snippet: string;
  score: number;
  path: { id: string; title: string; icon?: string }[];
  updated_at: number;
}

export interface BacklinkEntry {
  src: string;
  srcTitle: string;
  srcIcon?: string;
  context: string;
  prop_id: string;
  kind: "mention" | "relation";
}

export interface SnapshotEntry {
  id: string;
  node_id: string;
  ts: number;
  label: string | null;
  bytes: number;
}

export interface OpEntry {
  seq: number;
  ts: number;
  actor: string;
  device: string;
  node_id: string;
  op: "insert" | "update" | "delete" | "move";
  patch: Record<string, unknown>;
  tx: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderKind = "strata" | "ollama" | "lmstudio" | "openai-compatible";

export interface ProviderConfig {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  embedModel?: string;
  apiKeyRef?: string;
  enabled: boolean;
}

export interface ModelInfo {
  id: string;
  label?: string;
  contextLength?: number;
  ownedBy?: string;
}

export interface ProviderCapabilities {
  chat: boolean;
  stream: boolean;
  embed: boolean;
  structured: boolean;
}

/**
 * The result of asking one provider, right now, whether it works.
 *
 * This is what the settings screen renders. `health()` answered ok/models/error,
 * which is why the UI could only show a green dot and a count: no latency, no
 * model list, no embedding answer, and no way to tell "not running" from
 * "running with nothing pulled".
 */
export interface ProviderProbe {
  ok: boolean;
  latencyMs: number;
  models: number;
  /** ids for the model picker, capped by the server */
  modelIds: string[];
  /** embedding support: probed, not assumed */
  embedOk: boolean;
  embedModel?: string;
  error?: string;
  /** machine-readable failure class, so the UI can pick the right words */
  kind?: "config" | "network" | "timeout" | "aborted" | "http" | "parse" | "unsupported";
  status?: number;
  /** true when the provider is reachable but serves no models */
  empty?: boolean;
}

/** A local model server found by probing loopback ports. */
export interface DetectedProvider {
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  origin: string;
  running: boolean;
  models: number;
  modelIds: string[];
  /** models whose names look like embedding models (Ollama reports them all) */
  embedModelIds: string[];
  latencyMs: number;
  error?: string;
}

export interface AiUsageSummary {  calls: number;
  ok: number;
  failed: number;
  avgMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  /** characters generated — always known, unlike tokens on local servers */
  chars: number;
  byProvider: {
    provider: string;
    calls: number;
    failed: number;
    avgMs: number;
    lastModel: string;
    lastAt: number;
  }[];
  recent: {
    provider: string;
    model: string;
    action: string;
    ms: number;
    ok: boolean;
    promptTokens: number | null;
    completionTokens: number | null;
    chars: number;
    created_at: number;
    error?: string;
  }[];
}

export type AiAction =
  | "summarize"
  | "translate"
  | "fixGrammar"
  | "changeTone"
  | "autofill"
  | "askWorkspace";

export interface AiRequest {
  action: AiAction;
  providerId: string;
  text?: string;
  targetLang?: string;
  tone?: string;
  question?: string;
  nodeId?: string;
  dbId?: string;
  rowId?: string;
  propId?: string;
}

export interface AiResult {
  ok: boolean;
  text?: string;
  /** for autofill: propId -> value */
  values?: Record<string, PropertyValueInput>;
  sources?: { node_id: string; title: string; snippet: string }[];
  error?: string;
  provider: string;
  model: string;
  ms: number;
  /**
   * Token counts only when the provider reports them (OpenAI-compatible
   * `usage`). Local servers frequently do not, so `null` means "not reported",
   * never "zero". `chars` is always real and is what the UI shows by default.
   */
  usage?: { promptTokens: number | null; completionTokens: number | null; chars: number };
}

/**
 * One event on the streaming AI endpoint.
 *
 * `meta` arrives first with the provider and model that will answer, so the
 * editor can label the running operation before the first token. `delta` is raw
 * model text; the server applies its answer cleanup once, in the `done` result,
 * so the streamed preview and the final text can differ by a code fence.
 */
export type AiStreamEvent =
  | { type: "meta"; provider: string; model: string }
  | { type: "delta"; text: string }
  | { type: "done"; result: AiResult }
  | { type: "error"; result: AiResult };

// ─────────────────────────────────────────────────────────────────────────────
// Misc
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkspaceInfo {
  id: string;
  name: string;
  created_at: number;
  nodeCount: number;
  dbCount: number;
  bytes: number;
}

export interface TrashEntry {
  node_id: string;
  title: string;
  icon?: string;
  type: BlockType;
  deleted_at: number;
  path: { id: string; title: string }[];
}

export const PAGE_WIDTHS = ["default", "full", "wide"] as const;
export type PageWidth = (typeof PAGE_WIDTHS)[number];

export const FONTS = ["default", "serif", "mono"] as const;
export type FontFamily = (typeof FONTS)[number];
