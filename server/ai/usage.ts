/**
 * The AI call log.
 *
 * Two things the settings screen cannot answer without it: "is this provider
 * actually fast, and does it fail?" and "what did the model just do?". Every
 * request writes one row, and the diagnostics drawer reads the last few.
 *
 * Token counts are nullable. Most local servers do not report usage, and
 * writing 0 there would turn "unknown" into a fabricated number — the UI shows
 * characters, which are always real, and tokens only when the provider reports
 * them.
 */

import type { AiUsageSummary } from "../../shared/types.ts";
import type { Db } from "../db.ts";

export interface AiCallEntry {
  ws: string;
  provider: string;
  model?: string;
  action?: string;
  ms: number;
  ok: boolean;
  promptTokens?: number | null;
  completionTokens?: number | null;
  chars?: number;
  error?: string;
  createdAt?: number;
}

/** Keep the log bounded; a year of daily use is a few thousand rows. */
export const AI_CALL_RETENTION = 1_000;

export function logAiCall(db: Db, entry: AiCallEntry): void {
  db.run(
    `INSERT INTO ai_call
       (ws, provider, model, action, ms, ok, prompt_tokens, completion_tokens, chars, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    entry.ws,
    entry.provider,
    entry.model ?? "",
    entry.action ?? "",
    Math.max(0, Math.round(entry.ms)),
    entry.ok ? 1 : 0,
    entry.promptTokens ?? null,
    entry.completionTokens ?? null,
    Math.max(0, Math.round(entry.chars ?? 0)),
    entry.error ?? null,
    entry.createdAt ?? Date.now(),
  );
}

/** Drop the oldest rows beyond `keep`. Returns how many went. */
export function pruneAiCalls(db: Db, ws: string, keep: number = AI_CALL_RETENTION): number {
  const res = db.run(
    `DELETE FROM ai_call
     WHERE ws = ? AND id NOT IN (
       SELECT id FROM ai_call WHERE ws = ? ORDER BY created_at DESC LIMIT ?
     )`,
    ws,
    ws,
    Math.max(1, Math.floor(keep)),
  );
  return Number(res.changes ?? 0);
}

interface TotalsRow {
  calls: number;
  ok: number;
  failed: number;
  avg_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  chars: number | null;
}

interface ProviderRow {
  provider: string;
  calls: number;
  failed: number;
  avg_ms: number | null;
  last_model: string | null;
  last_at: number | null;
}

interface RecentRow {
  provider: string;
  model: string;
  action: string;
  ms: number;
  ok: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  chars: number;
  created_at: number;
  error: string | null;
}

/**
 * Aggregate the log.
 *
 * `days` is a look-back window: 1 = the last day, 30 = the last month. `0` and
 * `undefined` both mean "no window — everything kept", which is what the
 * settings screen wants by default. `recent` caps the detail list for the
 * drawer.
 */
export function aiUsageSummary(
  db: Db,
  ws: string,
  opts: { days?: number; recent?: number } = {},
): AiUsageSummary {
  const since = opts.days ? Date.now() - opts.days * 86_400_000 : 0;
  const recentLimit = Math.max(1, Math.min(200, opts.recent ?? 25));

  const totals = db.get<TotalsRow>(
    `SELECT count(*) AS calls,
            sum(ok) AS ok,
            sum(1 - ok) AS failed,
            avg(ms) AS avg_ms,
            sum(prompt_tokens) AS prompt_tokens,
            sum(completion_tokens) AS completion_tokens,
            sum(chars) AS chars
     FROM ai_call
     WHERE ws = ? AND created_at >= ?`,
    ws,
    since,
  );

  const calls = totals?.calls ?? 0;

  const providers = db.all<ProviderRow>(
    `SELECT provider,
            count(*) AS calls,
            sum(1 - ok) AS failed,
            avg(ms) AS avg_ms,
            (SELECT model FROM ai_call b WHERE b.ws = a.ws AND b.provider = a.provider ORDER BY b.created_at DESC LIMIT 1) AS last_model,
            max(created_at) AS last_at
     FROM ai_call a
     WHERE ws = ? AND created_at >= ?
     GROUP BY provider
     ORDER BY calls DESC`,
    ws,
    since,
  );

  const recent = db.all<RecentRow>(
    `SELECT provider, model, action, ms, ok, prompt_tokens, completion_tokens, chars, created_at, error
     FROM ai_call
     WHERE ws = ? AND created_at >= ?
     ORDER BY created_at DESC
     LIMIT ?`,
    ws,
    since,
    recentLimit,
  );

  return {
    calls,
    ok: totals?.ok ?? 0,
    failed: totals?.failed ?? 0,
    avgMs: Math.round(totals?.avg_ms ?? 0),
    // SUM over an all-NULL column is NULL: that is "not reported", and it must
    // stay null rather than becoming a confident 0.
    promptTokens: totals?.prompt_tokens ?? null,
    completionTokens: totals?.completion_tokens ?? null,
    chars: totals?.chars ?? 0,
    byProvider: providers.map((p) => ({
      provider: p.provider,
      calls: p.calls,
      failed: p.failed,
      avgMs: Math.round(p.avg_ms ?? 0),
      lastModel: p.last_model ?? "",
      lastAt: p.last_at ?? 0,
    })),
    recent: recent.map((r) => ({
      provider: r.provider,
      model: r.model,
      action: r.action,
      ms: r.ms,
      ok: r.ok === 1,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      chars: r.chars,
      created_at: r.created_at,
      ...(r.error ? { error: r.error } : {}),
    })),
  };
}
