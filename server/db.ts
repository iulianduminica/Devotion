/**
 * SQLite access layer.
 *
 * Uses Node's built-in `node:sqlite` (verified: SQLite 3.51.3 with FTS5, RTREE,
 * JSON1 and WAL). No native modules, so `npm install` works on any machine with
 * no compiler present — which matters for a tool people install locally.
 *
 * All SQL lives behind this file plus the repositories. If `node:sqlite` ever
 * stops being acceptable, swapping the driver touches this file only.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_VERSION = 1;

/**
 * Bound parameter types. `boolean` is deliberately absent: node:sqlite's
 * SQLInputValue rejects it, so callers pass 0/1 (which is what the schema's
 * bool_v columns store anyway).
 */
export type SqlParam = string | number | bigint | Uint8Array | null;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export class Db {
  readonly conn: DatabaseSync;
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    this.conn = new DatabaseSync(file);

    this.conn.exec("PRAGMA journal_mode = WAL");
    this.conn.exec("PRAGMA foreign_keys = ON");
    this.conn.exec("PRAGMA synchronous = NORMAL");
    this.conn.exec("PRAGMA temp_store = MEMORY");
    this.conn.exec("PRAGMA busy_timeout = 5000");
    this.conn.exec("PRAGMA cache_size = -32000"); // 32 MB
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): T[] {
    return this.conn.prepare(sql).all(...params) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.conn.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SqlParam[]): RunResult {
    const r = this.conn.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  /** Value of a single column from the first row, or undefined. */
  scalar<T = unknown>(sql: string, ...params: SqlParam[]): T | undefined {
    const row = this.get<Record<string, unknown>>(sql, ...params);
    if (!row) return undefined;
    const key = Object.keys(row)[0];
    return key === undefined ? undefined : (row[key] as T);
  }

  private depth = 0;

  /**
   * Transaction. Nested calls use SAVEPOINTs so repositories can compose
   * transactions without the caller knowing they are already inside one.
   */
  tx<T>(fn: () => T): T {
    const name = `sp_${this.depth}`;
    if (this.depth === 0) this.conn.exec("BEGIN IMMEDIATE");
    else this.conn.exec(`SAVEPOINT ${name}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      if (this.depth === 0) this.conn.exec("COMMIT");
      else this.conn.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      this.depth--;
      if (this.depth === 0) this.conn.exec("ROLLBACK");
      else this.conn.exec(`ROLLBACK TO ${name}`);
      throw err;
    }
  }

  close(): void {
    this.conn.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Migrations
// ─────────────────────────────────────────────────────────────────────────────

interface Migration {
  version: number;
  label: string;
  sql: string;
}

function loadMigrations(): Migration[] {
  // schema.sql is applied as the v1 baseline; later migrations are appended here.
  const baseline = readFileSync(join(HERE, "schema.sql"), "utf8");
  return [
    { version: 1, label: "baseline", sql: baseline },
    {
      version: 2,
      label: "ai_call log",
      // The AI call log arrived after v1. A fresh database already has it from
      // the baseline, so this must stay idempotent — it runs on every workspace
      // created before the table existed.
      sql: `
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
      `,
    },
  ];
}

export function migrate(db: Db): number {
  const current = Number(db.scalar<number>("PRAGMA user_version") ?? 0);
  const migrations = loadMigrations().filter((m) => m.version > current);
  if (!migrations.length) return current;

  for (const m of migrations) {
    db.tx(() => {
      db.conn.exec(m.sql);
      db.conn.exec(`PRAGMA user_version = ${m.version}`);
    });
  }
  return migrations.at(-1)!.version;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row mapping helpers
// ─────────────────────────────────────────────────────────────────────────────

export function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export const j = (value: unknown): string => JSON.stringify(value ?? null);

export function nowMs(): number {
  return Date.now();
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace file layout
//
// One folder = one workspace = one SQLite file + a content-addressed media dir.
// Backup and export are a folder copy, by construction.
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkspacePaths {
  root: string;
  dbFile: string;
  mediaDir: string;
  exportsDir: string;
}

export function workspacePaths(root: string): WorkspacePaths {
  return {
    root,
    dbFile: join(root, "data.sqlite"),
    mediaDir: join(root, "media"),
    exportsDir: join(root, "exports"),
  };
}

export function ensureWorkspaceDirs(paths: WorkspacePaths): void {
  for (const dir of [paths.root, paths.mediaDir, paths.exportsDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function openWorkspace(root: string): { db: Db; paths: WorkspacePaths } {
  const paths = workspacePaths(root);
  ensureWorkspaceDirs(paths);
  const db = new Db(paths.dbFile);
  migrate(db);
  return { db, paths };
}
