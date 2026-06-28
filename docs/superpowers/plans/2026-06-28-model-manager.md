# Model Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Model Manager tab to cluster-dash that scans spark1's HF model cache, enriches each model with facts/health/duplicate-grouping, stores editable metadata + comments + an action audit log in Postgres, investigates where each model is used, backs models up to an external drive, and deletes them with typed-name confirmation + safeguards.

**Architecture:** Thin Next.js App-Router API routes (`src/app/api/models/*`) over focused, independently-testable `src/lib` units (`db.ts`, `model-scan.ts`, `model-usage.ts`, `model-backup.ts`). The UI is one panel (`ModelManagerPanel.tsx`) plus small subcomponents, styled inline like the rest of the app. v1 reads spark1's local filesystem; every lib function takes a `node` arg so v2 can route the same calls over SSH.

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript, raw `pg` (node-postgres v8, no ORM), Postgres 16 (local peer auth), `vitest` for unit/integration tests, `du`/`rsync`/`lsblk`/`grep` via `child_process`.

## Global Constraints

- **Reference the spec:** `docs/superpowers/specs/2026-06-28-model-manager-design.md` — verbatim source of truth.
- **HF cache root:** `/home/absolome/.cache/huggingface/hub` (constant `HF_CACHE`).
- **DB:** database `cluster_dash`. Default connection string (used as fallback when `DATABASE_URL` unset): `postgresql://absolome@localhost:5432/cluster_dash?host=/var/run/postgresql`.
- **DB client:** raw `pg` Pool. No ORM. Tables keyed by `(node, model_id)`; every row carries `node` (default `'spark1'`).
- **Node default (v1):** `node = "spark1"`; all fs access is local.
- **Styling:** inline styles only, palette from `CLAUDE.md` (bg `#06090f`/`#0c1220`/`#0a1018`, borders `#1a2540`, text `#e2e8f0`/`#94a3b8`/`#475569`, accents green `#10b981`, blue `#3b82f6`, purple `#8b5cf6`, amber `#f59e0b`, red `#ef4444`, cyan `#22d3ee`). **Model Manager tab accent: teal `#14b8a6`** (active text `#2dd4bf`, inactive `#155e57`). Label `◆ MODELS`. Font sizes 9–11px labels / 14px headers, `fontFamily: "inherit"`.
- **Delete confirmation:** user must type the model's **short name** (last path segment of the repo id).
- **Backup unit:** full repo dir (`models--*`).
- **Safety:** delete operates on a single resolved absolute path asserted to start with `/home/absolome/.cache/huggingface/hub/models--`; never wildcards; never touches the running engine; refuse to delete the served model or one with a backup in flight.
- **No artificial caps in code** (user global rule). Usage-grep result caps exist only for UI responsiveness, are generous, and are reported via a `truncated` flag — not gatekeeping.
- **Build gate:** after code changes `npm run build` must exit 0, then `pm2 restart cluster-dash`.
- **Do NOT commit** `.env.local` or any host-specific data. Spec, plan, and code are committable. Commit messages end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Tests:** vitest. Pure-helper tests use **relative imports** (avoid the `@/` alias in tests). Integration tests that touch Postgres use `model_id` values prefixed `__test__/` and clean up after themselves.

---

## File Structure

| File | Responsibility |
|---|---|
| `vitest.config.ts` (create) | Minimal node-env vitest config. |
| `package.json` (modify) | Add `pg`, `@types/pg`, `vitest` + `test` script. |
| `.env.local` (create, git-ignored) | `DATABASE_URL` for cluster_dash. |
| `src/lib/db.ts` (create) | `pg.Pool` singleton, `ensureSchema()`, meta/comment/event query helpers. |
| `src/lib/model-scan.ts` (create) | HF cache scanner: pure fact/group/classify helpers + `scanModels()`. |
| `src/lib/model-usage.ts` (create) | `investigateUsage()` + grep helpers. |
| `src/lib/model-backup.ts` (create) | External-drive detection, `parseRsyncProgress()`, backup job registry. |
| `src/app/api/models/route.ts` (create) | `GET` — scan ⨝ DB meta + groups + served flag. |
| `src/app/api/models/usage/route.ts` (create) | `GET ?id=` — usage investigation. |
| `src/app/api/models/meta/route.ts` (create) | `POST` — upsert meta / add comment. |
| `src/app/api/models/delete/route.ts` (create) | `POST` — guarded delete. |
| `src/app/api/models/backup/route.ts` (create) | `GET` targets+status, `POST` start backup. |
| `src/lib/model-types.ts` (create) | Shared TS types reused by UI + routes. |
| `src/components/ModelManagerPanel.tsx` (create) | Top-level panel: summary, toolbar, list, drawer host. |
| `src/components/models/ModelRow.tsx` (create) | One model row (size bar, badges, meta). |
| `src/components/models/ModelTreemap.tsx` (create) | Proportional size bars by modality. |
| `src/components/models/ModelDetailDrawer.tsx` (create) | Facts, meta editor, comments, usage, actions. |
| `src/components/models/UsageReport.tsx` (create) | Renders usage hits. |
| `src/components/models/BackupDialog.tsx` (create) | Target picker + progress. |
| `src/app/page.tsx` (modify) | Register `"models"` tab + render block. |

---

## Task 1: Tooling, dependencies, and database

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `.env.local`
- Create: `src/lib/smoke.test.ts` (temporary smoke test, deleted at end of task)

**Interfaces:**
- Produces: a working `npx vitest run`; the `cluster_dash` database; `DATABASE_URL` in env.

- [ ] **Step 1: Install dependencies**

Run:
```bash
cd /home/absolome/sites/cluster-dash
npm install pg@^8
npm install -D @types/pg vitest
```
Expected: installs succeed; `package.json` now lists `pg` under dependencies and `@types/pg`, `vitest` under devDependencies.

- [ ] **Step 2: Add the test script**

Modify `package.json` `scripts` to add:
```json
"test": "vitest run"
```
(Keep existing `dev`, `build`, `start`, `lint`.)

- [ ] **Step 3: Create vitest config**

Create `vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration tests touch the local Postgres / filesystem; run serially
    // to avoid cross-test interference on shared resources.
    fileParallelism: false,
  },
});
```

- [ ] **Step 4: Create the database**

Run:
```bash
createdb cluster_dash 2>&1 || psql -U absolome -d postgres -c "CREATE DATABASE cluster_dash;"
psql -U absolome -d cluster_dash -tAc "select current_database();"
```
Expected: prints `cluster_dash`.

- [ ] **Step 5: Create `.env.local` (git-ignored)**

Create `.env.local`:
```
DATABASE_URL=postgresql://absolome@localhost:5432/cluster_dash?host=/var/run/postgresql
```
Verify it is ignored:
```bash
git check-ignore .env.local
```
Expected: prints `.env.local`.

- [ ] **Step 6: Write a smoke test**

Create `src/lib/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";

describe("vitest smoke", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 7: Run the smoke test**

Run: `npx vitest run src/lib/smoke.test.ts`
Expected: 1 passing test.

- [ ] **Step 8: Delete the smoke test, then commit**

```bash
rm src/lib/smoke.test.ts
git add package.json package-lock.json vitest.config.ts
git commit -m "chore(models): add pg + vitest tooling and cluster_dash db

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
(Do not add `.env.local` — it is git-ignored.)

---

## Task 2: Database module (`src/lib/db.ts`)

**Files:**
- Create: `src/lib/db.ts`
- Test: `src/lib/db.test.ts`

**Interfaces:**
- Produces:
  - `pool: pg.Pool`
  - `ensureSchema(): Promise<void>` — idempotent, runs once per process.
  - `getMetaMap(node: string): Promise<Record<string, ModelMeta>>` — keyed by `model_id`.
  - `upsertMeta(node: string, modelId: string, patch: Partial<ModelMeta>): Promise<ModelMeta>`
  - `addComment(node: string, modelId: string, body: string, author?: string): Promise<ModelComment>`
  - `getComments(node: string, modelId: string): Promise<ModelComment[]>`
  - `logEvent(node, modelId, action, status, detail?): Promise<number>` (returns event id)
  - `updateEvent(id: number, status: string, detail?: object): Promise<void>`
  - Types `ModelMeta`, `ModelComment` (also re-exported from `model-types.ts` in Task 5's setup; defined here authoritatively).

- [ ] **Step 1: Write the failing test**

Create `src/lib/db.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureSchema, upsertMeta, getMetaMap, addComment, getComments, logEvent, updateEvent, pool } from "./db";

const NODE = "spark1";
const MID = "__test__/db-model";

beforeAll(async () => {
  await ensureSchema();
  await pool.query("DELETE FROM model_meta WHERE model_id LIKE '__test__/%'");
  await pool.query("DELETE FROM model_comment WHERE model_id LIKE '__test__/%'");
  await pool.query("DELETE FROM model_event WHERE model_id LIKE '__test__/%'");
});

afterAll(async () => {
  await pool.query("DELETE FROM model_meta WHERE model_id LIKE '__test__/%'");
  await pool.query("DELETE FROM model_comment WHERE model_id LIKE '__test__/%'");
  await pool.query("DELETE FROM model_event WHERE model_id LIKE '__test__/%'");
  await pool.end();
});

describe("db meta", () => {
  it("upserts and reads metadata", async () => {
    const m = await upsertMeta(NODE, MID, { starred: true, tags: ["a", "b"], rating: 4, status: "keep" });
    expect(m.starred).toBe(true);
    expect(m.tags).toEqual(["a", "b"]);
    const map = await getMetaMap(NODE);
    expect(map[MID].rating).toBe(4);
  });

  it("merges patches without clobbering unset fields", async () => {
    await upsertMeta(NODE, MID, { notes: "hello" });
    const map = await getMetaMap(NODE);
    expect(map[MID].notes).toBe("hello");
    expect(map[MID].starred).toBe(true); // preserved from previous upsert
  });

  it("stores comments newest-last", async () => {
    await addComment(NODE, MID, "first");
    await addComment(NODE, MID, "second");
    const cs = await getComments(NODE, MID);
    expect(cs.map((c) => c.body)).toEqual(["first", "second"]);
  });

  it("logs and updates events", async () => {
    const id = await logEvent(NODE, MID, "backup", "started", { target: "/mnt/x" });
    await updateEvent(id, "success", { bytes: 123 });
    const { rows } = await pool.query("SELECT status, detail FROM model_event WHERE id=$1", [id]);
    expect(rows[0].status).toBe("success");
    expect(rows[0].detail.bytes).toBe(123);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/db.test.ts`
Expected: FAIL — cannot resolve `./db` / functions undefined.

- [ ] **Step 3: Implement `src/lib/db.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/db.test.ts`
Expected: 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db.ts src/lib/db.test.ts
git commit -m "feat(models): postgres data layer for model metadata

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Scan pure helpers (`src/lib/model-scan.ts` — part 1)

**Files:**
- Create: `src/lib/model-scan.ts` (pure helpers only this task)
- Test: `src/lib/model-scan.helpers.test.ts`

**Interfaces:**
- Produces (pure, no I/O):
  - `HF_CACHE: string` constant.
  - `cacheKeyToModelId(cacheKey: string): string`
  - `shortName(modelId: string): string`
  - `normalizeBaseKey(modelId: string): string`
  - `classifyModality(cfgFiles: ConfigFiles): Modality`
  - `parseFacts(cfgFiles: ConfigFiles): ModelFacts`
  - Types `Modality`, `ModelFacts`, `ConfigFiles`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `src/lib/model-scan.helpers.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { cacheKeyToModelId, shortName, normalizeBaseKey, classifyModality, parseFacts } from "./model-scan";

describe("id helpers", () => {
  it("converts cache key to model id", () => {
    expect(cacheKeyToModelId("models--Qwen--Qwen3-Coder-Next-FP8")).toBe("Qwen/Qwen3-Coder-Next-FP8");
  });
  it("extracts short name", () => {
    expect(shortName("Qwen/Qwen3-235B-A22B-Instruct-2507-FP8")).toBe("Qwen3-235B-A22B-Instruct-2507-FP8");
  });
});

describe("normalizeBaseKey groups variants", () => {
  it("groups the MiniMax-M2.7 family", () => {
    const a = normalizeBaseKey("MiniMaxAI/MiniMax-M2.7");
    const b = normalizeBaseKey("saricles/MiniMax-M2.7-NVFP4-GB10");
    const c = normalizeBaseKey("saricles/MiniMax-M2.7-REAP-172B-A10B-NVFP4-GB10");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
  it("groups Qwen3-235B quant variants", () => {
    expect(normalizeBaseKey("Qwen/Qwen3-235B-A22B-Instruct-2507-FP8"))
      .toBe(normalizeBaseKey("NVFP4/Qwen3-235B-A22B-Instruct-2507-FP4"));
  });
  it("keeps unrelated models distinct", () => {
    expect(normalizeBaseKey("openai/gpt-oss-120b")).not.toBe(normalizeBaseKey("Qwen/Qwen3-Coder-Next-FP8"));
  });
});

describe("classifyModality", () => {
  it("detects audio (whisper)", () => {
    expect(classifyModality({ config: { model_type: "whisper" } })).toBe("audio");
  });
  it("detects image-gen (diffusion model_index)", () => {
    expect(classifyModality({ modelIndex: { _class_name: "FluxPipeline" } })).toBe("image-gen");
  });
  it("detects vision when a preprocessor exists", () => {
    expect(classifyModality({ config: { model_type: "qwen2_vl" }, preprocessor: { image_processor_type: "x" } })).toBe("vision");
  });
  it("defaults to text", () => {
    expect(classifyModality({ config: { model_type: "qwen2" } })).toBe("text");
  });
});

describe("parseFacts", () => {
  it("reads arch, quant, context", () => {
    const f = parseFacts({
      config: {
        architectures: ["Qwen3MoeForCausalLM"],
        model_type: "qwen3_moe",
        max_position_embeddings: 262144,
        quantization_config: { quant_method: "fp8" },
      },
    });
    expect(f.arch).toBe("Qwen3MoeForCausalLM");
    expect(f.modelType).toBe("qwen3_moe");
    expect(f.contextLen).toBe(262144);
    expect(f.quant).toBe("FP8");
  });
  it("infers quant from name when config lacks it", () => {
    const f = parseFacts({ config: { architectures: ["X"] }, nameHint: "GLM-5.2-NVFP4-REAP-469B" });
    expect(f.quant).toBe("NVFP4");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/model-scan.helpers.test.ts`
Expected: FAIL — module/functions undefined.

- [ ] **Step 3: Implement the pure helpers**

Create `src/lib/model-scan.ts`:
```ts
// HF cache scanner for the Model Manager. Pure helpers + scanModels() (Task 4).
export const HF_CACHE = "/home/absolome/.cache/huggingface/hub";

export type Modality = "text" | "vision" | "audio" | "image-gen" | "unknown";

export interface ConfigFiles {
  config?: Record<string, unknown> | null;
  generation?: Record<string, unknown> | null;
  preprocessor?: Record<string, unknown> | null;
  processor?: Record<string, unknown> | null;
  modelIndex?: Record<string, unknown> | null; // diffusers model_index.json
  nameHint?: string; // model short name, for quant inference
}

export interface ModelFacts {
  arch: string | null;
  modelType: string | null;
  contextLen: number | null;
  quant: string | null;
  dtype: string | null;
}

export function cacheKeyToModelId(cacheKey: string): string {
  const withoutPrefix = cacheKey.slice("models--".length);
  const idx = withoutPrefix.indexOf("--");
  if (idx === -1) return withoutPrefix;
  return withoutPrefix.slice(0, idx) + "/" + withoutPrefix.slice(idx + 2);
}

export function shortName(modelId: string): string {
  return modelId.split("/").pop() ?? modelId;
}

// Tokens stripped to collapse quant/variant siblings into one group key.
const VARIANT_TOKENS = [
  "NVFP4", "MXFP4", "FP8", "FP4", "BF16", "FP16", "INT8", "INT4", "AWQ", "GPTQ", "GGUF",
  "REAP", "GB10", "INSTRUCT", "CHAT", "BASE",
];

export function normalizeBaseKey(modelId: string): string {
  let s = shortName(modelId).toUpperCase();
  // Drop date stamps like -2507 and param-size tags like -469B / -A22B / -A10B / -172B.
  s = s.replace(/-\d{3,4}(?=($|-))/g, "");           // 2507 date-ish
  s = s.replace(/-A?\d+(\.\d+)?B(?=($|-))/g, "");     // 235B, A22B, 172B, A10B
  for (const t of VARIANT_TOKENS) {
    s = s.replace(new RegExp(`-?${t}(?=($|-))`, "g"), "");
  }
  s = s.replace(/--+/g, "-").replace(/^-|-$/g, "");
  return s;
}

const QUANT_NAME_PATTERNS: [RegExp, string][] = [
  [/NVFP4/i, "NVFP4"],
  [/MXFP4/i, "MXFP4"],
  [/FP8/i, "FP8"],
  [/FP4/i, "FP4"],
  [/AWQ/i, "AWQ"],
  [/GPTQ/i, "GPTQ"],
  [/GGUF/i, "GGUF"],
];

export function classifyModality(c: ConfigFiles): Modality {
  if (c.modelIndex) return "image-gen";
  const mt = String((c.config?.model_type as string) ?? "").toLowerCase();
  const arch = ((c.config?.architectures as string[]) ?? []).join(" ").toLowerCase();
  if (mt.includes("whisper") || mt.includes("wav2vec") || arch.includes("whisper")) return "audio";
  if (
    c.preprocessor ||
    mt.includes("vl") || mt.includes("vision") || mt.includes("clip") ||
    arch.includes("vision") || arch.includes("vl")
  )
    return "vision";
  if (c.config) return "text";
  return "unknown";
}

export function parseFacts(c: ConfigFiles): ModelFacts {
  const cfg = c.config ?? {};
  const arch = Array.isArray(cfg.architectures) && cfg.architectures.length
    ? String((cfg.architectures as string[])[0])
    : null;
  const modelType = cfg.model_type ? String(cfg.model_type) : null;
  const contextLen =
    typeof cfg.max_position_embeddings === "number"
      ? (cfg.max_position_embeddings as number)
      : null;
  const dtype = cfg.torch_dtype ? String(cfg.torch_dtype) : null;

  let quant: string | null = null;
  const qc = cfg.quantization_config as Record<string, unknown> | undefined;
  if (qc?.quant_method) quant = String(qc.quant_method).toUpperCase();
  if (!quant && c.nameHint) {
    for (const [re, label] of QUANT_NAME_PATTERNS) if (re.test(c.nameHint)) { quant = label; break; }
  }
  return { arch, modelType, contextLen, quant, dtype };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/model-scan.helpers.test.ts`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-scan.ts src/lib/model-scan.helpers.test.ts
git commit -m "feat(models): pure scan helpers (id/group/modality/facts)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Filesystem scanner (`scanModels` + `groupDuplicates`)

**Files:**
- Modify: `src/lib/model-scan.ts` (append fs functions)
- Test: `src/lib/model-scan.fs.test.ts`

**Interfaces:**
- Consumes: helpers from Task 3.
- Produces:
  - `type Health = "ready" | "downloading" | "incomplete" | "stub" | "broken"`
  - `interface ScannedModel { node; id; org; name; sizeBytes; modality; arch; modelType; paramCountB; quant; contextLen; dtype; health; healthDetail; snapshotHash; mtime; groupKey; served }`
  - `scanModels(cacheRoot?: string, node?: string): ScannedModel[]`
  - `interface ModelGroup { key; members: ScannedModel[]; totalBytes; redundantBytes; unique }`
  - `groupDuplicates(models: ScannedModel[]): ModelGroup[]`

- [ ] **Step 1: Write the failing test (fixture-based)**

Create `src/lib/model-scan.fs.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanModels, groupDuplicates } from "./model-scan";

let root: string;

function makeModel(
  cacheKey: string,
  opts: { config?: object; sizeBytes?: number; incomplete?: boolean; hash?: string },
) {
  const dir = join(root, cacheKey);
  const hash = opts.hash ?? "abc123";
  const snap = join(dir, "snapshots", hash);
  const blobs = join(dir, "blobs");
  mkdirSync(snap, { recursive: true });
  mkdirSync(blobs, { recursive: true });
  mkdirSync(join(dir, "refs"), { recursive: true });
  writeFileSync(join(dir, "refs", "main"), hash);
  if (opts.config) writeFileSync(join(snap, "config.json"), JSON.stringify(opts.config));
  // a blob file sized to opts.sizeBytes (approx) to exercise du
  const size = opts.sizeBytes ?? 1024;
  writeFileSync(join(blobs, "weight.bin"), Buffer.alloc(size));
  if (opts.incomplete) writeFileSync(join(blobs, "part.incomplete"), Buffer.alloc(10));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hfcache-"));
  makeModel("models--Qwen--Qwen3-235B-A22B-Instruct-2507-FP8", {
    config: { architectures: ["Qwen3MoeForCausalLM"], model_type: "qwen3_moe", max_position_embeddings: 4096, quantization_config: { quant_method: "fp8" } },
    sizeBytes: 200_000,
  });
  makeModel("models--NVFP4--Qwen3-235B-A22B-Instruct-2507-FP4", {
    config: { architectures: ["Qwen3MoeForCausalLM"], model_type: "qwen3_moe" },
    sizeBytes: 120_000,
  });
  makeModel("models--openai--gpt-oss-120b", {
    config: { architectures: ["GptOssForCausalLM"], model_type: "gpt_oss" },
    sizeBytes: 60_000,
  });
  makeModel("models--bad--downloading", {
    config: { architectures: ["X"] }, sizeBytes: 5_000, incomplete: true,
  });
  // stub: config present but tiny (weights missing)
  makeModel("models--stub--tiny", { config: { architectures: ["X"] }, sizeBytes: 100 });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("scanModels", () => {
  it("finds every model dir", () => {
    const ms = scanModels(root, "spark1");
    expect(ms.length).toBe(5);
  });
  it("parses facts and marks health", () => {
    const ms = scanModels(root, "spark1");
    const q = ms.find((m) => m.id === "Qwen/Qwen3-235B-A22B-Instruct-2507-FP8")!;
    expect(q.quant).toBe("FP8");
    expect(q.contextLen).toBe(4096);
    expect(q.health).toBe("ready");
    const dl = ms.find((m) => m.id === "bad/downloading")!;
    expect(dl.health).toBe("downloading");
    const stub = ms.find((m) => m.id === "stub/tiny")!;
    expect(stub.health).toBe("stub");
  });
});

describe("groupDuplicates", () => {
  it("groups the two Qwen3-235B quants and flags redundancy", () => {
    const groups = groupDuplicates(scanModels(root, "spark1"));
    const qGroup = groups.find((g) => g.members.length === 2 && g.members.every((m) => m.name.includes("Qwen3-235B")));
    expect(qGroup).toBeTruthy();
    expect(qGroup!.redundantBytes).toBeGreaterThan(0);
    expect(qGroup!.unique).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/model-scan.fs.test.ts`
Expected: FAIL — `scanModels`/`groupDuplicates` undefined.

- [ ] **Step 3: Append fs functions to `src/lib/model-scan.ts`**

Add these imports at the **top** of the file (above the existing constant):
```ts
import { readdirSync, existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
```

Append at the **end** of the file:
```ts
export type Health = "ready" | "downloading" | "incomplete" | "stub" | "broken";

export interface ScannedModel {
  node: string;
  id: string;
  org: string;
  name: string;
  sizeBytes: number;
  modality: Modality;
  arch: string | null;
  modelType: string | null;
  paramCountB: number | null;
  quant: string | null;
  contextLen: number | null;
  dtype: string | null;
  health: Health;
  healthDetail: string;
  snapshotHash: string | null;
  mtime: number;
  groupKey: string;
  served: boolean;
}

const STUB_MAX_BYTES = 50 * 1024 * 1024; // <50MB with a config = weights missing

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function resolveSnapshotDir(dir: string): { snapDir: string | null; hash: string | null } {
  const snapshotsRoot = join(dir, "snapshots");
  if (!existsSync(snapshotsRoot)) return { snapDir: null, hash: null };
  // Prefer the hash named in refs/main.
  const refPath = join(dir, "refs", "main");
  let hash: string | null = null;
  try {
    hash = readFileSync(refPath, "utf8").trim() || null;
  } catch { /* no ref */ }
  if (hash && existsSync(join(snapshotsRoot, hash))) return { snapDir: join(snapshotsRoot, hash), hash };
  // Fallback: newest snapshot subdir.
  try {
    const subs = readdirSync(snapshotsRoot)
      .map((s) => ({ s, t: statSync(join(snapshotsRoot, s)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (subs.length) return { snapDir: join(snapshotsRoot, subs[0].s), hash: subs[0].s };
  } catch { /* none */ }
  return { snapDir: null, hash };
}

function dirBytes(path: string): number {
  try {
    const out = execSync(`du -sb '${path}' 2>/dev/null`, { timeout: 30000 }).toString();
    return parseInt(out.split("\t")[0]) || 0;
  } catch {
    return 0;
  }
}

function blobHealth(dir: string): { incomplete: number; complete: number } {
  const blobsDir = join(dir, "blobs");
  if (!existsSync(blobsDir)) return { incomplete: 0, complete: 0 };
  let incomplete = 0, complete = 0;
  for (const f of readdirSync(blobsDir)) {
    if (f.endsWith(".incomplete")) {
      try { if (statSync(join(blobsDir, f)).size > 0) incomplete++; } catch { /* skip */ }
    } else complete++;
  }
  return { incomplete, complete };
}

export function scanModels(cacheRoot: string = HF_CACHE, node = "spark1"): ScannedModel[] {
  let dirs: string[] = [];
  try {
    dirs = readdirSync(cacheRoot).filter((d) => d.startsWith("models--"));
  } catch {
    return [];
  }

  return dirs.map((cacheKey) => {
    const id = cacheKeyToModelId(cacheKey);
    const dir = join(cacheRoot, cacheKey);
    const name = shortName(id);
    const org = id.includes("/") ? id.split("/")[0] : "";
    const { snapDir, hash } = resolveSnapshotDir(dir);

    const cfgFiles: ConfigFiles = { nameHint: name };
    if (snapDir) {
      cfgFiles.config = readJson(join(snapDir, "config.json"));
      cfgFiles.generation = readJson(join(snapDir, "generation_config.json"));
      cfgFiles.preprocessor = readJson(join(snapDir, "preprocessor_config.json"));
      cfgFiles.processor = readJson(join(snapDir, "processor_config.json"));
      cfgFiles.modelIndex = readJson(join(snapDir, "model_index.json"));
    }

    const facts = parseFacts(cfgFiles);
    const modality = classifyModality(cfgFiles);
    const sizeBytes = dirBytes(dir);
    const { incomplete, complete } = blobHealth(dir);
    const hasConfig = !!cfgFiles.config || !!cfgFiles.modelIndex;

    let health: Health;
    let healthDetail: string;
    if (incomplete > 0) {
      health = "downloading";
      healthDetail = `${incomplete} blob(s) still downloading`;
    } else if (hasConfig && sizeBytes < STUB_MAX_BYTES) {
      health = "stub";
      healthDetail = "config present but weights missing";
    } else if (complete === 0 && !hasConfig) {
      health = "incomplete";
      healthDetail = "no complete blobs and no config";
    } else if (!snapDir) {
      health = "broken";
      healthDetail = "no resolvable snapshot";
    } else {
      health = "ready";
      healthDetail = "complete";
    }

    let mtime = 0;
    try { mtime = statSync(dir).mtimeMs; } catch { /* keep 0 */ }

    // Approx param count (billions) from total size: bytes/bytesPerParam.
    // FP8/FP4≈1 byte, BF16≈2. Heuristic only; null when size unknown.
    let paramCountB: number | null = null;
    if (sizeBytes > 0 && health === "ready") {
      const bpp = facts.quant && /FP4|NVFP4|MXFP4/.test(facts.quant) ? 0.5
        : facts.quant === "FP8" ? 1
        : facts.dtype && /16/.test(facts.dtype) ? 2 : 1;
      paramCountB = Math.round((sizeBytes / bpp / 1e9) * 10) / 10;
    }

    return {
      node, id, org, name, sizeBytes, modality,
      arch: facts.arch, modelType: facts.modelType, paramCountB,
      quant: facts.quant, contextLen: facts.contextLen, dtype: facts.dtype,
      health, healthDetail, snapshotHash: hash, mtime,
      groupKey: normalizeBaseKey(id), served: false,
    };
  });
}

export interface ModelGroup {
  key: string;
  members: ScannedModel[];
  totalBytes: number;
  redundantBytes: number;
  unique: boolean;
}

export function groupDuplicates(models: ScannedModel[]): ModelGroup[] {
  const byKey = new Map<string, ScannedModel[]>();
  for (const m of models) {
    const arr = byKey.get(m.groupKey) ?? [];
    arr.push(m);
    byKey.set(m.groupKey, arr);
  }
  const groups: ModelGroup[] = [];
  for (const [key, members] of byKey) {
    const totalBytes = members.reduce((s, m) => s + m.sizeBytes, 0);
    const largest = members.reduce((mx, m) => Math.max(mx, m.sizeBytes), 0);
    groups.push({
      key, members,
      totalBytes,
      redundantBytes: members.length > 1 ? totalBytes - largest : 0,
      unique: members.length === 1,
    });
  }
  return groups.sort((a, b) => b.totalBytes - a.totalBytes);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/model-scan.fs.test.ts`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-scan.ts src/lib/model-scan.fs.test.ts
git commit -m "feat(models): filesystem scanner + duplicate grouping

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Shared types + GET /api/models route

**Files:**
- Create: `src/lib/model-types.ts`
- Create: `src/app/api/models/route.ts`
- Test: manual curl (route uses real fs/engine/DB; covered by integration check).

**Interfaces:**
- Consumes: `scanModels`, `groupDuplicates` (Task 4); `getMetaMap` (Task 2); `detectEngine`, `getEngineModels`, `HEAD_HOST`, `API_PORT` (engine.ts).
- Produces:
  - `model-types.ts` re-exports `ScannedModel`, `ModelGroup`, `Modality`, `Health`, `ModelMeta`, `ModelComment`, plus `interface ModelsResponse { node; generatedAt; totalBytes; reclaimableBytes; servedModelId; models: ModelWithMeta[]; groups: ModelGroup[] }` and `type ModelWithMeta = ScannedModel & { meta: ModelMeta | null }`.
  - `GET /api/models` → `ModelsResponse`.

- [ ] **Step 1: Create shared types**

Create `src/lib/model-types.ts`:
```ts
export type { Modality, Health, ScannedModel, ModelGroup } from "./model-scan";
export type { ModelMeta, ModelComment } from "./db";
import type { ScannedModel, ModelGroup } from "./model-scan";
import type { ModelMeta } from "./db";

export type ModelWithMeta = ScannedModel & { meta: ModelMeta | null };

export interface ModelsResponse {
  node: string;
  generatedAt: number;
  totalBytes: number;
  reclaimableBytes: number;
  servedModelId: string | null;
  models: ModelWithMeta[];
  groups: ModelGroup[];
}
```

- [ ] **Step 2: Implement the route**

Create `src/app/api/models/route.ts`:
```ts
import { NextResponse } from "next/server";
import { scanModels, groupDuplicates } from "@/lib/model-scan";
import { getMetaMap } from "@/lib/db";
import { detectEngine, getEngineModels, HEAD_HOST, API_PORT } from "@/lib/engine";
import type { ModelsResponse, ModelWithMeta } from "@/lib/model-types";

export const dynamic = "force-dynamic";
const NODE = "spark1";

export async function GET() {
  try {
    // Filesystem scan + DB meta + live served-model detection, in parallel where possible.
    const models = scanModels(undefined, NODE);
    const [metaMap, served] = await Promise.all([
      getMetaMap(NODE).catch(() => ({})),     // DB optional: scan still works without it
      detectServed().catch(() => null),
    ]);

    for (const m of models) {
      if (served && (m.id === served || m.name === served.split("/").pop())) m.served = true;
    }

    const withMeta: ModelWithMeta[] = models
      .map((m) => ({ ...m, meta: (metaMap as Record<string, import("@/lib/db").ModelMeta>)[m.id] ?? null }))
      .sort((a, b) => b.sizeBytes - a.sizeBytes);

    const groups = groupDuplicates(models);
    const totalBytes = models.reduce((s, m) => s + m.sizeBytes, 0);
    const reclaimableBytes =
      groups.reduce((s, g) => s + g.redundantBytes, 0) +
      models.filter((m) => m.health === "stub" || m.health === "broken").reduce((s, m) => s + m.sizeBytes, 0);

    const body: ModelsResponse = {
      node: NODE, generatedAt: Date.now(),
      totalBytes, reclaimableBytes, servedModelId: served,
      models: withMeta, groups,
    };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

async function detectServed(): Promise<string | null> {
  const eng = await detectEngine();
  if (eng.type === "none") return null;
  const m = await getEngineModels(HEAD_HOST, API_PORT);
  return m?.model ?? null;
}
```

- [ ] **Step 3: Build, restart, verify**

Run:
```bash
npm run build && pm2 restart cluster-dash
sleep 3
curl -s http://localhost:3099/api/models | python3 -c "import sys,json; d=json.load(sys.stdin); print('models:', len(d['models']), 'totalGB:', round(d['totalBytes']/1e9,1), 'reclaimableGB:', round(d['reclaimableBytes']/1e9,1), 'served:', d['servedModelId'])"
```
Expected: `models: 14` (or current count), a multi-hundred-GB total, a non-empty served id if the engine is up (else `None`).

- [ ] **Step 4: Commit**

```bash
git add src/lib/model-types.ts src/app/api/models/route.ts
git commit -m "feat(models): GET /api/models scan+meta+served endpoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Usage investigation lib (`src/lib/model-usage.ts`)

**Files:**
- Create: `src/lib/model-usage.ts`
- Test: `src/lib/model-usage.test.ts`

**Interfaces:**
- Consumes: `shortName` (model-scan); `detectEngine`, `getEngineModels`, `HEAD_HOST`, `API_PORT` (engine.ts).
- Produces:
  - `interface UsageHit { source: "engine" | "script" | "config"; path: string; line: number | null; excerpt: string }`
  - `interface UsageReport { modelId: string; hits: UsageHit[]; truncated: boolean }`
  - `grepHits(term: string, roots: string[], source, opts): UsageHit[]` (exported for test)
  - `investigateUsage(modelId: string, node?: string): Promise<UsageReport>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/model-usage.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { grepHits } from "./model-usage";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "usage-"));
  mkdirSync(join(root, "research"), { recursive: true });
  writeFileSync(join(root, "research", "run-x.sh"), "vllm serve Qwen/Qwen3-Coder-Next-FP8 --port 30000\n");
  writeFileSync(join(root, "research", "other.sh"), "echo nothing here\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("grepHits", () => {
  it("finds the model id in scripts", () => {
    const hits = grepHits("Qwen/Qwen3-Coder-Next-FP8", [join(root, "research")], "script", { max: 50 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toContain("run-x.sh");
    expect(hits[0].excerpt).toContain("vllm serve");
  });
  it("returns nothing for an absent term", () => {
    const hits = grepHits("NoSuchModelXYZ", [join(root, "research")], "script", { max: 50 });
    expect(hits.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/model-usage.test.ts`
Expected: FAIL — `grepHits` undefined.

- [ ] **Step 3: Implement `src/lib/model-usage.ts`**

```ts
import { execSync } from "child_process";
import { shortName } from "./model-scan";
import { detectEngine, getEngineModels, HEAD_HOST, API_PORT } from "./engine";

export interface UsageHit {
  source: "engine" | "script" | "config";
  path: string;
  line: number | null;
  excerpt: string;
}
export interface UsageReport {
  modelId: string;
  hits: UsageHit[];
  truncated: boolean;
}

const SCRIPT_ROOTS = ["/home/absolome/research"];
const CONFIG_ROOTS = ["/home/absolome/sites"];
// Generous cap purely to keep the response/UI snappy — reported via `truncated`.
const MAX_HITS_PER_SOURCE = 200;

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

export function grepHits(
  term: string,
  roots: string[],
  source: UsageHit["source"],
  opts: { max: number },
): UsageHit[] {
  const existing = roots.filter((r) => {
    try { execSync(`test -d '${shellEscape(r)}'`); return true; } catch { return false; }
  });
  if (!existing.length) return [];
  const excludes = [
    "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=.next",
    "--exclude-dir=.cache", "--exclude-dir=dist", "--exclude-dir=build",
  ].join(" ");
  // -R recursive, -n line numbers, -I skip binary, -F fixed string.
  const cmd =
    `grep -RnI -F ${excludes} -- '${shellEscape(term)}' ` +
    existing.map((r) => `'${shellEscape(r)}'`).join(" ") +
    ` 2>/dev/null | head -n ${opts.max + 1} || true`;
  let out = "";
  try { out = execSync(cmd, { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }).toString(); } catch { return []; }
  const lines = out.split("\n").filter(Boolean);
  return lines.slice(0, opts.max).map((l) => {
    // format: path:lineno:content
    const first = l.indexOf(":");
    const second = l.indexOf(":", first + 1);
    const path = l.slice(0, first);
    const lineNo = parseInt(l.slice(first + 1, second));
    const excerpt = l.slice(second + 1).trim().slice(0, 240);
    return { source, path, line: isNaN(lineNo) ? null : lineNo, excerpt };
  });
}

export async function investigateUsage(modelId: string, _node = "spark1"): Promise<UsageReport> {
  const name = shortName(modelId);
  const hits: UsageHit[] = [];
  let truncated = false;

  // 1) Live engine
  try {
    const eng = await detectEngine();
    if (eng.type !== "none") {
      const served = await getEngineModels(HEAD_HOST, API_PORT);
      if (served && (served.model === modelId || served.model.split("/").pop() === name)) {
        hits.push({
          source: "engine",
          path: `${eng.label} @ ${HEAD_HOST}:${API_PORT}`,
          line: null,
          excerpt: `Currently served by the live ${eng.label} cluster (${eng.parallel})`,
        });
      }
    }
  } catch { /* engine optional */ }

  // 2) Launch scripts + 3) project configs. Search id and short name, dedupe.
  const terms = Array.from(new Set([modelId, name]));
  const collect = (roots: string[], source: UsageHit["source"]) => {
    const seen = new Set<string>();
    for (const t of terms) {
      const found = grepHits(t, roots, source, { max: MAX_HITS_PER_SOURCE });
      if (found.length >= MAX_HITS_PER_SOURCE) truncated = true;
      for (const h of found) {
        const k = `${h.path}:${h.line}`;
        if (!seen.has(k)) { seen.add(k); hits.push(h); }
      }
    }
  };
  collect(SCRIPT_ROOTS, "script");
  collect(CONFIG_ROOTS, "config");

  return { modelId, hits, truncated };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/model-usage.test.ts`
Expected: passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-usage.ts src/lib/model-usage.test.ts
git commit -m "feat(models): usage investigation (engine/scripts/configs)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: GET /api/models/usage route

**Files:**
- Create: `src/app/api/models/usage/route.ts`

**Interfaces:**
- Consumes: `investigateUsage` (Task 6).
- Produces: `GET /api/models/usage?id=<modelId>` → `UsageReport`.

- [ ] **Step 1: Implement the route**

Create `src/app/api/models/usage/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { investigateUsage } from "@/lib/model-usage";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    const report = await investigateUsage(id, "spark1");
    return NextResponse.json(report);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Build, restart, verify**

Run:
```bash
npm run build && pm2 restart cluster-dash && sleep 3
curl -s "http://localhost:3099/api/models/usage?id=Qwen/Qwen3-Coder-Next-FP8" | python3 -c "import sys,json; d=json.load(sys.stdin); print('hits:', len(d['hits']), 'truncated:', d['truncated']); [print(' ', h['source'], h['path']) for h in d['hits'][:5]]"
```
Expected: prints hit count (may be 0 if unreferenced); no error.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/models/usage/route.ts
git commit -m "feat(models): GET /api/models/usage endpoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: POST /api/models/meta route

**Files:**
- Create: `src/app/api/models/meta/route.ts`

**Interfaces:**
- Consumes: `upsertMeta`, `addComment`, `getComments`, `getMetaMap` (Task 2).
- Produces: `POST /api/models/meta` accepting `{ modelId, patch?, comment? }` → `{ meta, comments }`; `GET /api/models/meta?id=` → `{ meta, comments }`.

- [ ] **Step 1: Implement the route**

Create `src/app/api/models/meta/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { upsertMeta, addComment, getComments, getMetaMap } from "@/lib/db";

export const dynamic = "force-dynamic";
const NODE = "spark1";

const ALLOWED = ["display_name", "tags", "rating", "starred", "notes", "status"] as const;

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const [map, comments] = await Promise.all([getMetaMap(NODE), getComments(NODE, id)]);
  return NextResponse.json({ meta: map[id] ?? null, comments });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      modelId?: string;
      patch?: Record<string, unknown>;
      comment?: string;
    };
    if (!body.modelId) return NextResponse.json({ error: "modelId required" }, { status: 400 });

    if (body.patch) {
      const clean: Record<string, unknown> = {};
      for (const k of ALLOWED) if (k in body.patch) clean[k] = body.patch[k];
      if (Object.keys(clean).length) await upsertMeta(NODE, body.modelId, clean);
    }
    if (body.comment && body.comment.trim()) {
      await addComment(NODE, body.modelId, body.comment.trim());
    }

    const [map, comments] = await Promise.all([getMetaMap(NODE), getComments(NODE, body.modelId)]);
    return NextResponse.json({ ok: true, meta: map[body.modelId] ?? null, comments });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Build, restart, verify round-trip**

Run:
```bash
npm run build && pm2 restart cluster-dash && sleep 3
curl -s -X POST http://localhost:3099/api/models/meta -H 'content-type: application/json' \
  -d '{"modelId":"openai/gpt-oss-120b","patch":{"starred":true,"tags":["keep","fast"],"status":"keep"},"comment":"primary tool model"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('starred:', d['meta']['starred'], 'tags:', d['meta']['tags'], 'comments:', len(d['comments']))"
```
Expected: `starred: True tags: ['keep', 'fast'] comments: 1`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/models/meta/route.ts
git commit -m "feat(models): POST/GET /api/models/meta (tags/notes/comments)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Delete (path-safety helper + guarded route)

**Files:**
- Modify: `src/lib/model-scan.ts` (add `resolveModelDir` + `validateDeletePath`)
- Create: `src/app/api/models/delete/route.ts`
- Test: `src/lib/model-scan.delete.test.ts`

**Interfaces:**
- Consumes: `cacheKeyToModelId`/`shortName` (Task 3), `detectServed`-style engine check, `logEvent`/`updateEvent` (Task 2).
- Produces:
  - `modelIdToCacheKey(modelId: string): string`
  - `resolveModelDir(modelId: string, cacheRoot?: string): string`
  - `validateDeletePath(absPath: string, cacheRoot?: string): boolean` — true only if under `<cacheRoot>/models--` and free of shell metacharacters.
  - `POST /api/models/delete` `{ modelId, confirm }` → `{ ok, freedBytes }` or 4xx with reason.

- [ ] **Step 1: Write the failing test**

Create `src/lib/model-scan.delete.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { modelIdToCacheKey, validateDeletePath } from "./model-scan";

describe("modelIdToCacheKey", () => {
  it("round-trips an id", () => {
    expect(modelIdToCacheKey("Qwen/Qwen3-Coder-Next-FP8")).toBe("models--Qwen--Qwen3-Coder-Next-FP8");
  });
});

describe("validateDeletePath", () => {
  const root = "/home/absolome/.cache/huggingface/hub";
  it("accepts a real cache subdir", () => {
    expect(validateDeletePath(`${root}/models--Qwen--Qwen3-Coder-Next-FP8`, root)).toBe(true);
  });
  it("rejects paths outside the cache", () => {
    expect(validateDeletePath("/home/absolome/.cache/huggingface/hub", root)).toBe(false);
    expect(validateDeletePath("/etc/passwd", root)).toBe(false);
    expect(validateDeletePath(`${root}/../../evil`, root)).toBe(false);
  });
  it("rejects shell metacharacters and wildcards", () => {
    expect(validateDeletePath(`${root}/models--x*`, root)).toBe(false);
    expect(validateDeletePath(`${root}/models--x;rm`, root)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/model-scan.delete.test.ts`
Expected: FAIL — functions undefined.

- [ ] **Step 3: Append helpers to `src/lib/model-scan.ts`**

Add `resolve` to the existing `path` import:
```ts
import { join, resolve } from "path";
```
Append at the **end** of the file:
```ts
export function modelIdToCacheKey(modelId: string): string {
  return "models--" + modelId.replace("/", "--");
}

export function resolveModelDir(modelId: string, cacheRoot: string = HF_CACHE): string {
  return join(cacheRoot, modelIdToCacheKey(modelId));
}

// True only if absPath is a direct `models--*` child of cacheRoot and contains
// no shell metacharacters/wildcards. Defends rm -rf against traversal/injection.
export function validateDeletePath(absPath: string, cacheRoot: string = HF_CACHE): boolean {
  if (/[*?;&|`$(){}<>\n\\]/.test(absPath)) return false;
  const resolved = resolve(absPath);
  const prefix = resolve(cacheRoot) + "/models--";
  if (!resolved.startsWith(prefix)) return false;
  // Must be exactly one path segment below the cache root (no nested traversal).
  const rest = resolved.slice(resolve(cacheRoot).length + 1);
  if (rest.includes("/")) return false;
  return rest.startsWith("models--");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/model-scan.delete.test.ts`
Expected: passing.

- [ ] **Step 5: Implement the delete route**

Create `src/app/api/models/delete/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { resolveModelDir, validateDeletePath, shortName } from "@/lib/model-scan";
import { detectEngine, getEngineModels, HEAD_HOST, API_PORT } from "@/lib/engine";
import { logEvent, updateEvent } from "@/lib/db";
import { backupInFlightFor } from "@/lib/model-backup";

export const dynamic = "force-dynamic";
const NODE = "spark1";
const execAsync = promisify(exec);

export async function POST(req: NextRequest) {
  let eventId: number | null = null;
  try {
    const { modelId, confirm } = (await req.json()) as { modelId?: string; confirm?: string };
    if (!modelId) return NextResponse.json({ error: "modelId required" }, { status: 400 });

    const name = shortName(modelId);
    // 1) Typed-name confirmation
    if (confirm !== name) {
      return NextResponse.json({ error: `Type the model name "${name}" to confirm deletion` }, { status: 400 });
    }
    // 2) Served guard
    try {
      const eng = await detectEngine();
      if (eng.type !== "none") {
        const served = await getEngineModels(HEAD_HOST, API_PORT);
        if (served && (served.model === modelId || served.model.split("/").pop() === name)) {
          return NextResponse.json({ error: "Refusing: this model is currently being served. Stop the engine first." }, { status: 409 });
        }
      }
    } catch { /* engine unreachable: allow */ }
    // 3) Backup-lock guard
    if (backupInFlightFor(modelId)) {
      return NextResponse.json({ error: "Refusing: a backup of this model is in progress." }, { status: 409 });
    }
    // 4) Path safety
    const dir = resolveModelDir(modelId);
    if (!validateDeletePath(dir)) {
      return NextResponse.json({ error: "Unsafe path; aborting." }, { status: 400 });
    }
    if (!existsSync(dir)) return NextResponse.json({ error: "Model dir not found." }, { status: 404 });

    // 5) Measure, log, delete, confirm.
    let sizeBytes = 0;
    try {
      const { stdout } = await execAsync(`du -sb '${dir}' 2>/dev/null`, { timeout: 30000 });
      sizeBytes = parseInt(stdout.split("\t")[0]) || 0;
    } catch { /* size best-effort */ }

    eventId = await logEvent(NODE, modelId, "delete", "started", { path: dir, sizeBytes });
    await execAsync(`rm -rf '${dir}'`, { timeout: 120000 });
    if (existsSync(dir)) throw new Error("Directory still present after rm");
    await updateEvent(eventId, "success", { path: dir, freedBytes: sizeBytes });

    return NextResponse.json({ ok: true, freedBytes: sizeBytes });
  } catch (e) {
    if (eventId !== null) await updateEvent(eventId, "failed", { error: (e as Error).message }).catch(() => {});
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 6: Build + verify guards (no real deletion)**

Run:
```bash
npm run build && pm2 restart cluster-dash && sleep 3
# wrong confirmation -> 400, nothing deleted
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3099/api/models/delete \
  -H 'content-type: application/json' -d '{"modelId":"openai/gpt-oss-120b","confirm":"wrong"}'
```
Expected: `400`. (Do NOT run a real deletion during implementation — guard verification only.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/model-scan.ts src/lib/model-scan.delete.test.ts src/app/api/models/delete/route.ts
git commit -m "feat(models): guarded delete with typed-name confirm + path safety

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Backup to external drive (lib + route)

**Files:**
- Create: `src/lib/model-backup.ts`
- Create: `src/app/api/models/backup/route.ts`
- Test: `src/lib/model-backup.test.ts`

**Interfaces:**
- Consumes: `resolveModelDir`, `modelIdToCacheKey` (Task 9); `logEvent`/`updateEvent` (Task 2).
- Produces:
  - `parseRsyncProgress(line: string): number | null` (percent 0–100)
  - `detectTargets(): Promise<BackupTarget[]>` where `BackupTarget = { mountpoint; label; freeBytes }`
  - `startBackup(modelId: string, target: string): { error?: string }` (begins a tracked job)
  - `getBackupStatus(): BackupJob | null`
  - `backupInFlightFor(modelId: string): boolean`
  - `GET /api/models/backup` → `{ targets, job }`; `POST /api/models/backup` `{ modelId, target }`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/model-backup.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseRsyncProgress, backupInFlightFor } from "./model-backup";

describe("parseRsyncProgress", () => {
  it("parses the percentage from an --info=progress2 line", () => {
    expect(parseRsyncProgress("  1,234,567  45%   12.3MB/s    0:00:10")).toBe(45);
  });
  it("returns null for non-progress lines", () => {
    expect(parseRsyncProgress("sending incremental file list")).toBe(null);
  });
});

describe("backupInFlightFor", () => {
  it("is false when no job is running", () => {
    expect(backupInFlightFor("openai/gpt-oss-120b")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/model-backup.test.ts`
Expected: FAIL — module undefined.

- [ ] **Step 3: Implement `src/lib/model-backup.ts`**

```ts
import { spawn, execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { resolveModelDir, modelIdToCacheKey } from "./model-scan";
import { logEvent, updateEvent } from "./db";

export interface BackupTarget { mountpoint: string; label: string; freeBytes: number }
export interface BackupJob {
  modelId: string;
  target: string;
  startedAt: number;
  percent: number;
  status: "running" | "success" | "failed";
  message: string;
}

const NODE = "spark1";
const ALLOWED_MOUNT_PREFIXES = ["/media", "/mnt", "/run/media"];

// Single in-process job at a time (one external drive, sequential copies).
const g = globalThis as unknown as { __modelBackupJob?: BackupJob | null };
function current(): BackupJob | null { return g.__modelBackupJob ?? null; }

export function getBackupStatus(): BackupJob | null { return current(); }
export function backupInFlightFor(modelId: string): boolean {
  const j = current();
  return !!j && j.status === "running" && j.modelId === modelId;
}

export function parseRsyncProgress(line: string): number | null {
  const m = line.match(/(\d+)%/);
  return m ? parseInt(m[1]) : null;
}

export async function detectTargets(): Promise<BackupTarget[]> {
  let json: { blockdevices?: unknown[] } = {};
  try {
    const out = execSync("lsblk -J -b -o NAME,MOUNTPOINT,SIZE,FSAVAIL,RM,TYPE 2>/dev/null").toString();
    json = JSON.parse(out);
  } catch { return []; }

  const targets: BackupTarget[] = [];
  const walk = (nodes: unknown[]) => {
    for (const n of nodes as Array<Record<string, unknown>>) {
      const mp = n.mountpoint as string | null;
      const avail = typeof n.fsavail === "string" ? parseInt(n.fsavail) : (n.fsavail as number | null);
      if (mp && ALLOWED_MOUNT_PREFIXES.some((p) => mp.startsWith(p))) {
        targets.push({ mountpoint: mp, label: String(n.name ?? mp), freeBytes: avail ?? 0 });
      }
      if (Array.isArray(n.children)) walk(n.children as unknown[]);
    }
  };
  walk(json.blockdevices ?? []);
  return targets;
}

export function startBackup(modelId: string, target: string): { error?: string } {
  const existing = current();
  if (existing && existing.status === "running") return { error: "A backup is already running." };
  if (!ALLOWED_MOUNT_PREFIXES.some((p) => target.startsWith(p))) return { error: "Target is not an allowed external mount." };
  if (!existsSync(target)) return { error: "Target mountpoint does not exist." };

  const src = resolveModelDir(modelId);
  if (!existsSync(src)) return { error: "Source model dir not found." };

  const destRoot = join(target, "cluster-dash-models");
  const dest = join(destRoot, modelIdToCacheKey(modelId));
  try { mkdirSync(dest, { recursive: true }); } catch (e) { return { error: (e as Error).message }; }

  const job: BackupJob = {
    modelId, target, startedAt: Date.now(), percent: 0, status: "running",
    message: "starting rsync",
  };
  g.__modelBackupJob = job;

  // rsync -a preserves the full repo structure (blobs/snapshots/refs). Trailing
  // slash on src copies its *contents* into dest.
  const child = spawn("rsync", ["-a", "--info=progress2", `${src}/`, `${dest}/`], { stdio: ["ignore", "pipe", "pipe"] });

  logEvent(NODE, modelId, "backup", "started", { target: dest }).then((id) => {
    let lastErr = "";
    child.stdout.on("data", (b: Buffer) => {
      for (const line of b.toString().split(/\r|\n/)) {
        const pct = parseRsyncProgress(line);
        if (pct !== null) job.percent = pct;
      }
    });
    child.stderr.on("data", (b: Buffer) => { lastErr = b.toString().slice(-300); });
    child.on("close", (code) => {
      if (code === 0) {
        job.status = "success"; job.percent = 100; job.message = "complete";
        updateEvent(id, "success", { target: dest });
      } else {
        job.status = "failed"; job.message = lastErr || `rsync exited ${code}`;
        updateEvent(id, "failed", { error: job.message });
      }
    });
  });

  return {};
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/model-backup.test.ts`
Expected: passing.

- [ ] **Step 5: Implement the route**

Create `src/app/api/models/backup/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { detectTargets, startBackup, getBackupStatus } from "@/lib/model-backup";

export const dynamic = "force-dynamic";

export async function GET() {
  const targets = await detectTargets();
  return NextResponse.json({ targets, job: getBackupStatus() });
}

export async function POST(req: NextRequest) {
  try {
    const { modelId, target } = (await req.json()) as { modelId?: string; target?: string };
    if (!modelId || !target) return NextResponse.json({ error: "modelId and target required" }, { status: 400 });
    const r = startBackup(modelId, target);
    if (r.error) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ ok: true, job: getBackupStatus() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 6: Build, restart, verify target detection**

Run:
```bash
npm run build && pm2 restart cluster-dash && sleep 3
curl -s http://localhost:3099/api/models/backup | python3 -c "import sys,json; d=json.load(sys.stdin); print('targets:', [t['mountpoint'] for t in d['targets']], 'job:', d['job'])"
```
Expected: a list of external mountpoints (empty `[]` if no external drive attached — that's correct) and `job: None`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/model-backup.ts src/lib/model-backup.test.ts src/app/api/models/backup/route.ts
git commit -m "feat(models): external-drive backup (detect + tracked rsync job)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Frontend — panel skeleton, treemap, and tab wiring

**Files:**
- Create: `src/components/ModelManagerPanel.tsx`
- Create: `src/components/models/ModelTreemap.tsx`
- Modify: `src/app/page.tsx`

**Interfaces:**
- Consumes: `GET /api/models` (`ModelsResponse`).
- Produces: a rendered MODELS tab showing summary + treemap + a model list placeholder slot that Task 12 fills with `ModelRow`/`ModelDetailDrawer`.
- Note: client components must not import server-only libs; define local UI copies of the response types (do not import from `@/lib/db`).

- [ ] **Step 1: Create the treemap component**

Create `src/components/models/ModelTreemap.tsx`:
```tsx
"use client";

const MOD_COLORS: Record<string, string> = {
  text: "#3b82f6", vision: "#8b5cf6", audio: "#22d3ee", "image-gen": "#f59e0b", unknown: "#475569",
};

export function ModelTreemap({
  items,
}: {
  items: { id: string; name: string; sizeBytes: number; modality: string }[];
}) {
  const total = items.reduce((s, i) => s + i.sizeBytes, 0) || 1;
  return (
    <div style={{ display: "flex", width: "100%", height: 26, borderRadius: 6, overflow: "hidden", border: "1px solid #1a2540" }}>
      {items.map((i) => {
        const pct = (i.sizeBytes / total) * 100;
        if (pct < 0.3) return null;
        return (
          <div
            key={i.id}
            title={`${i.name} · ${(i.sizeBytes / 1e9).toFixed(1)} GB`}
            style={{
              width: `${pct}%`,
              background: MOD_COLORS[i.modality] ?? "#475569",
              opacity: 0.85,
              borderRight: "1px solid #06090f",
            }}
          />
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Create the panel skeleton**

Create `src/components/ModelManagerPanel.tsx`:
```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { ModelTreemap } from "./models/ModelTreemap";

// Local UI types (mirror of the server ModelsResponse — keep client server-free).
export interface UiMeta {
  display_name: string | null; tags: string[]; rating: number | null;
  starred: boolean; notes: string | null; status: string;
}
export interface UiModel {
  node: string; id: string; org: string; name: string; sizeBytes: number;
  modality: string; arch: string | null; modelType: string | null;
  paramCountB: number | null; quant: string | null; contextLen: number | null;
  dtype: string | null; health: string; healthDetail: string;
  snapshotHash: string | null; mtime: number; groupKey: string; served: boolean;
  meta: UiMeta | null;
}
export interface UiGroup { key: string; members: UiModel[]; totalBytes: number; redundantBytes: number; unique: boolean }
export interface UiResponse {
  node: string; generatedAt: number; totalBytes: number; reclaimableBytes: number;
  servedModelId: string | null; models: UiModel[]; groups: UiGroup[];
}

export const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;

const TEAL = "#14b8a6";

export function ModelManagerPanel() {
  const [data, setData] = useState<UiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/models", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Summary bar */}
      <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap", padding: "12px 16px", background: "#0c1220", border: "1px solid #1a2540", borderRadius: 8 }}>
        <Stat label="MODELS" value={data ? String(data.models.length) : "—"} />
        <Stat label="TOTAL DISK" value={data ? gb(data.totalBytes) : "—"} color="#e2e8f0" />
        <Stat label="RECLAIMABLE" value={data ? gb(data.reclaimableBytes) : "—"} color="#f59e0b" />
        <Stat label="SERVED" value={data?.servedModelId ? (data.servedModelId.split("/").pop() ?? "—") : "none"} color={TEAL} />
        <div style={{ marginLeft: "auto" }}>
          <button onClick={load} disabled={loading} style={btn(TEAL)}>
            {loading ? "SCANNING…" : "↻ RESCAN"}
          </button>
        </div>
      </div>

      {err && <div style={{ color: "#ef4444", fontSize: 11 }}>⚠ {err}</div>}

      {/* Disk treemap */}
      {data && (
        <div style={{ padding: "12px 16px", background: "#0c1220", border: "1px solid #1a2540", borderRadius: 8 }}>
          <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.14em", marginBottom: 8, textTransform: "uppercase" }}>▸ DISK BY MODEL</div>
          <ModelTreemap items={data.models.map((m) => ({ id: m.id, name: m.name, sizeBytes: m.sizeBytes, modality: m.modality }))} />
        </div>
      )}

      {/* Model list — filled by Task 12 */}
      <div id="model-list-slot" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {data?.models.map((m) => (
          <div key={m.id} style={{ padding: "10px 14px", background: "#0c1220", border: "1px solid #1a2540", borderRadius: 8, fontSize: 12, color: "#e2e8f0", display: "flex", justifyContent: "space-between" }}>
            <span>{m.name}</span>
            <span style={{ color: "#94a3b8" }}>{gb(m.sizeBytes)} · {m.health}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, color = "#94a3b8" }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.12em" }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

export function btn(accent: string): React.CSSProperties {
  return {
    background: `${accent}18`, border: `1px solid ${accent}55`, color: accent,
    padding: "6px 14px", borderRadius: 6, fontSize: 10, letterSpacing: "0.1em",
    cursor: "pointer", fontFamily: "inherit", textTransform: "uppercase",
  };
}
```

- [ ] **Step 3: Wire the tab into `src/app/page.tsx`**

Add the import near the other component imports (after line 14):
```tsx
import { ModelManagerPanel } from "@/components/ModelManagerPanel";
```

Extend the `activeTab` union (the `useState` at ~line 121) to include `"models"`:
```tsx
const [activeTab, setActiveTab] = useState<"overview" | "inference" | "tasks" | "control" | "models" | "backup" | "pm2" | "logs" | "chat" | "agent">("overview");
```

Add `"models"` to the tab-row array (the `as const` list at ~line 370) — place it right after `"control"`:
```tsx
        {(["overview", "inference", "tasks", "control", "models", "backup", "pm2", "logs", "chat", "agent"] as const)
```

Add the label and accent for `models` in the `labels` map and the accent ternaries (inside the `.map`, ~lines 373–389):
- In `labels`: add `models: "◆ MODELS",`
- In `accentColor`: add `: tab === "models" ? "#14b8a6"` before the final `: "#3b82f6"`.
- In `activeText`: add `: tab === "models" ? "#2dd4bf"` before the final `: "#3b82f6"`.
- In `inactiveText`: add `: tab === "models" ? "#155e57"` before the final `: "#334155"`.

Add the render block — place it after the CLUSTER CONTROL block (after line 560, before the BACKUP block):
```tsx
        {/* ── MODELS TAB ── */}
        {activeTab === "models" && (
          <section>
            <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.14em", marginBottom: 8, textTransform: "uppercase" }}>
              ▸ MODEL MANAGER · spark1 · {data?.engine?.label && data.engine.type !== "none" ? `served by ${data.engine.label}` : "scan & manage downloaded models"}
            </div>
            <ModelManagerPanel />
          </section>
        )}
```

- [ ] **Step 4: Build, restart, verify the tab renders**

Run:
```bash
npm run build && pm2 restart cluster-dash && sleep 3
curl -s http://localhost:3099/ | grep -o "◆ MODELS" | head -1
```
Expected: prints `◆ MODELS` (tab present in SSR output). Also load `http://<spark1>:3099` in a browser, click MODELS, confirm summary numbers + treemap render.

- [ ] **Step 5: Commit**

```bash
git add src/components/ModelManagerPanel.tsx src/components/models/ModelTreemap.tsx src/app/page.tsx
git commit -m "feat(models): Model Manager tab — summary, treemap, scan wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Frontend — rows, detail drawer, usage, backup, delete UI

**Files:**
- Create: `src/components/models/ModelRow.tsx`
- Create: `src/components/models/ModelDetailDrawer.tsx`
- Create: `src/components/models/UsageReport.tsx`
- Create: `src/components/models/BackupDialog.tsx`
- Modify: `src/components/ModelManagerPanel.tsx` (toolbar: search/sort/filter/group; render rows + drawer)

**Interfaces:**
- Consumes: `UiModel`, `UiResponse`, `gb`, `btn` (Task 11); `GET /api/models/usage`, `GET/POST /api/models/meta`, `POST /api/models/delete`, `GET/POST /api/models/backup`.
- Produces: full interactive Model Manager.

- [ ] **Step 1: Create `UsageReport.tsx`**

```tsx
"use client";

interface Hit { source: string; path: string; line: number | null; excerpt: string }

export function UsageReport({ hits, truncated, loading }: { hits: Hit[]; truncated: boolean; loading: boolean }) {
  if (loading) return <div style={{ fontSize: 11, color: "#94a3b8" }}>investigating…</div>;
  if (!hits.length) return <div style={{ fontSize: 11, color: "#475569" }}>No references found in engine, launch scripts, or project configs.</div>;
  const color: Record<string, string> = { engine: "#14b8a6", script: "#f59e0b", config: "#3b82f6" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {hits.map((h, i) => (
        <div key={i} style={{ fontSize: 11, color: "#cbd5e1", borderLeft: `2px solid ${color[h.source] ?? "#475569"}`, paddingLeft: 8 }}>
          <span style={{ color: color[h.source] ?? "#475569", textTransform: "uppercase", fontSize: 9, letterSpacing: "0.1em" }}>{h.source}</span>{" "}
          <span style={{ color: "#94a3b8" }}>{h.path}{h.line ? `:${h.line}` : ""}</span>
          <div style={{ color: "#64748b", fontFamily: "monospace", fontSize: 10, marginTop: 2 }}>{h.excerpt}</div>
        </div>
      ))}
      {truncated && <div style={{ fontSize: 10, color: "#f59e0b" }}>results truncated — more references exist</div>}
    </div>
  );
}
```

- [ ] **Step 2: Create `BackupDialog.tsx`**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { btn } from "../ModelManagerPanel";

interface Target { mountpoint: string; label: string; freeBytes: number }
interface Job { modelId: string; target: string; percent: number; status: string; message: string }

export function BackupDialog({ modelId, sizeBytes, onClose }: { modelId: string; sizeBytes: number; onClose: () => void }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/models/backup", { cache: "no-store" });
    const d = await r.json();
    setTargets(d.targets ?? []);
    setJob(d.job ?? null);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (job?.status !== "running") return;
    const id = setInterval(refresh, 1500);
    return () => clearInterval(id);
  }, [job?.status, refresh]);

  const start = async (target: string) => {
    setErr(null);
    const r = await fetch("/api/models/backup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelId, target }) });
    const d = await r.json();
    if (!r.ok) setErr(d.error ?? "failed");
    else setJob(d.job);
  };

  return (
    <div style={{ marginTop: 8, padding: 12, background: "#0a1018", border: "1px solid #14b8a644", borderRadius: 8 }}>
      <div style={{ fontSize: 10, color: "#2dd4bf", letterSpacing: "0.1em", marginBottom: 8 }}>BACKUP TO EXTERNAL DRIVE · {(sizeBytes / 1e9).toFixed(1)} GB</div>
      {err && <div style={{ color: "#ef4444", fontSize: 11, marginBottom: 6 }}>⚠ {err}</div>}
      {job && job.status === "running" ? (
        <div style={{ fontSize: 11, color: "#94a3b8" }}>
          Copying {job.modelId.split("/").pop()} → {job.target} · {job.percent}%
          <div style={{ height: 6, background: "#1a2540", borderRadius: 3, marginTop: 4 }}>
            <div style={{ width: `${job.percent}%`, height: "100%", background: "#14b8a6", borderRadius: 3 }} />
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {targets.length === 0 && <div style={{ fontSize: 11, color: "#475569" }}>No external drive detected. Plug one in, then ↻ rescan.</div>}
          {targets.map((t) => {
            const fits = t.freeBytes >= sizeBytes;
            return (
              <div key={t.mountpoint} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, color: "#cbd5e1" }}>
                <span style={{ flex: 1 }}>{t.mountpoint} <span style={{ color: "#475569" }}>({(t.freeBytes / 1e9).toFixed(0)} GB free)</span></span>
                <button disabled={!fits} onClick={() => start(t.mountpoint)} style={{ ...btn("#14b8a6"), opacity: fits ? 1 : 0.4 }}>
                  {fits ? "BACKUP HERE" : "NOT ENOUGH SPACE"}
                </button>
              </div>
            );
          })}
          {job && job.status !== "running" && <div style={{ fontSize: 11, color: job.status === "success" ? "#10b981" : "#ef4444" }}>last backup: {job.status} — {job.message}</div>}
        </div>
      )}
      <button onClick={onClose} style={{ ...btn("#475569"), marginTop: 8 }}>CLOSE</button>
    </div>
  );
}
```

- [ ] **Step 3: Create `ModelDetailDrawer.tsx`**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import type { UiModel } from "../ModelManagerPanel";
import { btn, gb } from "../ModelManagerPanel";
import { UsageReport } from "./UsageReport";
import { BackupDialog } from "./BackupDialog";

interface Comment { id: number; author: string; body: string; created_at: string }

export function ModelDetailDrawer({ model, onChanged }: { model: UiModel; onChanged: () => void }) {
  const [notes, setNotes] = useState(model.meta?.notes ?? "");
  const [tagText, setTagText] = useState((model.meta?.tags ?? []).join(", "));
  const [status, setStatus] = useState(model.meta?.status ?? "keep");
  const [rating, setRating] = useState<number | null>(model.meta?.rating ?? null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState("");
  const [usage, setUsage] = useState<{ hits: []; truncated: boolean } | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const loadMeta = useCallback(async () => {
    const r = await fetch(`/api/models/meta?id=${encodeURIComponent(model.id)}`, { cache: "no-store" });
    const d = await r.json();
    setComments(d.comments ?? []);
  }, [model.id]);

  useEffect(() => { loadMeta(); }, [loadMeta]);

  const saveMeta = async (patch: Record<string, unknown>, comment?: string) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/models/meta", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelId: model.id, patch, comment }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setComments(d.comments ?? []);
      onChanged();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const investigate = async () => {
    setUsageLoading(true);
    try {
      const r = await fetch(`/api/models/usage?id=${encodeURIComponent(model.id)}`, { cache: "no-store" });
      setUsage(await r.json());
    } finally { setUsageLoading(false); }
  };

  const doDelete = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/models/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelId: model.id, confirm: confirmText }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setMsg(`Deleted — freed ${gb(d.freedBytes)}`);
      onChanged();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const fact = (k: string, v: React.ReactNode) => (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "2px 0" }}>
      <span style={{ color: "#475569" }}>{k}</span><span style={{ color: "#cbd5e1" }}>{v}</span>
    </div>
  );

  return (
    <div style={{ padding: 14, background: "#0a1018", borderTop: "1px solid #1a2540", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
      {/* Left: facts + usage */}
      <div>
        <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.12em", marginBottom: 6 }}>FACTS</div>
        {fact("id", model.id)}
        {fact("modality", model.modality)}
        {fact("architecture", model.arch ?? "—")}
        {fact("type", model.modelType ?? "—")}
        {fact("quant", model.quant ?? "—")}
        {fact("context", model.contextLen ? model.contextLen.toLocaleString() : "—")}
        {fact("params≈", model.paramCountB ? `${model.paramCountB}B` : "—")}
        {fact("size", gb(model.sizeBytes))}
        {fact("health", `${model.health} — ${model.healthDetail}`)}
        {fact("snapshot", model.snapshotHash?.slice(0, 12) ?? "—")}
        <div style={{ marginTop: 12 }}>
          <button onClick={investigate} style={btn("#3b82f6")}>⌕ INVESTIGATE USAGE</button>
          {usage && <div style={{ marginTop: 8 }}><UsageReport hits={usage.hits} truncated={usage.truncated} loading={usageLoading} /></div>}
          {usageLoading && !usage && <div style={{ marginTop: 8 }}><UsageReport hits={[]} truncated={false} loading /></div>}
        </div>
      </div>

      {/* Right: meta + comments + actions */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.12em", marginBottom: 6 }}>METADATA</div>
          <label style={lbl}>tags (comma-separated)</label>
          <input value={tagText} onChange={(e) => setTagText(e.target.value)} onBlur={() => saveMeta({ tags: tagText.split(",").map((s) => s.trim()).filter(Boolean) })} style={inp} />
          <label style={lbl}>status</label>
          <select value={status} onChange={(e) => { setStatus(e.target.value); saveMeta({ status: e.target.value }); }} style={inp}>
            <option value="keep">keep</option>
            <option value="archive">archive</option>
            <option value="candidate-delete">candidate-delete</option>
          </select>
          <label style={lbl}>rating</label>
          <div style={{ display: "flex", gap: 4 }}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} onClick={() => { setRating(n); saveMeta({ rating: n }); }} style={{ ...btn(rating && n <= rating ? "#f59e0b" : "#475569"), padding: "2px 8px" }}>★</button>
            ))}
          </div>
          <label style={lbl}>notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => saveMeta({ notes })} rows={3} style={{ ...inp, resize: "vertical" }} />
        </div>

        <div>
          <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.12em", marginBottom: 6 }}>COMMENTS</div>
          {comments.map((c) => (
            <div key={c.id} style={{ fontSize: 11, color: "#cbd5e1", marginBottom: 4 }}>
              <span style={{ color: "#475569" }}>{new Date(c.created_at).toLocaleString("en-GB")}: </span>{c.body}
            </div>
          ))}
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <input value={newComment} onChange={(e) => setNewComment(e.target.value)} placeholder="add comment…" style={{ ...inp, flex: 1 }} />
            <button onClick={() => { if (newComment.trim()) { saveMeta({}, newComment.trim()); setNewComment(""); } }} style={btn("#14b8a6")}>ADD</button>
          </div>
        </div>

        <div>
          <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.12em", marginBottom: 6 }}>ACTIONS</div>
          <button onClick={() => setShowBackup((s) => !s)} style={btn("#14b8a6")}>⇩ BACKUP TO DRIVE</button>
          {showBackup && <BackupDialog modelId={model.id} sizeBytes={model.sizeBytes} onClose={() => setShowBackup(false)} />}
          <div style={{ marginTop: 10, padding: 10, border: "1px solid #ef444444", borderRadius: 6 }}>
            <div style={{ fontSize: 10, color: "#ef4444", marginBottom: 4 }}>DANGER · type <b>{model.name}</b> to delete ({gb(model.sizeBytes)})</div>
            {model.served && <div style={{ fontSize: 10, color: "#f59e0b", marginBottom: 4 }}>⚠ currently served — deletion will be refused</div>}
            <div style={{ display: "flex", gap: 6 }}>
              <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={model.name} style={{ ...inp, flex: 1 }} />
              <button disabled={busy || confirmText !== model.name} onClick={doDelete} style={{ ...btn("#ef4444"), opacity: confirmText === model.name ? 1 : 0.4 }}>DELETE</button>
            </div>
          </div>
        </div>
        {msg && <div style={{ fontSize: 11, color: msg.startsWith("Deleted") ? "#10b981" : "#ef4444" }}>{msg}</div>}
      </div>
    </div>
  );
}

const lbl: React.CSSProperties = { display: "block", fontSize: 9, color: "#475569", letterSpacing: "0.1em", margin: "8px 0 2px" };
const inp: React.CSSProperties = { width: "100%", background: "#06090f", border: "1px solid #1a2540", borderRadius: 4, color: "#e2e8f0", fontSize: 11, padding: "5px 8px", fontFamily: "inherit" };
```

- [ ] **Step 4: Create `ModelRow.tsx`**

```tsx
"use client";

import type { UiModel } from "../ModelManagerPanel";
import { gb } from "../ModelManagerPanel";

const MOD_COLORS: Record<string, string> = { text: "#3b82f6", vision: "#8b5cf6", audio: "#22d3ee", "image-gen": "#f59e0b", unknown: "#475569" };
const HEALTH_COLORS: Record<string, string> = { ready: "#10b981", downloading: "#3b82f6", incomplete: "#f59e0b", stub: "#f59e0b", broken: "#ef4444" };

export function ModelRow({ model, maxBytes, expanded, onToggle }: { model: UiModel; maxBytes: number; expanded: boolean; onToggle: () => void }) {
  const pct = maxBytes > 0 ? (model.sizeBytes / maxBytes) * 100 : 0;
  return (
    <div onClick={onToggle} style={{ cursor: "pointer", padding: "10px 14px", background: expanded ? "#0e1626" : "#0c1220", border: `1px solid ${expanded ? "#14b8a655" : "#1a2540"}`, borderRadius: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: HEALTH_COLORS[model.health] ?? "#475569" }} title={model.healthDetail} />
        {model.meta?.starred && <span style={{ color: "#f59e0b", fontSize: 11 }}>★</span>}
        <span style={{ fontSize: 12, color: "#e2e8f0", fontWeight: 600 }}>{model.name}</span>
        <span style={{ fontSize: 9, color: MOD_COLORS[model.modality], border: `1px solid ${MOD_COLORS[model.modality]}55`, borderRadius: 4, padding: "1px 5px" }}>{model.modality}</span>
        {model.quant && <span style={{ fontSize: 9, color: "#94a3b8" }}>{model.quant}</span>}
        {model.served && <span style={{ fontSize: 9, color: "#14b8a6", border: "1px solid #14b8a655", borderRadius: 4, padding: "1px 5px" }}>SERVED</span>}
        {model.meta?.status && model.meta.status !== "keep" && <span style={{ fontSize: 9, color: "#f59e0b" }}>{model.meta.status}</span>}
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#cbd5e1", fontVariantNumeric: "tabular-nums" }}>{gb(model.sizeBytes)}</span>
      </div>
      <div style={{ height: 4, background: "#0a1018", borderRadius: 2, marginTop: 6 }}>
        <div style={{ width: `${pct}%`, height: "100%", background: MOD_COLORS[model.modality], opacity: 0.7, borderRadius: 2 }} />
      </div>
      {(model.meta?.tags?.length ?? 0) > 0 && (
        <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
          {model.meta!.tags.map((t) => <span key={t} style={{ fontSize: 9, color: "#94a3b8", background: "#1a2540", borderRadius: 4, padding: "1px 6px" }}>{t}</span>)}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Wire toolbar + rows + drawer into `ModelManagerPanel.tsx`**

Replace the `{/* Model list — filled by Task 12 */}` block (the `<div id="model-list-slot">…</div>`) with the toolbar + list below, and add the needed imports/state at the top of the component.

Add imports after the existing `ModelTreemap` import:
```tsx
import { ModelRow } from "./models/ModelRow";
import { ModelDetailDrawer } from "./models/ModelDetailDrawer";
```

Add state inside `ModelManagerPanel`, right after the `err` state:
```tsx
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"size" | "name" | "date">("size");
  const [modalityFilter, setModalityFilter] = useState<string>("all");
  const [groupDup, setGroupDup] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
```

Replace the list slot with:
```tsx
      {/* Toolbar */}
      {data && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search…" style={{ background: "#06090f", border: "1px solid #1a2540", borderRadius: 6, color: "#e2e8f0", fontSize: 11, padding: "6px 10px", fontFamily: "inherit" }} />
          <select value={sort} onChange={(e) => setSort(e.target.value as "size" | "name" | "date")} style={selStyle}>
            <option value="size">sort: size</option>
            <option value="name">sort: name</option>
            <option value="date">sort: date</option>
          </select>
          <select value={modalityFilter} onChange={(e) => setModalityFilter(e.target.value)} style={selStyle}>
            {["all", "text", "vision", "audio", "image-gen", "unknown"].map((m) => <option key={m} value={m}>{m === "all" ? "modality: all" : m}</option>)}
          </select>
          <label style={{ fontSize: 10, color: "#94a3b8", display: "flex", alignItems: "center", gap: 5 }}>
            <input type="checkbox" checked={groupDup} onChange={(e) => setGroupDup(e.target.checked)} /> group duplicates
          </label>
        </div>
      )}

      {/* List */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {data && (() => {
          let list = data.models.filter((m) =>
            (modalityFilter === "all" || m.modality === modalityFilter) &&
            (q === "" || m.id.toLowerCase().includes(q.toLowerCase()))
          );
          list = [...list].sort((a, b) =>
            sort === "size" ? b.sizeBytes - a.sizeBytes :
            sort === "name" ? a.name.localeCompare(b.name) :
            b.mtime - a.mtime
          );
          const maxBytes = Math.max(1, ...list.map((m) => m.sizeBytes));

          if (groupDup) {
            const groups = data.groups
              .map((g) => ({ ...g, members: g.members.filter((m) => list.some((l) => l.id === m.id)) }))
              .filter((g) => g.members.length > 0)
              .sort((a, b) => b.totalBytes - a.totalBytes);
            return groups.map((g) => (
              <div key={g.key} style={{ border: g.unique ? "none" : "1px dashed #14b8a644", borderRadius: 8, padding: g.unique ? 0 : 6, display: "flex", flexDirection: "column", gap: 6 }}>
                {!g.unique && <div style={{ fontSize: 9, color: "#2dd4bf", letterSpacing: "0.1em" }}>VARIANT GROUP · {g.members.length} · {gb(g.totalBytes)} total · {gb(g.redundantBytes)} redundant</div>}
                {g.members.map((m) => rowWithDrawer(m, maxBytes))}
              </div>
            ));
          }
          return list.map((m) => rowWithDrawer(m, maxBytes));
        })()}
      </div>
```

Add this render helper inside the component (before the `return`):
```tsx
  const rowWithDrawer = (m: UiModel, maxBytes: number) => (
    <div key={m.id}>
      <ModelRow model={m} maxBytes={maxBytes} expanded={expanded === m.id} onToggle={() => setExpanded(expanded === m.id ? null : m.id)} />
      {expanded === m.id && <ModelDetailDrawer model={m} onChanged={load} />}
    </div>
  );
```

Add the select style constant near `btn` (bottom of file):
```tsx
const selStyle: React.CSSProperties = { background: "#06090f", border: "1px solid #1a2540", borderRadius: 6, color: "#94a3b8", fontSize: 10, padding: "6px 8px", fontFamily: "inherit" };
```

- [ ] **Step 6: Build, restart, verify**

Run:
```bash
npm run build && pm2 restart cluster-dash && sleep 3
```
Then in a browser at `http://<spark1>:3099` → MODELS:
- Rows render with size bars, health dots, modality badges, SERVED badge.
- Search / sort / modality filter / group-duplicates toggle work.
- Expand a row → drawer shows facts; "Investigate usage" returns hits; tags/notes/rating/status persist (reload page → still there); comment adds and persists.
- "Backup to drive" lists targets (or "no external drive"); delete button stays disabled until the exact name is typed; deleting a served model is refused with a clear message.

- [ ] **Step 7: Commit**

```bash
git add src/components/models/ src/components/ModelManagerPanel.tsx
git commit -m "feat(models): rows, detail drawer, usage, backup & delete UI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Documentation, final verification, push

**Files:**
- Modify: `CLAUDE.md` (add a Model Manager section)
- Modify: `README` only if one exists for the dashboard (skip otherwise).

- [ ] **Step 1: Document the feature in `CLAUDE.md`**

Add a new section after the "Dashboard Codebase Structure" section:
```markdown
### Model Manager (MODELS tab)

Scans spark1's HF cache (`/home/absolome/.cache/huggingface/hub`) and manages models.
- API: `src/app/api/models/{route,usage,meta,delete,backup}.ts`
- Libs: `src/lib/{db,model-scan,model-usage,model-backup,model-types}.ts`
- UI: `src/components/ModelManagerPanel.tsx` + `src/components/models/*`
- Metadata store: Postgres DB `cluster_dash` (tables `model_meta`, `model_comment`, `model_event`). Connection via `DATABASE_URL` in `.env.local` (default socket conn to local PG as `absolome`).
- Features: rich facts, health/integrity, duplicate-variant grouping, disk treemap, tags/notes/rating/comments, usage investigation (engine/scripts/configs), external-drive backup (rsync), guarded delete (typed-name confirm, served + backup locks, path-safety).
- v1 = spark1 only; lib functions take a `node` arg for the v2 multi-node extension (rows keyed by `(node, model_id)`).
```

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all test files pass (db, scan helpers, scan fs, delete, usage, backup).

- [ ] **Step 3: Production build gate**

Run: `npm run build`
Expected: exit 0, no type errors.

- [ ] **Step 4: Restart and smoke-test every endpoint**

```bash
pm2 restart cluster-dash && sleep 3
for ep in "/api/models" "/api/models/usage?id=openai/gpt-oss-120b" "/api/models/backup"; do
  echo -n "$ep -> "; curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3099$ep"
done
```
Expected: all `200`.

- [ ] **Step 5: Commit and push**

```bash
git add CLAUDE.md
git commit -m "docs(models): document Model Manager in CLAUDE.md

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push origin main
```
Expected: push succeeds.

---

## Self-Review (completed during planning)

**Spec coverage:**
- New tab → Task 11. Scan/facts/health → Tasks 3–5. Duplicate grouping → Task 4. Treemap/sort/filter → Tasks 11–12. Metadata+comments in Postgres → Tasks 2, 8. Usage investigation (engine/scripts/configs) → Tasks 6–7. Delete with typed-name + safeguards → Task 9. External-drive backup → Task 10. `pg` dep + DB + env → Task 1. Multi-node forward-compat (`node` column/arg) → Tasks 2–4. Documentation → Task 13. All spec sections mapped.

**Placeholder scan:** No TBD/TODO; every code step contains complete code; commands have expected output.

**Type consistency:** `ScannedModel`/`ModelGroup`/`Health`/`Modality` defined in `model-scan.ts` and reused via `model-types.ts`; UI mirrors them as `Ui*` (client stays server-free). `ModelMeta`/`ModelComment` defined in `db.ts`. Function names (`scanModels`, `groupDuplicates`, `investigateUsage`, `grepHits`, `validateDeletePath`, `resolveModelDir`, `modelIdToCacheKey`, `detectTargets`, `startBackup`, `backupInFlightFor`, `parseRsyncProgress`, `upsertMeta`, `addComment`, `logEvent`, `updateEvent`) are consistent across producer and consumer tasks.

**Known intentional choices:** delete-route imports `backupInFlightFor` from `model-backup` (Task 10) — Task 9 lands first, so during Task 9's isolated build that import won't exist yet. **Resolution:** implement Task 10 before Task 9, OR in Task 9 temporarily stub the guard. The dependency-correct execution order is **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 10 → 9 → 11 → 12 → 13** (backup before delete). Follow that order.
