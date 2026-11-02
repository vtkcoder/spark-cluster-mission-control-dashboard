# Cluster Dash — Project Board

Operational board for the Spark Cluster Mission Control dashboard. Authoritative
for *this* deployment; the repo's `CLAUDE.md` carries the longer cluster history.

Last updated: **2026-11-02** (repair of the all-nodes-OFFLINE outage + engine
metadata rewrite for the live SGLang 4-node launch).

---

## 1. Where it runs

| Item | Value |
|---|---|
| App | Cluster Dash (Next.js 15.3.2, App Router) |
| Host | **Mac mini** — `absolomes-Mac-mini`, `100.96.8.98` (Tailscale) |
| Repo | `/Users/absolome/sites/cluster-dash` (remote: `github.com/vtkcoder/spark-cluster-mission-control-dashboard`) |
| URL | **http://100.96.8.98:3099/** (also `http://localhost:3099/` on the Mac) |
| Process manager | **PM2**, app name `cluster-dash`, **id 0**, `fork` mode |
| PM2 exec | `/opt/homebrew/bin/npm start` → `next start -p 3099`, cwd = repo root |
| Node runtime | `/opt/homebrew/Cellar/node/26.9.0/bin/node` (26.9.0) |
| Logs | `~/.pm2/logs/cluster-dash-out.log`, `~/.pm2/logs/cluster-dash-error.log` |
| DB | local Postgres `cluster_dash` — `DATABASE_URL=postgresql://absolome@localhost:5432/cluster_dash` |
| Poll interval | 3 s (`/api/cluster`), 5 s for the tasks tab |

**It does NOT run on spark1.** spark1's PM2 has no `cluster-dash` entry. The app
runs in *remote-spark1 mode*: `CLUSTER_DASH_SPARK1_SSH` / `CLUSTER_DASH_SPARK1_API`
in `.env.local` (gitignored) point at spark1's Tailscale address.

---

## 2. Stable targets (never hardcode LAN IPs in the app)

`src/lib/nodes.ts` is the single source of truth; both the server and the client
components import it, so a card can never display an address the server is not
dialling.

| Node | Hostname | Tailscale (used) | LAN (reference only) |
|---|---|---|---|
| spark1 | `edgexpert-74a6` | `100.79.103.61` | 10.0.0.223 |
| spark2 | `edgexpert-77fd` | `100.112.35.83` | 10.0.0.45 (DHCP, drifts) |
| spark3 | `edgexpert-88dd` | `100.71.243.12` | 10.0.0.101 (DHCP, drifts) |
| spark4 | `edgexpert-7833` | `100.123.85.111` | 10.0.0.66 (DHCP, drifts) |

SSH: `ssh -o BatchMode=yes absolome@<tailscale-ip> '<cmd>'` — key-based, no
password, `StrictHostKeyChecking=accept-new` (never `no`).
The dashboard reaches the nodes with an SSH **ControlMaster** socket in
`~/.cd-ssh` (NOT `/tmp` — macOS's periodic cleaner deletes `/tmp` directories and
that took the whole fleet offline; see §6).

---

## 3. Live serving stack (read-only observation — the dashboard adapts to it)

| Item | Value |
|---|---|
| Engine | **SGLang** (`sglang.launch_server`) inside a custom image |
| Image / container | `dsv41-4x-spark:canary-roce` · `dsv41-head` (spark3) + `dsv41-worker` (spark1/2/4) |
| Model | `deepseek-v4.1-flash` (`/models/DeepSeek-V4.1-Flash`) |
| Parallelism | `--tp 4 --nnodes 4` → **TP=4, 4 nodes** |
| Head (rank 0) | **spark3** — `100.71.243.12:8001` |
| Ranks | rank0 spark3 · rank1 spark4 · rank2 spark1 · rank3 spark2 |
| API | OpenAI-compatible `http://100.71.243.12:8001/v1` (also `/v1/models`, `/health`) |
| Context | 1 048 576 tok (`--context-length 1048576`) |
| Prometheus | **off** (no `--enable-metrics`) → decode tok/s is scraped from the rank0 log |

Container names contain neither "vllm" nor "sglang", so engine discovery reads
the **process** inside each container (`docker exec … cat /proc/*/cmdline`) and
parses `--tp/--tp-size/--tensor-parallel-size`, `--pp`, `--nnodes`, `--node-rank`,
`--port`, `--context-length`. `--node-rank 0` identifies the head.

---

## 4. Deployment commands (this instance only)

```bash
cd /Users/absolome/sites/cluster-dash

npx tsc --noEmit          # typecheck
npx vitest run            # tests (serial; touches local PG + filesystem)
npm run build             # production build -> .next

export PATH="/opt/homebrew/bin:$PATH"
pm2 restart cluster-dash --update-env   # SAME app, id 0 — never start a second one
```

Never: `pm2 start` a duplicate, global npm installs, systemd, or restarting
anything other than the `cluster-dash` PM2 app.

Verification after a deploy:

```bash
curl -s http://127.0.0.1:3099/api/cluster | python3 -m json.tool
# expect: 4 non-null nodes, nodeErrors all null,
#         engine.type=sglang, engine.topology="TP=4 · spark1/spark2/spark3/spark4"
```

---

## 5. Verification performed 2026-11-02 (post-repair)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 11 files / 74 tests passed (27 new for this repair) |
| `npm run build` | compiled, BUILD_ID `3IBtKzKy5Xda23ASGvYnG` |
| `GET /api/cluster` | HTTP 200, ~0.62 s, **4/4 non-null nodes**, `nodeErrors` all null |
| Engine metadata | `sglang` · `TP=4 · spark1/spark2/spark3/spark4` · head `spark3` · 4 containers mapped by rank |
| Container states | head/worker/worker2/worker3 = `running` |
| Source↔host reconciliation | **64/64 field checks OK, 0 mismatches** (see `evidence/reconciliation.json`) |
| GPU gauge liveness | dashboard reported spark1 util 57 % while `nvidia-smi` sampled the same window → gauge is live, not a stuck 0 |
| Browser (headless Chrome + CDP) | overview renders 4 populated cards, KPI `4 / 4`, `ALL SYSTEMS GO`, engine panel lists all 4 ranks |
| Resilience | deleting `~/.cd-ssh` under the running app → next poll still returns 4/4 (dir recreated on demand) |
| Other endpoints | `/api/inference`, `/api/models`, `/api/tasks`, `/api/benchmarks/target`, `/api/logs`, `/api/pm2` → HTTP 200 |

Evidence + full report: `/Users/absolome/.hermes/cache/scratch/cluster-dash-repair/`.

---

## 6. Failure modes that bit us (do not regress these)

1. **SSH control socket in `/tmp`** — the socket dir was created once at module
   load under `/tmp/cluster-dash-ssh`. macOS's periodic cleaner deleted it and
   *every* ssh died with `unix_listener: cannot bind to path …`. Because both the
   node collectors AND the container discovery go over ssh, that single missing
   directory produced both symptoms at once: 4 null nodes **and** bogus engine
   metadata ("vLLM · 1 node", all containers "absent").
   *Now*: `~/.cd-ssh`, re-created on every command build, plus a
   non-multiplexed retry when the control socket errors.
2. **Engine discovery by container name** — `/vllm|sglang/i` never matched
   `dsv41-*`. *Now*: classify by the process inside the container.
3. **Only the vLLM flag dialect was parsed** — `--tp`/`--nnodes`/`--node-rank`
   were unknown, so an SGLang launch was reported as "1 node". *Now*: both
   dialects.
4. **Fabricated zeros** — unsupported metrics were coerced to `0`. *Now*: `null`
   all the way to the UI, which renders `n/a`; node collection errors are
   surfaced per node in `nodeErrors` and shown on the card instead of a silent
   "NODE OFFLINE".

---

## 7. Known gaps (not part of the 2026-11-02 repair)

- **MODELS tab is empty.** `src/lib/model-scan.ts` still reads the *local*
  filesystem (`/home/absolome/.cache/huggingface/hub`), which does not exist on
  the Mac mini. It needs a remote (SSH) scan like the HF-cache download panel
  already uses. Tracked as a WaitRoom item.
- **CLUSTER CONTROL tab still targets the legacy vLLM containers**
  (`vllm_node`) and the legacy launch flow; it does not control the SGLang
  `dsv41-*` deployment, which is launched externally.
- `open-webui` on spark1 is **exited** (reported truthfully by the dashboard).
