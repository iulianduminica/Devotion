-- Strata Notes — schema v1
--
-- Design notes (read before editing):
--   * `node` is the unified tree: pages, blocks and database rows are all nodes.
--     A row is a page, so it holds nested content. Never split these into systems.
--   * `pos` is a fractional index (see server/ids.ts): ordered lexicographically,
--     so a drag-reorder writes exactly ONE row.
--   * `property_value` spreads each value across typed columns (text_v/num_v/
--     date_v/bool_v/json_v) so multi-rule filter + sort + aggregation is plain SQL.
--   * `op_log` is the single write path's audit trail. Undo, version history,
--     trash/restore, backup and (later) multi-device sync all derive from it.
--   * FTS5 is kept in sync by triggers on `search_doc`, so search can never drift.
--   * Do not SELECT raw int64 columns: node:sqlite throws RangeError on values
--     outside the JS safe-integer range. epoch-ms and seq values are safe.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspace (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  root_id    TEXT
);

-- ── unified tree ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS node (
  id           TEXT PRIMARY KEY,
  ws           TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('page','block','row')),
  type         TEXT NOT NULL,
  parent_id    TEXT REFERENCES node(id) ON DELETE CASCADE,
  parent_kind  TEXT NOT NULL CHECK (parent_kind IN ('workspace','node','database')),
  pos          TEXT NOT NULL,
  props        TEXT NOT NULL DEFAULT '{}',
  body         TEXT,
  meta         TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  created_by   TEXT NOT NULL DEFAULT 'local',
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT NOT NULL DEFAULT 'local',
  deleted_at   INTEGER,
  template_ref TEXT
);
CREATE INDEX IF NOT EXISTS node_parent   ON node(parent_id, pos);
CREATE INDEX IF NOT EXISTS node_active   ON node(parent_id, pos) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS node_ws       ON node(ws, updated_at DESC);
CREATE INDEX IF NOT EXISTS node_trash    ON node(ws, deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS node_template ON node(ws, template_ref) WHERE template_ref IS NOT NULL;

-- ── databases ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS database_obj (
  id           TEXT PRIMARY KEY,
  ws           TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT '',
  icon         TEXT,
  inline_in_id TEXT REFERENCES node(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE INDEX IF NOT EXISTS db_ws ON database_obj(ws) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS property_def (
  id       TEXT PRIMARY KEY,
  db_id    TEXT NOT NULL REFERENCES database_obj(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  type     TEXT NOT NULL,
  pos      TEXT NOT NULL,
  config   TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS prop_unique ON property_def(db_id, name);
CREATE INDEX IF NOT EXISTS prop_db ON property_def(db_id, pos);

CREATE TABLE IF NOT EXISTS property_value (
  row_id  TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  prop_id TEXT NOT NULL REFERENCES property_def(id) ON DELETE CASCADE,
  text_v  TEXT,
  num_v   REAL,
  date_v  INTEGER,
  bool_v  INTEGER,
  json_v  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS pv_key       ON property_value(row_id, prop_id);
CREATE INDEX IF NOT EXISTS pv_num             ON property_value(prop_id, num_v);
CREATE INDEX IF NOT EXISTS pv_date            ON property_value(prop_id, date_v);
CREATE INDEX IF NOT EXISTS pv_text            ON property_value(prop_id, text_v);
CREATE INDEX IF NOT EXISTS pv_bool            ON property_value(prop_id, bool_v);
CREATE INDEX IF NOT EXISTS pv_row             ON property_value(row_id);

CREATE TABLE IF NOT EXISTS view (
  id    TEXT PRIMARY KEY,
  db_id TEXT NOT NULL REFERENCES database_obj(id) ON DELETE CASCADE,
  name  TEXT NOT NULL,
  type  TEXT NOT NULL CHECK (type IN
          ('table','board','list','gallery','calendar','timeline','chart','form')),
  spec  TEXT NOT NULL,
  pos   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS view_db ON view(db_id, pos);

-- ── links ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS relation_edge (
  prop_id  TEXT NOT NULL REFERENCES property_def(id) ON DELETE CASCADE,
  from_row TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  to_row   TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS rel_key ON relation_edge(prop_id, from_row, to_row);
CREATE INDEX IF NOT EXISTS rel_to ON relation_edge(prop_id, to_row);

CREATE TABLE IF NOT EXISTS backlink (
  src     TEXT NOT NULL,
  dst     TEXT NOT NULL,
  prop_id TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  kind    TEXT NOT NULL DEFAULT 'mention' CHECK (kind IN ('mention','relation')),
  PRIMARY KEY (src, dst, prop_id)
);
CREATE INDEX IF NOT EXISTS backlink_dst ON backlink(dst);
CREATE INDEX IF NOT EXISTS backlink_src ON backlink(src);

-- ── media (content-addressed: dedupe, and export is a file copy) ─────────────
CREATE TABLE IF NOT EXISTS media (
  id         TEXT PRIMARY KEY,
  ws         TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  sha256     TEXT NOT NULL,
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  name       TEXT,
  width      INTEGER,
  height     INTEGER,
  duration   REAL,
  path       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS media_hash ON media(ws, sha256);

-- ── templates ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS template (
  id         TEXT PRIMARY KEY,
  ws         TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  scope      TEXT NOT NULL CHECK (scope IN ('page','database')),
  icon       TEXT,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS template_ws ON template(ws, scope);

-- ── op log: the single write path's trail ────────────────────────────────────
CREATE TABLE IF NOT EXISTS op_log (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  actor    TEXT NOT NULL DEFAULT 'local',
  device   TEXT NOT NULL DEFAULT 'this-install',
  node_id  TEXT NOT NULL,
  op       TEXT NOT NULL CHECK (op IN ('insert','update','delete','move','restore')),
  patch    TEXT NOT NULL DEFAULT '{}',
  tx       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS op_node ON op_log(node_id, seq);
CREATE INDEX IF NOT EXISTS op_tx   ON op_log(tx);
CREATE INDEX IF NOT EXISTS op_ts   ON op_log(ts);

CREATE TABLE IF NOT EXISTS snapshot (
  id      TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  ws      TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  ts      INTEGER NOT NULL,
  label   TEXT,
  state   BLOB NOT NULL,
  bytes   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS snap_node ON snapshot(node_id, ts DESC);

-- ── AI: embeddings for workspace Q&A ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chunk (
  id         TEXT PRIMARY KEY,
  node_id    TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  ws         TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  ord        INTEGER NOT NULL,
  text       TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  emb        BLOB NOT NULL,
  model      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chunk_node ON chunk(node_id);
CREATE INDEX IF NOT EXISTS chunk_ws   ON chunk(ws, model);

-- ── settings: providers, theme, editor prefs ─────────────────────────────────
CREATE TABLE IF NOT EXISTS setting (
  ws        TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ws, key)
);

-- ── AI call log: the diagnostics drawer and the usage stats read this ────────
-- One row per request. Token counts are nullable on purpose: most local servers
-- do not report usage, and a 0 there would be a lie. `chars` is always real.
CREATE TABLE IF NOT EXISTS ai_call (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ws                TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL DEFAULT '',
  action            TEXT NOT NULL DEFAULT '',
  ms                INTEGER NOT NULL DEFAULT 0,
  ok                INTEGER NOT NULL DEFAULT 1,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  chars             INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_call_ws ON ai_call(ws, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_call_provider ON ai_call(ws, provider, created_at DESC);

-- ── search: shadow table + FTS5, trigger-synced ──────────────────────────────
CREATE TABLE IF NOT EXISTS search_doc (
  rid     INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL UNIQUE REFERENCES node(id) ON DELETE CASCADE,
  ws      TEXT NOT NULL,
  title   TEXT NOT NULL DEFAULT '',
  body    TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS search_ws ON search_doc(ws);

CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
  title, body,
  content='search_doc',
  content_rowid='rid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS sdoc_ai AFTER INSERT ON search_doc BEGIN
  INSERT INTO node_fts(rowid, title, body) VALUES (new.rid, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS sdoc_ad AFTER DELETE ON search_doc BEGIN
  INSERT INTO node_fts(node_fts, rowid, title, body)
  VALUES ('delete', old.rid, old.title, old.body);
END;

CREATE TRIGGER IF NOT EXISTS sdoc_au AFTER UPDATE OF title, body ON search_doc BEGIN
  INSERT INTO node_fts(node_fts, rowid, title, body)
  VALUES ('delete', old.rid, old.title, old.body);
  INSERT INTO node_fts(rowid, title, body) VALUES (new.rid, new.title, new.body);
END;

-- node updates refresh their own search document.
-- Title comes from heading/page/todo blocks; body is the JSON text runs joined.
CREATE TRIGGER IF NOT EXISTS node_au_search AFTER UPDATE OF body, deleted_at ON node
BEGIN
  INSERT INTO search_doc(node_id, ws, title, body, deleted)
  VALUES (
    new.id,
    new.ws,
    CASE WHEN new.type IN ('page','child_page','heading_1','heading_2','heading_3','table_row')
         THEN ifnull((SELECT group_concat(json_extract(j.value, '$.text'), ' ')
                      FROM json_each(new.body) j), '')
         ELSE '' END,
    ifnull((SELECT group_concat(json_extract(j.value, '$.text'), ' ')
            FROM json_each(new.body) j), '')
      || ' ' ||
    ifnull((SELECT group_concat(json_extract(j.value, '$.url'), ' ')
            FROM json_each(json_extract(new.props, '$.linkUrls')) j), ''),
    CASE WHEN new.deleted_at IS NULL THEN 0 ELSE 1 END
  )
  ON CONFLICT(node_id) DO UPDATE SET
    title   = excluded.title,
    body    = excluded.body,
    deleted = excluded.deleted;
END;

CREATE TRIGGER IF NOT EXISTS node_ai_search AFTER INSERT ON node
BEGIN
  INSERT INTO search_doc(node_id, ws, title, body, deleted)
  VALUES (
    new.id,
    new.ws,
    CASE WHEN new.type IN ('page','child_page','heading_1','heading_2','heading_3','table_row')
         THEN ifnull((SELECT group_concat(json_extract(j.value, '$.text'), ' ')
                      FROM json_each(new.body) j), '')
         ELSE '' END,
    ifnull((SELECT group_concat(json_extract(j.value, '$.text'), ' ')
            FROM json_each(new.body) j), ''),
    CASE WHEN new.deleted_at IS NULL THEN 0 ELSE 1 END
  )
  ON CONFLICT(node_id) DO UPDATE SET
    title   = excluded.title,
    body    = excluded.body,
    deleted = excluded.deleted;
END;

CREATE TRIGGER IF NOT EXISTS node_ad_search AFTER DELETE ON node BEGIN
  DELETE FROM search_doc WHERE node_id = old.id;
END;
