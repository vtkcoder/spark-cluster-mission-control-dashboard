# Model Manager — Design Spec

**Date:** 2026-06-28
**Status:** Approved (design), ready for implementation
**Scope (v1):** spark1 only. Multi-node is designed-in but not built.

---

## 1. Problem & Goal

The HF model cache on spark1 (`/home/absolome/.cache/huggingface/hub`) holds **14 model repos totalling ~1.9 TB** — a mix of LLMs (many near-duplicate quants: 3× MiniMax-M2.7, Qwen3-235B in FP8/FP4/NVFP4, GLM variants), an image model (FLUX.2-dev), and an audio model (faster-whisper-base). Several dirs are stubs (config only, weights missing). Managing these large files has become a real operational pain.

**Goal:** a full-featured **Model Manager** tab in cluster-dash that scans, enriches, annotates, investigates, and manages (backup/delete) every model on spark1's drive — with durable metadata in Postgres.

### Approved scope (v1)
- Scan & enrich all models (LLM + image + audio).
- Rich model facts from on-disk config.
- Health/integrity checks (incomplete downloads, stub dirs, broken symlinks).
- Duplicate/variant grouping with redundant-disk flagging.
- Disk treemap / sortable size breakdown.
- Editable metadata: tags, rating, star, notes, lifecycle status, **comments thread** — stored in Postgres.
- **Investigate usage**: where/how a model is referenced (live engine + launch scripts + project configs).
- **Delete** with typed-name confirmation + safeguards.
- **Backup to external drive**: detect removable mounts, copy a model to external media, track progress.

### Out of scope (v1)
- Other nodes (spark2/3/4) — designed-in via a `node` column + node-parameterized scan, built in v2.
- Downloading new models (the existing Download/Control flow already covers that).
- Online enrichment from the HF Hub API (offline-first; facts come from local config files).

### Locked sub-decisions
- **(a) Tab accent:** teal `#14b8a6`, label `◆ MODELS`.
- **(b) Delete confirmation:** user must type the **model's name** (last path segment of the repo id, e.g. `Qwen3-235B-A22B-Instruct-2507-FP8`). More meaningful than a generic `DELETE` word.
- **(c) Backup unit:** the **full repo dir** (`models--*` incl. `blobs/`, `snapshots/`, `refs/`) so the copy is a drop-in restorable HF cache entry.

---

## 2. Environment facts (verified)

- **Postgres:** system PG 16 at `127.0.0.1:5432`. Auth as OS user `absolome` via local peer/socket — **no password**. Convention: one DB per project (`daviso`, `altair`, `velaris_office`, …). Connection string style used by daviso:
  `postgresql://absolome@localhost:5432/<db>?host=/var/run/postgresql`
  **No `cluster_dash` DB exists yet** — we create it.
- **DB client:** `pg` (node-postgres) v8 is the existing convention (daviso). No ORM in cluster-dash — use raw `pg`, matching the repo's no-framework, inline-style approach.
- **HF cache root:** `/home/absolome/.cache/huggingface/hub`. Entries are `models--{org}--{name}` → `{org}/{name}`. Each has `blobs/`, `snapshots/<hash>/`, `refs/main`. Snapshots reference blobs (symlinks); config files (`config.json`, `generation_config.json`, `preprocessor_config.json`, `processor_config.json`) live in the active snapshot.
- **Engine detection:** `src/lib/engine.ts` exposes `detectEngine()`, `getEngineModels(host, port)`, `HEAD_HOST`, `API_PORT`, `NODE_LAN_IP`. The currently-served model id is derivable from `getEngineModels`.
- **Tab system:** `src/app/page.tsx` — `activeTab` is a string union; the tab row is a `.map` over a `const` array with a per-tab label/accent lookup. Adding a tab = extend the union + array + a render block.
- **Existing scan logic to reuse/extend:** `src/app/api/control/route.ts` already has `cacheKeyToModelId`, `dirBytes` (via `du -sb`), and incomplete-blob detection — the new scanner generalizes these.
- **Long-running job pattern:** `src/app/api/agent/route.ts` and `src/app/api/backup/route.ts` manage background jobs; the model-backup job follows the same pattern.

---

## 3. Architecture overview

```
page.tsx (new "models" tab)
   └── ModelManagerPanel.tsx ──> /api/models            (GET: scan + facts + health + groups ⨝ DB meta)
        ├── ModelDetail (drawer) ─> /api/models/usage    (GET ?id= : live engine + scripts + configs)
        │                          /api/models/meta      (POST: tags/rating/star/notes/status + comments)
        │                          /api/models/delete     (POST: typed-name confirm + safeguards)
        └── BackupDialog ─────────> /api/models/backup    (GET: targets+job status, POST: start/track)

src/lib/
  db.ts          — pg.Pool singleton + idempotent schema bootstrap
  model-scan.ts  — HF cache scanner: facts, size, health, duplicate grouping
  model-usage.ts — usage investigation (engine/scripts/configs)
  model-backup.ts— external-drive detection + rsync job tracking
  (engine.ts     — reused for served-model detection)
```

Each `src/lib` unit is independently testable: pure-ish functions that take inputs (cache root, model id, node) and return typed data; the API routes are thin glue. v1 passes `node = "spark1"` and reads the local filesystem; v2 will route the same calls over SSH.

---

## 4. Database

**DB:** `cluster_dash` (created once; bootstrap also runnable by app).
**Access:** `DATABASE_URL` env, default
`postgresql://absolome@localhost:5432/cluster_dash?host=/var/run/postgresql`.

`src/lib/db.ts`:
- Lazy `pg.Pool` singleton (module-level, reused across requests — Next dev/prod safe via `globalThis` guard).
- `ensureSchema()` runs `CREATE TABLE IF NOT EXISTS …` once per process (guarded by a module flag); called at the top of each route handler before queries.

### Schema (all tables carry `node` for multi-node forward-compat)

```sql
CREATE TABLE IF NOT EXISTS model_meta (
  node         TEXT        NOT NULL DEFAULT 'spark1',
  model_id     TEXT        NOT NULL,                 -- "Qwen/Qwen3-235B-A22B-Instruct-2507-FP8"
  display_name TEXT,
  tags         TEXT[]      NOT NULL DEFAULT '{}',
  rating       INT,                                  -- 1..5, nullable
  starred      BOOLEAN     NOT NULL DEFAULT false,
  notes        TEXT,                                 -- freeform markdown
  status       TEXT        NOT NULL DEFAULT 'keep',  -- 'keep' | 'archive' | 'candidate-delete'
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
  action     TEXT        NOT NULL,                   -- 'delete' | 'backup' | 'restore'
  detail     JSONB,                                  -- { targetPath, bytes, freedGb, error, ... }
  status     TEXT        NOT NULL,                   -- 'started' | 'success' | 'failed'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_event_model_idx ON model_event (node, model_id, created_at);
```

`status` and `rating` are intentionally un-CHECK-constrained for flexibility; the UI restricts inputs.

---

## 5. Scan engine — `src/lib/model-scan.ts`

`scanModels(cacheRoot = HF_CACHE, node = "spark1"): ScannedModel[]`

Per `models--*` dir:
1. **id** — `cacheKeyToModelId` (reuse logic from control route).
2. **snapshot** — read `refs/main` → hash → `snapshots/<hash>/`. Fallback: newest dir under `snapshots/`.
3. **facts** — parse from the snapshot:
   - `config.json`: `architectures[]`, `model_type`, `hidden_size`, `num_hidden_layers`, `max_position_embeddings` (context), `quantization_config.quant_method` (or infer from name), `torch_dtype`.
   - param count: prefer `model.safetensors.index.json` `metadata.total_size` / dtype heuristic, else estimate from config dims, else `null` (show "—"). Display is best-effort, clearly approximate.
   - modality: `text` default; `vision` if architectures/config indicate VLM or `preprocessor_config.json` present with image keys; `audio` if whisper/audio processor; `image-gen` for diffusion (FLUX → `model_index.json` present / black-forest-labs). Heuristic, documented.
4. **size** — `du -sb` on the repo dir (bytes). (Fast; stats only.)
5. **health** — one of `ready | downloading | incomplete | stub | broken`:
   - `downloading`/`incomplete`: nonzero `*.incomplete` blobs present (reuse control-route rule).
   - `stub`: total size below a small threshold (e.g. < 50 MB) while a config exists → weights missing (catches the 12K FLUX/Ornith dirs).
   - `broken`: snapshot symlinks pointing at absent blobs.
   - `ready`: complete blobs present, no incompletes, size plausible.
6. **served** — set later by the route via engine detection (kept out of the pure scanner).

`groupDuplicates(models): ModelGroup[]` — normalize a base key by stripping org and quant/variant tokens (`FP8`,`FP4`,`NVFP4`,`REAP`,`-GB10`,`-Instruct`, trailing param-size tags) from the name; group by base key. Each group reports member count, total bytes, and **redundant bytes** = total − largest-single-member (rough "reclaimable if deduped" hint). Single-member groups are flagged `unique`.

**Type sketch:**
```ts
type Modality = "text" | "vision" | "audio" | "image-gen" | "unknown";
type Health   = "ready" | "downloading" | "incomplete" | "stub" | "broken";

interface ScannedModel {
  node: string; id: string; org: string; name: string;
  sizeBytes: number;
  modality: Modality;
  arch: string | null; modelType: string | null;
  paramCountB: number | null;        // billions, approximate
  quant: string | null;              // "FP8" | "NVFP4" | "MXFP4" | ...
  contextLen: number | null;
  health: Health; healthDetail: string;
  snapshotHash: string | null; mtime: number;
  groupKey: string;                  // duplicate-group key
  served: boolean;                   // filled by route
}
```

---

## 6. Usage investigation — `src/lib/model-usage.ts`

`investigateUsage(modelId, node = "spark1"): UsageHit[]`

Search the model id **and** its short name across three sources (chosen by the user):
1. **Live engine** — `detectEngine()` + `getEngineModels(HEAD_HOST, API_PORT)`; if served id matches → a hit `{source:"engine", path:"vllm-mm @ spark2:30000", excerpt:"currently served"}`.
2. **Launch scripts** — `grep -rIn` the id + short name in `~/research` (`*.sh`).
3. **Project configs** — `grep -rIn` across `~/sites` excluding `node_modules`, `.git`, `.next`, `.cache`, and the cluster-dash specs themselves; cap results (e.g. first 100 hits) and report the cap.

Returns `{source, path, line, excerpt}[]`, deduped, bounded, with a `truncated` flag. All greps run with timeouts and `|| true` so a slow/large tree never hangs the request.

---

## 7. Backup to external drive — `src/lib/model-backup.ts` + `/api/models/backup`

- **Detect targets** (`GET`): enumerate removable/external mounts via `lsblk -J -o NAME,MOUNTPOINT,SIZE,FSAVAIL,RM,TYPE` and/or `findmnt`, keep mountpoints under `/media`, `/mnt`, `/run/media` (and `RM=1` removable devices). Return `{mountpoint, label, freeBytes}[]`. Also return current job status.
- **Start backup** (`POST {modelId, target}`):
  - Validate `target` is one of the detected mountpoints (no arbitrary paths).
  - Validate free space ≥ model size.
  - `rsync -a --info=progress2 <repoDir>/ <target>/cluster-dash-models/<cacheKey>/` as a tracked **background job** (one at a time), following the `agent`/`backup` route job pattern: spawn, write to a log file, expose progress (parse rsync `%`) + status via `GET`.
  - Write `model_event` rows: `started` then `success`/`failed`.
- Backups are additive and safe (read-only on the source). A model with an in-flight backup is **delete-locked**.

---

## 8. Delete — `/api/models/delete`

`POST {node:"spark1", modelId, confirm}`:
1. `ensureSchema()`, resolve repo dir from `modelId`.
2. **Path safety:** compute absolute path; assert it `startsWith("/home/absolome/.cache/huggingface/hub/models--")` and contains no shell metacharacters/wildcards. Abort otherwise.
3. **Served guard:** refuse if the live engine is serving this model.
4. **Backup-lock guard:** refuse if a backup job for it is running.
5. **Typed confirmation:** `confirm` must equal the model's short name (decision (b)). Refuse with a clear message otherwise.
6. Log `model_event {action:'delete', status:'started', detail:{path, sizeBytes}}`, run `rm -rf <exact path>` (single resolved path, no wildcards — per repo safety rules), then log `success`/`failed` with freed bytes.
7. Response includes freed GB. The UI requires the user to type the name before the button enables.

---

## 9. Frontend — `src/components/ModelManagerPanel.tsx` (+ subcomponents)

Match the existing inline-style design system (colors/sizes from CLAUDE.md). No chart library — visualizations built with `div`s (like `SparkLine`).

- **Summary bar:** total models, total disk, count by health, estimated reclaimable (sum of duplicate-group redundant bytes + stub/broken).
- **Toolbar:** search box; sort (size ▾ / date / name); filter chips (modality, health, status); "group duplicates" toggle.
- **Disk treemap / size bars:** proportional horizontal bars (or simple treemap) colored by modality, biggest first — the space hogs are obvious at a glance.
- **Model list:** rows (or grouped cards when duplicates-toggle on). Each row: name + org, size bar, modality badge, quant, params, context, **health badge**, **SERVED** badge, star, tags, rating.
- **Detail drawer** (expand a row):
  - Facts table (arch, type, params, quant, context, modality, snapshot hash, size, mtime, health detail).
  - **Editable meta:** tags (chips), rating (1–5), star, status select, notes (textarea) → `POST /meta`.
  - **Comments thread:** list + add box → `POST /meta`.
  - **Investigate usage:** button → `GET /usage`, render grouped hits.
  - **Backup:** opens dialog → pick detected target → start → live progress.
  - **Delete:** type-the-name confirm field gating a red Delete button → `POST /delete`.
- Polling: the panel fetches `/api/models` on tab open + a manual Refresh button (scan is heavier than the 3 s cluster poll; no aggressive auto-poll). Backup progress polls while a job is active.

Subcomponents kept small & focused: `ModelRow`, `ModelDetailDrawer`, `ModelTreemap`, `BackupDialog`, `UsageReport`.

---

## 10. Dependencies & config

- Add `pg@^8` (+ `@types/pg` dev) to `package.json`.
- Create DB: `createdb cluster_dash` (or `CREATE DATABASE cluster_dash;`).
- `.env.local` (git-ignored by Next default): `DATABASE_URL=postgresql://absolome@localhost:5432/cluster_dash?host=/var/run/postgresql`. Code falls back to this exact default if env is unset, so it works under PM2 without extra wiring.

---

## 11. Workflow compliance (from CLAUDE.md)

- After code changes: `npm run build` must exit 0, then `pm2 restart cluster-dash`.
- No artificial limits/caps in code (user global rule). Result caps in usage-grep exist only to keep the UI responsive and are generous + reported, not gatekeeping.
- Safety: delete uses a single resolved path, never wildcards; never kills/affects the running engine; backups are read-only on source.
- Commit per the repo's commit-message convention; **do not commit** `.env.local` or host-specific data. Spec doc and code are committable.

---

## 12. Multi-node path (v2, not built)

`scanModels`, `investigateUsage`, `model-backup` all already take a `node` param. v2:
- Add a node switcher in the panel (online nodes from existing cluster data).
- For non-spark1 nodes, run the same scan/grep/du over `ssh <LAN_IP>` (LAN IPs already in `engine.ts`), and `rm`/`rsync` likewise.
- DB rows already keyed by `(node, model_id)` — no migration needed.

---

## 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `du -sb` on ~1.9 TB across 14 dirs is slow | du stats only (fast); scan on demand + manual refresh, not in the 3 s poll. Consider per-dir timeout + cached last-good size. |
| Accidental deletion of a needed/served model | Served-guard + backup-lock + typed-name confirm + path assertion + audit log. |
| Wrong external mount / insufficient space | Validate target against detected mounts; free-space check before rsync. |
| Param/modality heuristics imperfect | Clearly marked approximate; facts degrade to "—" rather than guessing wrong. |
| Postgres unreachable | Routes return a clear error; scan (filesystem facts) still works read-only without DB meta. |
