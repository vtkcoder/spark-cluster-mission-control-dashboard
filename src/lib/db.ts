// Postgres access for cluster-dash (Model Manager metadata).
// System PG 16, local peer auth as `absolome` via socket. One DB per project.
import { Pool } from "pg";

const DEFAULT_URL =
  "postgresql://absolome@localhost:5432/cluster_dash?host=/var/run/postgresql";

// Reuse a single Pool across hot-reloads / requests.
const g = globalThis as unknown as { __clusterDashPool?: Pool };
export const pool: Pool =
  g.__clusterDashPool ??
  (g.__clusterDashPool = new Pool({
    connectionString: process.env.DATABASE_URL || DEFAULT_URL,
    max: 5,
  }));

export interface ModelMeta {
  node: string;
  model_id: string;
  display_name: string | null;
  tags: string[];
  rating: number | null;
  starred: boolean;
  notes: string | null;
  status: string; // 'keep' | 'archive' | 'candidate-delete'
  created_at: string;
  updated_at: string;
}

export interface ModelComment {
  id: number;
  node: string;
  model_id: string;
  author: string;
  body: string;
  created_at: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS model_meta (
  node         TEXT        NOT NULL DEFAULT 'spark1',
  model_id     TEXT        NOT NULL,
  display_name TEXT,
  tags         TEXT[]      NOT NULL DEFAULT '{}',
  rating       INT,
  starred      BOOLEAN     NOT NULL DEFAULT false,
  notes        TEXT,
  status       TEXT        NOT NULL DEFAULT 'keep',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (node, model_id)
);
CREATE TABLE IF NOT EXISTS model_comment (
  id         BIGSERIAL   PRIMARY KEY,
  node       TEXT        NOT NULL DEFAULT 'spark1',
  model_id   TEXT        NOT NULL,
  author     TEXT        NOT NULL DEFAULT 'operator',
  body       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_comment_model_idx ON model_comment (node, model_id, created_at);
CREATE TABLE IF NOT EXISTS model_event (
  id         BIGSERIAL   PRIMARY KEY,
  node       TEXT        NOT NULL DEFAULT 'spark1',
  model_id   TEXT        NOT NULL,
  action     TEXT        NOT NULL,
  detail     JSONB,
  status     TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_event_model_idx ON model_event (node, model_id, created_at);
`;

let schemaReady: Promise<void> | null = null;
export function ensureSchema(): Promise<void> {
  if (!schemaReady) schemaReady = pool.query(SCHEMA_SQL).then(() => undefined);
  return schemaReady;
}

export async function getMetaMap(node: string): Promise<Record<string, ModelMeta>> {
  await ensureSchema();
  const { rows } = await pool.query<ModelMeta>(
    "SELECT * FROM model_meta WHERE node=$1",
    [node],
  );
  const out: Record<string, ModelMeta> = {};
  for (const r of rows) out[r.model_id] = r;
  return out;
}

const META_COLS = ["display_name", "tags", "rating", "starred", "notes", "status"] as const;
type MetaCol = (typeof META_COLS)[number];

export async function upsertMeta(
  node: string,
  modelId: string,
  patch: Partial<Record<MetaCol, unknown>>,
): Promise<ModelMeta> {
  await ensureSchema();
  // Only update the columns present in `patch`; INSERT seeds defaults.
  const cols = META_COLS.filter((c) => c in patch);
  const insertCols = ["node", "model_id", ...cols];
  const values: unknown[] = [node, modelId, ...cols.map((c) => patch[c])];
  const placeholders = insertCols.map((_, i) => `$${i + 1}`);
  const updates = cols.map((c) => `${c}=EXCLUDED.${c}`);
  updates.push("updated_at=now()");
  const sql = `
    INSERT INTO model_meta (${insertCols.join(",")})
    VALUES (${placeholders.join(",")})
    ON CONFLICT (node, model_id) DO UPDATE SET ${updates.join(",")}
    RETURNING *`;
  const { rows } = await pool.query<ModelMeta>(sql, values);
  return rows[0];
}

export async function addComment(
  node: string,
  modelId: string,
  body: string,
  author = "operator",
): Promise<ModelComment> {
  await ensureSchema();
  const { rows } = await pool.query<ModelComment>(
    `INSERT INTO model_comment (node, model_id, author, body)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [node, modelId, author, body],
  );
  return rows[0];
}

export async function getComments(node: string, modelId: string): Promise<ModelComment[]> {
  await ensureSchema();
  const { rows } = await pool.query<ModelComment>(
    `SELECT * FROM model_comment WHERE node=$1 AND model_id=$2 ORDER BY created_at ASC, id ASC`,
    [node, modelId],
  );
  return rows;
}

export async function logEvent(
  node: string,
  modelId: string,
  action: string,
  status: string,
  detail?: object,
): Promise<number> {
  await ensureSchema();
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO model_event (node, model_id, action, status, detail)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [node, modelId, action, status, detail ?? null],
  );
  return rows[0].id;
}

export async function updateEvent(id: number, status: string, detail?: object): Promise<void> {
  await pool.query(`UPDATE model_event SET status=$2, detail=COALESCE($3, detail) WHERE id=$1`, [
    id,
    status,
    detail ?? null,
  ]);
}
