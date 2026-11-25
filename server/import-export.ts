/**
 * Import / export bridge.
 *
 * The Markdown, HTML and CSV parsers live in server/port/. This file is the
 * seam: it turns a parsed import into real nodes through the normal write path
 * (so imports are undoable and land in the search index), and it assembles
 * exports from the node tree.
 */

import type { Db } from "./db.ts";
import { createNode, updateNode, DEFAULT_ACTOR, type ActorInfo } from "./ops.ts";
import {
  getTree,
  childrenOf,
  getNode,
  nodeTitle,
  workspaceInfo,
} from "./library.ts";
import {
  createDatabase,
  createRow,
  listProperties,
  listViews,
  listRows,
  setPropertyValue,
  queryRows,
  optionsOf,
} from "./databases.ts";
import type { ImportResult, ParsedBlock, ParsedDatabase } from "./port/blocks.ts";
import { blocksToMarkdown } from "./port/markdown.ts";
import { blocksToHtml } from "./port/html.ts";
import { toCsv } from "./port/csv.ts";
import { bodyToPlainText, type NodeTree, type PropertyValueInput, type PropertyType } from "../shared/types.ts";

export interface MaterializeResult {
  pages: number;
  blocks: number;
  databases: number;
  rows: number;
  rootIds: string[];
  warnings: string[];
}

/**
 * Write an ImportResult into the workspace.
 *
 * Goes through createNode, so every imported block is an op-log entry: an
 * import is one undoable edit, and it is searchable the moment it lands.
 */
export function materializeImport(
  db: Db,
  ws: string,
  parentId: string | null,
  result: ImportResult,
  opts: { actor?: ActorInfo; title?: string; tx?: number } = {},
): MaterializeResult {
  const actor = opts.actor ?? DEFAULT_ACTOR;
  const stats: MaterializeResult = {
    pages: 0,
    blocks: 0,
    databases: 0,
    rows: 0,
    rootIds: [],
    warnings: [...(result.warnings ?? [])],
  };

  db.tx(() => {
    // A Markdown import that starts with an H1 becomes the page title, the way
    // Notion's own export does.
    const heading = result.blocks.find((b) => b.type === "heading_1");
    const title = opts.title ?? (heading ? bodyToPlainText(heading.body) : "Imported");

    const pageId = createNode(db, {
      ws,
      kind: "page",
      type: parentId ? "child_page" : "page",
      parent_id: parentId,
      parent_kind: parentId ? "node" : "workspace",
      body: [{ type: "text", text: title, styles: {} }],
      meta: {},
      actor,
      tx: opts.tx,
    });
    stats.pages++;
    stats.rootIds.push(pageId);

    const skipHeading = heading && result.blocks[0]?.type === "heading_1";
    const body = skipHeading ? result.blocks.slice(1) : result.blocks;
    stats.blocks += writeBlocks(db, ws, pageId, body, actor, opts.tx, stats);

    for (const parsed of result.databases ?? []) {
      const host = createNode(db, {
        ws,
        kind: "block",
        type: "paragraph",
        parent_id: pageId,
        parent_kind: "node",
        body: [{ type: "text", text: parsed.title, styles: { bold: true } }],
        actor,
        tx: opts.tx,
      });
      void host;
      const created = createDatabase(db, {
        ws,
        parent_id: pageId,
        parent_kind: "node",
        title: parsed.title,
        properties: parsed.properties.map((p) => ({ name: p.name, type: p.type as PropertyType })),
        actor,
      });
      stats.databases++;

      const props = listProperties(db, created.databaseId);
      const byName = new Map(props.map((p) => [p.name, p]));
      for (const row of parsed.rows) {
        const values: Record<string, PropertyValueInput> = {};
        for (const [name, value] of Object.entries(row)) {
          const prop = byName.get(name);
          if (prop) values[prop.id] = value as PropertyValueInput;
        }
        createRow(db, created.databaseId, values, { actor, tx: opts.tx });
        stats.rows++;
      }
    }
  });

  return stats;
}

function writeBlocks(
  db: Db,
  ws: string,
  parentId: string,
  blocks: ParsedBlock[],
  actor: ActorInfo,
  tx: number | undefined,
  stats: MaterializeResult,
): number {
  let count = 0;
  for (const block of blocks) {
    const id = createNode(db, {
      ws,
      kind: "block",
      type: block.type,
      parent_id: parentId,
      parent_kind: "node",
      body: block.body,
      props: block.props,
      actor,
      tx,
    });
    count++;
    if (block.children?.length) {
      count += writeBlocks(db, ws, id, block.children, actor, tx, stats);
    }
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

/** NodeTree → ParsedBlock[] for the port module's writers. */
export function treeToParsed(tree: NodeTree): ParsedBlock {
  return {
    type: tree.type,
    props: (typeof tree.props === "string" ? JSON.parse(tree.props) : tree.props) as Record<string, unknown>,
    body: typeof tree.body === "string" ? (JSON.parse(tree.body) as ParsedBlock["body"]) : tree.body,
    children: (tree.children ?? []).map(treeToParsed),
  };
}

/** Databases referenced by a page are appended as GFM tables. */
export function expandDatabases(db: Db, blocks: ParsedBlock[]): ParsedBlock[] {
  const out: ParsedBlock[] = [];
  for (const block of blocks) {
    if (block.type === "child_database") {
      const props = block.props as { databaseId?: string };
      const dbId = props.databaseId;
      if (dbId) {
        const table = databaseToParsedTable(db, dbId);
        if (table) {
          out.push(table);
          continue;
        }
      }
    }
    out.push({ ...block, children: expandDatabases(db, block.children ?? []) });
  }
  return out;
}

function databaseToParsedTable(db: Db, databaseId: string): ParsedBlock | null {
  const props = listProperties(db, databaseId);
  const views = listViews(db, databaseId);
  const rows = views[0] ? queryRows(db, databaseId, views[0].spec).rows : listRows(db, databaseId);

  const header = props.map((p) => p.name);
  const body = rows.map((row) =>
    props.map((p) => renderCellValue(db, p, row.values[p.id])),
  );

  return {
    // "child_database" is a real BlockType; the port module reads props.table
    // from it, so the block survives both Markdown and HTML export.
    type: "child_database",
    props: {
      databaseId,
      table: { header, rows: body },
      title: db.scalar<string>("SELECT title FROM database_obj WHERE id = ?", databaseId) ?? "",
    },
    body: null,
    children: [],
  };
}

function renderCellValue(db: Db, prop: { id: string; type: string; config: unknown }, value: PropertyValueInput | undefined): string {
  if (value === null || value === undefined) return "";
  const options = optionsOf(prop as never);

  switch (prop.type) {
    case "checkbox":
      return value === true ? "☑" : "☐";
    case "select":
    case "multi_select":
    case "status": {
      const ids = Array.isArray(value) ? value : [];
      return ids.map((id) => options.find((o) => o.id === id)?.name ?? id).join(", ");
    }
    case "date": {
      const v = value as { start: number | null; end: number | null };
      if (!v?.start) return "";
      const s = new Date(v.start).toISOString().slice(0, 10);
      return v.end ? `${s} → ${new Date(v.end).toISOString().slice(0, 10)}` : s;
    }
    case "relation": {
      const rows = (value as { rows: string[] })?.rows ?? [];
      return rows
        .map((id) => {
          const n = getNode(db, id);
          return n ? nodeTitle(n) : id;
        })
        .join(", ");
    }
    case "number":
    case "unique_id":
      return String(value);
    default:
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

export function exportPageMarkdown(db: Db, nodeId: string): string {
  const tree = getTree(db, nodeId, 30);
  if (!tree) return "";
  const node = getNode(db, nodeId);
  const title = node ? nodeTitle(node) : "Untitled";

  const blocks: ParsedBlock[] = [
    { type: "heading_1", props: {}, body: tree.body, children: [] },
    ...expandDatabases(db, (tree.children ?? []).map(treeToParsed)),
  ];
  return blocksToMarkdown(blocks);
}

export function exportPageHtml(db: Db, nodeId: string): string {
  const tree = getTree(db, nodeId, 30);
  if (!tree) return "";
  const node = getNode(db, nodeId);
  const title = node ? nodeTitle(node) : "Untitled";
  const blocks: ParsedBlock[] = [
    { type: "heading_1", props: {}, body: tree.body, children: [] },
    ...expandDatabases(db, (tree.children ?? []).map(treeToParsed)),
  ];
  return blocksToHtml(blocks, { title });
}

/** A database view → CSV, with the same filter/sort the view defines. */
export function exportViewCsv(db: Db, viewId: string): string {
  const view = db.get<{ id: string; db_id: string; name: string; spec: string }>(
    "SELECT id, db_id, name, spec FROM view WHERE id = ?",
    viewId,
  );
  if (!view) return "";
  const spec = JSON.parse(view.spec) as import("../shared/types.ts").ViewSpec;
  const props = listProperties(db, view.db_id).filter((p) => !spec.hidden.includes(p.id));
  const rows = queryRows(db, view.db_id, spec).rows;

  const header = props.map((p) => p.name);
  const body = rows.map((row) => props.map((p) => renderCellValue(db, p, row.values[p.id])));
  return toCsv([header, ...body]);
}

/** Whole-workspace Markdown: one .md per top-level page, mirroring the tree. */
export function exportWorkspace(db: Db, ws: string): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  const info = workspaceInfo(db, ws);

  const slug = (s: string): string =>
    (s.replace(/[^\w\- ]/g, "").trim().replace(/\s+/g, "-") || "untitled").slice(0, 60);

  const walk = (nodeId: string, dir: string, name: string): void => {
    const tree = getTree(db, nodeId, 30);
    if (!tree) return;
    const node = getNode(db, nodeId);
    const title = node ? nodeTitle(node) : name;

    const childPages = (tree.children ?? []).filter(
      (c) => c.type === "child_page" || c.type === "page" || c.type === "child_database",
    );
    const blockChildren = (tree.children ?? []).filter(
      (c) => c.type !== "child_page" && c.type !== "page" && c.type !== "child_database",
    );

    const blocks: ParsedBlock[] = [
      { type: "heading_1", props: {}, body: tree.body, children: [] },
      ...expandDatabases(db, blockChildren.map(treeToParsed)),
    ];

    const base = dir ? `${dir}/${slug(title)}` : slug(title);
    files.push({ path: `${base}.md`, content: blocksToMarkdown(blocks) });

    for (const child of childPages) {
      if (child.type === "child_database") continue;
      const childNode = getNode(db, child.id);
      walk(child.id, base, childNode ? nodeTitle(childNode) : "untitled");
    }
  };

  const roots = childrenOf(db, null).filter((n) => n.kind === "page" || n.type === "page");
  for (const root of roots) walk(root.id, "", nodeTitle(root));

  files.push({
    path: "index.md",
    content: `# ${info?.name ?? "Workspace"}\n\n${roots
      .map((r) => `- ${nodeTitle(r)}`)
      .join("\n")}\n`,
  });

  return files;
}

export { updateNode };
