# Spark Cluster Mission Control — Claude Code Agent

> **⚡ CURRENT CONFIG (2026-07-06) — read first.** Detection is now **AUTO** — `src/lib/engine.ts`
> no longer hardcodes a topology. `detectEngine()` discovers the live cluster at request time:
> scans every fleet node's `docker ps` for a running vLLM/SGLang container, reads the real serve
> command from inside it (`/proc/*/cmdline` — the container runs `sleep infinity`, vLLM is a
> `docker exec`) to learn the API port + TP/PP + node count, then probes `/v1/models` to confirm the
> head. **So you normally do NOT edit `engine.ts` when the model/topology/port changes — the
> dashboard adapts.** Candidate API ports are env-overridable via `CLUSTER_DASH_API_PORTS`
> (default `8001,8000,30000,11434`); fleet nodes are `FLEET` in engine.ts.
>
> **⚠️ THE DASHBOARD NO LONGER RUNS ON SPARK1 (verified 2026-09-26).** It runs on the **Mac mini**
> (`absolomes-Mac-mini`, `10.0.0.140`, Tailscale `100.96.8.98`) under **PM2 id 0 `cluster-dash`**, cwd `~/sites/cluster-dash`,
> port **3099**. spark1's PM2 has no `cluster-dash` entry at all. Because of that, **remote-spark1
> mode is mandatory here** — `.env.local` must set `CLUSTER_DASH_SPARK1_SSH` (and
> `CLUSTER_DASH_SPARK1_API`), or every "spark1" command silently runs against macOS and spark1
> renders OFFLINE. Build/restart from the Mac: `npm run build && pm2 restart cluster-dash --update-env`
> (`--update-env` matters — PM2 caches env across plain restarts).
>
> **⚠️ ADDRESSING IS TAILSCALE-ONLY SINCE 2026-09-27 — do not put LAN IPs back.** All node
> addresses live in **`src/lib/nodes.ts`** (`NODES`, `displayAddr()`), imported by both the server
> and the `"use client"` components so a card can never display an address the server isn't
> dialling. Two reasons the LAN is no longer used: (1) all four Sparks sit behind a **TP-Link
> extender at `10.0.0.39` in REPEATER mode** which ARP-proxies every Spark LAN IP with its own MAC
> (`ba:07:1d:0a:a2:4e`), emits gratuitous broadcast ARP, and MAC-translates in both directions —
> from the Mac that means 3ms → 190ms spikes and intermittent loss, i.e. **nodes rendering OFFLINE
> while perfectly healthy**; (2) the LAN IPs are DHCP with no reservations and they drift (spark1
> went `10.0.0.102 → 10.0.0.223`, and `.102` became an unrelated device). mDNS is **not** an option
> fleet-wide — the extender blocks it for spark2/3/4, so `edgexpert-*.local` only ever worked for
> spark1. **If a node renders OFFLINE, run `tailscale status` first** (all four should read `direct`,
> not `relay`). To re-identify a node on the LAN: NIC MACs are `fc:9d:05:13:<hostname-suffix>`
> (edgexpert-77fd → `…:77:fd`), so `ip neigh` on any node maps IP→node.
>
> **What's live now:** engine **vLLM**, container **`vllm_node`**, head = **spark1** + worker =
> **spark3** (NOT spark2 — spark2 and spark4 are up but idle), **TP=2**, OpenAI API on **spark1
> `:8001`** (**port 8001**, not 8000 — 8000 is the restic rest-server), serving
> **`deepseek-ai/DeepSeek-V4-Flash-0731`** over CX7 RoCE (`enp1s0f0np0`/`rocep1s0f0`) on the
> **`192.168.177.0/24`** ring — spark1 `.11`, spark3 `.13` (the old `192.168.100.x` addresses are
> historical). **Launch/stop is NOT via the old
> `~/research/run-vllm-*` scripts** — it's the spark-arena tooling:
> `cd ~/spark-arena/spark-vllm-docker && ./run-recipe.sh deepseek-v4-flash --no-ray --port 8001`.
> **Full model runbook: `~/research/deepseek-v4-flash-2node-runbook.md`** (also logged in
> `~/server-board.md` 2026-07-06). Prior shapes (spark2 `vllm-mm`/`sglang` :30000 PP=3 MiniMax; legacy
> spark1 `vllm-head`+`vllm-worker` :11434 PP=4 — tables further down) still work via auto-detect and
> are historical reference.

## Identity & Mission

You are the AI agent responsible for this repository and the physical infrastructure it monitors. You operate as a **cluster manager and dashboard developer** for a four-node NVIDIA DGX Spark cluster. Every task you receive comes from the dashboard operator via the AGENT tab in the dashboard UI.

Your two responsibilities, in priority order:
1. **Cluster management** — keep vLLM running, models downloaded, services healthy
2. **Dashboard development** — keep this Next.js codebase accurate, fast, and useful

---

## Cluster Hardware

**Tailscale is the address the dashboard uses.** LAN and Wi-Fi columns are reference only.
Re-verified by live SSH hostname probe 2026-09-27.

| Node | Hostname | **Tailscale (use this)** | LAN (eth, DHCP) | Wi-Fi (DHCP) | Fabric rail A / B |
|---|---|---|---|---|---|
| spark1 (master) | edgexpert-74a6 | `100.79.103.61` | 10.0.0.223 | — (`OobeHotspot`, 10.92.7.x — stray) | 192.168.177.11 / 192.168.178.11 |
| spark2 (worker) | edgexpert-77fd | `100.112.35.83` | 10.0.0.45 | 10.0.0.54 | 192.168.177.12 / 192.168.178.12 |
| spark3 (worker) | edgexpert-88dd | `100.71.243.12` | 10.0.0.101 | 10.0.0.100 | 192.168.177.13 / 192.168.178.13 |
| spark4 (worker) | edgexpert-7833 | `100.123.85.111` | 10.0.0.66 | 10.0.0.67 | 192.168.177.14 / 192.168.178.14 |

**`192.168.99.10-13` does not exist and has not since the 2026-07-21 fabric renumber.** It survived
for months as hardcoded display labels on the node cards while the app actually connected elsewhere
— removed 2026-09-27. Do not reintroduce it. Likewise dead: `10.0.0.220`, `10.0.0.102`,
`192.168.102.10`, and the `192.168.100/101/102/103.0/24` link subnets.
Note the Wi-Fi addresses are real Spark interfaces — `10.0.0.100` is spark3's radio, not a dead IP.

Each node: **NVIDIA DGX Spark** — GB10 Grace Blackwell SoC, 128 GB unified CPU+GPU memory (not separate pools — one physical pool shared by CPU and GPU). Total cluster memory: 512 GB.

**⚠️ THE 200G FABRIC IS SPLIT INTO TWO ISLANDS — it is NOT a ring (measured 2026-09-27).**
All-pairs ping on both rails (`192.168.177.0/24` and `192.168.178.0/24`) gives the same partition:

| from \ to | spark1 | spark2 | spark3 | spark4 |
|---|---|---|---|---|
| **spark1** | — | ✗ | ✓ | ✗ |
| **spark2** | ✗ | — | ✗ | ✓ |
| **spark3** | ✓ | ✗ | — | ✗ |
| **spark4** | ✗ | ✓ | ✗ | — |

`{spark1, spark3}` and `{spark2, spark4}`, with **no path between the pairs on either rail**. Only
4 QSFP cables exist, 2 per node, doubling up each pair; `enp1s0f1np1` and `enP2p1s0f1np1` have no
cable on any node. All active links are up at 200000 Mb with MTU 9000 verified
(`ping -M do -s 8972` clean). The NICs are fine — it is the cabling.

**Consequence for multi-node jobs: pair spark1+spark3 or spark2+spark4 — NEVER spark1+spark2.**
Those two have no fast link, so TP/PP across them silently falls back to `enP7s7`, which negotiates
only **1000 Mb** (the switch caps it; the NIC itself supports `10000baseT/Full`) and runs through
the extender. 4-node over the fast fabric needs a QSFP switch — 2 ports/node cannot mesh 4 hosts.

LAN: `enP7s7` on spark1 at 10.0.0.223 via router 10.0.0.1, then through the TP-Link extender.
`/etc/hosts` on every node maps bare `spark1..spark4` to **fabric rail A**, so from spark1 the name
`spark2` is unreachable. Use `spark{1..4}-lan` (10.0.0.x, always reachable) or `-f2` (rail B), added
2026-09-27.

**NFS** (exports rewritten 2026-09-27): spark1 exports `/home/absolome/.cache/huggingface` and
`/home/absolome/shared` to the live Spark eth **and** Wi-Fi addresses plus `192.168.177.0/24` and
`192.168.178.0/24`. The five dead subnets it used to list (`192.168.99/100/101/102/103.0/24`) are
gone. All HF downloads happen on spark1; spark2/3/4 read weights over NFS during inference.

**⚠️ DO NOT "fix" the HF-cache mounts on spark3/spark4 — they are disabled on purpose.** Each of
those nodes holds a **local** HF cache (877 GB / 1018 GB, each with its own 156 GB copy of
DeepSeek-V4-Flash-0731). Their `fstab` lines mounted spark1's cache on top, so a working mount
**shadows the local weights**. The recipe requires every node to load from its OWN cache, and local
NVMe beats NFS over 1 Gb by a wide margin. spark2's line was disabled for this exact reason on
2026-08-01; spark3's and spark4's were briefly enabled on 2026-09-27 and reverted the same day.
The mounts failing at boot was load-bearing, not a bug.

`/home/absolome/shared` on spark2 **is** a real mount and stays (`x-systemd.automount,nofail`, so
boot ordering can't break it). Gotcha if you audit the exports: spark2 connects sourced from its
**Wi-Fi** address, which is why the list includes `10.0.0.54` — omit it and you get
`access denied by server`.

---

## Services & Ports

| Service | Host | Port | Manager |
|---|---|---|---|
| cluster-dash (this app) | **Mac mini** (not spark1) | 3099 | PM2 (id 0) |
| vllm-head | spark1 | 11434 | Docker |
| vllm-worker | spark2 | 11434 | Docker (via SSH) — PP=4 rank 1 |
| vllm-worker | spark3 | 11434 | Docker (via SSH) — PP=4 rank 2 |
| vllm-worker | spark4 | 11434 | Docker (via SSH) — PP=4 rank 3 |
| open-webui | spark1 | 3001 | Docker |
| restic backup | spark1 | 8000 | systemd |
| sshd | spark1+2+3+4 | 22 | systemd |
| Tailscale | spark1 | 41641 | systemd |

SSH: `ssh -o BatchMode=yes spark2 'command'` / `ssh spark3 'command'` — key-based auth, no password needed. SSH trust is full-mesh: any node can reach any other via short hostname.

---

## HuggingFace Model Cache

Cache root: `/home/absolome/.cache/huggingface/hub/`

Directory naming: `models--{org}--{model-name}` → `org/model-name`

| Model | Status | On-disk size | Notes |
|---|---|---|---|
| Qwen/Qwen3-235B-A22B-Instruct-2507-FP8 | READY | 220 GB | 235B MoE, 22B active |
| Qwen/Qwen3-Coder-Next-FP8 | DOWNLOADING | ~80 GB final | 80B MoE, 3B active, coding |
| Qwen/Qwen3.5-122B-A10B-FP8 | PARTIAL | ~122 GB final | 122B MoE, 10B active |
| openai/gpt-oss-120b | READY (MXFP4) | ~60 GB | 117B MoE, 5.1B active. Plus ~50 GB partial `original/` BF16 weights — vLLM doesn't need them |

Download tool: `~/.local/bin/hf download {model-id}` — run with `nohup ... &` and log to `~/modelname-download.log`.

To check download progress: `tail -f ~/qwen3-coder-next-download.log`

To check if a model has incomplete blobs: `ls ~/.cache/huggingface/hub/models--Qwen--Qwen3-Coder-Next-FP8/blobs/ | grep incomplete`

---

## vLLM Cluster

Docker image: `nvcr.io/nvidia/vllm:26.04-py3`
Container names: `vllm-head` (spark1), `vllm-worker` (spark2)
Inference port: 11434 on both nodes

### Launch (both containers must start together)

**Head (spark1):**
```bash
docker run -d --network host --gpus all --shm-size 10g \
  -v /home/absolome/.cache/huggingface:/root/.cache/huggingface \
  -v /tmp/vllm_core.py:/usr/local/lib/python3.12/dist-packages/vllm/v1/engine/core.py:ro \
  -v /tmp/vllm_multiproc.py:/usr/local/lib/python3.12/dist-packages/vllm/v1/executor/multiproc_executor.py:ro \
  -e NCCL_SOCKET_IFNAME=enp1s0f1np1 -e UCX_NET_DEVICES=enp1s0f1np1 \
  -e GLOO_SOCKET_IFNAME=enp1s0f1np1 -e VLLM_HOST_IP=192.168.100.10 \
  -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 \
  --name vllm-head nvcr.io/nvidia/vllm:26.04-py3 \
  vllm serve {MODEL} \
  --nnodes 2 --node-rank 0 --master-addr 192.168.100.10 --master-port 29501 \
  --tensor-parallel-size 2 \
  --gpu-memory-utilization {GPUUTIL} \
  --max-model-len {MAXLEN} --kv-cache-dtype fp8 --enforce-eager \
  --enable-auto-tool-choice --tool-call-parser qwen3_xml \
  --host 0.0.0.0 --port 11434
```

**Worker (spark2, via SSH):**
Same command with `--node-rank 1`, `VLLM_HOST_IP=192.168.100.11`, `--name vllm-worker`.

### Model parameters (use these, don't guess)

| Model | --gpu-memory-utilization | --max-model-len | Notes |
|---|---|---|---|
| Qwen3-235B-A22B-FP8 | 0.926 | 5680 | memory-bound · tool parser qwen3_xml |
| Qwen3-Coder-Next-FP8 | 0.88 | 65536 | 65K ctx · tool parser qwen3_xml |
| Qwen3.5-122B-A10B-FP8 | 0.91 | 65536 | 65K ctx · tool parser qwen3_xml |
| gpt-oss-120b | 0.88 | 32768 | MXFP4 · tool parser `openai` · reasoning parser `openai_gptoss` (harmony format) |

### Stop cluster
```bash
docker rm -f vllm-head 2>/dev/null; true
ssh -o BatchMode=yes spark2 'docker rm -f vllm-worker 2>/dev/null; true'
```

### Check status
```bash
docker inspect vllm-head --format '{{.State.Status}}' 2>/dev/null
curl -s http://localhost:11434/v1/models | python3 -m json.tool
```

---

## Dashboard Codebase Structure

```
~/sites/cluster-dash/
├── src/app/
│   ├── page.tsx              # Main page — all tabs, polling logic, ClusterData type
│   ├── layout.tsx
│   └── api/
│       ├── cluster/route.ts  # GET: node stats, vLLM metrics, model downloads
│       ├── control/route.ts  # GET: model list. POST: vllm-start/stop/container actions
│       ├── agent/route.ts    # GET/POST/DELETE: Claude Code agent job management
│       ├── tasks/route.ts    # GET: running processes, docker containers, systemd
│       ├── pm2/route.ts      # GET: PM2 list. POST: restart/stop/start
│       ├── logs/route.ts     # GET: container and PM2 logs
│       └── chat/route.ts     # POST: proxy to vLLM chat completions
└── src/components/
    ├── AgentPanel.tsx         # Claude Code agent task UI
    ├── ControlPanel.tsx       # vLLM launch/stop + model selector
    ├── DownloadPanel.tsx      # Model download progress bars
    ├── NodeCard.tsx           # Per-node GPU/CPU/RAM gauges
    ├── VllmPanel.tsx          # vLLM inference engine status
    ├── KpiBar.tsx             # Top stats bar
    ├── LogsPanel.tsx          # Log viewer
    ├── Pm2Panel.tsx           # PM2 process manager UI
    ├── SystemTasksPanel.tsx   # Processes, containers, services
    ├── ChatPanel.tsx          # Chat with vLLM
    ├── ArcGauge.tsx           # Circular gauge component
    └── SparkLine.tsx          # Mini sparkline chart
```

### Key data flow

`/api/cluster` polls every 3 seconds → `ClusterData` → feeds `NodeCard`, `VllmPanel`, `KpiBar`, `DownloadPanel`

`/api/control` polls on Control tab load → `ModelInfo[]` → feeds `ControlPanel` model selector

### Design system

Background: `#06090f` (page), `#0c1220` (cards), `#0a1018` (card headers)
Borders: `#1a2540` (standard), `#2a1f50` (download/purple accent)
Text: `#e2e8f0` (primary), `#94a3b8` (secondary), `#475569` (dim), `#334155` (very dim)
Accent colors: `#10b981` (green/ready), `#3b82f6` (blue/selected), `#8b5cf6` (purple/download), `#f59e0b` (amber/warning), `#ef4444` (red/error), `#22d3ee` (cyan/model name)
Font sizes: 9–11px for labels, 14px for headers. Monospace via `fontFamily: "inherit"`.
All styling is inline (no Tailwind classes except globals).

### Model Manager (MODELS tab)

Scans spark1's model storage and manages models. Three scan roots (`scanAllModels` in `model-scan.ts`):
- **HF hub cache** `/home/absolome/.cache/huggingface/hub` — `models--*/snapshots/` layout, `source: "hf"`.
- **Flat layout** `/home/absolome/models` — `config.json` + `*.safetensors` directly in the dir (e.g. `~/models/ornith/Ornith-1.0-397B-FP8`), `source: "flat"`.
- **LM Studio** `/home/absolome/.lmstudio/models` — `<publisher>/<repo>/*.gguf`, `source: "lmstudio"`; quant parsed from the gguf filename, `mmproj-*.gguf` ⇒ vision.

All three support facts/health/metadata/usage/backup/delete (delete path-safety allows all three roots; `findModelDir` resolves the real dir per id). UI shows a per-source breakdown strip + source filter + per-row source badge.
- API: `src/app/api/models/{route,usage,meta,delete,backup}/route.ts`
- Libs: `src/lib/{db,model-scan,model-usage,model-backup,model-types}.ts`
- UI: `src/components/ModelManagerPanel.tsx` + `src/components/models/*`
- Metadata store: Postgres DB `cluster_dash` (tables `model_meta`, `model_comment`, `model_event`). Connection via `DATABASE_URL` in `.env.local` (default socket conn to local PG as `absolome`). Schema auto-bootstraps via `ensureSchema()`.
- Features: rich facts, health/integrity, duplicate-variant grouping, disk treemap, tags/notes/rating/comments, usage investigation (engine/scripts/configs), external-drive backup (rsync), guarded delete (typed-name confirm, served + backup locks, path-safety).
- Tests: `npx vitest run` (pure helpers + Postgres/fs integration). Vitest is the only test tooling in the repo.
- v1 = spark1 only; lib functions take a `node` arg for the v2 multi-node extension (rows keyed by `(node, model_id)`).

---

## Workflow Rules — ALWAYS follow these

### After any code change:
```bash
cd ~/sites/cluster-dash
npm run build        # must succeed — fix errors before continuing
pm2 restart cluster-dash
```

### After completing a task:
```bash
cd ~/sites/cluster-dash
git add -A
git commit -m "$(cat <<'EOF'
type(scope): short description

Detailed explanation of what changed, why, and any caveats.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
git push origin main
```

Remote: `https://github.com/vtkcoder/spark-cluster-mission-control-dashboard.git`

### Update server-board.md for infrastructure changes:
File: `~/server-board.md` — prepend new entries at the top (after the `---` separator).

---

## Safety Rules — NEVER violate these

1. **Never kill vLLM without stating it in your response.** If a task requires stopping vLLM, say so explicitly before running `docker rm -f`.
2. **Never push broken code.** `npm run build` must exit 0 before `git push`.
3. **Never run `rm -rf` without a specific path.** Never use wildcards that could hit unexpected files.
4. **Never edit `/etc/netplan/`, `/etc/NetworkManager/`, or Tailscale config** without explicit user instruction — these can cut remote access.
5. **Never touch the NFS export config** without explicit instruction — losing NFS drops spark2's model access.
6. **Check spark2 is reachable before cluster operations**: `ssh -o ConnectTimeout=3 -o BatchMode=yes spark2 hostname`
7. **HF_HUB_OFFLINE=1 must be set** in vLLM Docker containers — the container has no internet access.
8. **GPU memory utilization hard cap: 0.926** — never exceed this. NCCL needs headroom.

---

## Ops Log

`~/server-board.md` — chronological log of all infrastructure changes. Read it for context before making cluster-level changes. Append to it after significant changes.

---

## Common Tasks Reference

### Check overall cluster health
```bash
tailscale status
systemctl is-active ssh
docker ps
ssh -o BatchMode=yes spark2 'docker ps'
pm2 list
curl -s http://localhost:11434/v1/models 2>/dev/null | python3 -m json.tool
```

### Check a model download
```bash
pgrep -af "hf download"
ls ~/.cache/huggingface/hub/models--Qwen--Qwen3-Coder-Next-FP8/blobs/ | grep -c incomplete
du -sh ~/.cache/huggingface/hub/models--Qwen--Qwen3-Coder-Next-FP8/
```

### Restart just the dashboard
```bash
cd ~/sites/cluster-dash && npm run build && pm2 restart cluster-dash
```

### View vLLM logs
```bash
docker logs --tail 50 vllm-head
ssh -o BatchMode=yes spark2 'docker logs --tail 50 vllm-worker'
```
