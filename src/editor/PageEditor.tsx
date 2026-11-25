/**
 * Page editor.
 *
 * Structure matters here: the BlockNote view must be constructed with its
 * content. An earlier version fetched the tree, called replaceBlocks, and only
 * then mounted BlockNoteView — and mounting re-initialises the ProseMirror doc
 * from the editor's initial content, so every block vanished. So the editor is
 * created in a child component, keyed by page, with `initialContent` already in
 * hand.
 *
 * The page title is a separate field, not a block — matching Notion, and it
 * keeps a page node's `body` usable as the searchable title.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BlockNoteSchema, defaultBlockSpecs, defaultStyleSpecs, defaultInlineContentSpecs } from "@blocknote/core";
import { useCreateBlockNote } from "@blocknote/react";
// BlockNoteView is the Mantine-wrapped variant: it applies the theme provider
// the @blocknote/mantine stylesheet expects.
import { BlockNoteView } from "@blocknote/mantine";
import { ImagePlus, Palette, Trash2, Type } from "lucide-react";

import { api, mediaSrc } from "../api.ts";
import type { NodeRow, NodeTree, PageMeta } from "../../shared/types.ts";
import { customBlockSpecs, editorHost } from "./blocks.tsx";
import { AiToolbar } from "./AiToolbar.tsx";
import {
  contentToText,
  fromBnProps,
  fromBlockNote,
  bodyForType,
  markdownToBnBlocks,
  toContent,
  treeToBlocks,
  type BodyLike,
  type FlatBlock,
} from "./serialize.ts";

export const editorSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    ...customBlockSpecs,
  },
  styleSpecs: defaultStyleSpecs,
  inlineContentSpecs: defaultInlineContentSpecs,
});

interface OutOp {
  op: "insert" | "update" | "move" | "delete";
  id: string;
  parentId?: string | null;
  parentKind?: "node" | "workspace" | "database";
  type?: string;
  kind?: "page" | "block" | "row";
  body?: unknown;
  props?: Record<string, unknown>;
  before?: string | null;
  after?: string | null;
  patch?: Record<string, unknown>;
}

export interface PageEditorProps {
  node: NodeRow;
  children_: NodeRow[];
  onChanged: () => void;
  onTreeChanged: () => void;
  onNavigate: (id: string) => void;
  notify: (message: string) => void;
  setDirty: (dirty: boolean) => void;
  onSetMeta: (patch: Partial<PageMeta>) => Promise<void>;
  onTrash: () => void;
  /** word/block counts for the statusbar, recomputed whenever the tree loads */
  onStats?: (stats: { words: number; blocks: number }) => void;
  /**
   * Bumped by the shell after a server undo/redo. The editor is built from the
   * tree it loaded on mount, so without this the visible document would keep
   * showing the pre-undo state.
   */
  revision?: number;
}

/** Words and blocks in a page subtree, for the statusbar. */
function countTree(tree: NodeTree): { words: number; blocks: number } {
  let words = 0;
  let blocks = 0;
  const walk = (n: NodeTree): void => {
    for (const c of n.children) {
      blocks += 1;
      const body = c.body as unknown;
      const text = Array.isArray(body)
        ? body.map((i) => (i as { text?: string }).text ?? "").join("")
        : typeof body === "string"
          ? body
          : "";
      const t = text.trim();
      if (t) words += t.split(/\s+/).length;
      walk(c);
    }
  };
  walk(tree);
  return { words, blocks };
}

export function PageEditor(props: PageEditorProps): React.ReactNode {
  const { node } = props;
  const [tree, setTree] = useState<NodeTree | null>(null);
  const [loading, setLoading] = useState(true);
  const theme = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";

  // statusbar stats; the callback is a stable setter from the shell
  useEffect(() => {
    if (tree) props.onStats?.(countTree(tree));
  }, [tree]);

  const initialTitle = useMemo(
    () => (Array.isArray(node.body) ? (node.body as BodyLike[]).map((i) => i.text).join("") : ""),
    [node.id],
  );
  const [title, setTitle] = useState(initialTitle);
  useEffect(() => setTitle(initialTitle), [initialTitle]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setTree(null);
    void api
      .fullTree(node.id, 25)
      .then((t) => {
        if (cancelled) return;
        setTree(t);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        props.notify(`Load failed: ${err.message}`);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [node.id, props.revision]);

  // child-page blocks label themselves from the tree
  useEffect(() => {
    editorHost.setPageTitleResolver((id) => {
      const hit = findInTree(tree, id);
      if (!hit) return undefined;
      return { title: contentToText(toContent(hit.body as unknown as BodyLike[])), icon: hit.meta?.icon };
    });
  }, [tree]);

  const commitTitle = async (): Promise<void> => {
    await api.patchNode(node.id, { body: [{ type: "text", text: title, styles: {} }] });
    props.onChanged();
    props.onTreeChanged();
  };

  return (
    <div
      className="sn-page"
      data-width={node.meta?.pageWidth ?? (node.meta?.fullWidth ? "full" : "default")}
      data-font={node.meta?.font ?? "default"}
    >
      {node.meta?.cover && (
        <div className="sn-cover" style={{ backgroundImage: `url(${mediaSrc(node.meta.cover)})`, marginBottom: 8 }} />
      )}

      {node.meta?.icon && (
        <div style={{ padding: "0 0 4px" }}>
          <button className="sn-page-icon" title="Change icon" onClick={() => editorHost.pick(node.id, "icon")}>
            {node.meta.icon}
          </button>
        </div>
      )}

      <input
        value={title}
        placeholder="Untitled"
        aria-label="Page title"
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => void commitTitle()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commitTitle();
            (e.target as HTMLInputElement).blur();
          }
        }}
        style={{
          width: "100%",
          background: "transparent",
          border: 0,
          color: "var(--text-primary)",
          fontSize: "var(--text-2xl)",
          fontWeight: 700,
          letterSpacing: "-0.02em",
          padding: "4px 0 12px",
          outline: "none",
          fontFamily: "inherit",
        }}
      />

      {loading && <div className="sn-muted" style={{ padding: "16px 0" }}>Loading blocks…</div>}

      {/* Keyed by page id, and only mounted once the blocks are in hand: the
          editor is constructed with its content. */}
      {!loading && tree && (
        <EditorSurface
          key={`${node.id}:${props.revision ?? 0}`}
          pageId={node.id}
          tree={tree}
          theme={theme}
          notify={props.notify}
          setDirty={props.setDirty}
          onTreeChanged={props.onTreeChanged}
        />
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 24, flexWrap: "wrap" }}>
        <button className="sn-btn sn-btn-ghost sn-btn-sm" onClick={() => editorHost.pick(node.id, "icon")}>
          <Palette size={13} strokeWidth={1.5} />
          Icon
        </button>
        <button
          className="sn-btn sn-btn-ghost sn-btn-sm"
          onClick={() => void props.onSetMeta({ pageWidth: node.meta?.pageWidth === "full" ? "default" : "full" })}
        >
          <Type size={13} strokeWidth={1.5} />
          {node.meta?.pageWidth === "full" ? "Default width" : "Full width"}
        </button>
        <button
          className="sn-btn sn-btn-ghost sn-btn-sm"
          onClick={() => {
            const fonts = ["default", "serif", "mono"] as const;
            const current = (node.meta?.font ?? "default") as (typeof fonts)[number];
            void props.onSetMeta({ font: fonts[(fonts.indexOf(current) + 1) % fonts.length] });
          }}
        >
          <Type size={13} strokeWidth={1.5} />
          Font: {node.meta?.font ?? "default"}
        </button>
        <button
          className="sn-btn sn-btn-ghost sn-btn-sm"
          onClick={() => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*";
            input.onchange = async () => {
              const file = input.files?.[0];
              if (!file) return;
              const stored = await api.uploadMedia(file);
              await props.onSetMeta({ cover: stored.id });
              props.notify("Cover updated");
            };
            input.click();
          }}
        >
          <ImagePlus size={13} strokeWidth={1.5} />
          Cover
        </button>
        <div style={{ flex: 1 }} />
        <button className="sn-btn sn-btn-destructive sn-btn-sm" onClick={props.onTrash}>
          <Trash2 size={13} strokeWidth={1.5} />
          Move to trash
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

interface EditorSurfaceProps {
  pageId: string;
  tree: NodeTree;
  theme: "light" | "dark";
  notify: (m: string) => void;
  setDirty: (d: boolean) => void;
  onTreeChanged: () => void;
}

function EditorSurface(props: EditorSurfaceProps): React.ReactNode {
  const { pageId, tree, theme, notify, setDirty, onTreeChanged } = props;

  const { blocks, meta } = useMemo(() => treeToBlocks(tree), [tree]);
  // A page with no blocks yet (a freshly created one) must still get a document:
  // BlockNote throws on an empty initialContent array.
  const initialContent = useMemo(
    () => (blocks.length ? blocks : [{ type: "paragraph", content: [] }]),
    [blocks],
  );
  const baseline = useRef<Map<string, FlatBlock>>(meta);
  const saveTimer = useRef<number | null>(null);
  const busy = useRef(false);
  const pending = useRef(false);
  const [selection, setSelection] = useState<{ blockId: string | null; text: string }>({ blockId: null, text: "" });

  const editor = useCreateBlockNote({ schema: editorSchema, initialContent: initialContent as never }, [pageId]);

  const flatten = useCallback((): FlatBlock[] => {
    const out: FlatBlock[] = [];
    const walk = (list: readonly Record<string, unknown>[], parentId: string | null): void => {
      list.forEach((b, index) => {
        const bnType = String(b.type ?? "paragraph");
        const bProps = (b.props ?? {}) as Record<string, unknown>;
        out.push({
          id: String(b.id),
          type: fromBlockNote(bnType, bProps),
          bnType,
          props: fromBnProps(bnType, bProps),
          content: (b.content ?? []) as unknown[],
          parentId,
          pos: "",
          index,
        });
        const children = (b.children ?? []) as readonly Record<string, unknown>[];
        if (children.length) walk(children, String(b.id));
      });
    };
    walk(editor.document as unknown as readonly Record<string, unknown>[], pageId);
    return out;
  }, [editor, pageId]);

  const save = useCallback(async (): Promise<void> => {
    if (busy.current) {
      pending.current = true;
      return;
    }
    busy.current = true;
    try {
      const current = flatten();
      const base = baseline.current;
      const ops: OutOp[] = [];
      const seen = new Set<string>();

      current.forEach((block, i) => {
        seen.add(block.id);
        const prev = base.get(block.id);

        if (!prev) {
          // Anchor the insert on a node that is guaranteed to exist when the op
          // is applied. `current` is walked in document order, so every earlier
          // sibling has already been created in this same transaction; anchoring
          // on the *next* sibling breaks when that sibling is also new.
          const siblings = current.filter((c) => c.parentId === block.parentId);
          const idx = siblings.findIndex((c) => c.id === block.id);
          const prevSib = siblings[idx - 1];
          const nextSib = siblings[idx + 1];
          ops.push({
            op: "insert",
            id: block.id,
            parentId: block.parentId,
            parentKind: "node",
            type: block.type,
            kind: block.type === "child_page" ? "page" : "block",
            body: bodyForType(block.bnType, block.content),
            props: block.props,
            after: prevSib ? prevSib.id : null,
            before: !prevSib && nextSib && base.has(nextSib.id) ? nextSib.id : null,
          });
          return;
        }

        if (prev.parentId !== block.parentId || prev.index !== block.index) {
          const siblings = current.filter((c) => c.parentId === block.parentId);
          const idx = siblings.findIndex((c) => c.id === block.id);
          ops.push({
            op: "move",
            id: block.id,
            parentId: block.parentId,
            before: siblings[idx + 1]?.id ?? null,
            after: siblings[idx - 1]?.id ?? null,
          });
        }

        if (
          JSON.stringify(prev.content) !== JSON.stringify(block.content) ||
          JSON.stringify(prev.props) !== JSON.stringify(block.props) ||
          prev.type !== block.type
        ) {
          ops.push({ op: "update", id: block.id, patch: { body: bodyForType(block.bnType, block.content), props: block.props, type: block.type } });
        }
      });

      for (const id of base.keys()) if (!seen.has(id)) ops.push({ op: "delete", id });
      if (!ops.length) return;

      await api.tx(ops);
      const fresh = await api.fullTree(pageId, 25);
      baseline.current = treeToBlocks(fresh).meta;
      setDirty(false);
      onTreeChanged();
    } catch (err) {
      notify(`Save failed: ${(err as Error).message}`);
      setDirty(false);
    } finally {
      busy.current = false;
      if (pending.current) {
        pending.current = false;
        void save();
      }
    }
  }, [editor, pageId, flatten, notify, setDirty, onTreeChanged]);

  useEffect(() => () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
  }, []);

  const onChange = (): void => {
    setDirty(true);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void save(), 450);
  };

  const snapshotSelection = useCallback((): { blockId: string | null; text: string } => {
    try {
      // getSelection() returns { blocks } in 0.57 — not an array. Reading [0]
      // off it yields undefined, which silently disabled every AI action.
      const block = editor.getSelection()?.blocks[0];
      if (!block) return { blockId: null, text: "" };
      const domText = window.getSelection()?.toString() ?? "";
      return {
        blockId: block.id,
        text: domText.trim() || contentToText(block.content as unknown[]),
      };
    } catch {
      return { blockId: null, text: "" };
    }
  }, [editor]);

  return (
    <>
      <div className="sn-editor">
        <BlockNoteView
          editor={editor}
          theme={theme}
          onChange={onChange}
          onSelectionChange={() => setSelection(snapshotSelection())}
        />
      </div>
      <AiToolbar
        selection={selection.text}
        nodeId={pageId}
        onInsert={(text) => {
          if (!selection.blockId) return;
          // Insert the result below the source block: non-destructive, and it
          // lands as one undoable op. Models reply in Markdown, so convert it
          // into real blocks instead of pasting literal `- ` and `**`.
          editor.insertBlocks(markdownToBnBlocks(text) as never, selection.blockId, "after");
        }}
        onReplace={(text) => {
          if (!selection.blockId) return;
          // The destructive option, offered explicitly by the toolbar. One
          // insertBlocks + delete pair, so a single undo reverses it.
          const blocks = markdownToBnBlocks(text) as never[];
          editor.replaceBlocks([selection.blockId], blocks);
        }}
        notify={notify}
      />
    </>
  );
}

function findInTree(tree: NodeTree | null, id: string): NodeTree | null {
  if (!tree) return null;
  if (tree.id === id) return tree;
  for (const child of tree.children) {
    const hit = findInTree(child, id);
    if (hit) return hit;
  }
  return null;
}
