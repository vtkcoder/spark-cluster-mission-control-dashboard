// Postgres persistence for benchmark runs (Benchmarks tab).
// Reuses the shared cluster_dash pool from db.ts. One row per llama-benchy run.
import { pool } from "./db";
import type { BenchConfig, BenchResultJson, BenchRunSummary } from "./bench-types";
import { headlineThroughput } from "./bench-run";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bench_run (
  id          BIGSERIAL   PRIMARY KEY,
  node        TEXT        NOT NULL DEFAULT 'spark1',
  base_url    TEXT        NOT NULL,
  model       TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'running',
  config      JSONB       NOT NULL,
  result      JSONB,
  error       TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS bench_run_started_idx ON bench_run (started_at DESC);
`;

let schemaReady: Promise<void> | null = null;
export function ensureBenchSchema(): Promise<void> {
  if (!schemaReady) schemaReady = pool.query(SCHEMA_SQL).then(() => undefined);
  return schemaReady;
}

export interface BenchRunRow {
  id: number;
  node: string;
  base_url: string;
  model: string;
  status: string;
  config: BenchConfig;
  result: BenchResultJson | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

// Insert a new run in 'running' status; returns the new row id.
export async function createBenchRun(
  config: BenchConfig,
  node = "spark1",
): Promise<number> {
  await ensureBenchSchema();
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO bench_run (node, base_url, model, status, config)
     VALUES ($1,$2,$3,'running',$4) RETURNING id`,
    [node, config.baseUrl, config.model, JSON.stringify(config)],
  );
  return rows[0].id;
}

// Finalize a run: set status + result/error + finished_at.
export async function finishBenchRun(
  id: number,
  status: "done" | "error",
  result: BenchResultJson | null,
  error: string | null,
): Promise<void> {
  await ensureBenchSchema();
  await pool.query(
    `UPDATE bench_run
       SET status=$2, result=$3, error=$4, finished_at=now()
     WHERE id=$1`,
    [id, status, result ? JSON.stringify(result) : null, error],
  );
}

export async function getBenchRun(id: number): Promise<BenchRunRow | null> {
  await ensureBenchSchema();
  const { rows } = await pool.query<BenchRunRow>(
    `SELECT * FROM bench_run WHERE id=$1`,
    [id],
  );
  return rows[0] ?? null;
}

// List recent runs as lightweight summaries (no full result payload beyond what
// headline numbers need). Newest first.
export async function listBenchRuns(limit = 50): Promise<BenchRunSummary[]> {
  await ensureBenchSchema();
  const { rows } = await pool.query<BenchRunRow>(
    `SELECT id, node, base_url, model, status, config, result, error, started_at, finished_at
       FROM bench_run ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => {
    const { peakTgTs, peakPpTs } = headlineThroughput(r.result);
    return {
      id: r.id,
      node: r.node,
      base_url: r.base_url,
      model: r.model,
      status: r.status,
      config: r.config,
      started_at: r.started_at,
      finished_at: r.finished_at,
      peakTgTs,
      peakPpTs,
    };
  });
}

export async function deleteBenchRun(id: number): Promise<boolean> {
  await ensureBenchSchema();
  const res = await pool.query(`DELETE FROM bench_run WHERE id=$1`, [id]);
  return (res.rowCount ?? 0) > 0;
}

// Mark any stale 'running' rows as errored — used on route module load so a
// process restart mid-run doesn't leave zombie 'running' rows forever.
export async function reconcileStuckRuns(): Promise<void> {
  await ensureBenchSchema();
  await pool.query(
    `UPDATE bench_run
       SET status='error', error=COALESCE(error,'interrupted (dashboard restarted)'), finished_at=now()
     WHERE status='running'`,
  );
}
