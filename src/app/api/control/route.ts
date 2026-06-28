import { exec } from "child_process";
import { promisify } from "util";
import { readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import { NextRequest, NextResponse } from "next/server";
import { NODE_LAN_IP } from "@/lib/engine";

export const dynamic = "force-dynamic";
const execAsync = promisify(exec);

const HF_CACHE = "/home/absolome/.cache/huggingface/hub";
const VLLM_IMAGE = "nvcr.io/nvidia/vllm:26.04-py3";

// Current cluster (head=spark2, PP=3 across spark2/3/4) is launched/stopped by this
// known-good script — `up` brings MiniMax-M2.7 FP8 online, `down` removes `vllm-mm`
// on all three nodes. The legacy TP=2 head=spark1 builders below are preserved for revert.
const CLUSTER_SCRIPT = "/home/absolome/research/run-vllm-minimax-fp8-3node.sh";

// ── Per-model defaults for known models ───────────────────────────────────────
// Auto-discovery surfaces any model in the HF cache; this table provides the
// optimal launch parameters. Unknown models fall back to safe generic defaults.
interface ModelDefaults {
  displayName: string;
  expectedGb: number;
  defaultMaxLen: number;
  defaultGpuUtil: number;
  maxGpuUtil: number;        // per-model hard ceiling for the GPU util slider
  maxContextSlider: number;
  note: string;
  toolCallParser: string;    // vLLM --tool-call-parser
  reasoningParser?: string;  // vLLM --reasoning-parser (optional, for thinking/CoT models)
}

const KNOWN_MODELS: Record<string, ModelDefaults> = {
  "Qwen/Qwen3-235B-A22B-Instruct-2507-FP8": {
    displayName: "Qwen3-235B-A22B",
    expectedGb: 220,
    defaultMaxLen: 5680,
    defaultGpuUtil: 0.926,
    maxGpuUtil: 0.926,
    maxContextSlider: 7168,
    note: "5,680 ctx — GPU memory bound",
    toolCallParser: "qwen3_xml",
  },
  "Qwen/Qwen3-Coder-Next-FP8": {
    displayName: "Qwen3-Coder-Next",
    expectedGb: 75,
    defaultMaxLen: 65536,
    defaultGpuUtil: 0.88,
    maxGpuUtil: 0.926,
    maxContextSlider: 65536,
    note: "65K ctx · 80B MoE coding model",
    toolCallParser: "qwen3_xml",
  },
  "Qwen/Qwen3.5-122B-A10B-FP8": {
    displayName: "Qwen3.5-122B-A10B",
    expectedGb: 122,
    defaultMaxLen: 65536,
    defaultGpuUtil: 0.91,
    maxGpuUtil: 0.926,
    maxContextSlider: 65536,
    note: "65K context",
    toolCallParser: "qwen3_xml",
  },
  "openai/gpt-oss-120b": {
    displayName: "GPT-OSS-120B",
    expectedGb: 60, // MXFP4 shards only — original/ BF16 weights are not needed for vLLM
    defaultMaxLen: 32768,
    defaultGpuUtil: 0.88,
    maxGpuUtil: 0.926,
    maxContextSlider: 131072,
    note: "117B MoE · 5.1B active · MXFP4 · harmony tools",
    toolCallParser: "openai",
    reasoningParser: "openai_gptoss",
  },
};

// ── HF cache discovery ────────────────────────────────────────────────────────
function cacheKeyToModelId(cacheKey: string): string {
  // "models--Qwen--Qwen3-Coder-Next-FP8" → "Qwen/Qwen3-Coder-Next-FP8"
  const withoutPrefix = cacheKey.slice("models--".length);
  const idx = withoutPrefix.indexOf("--");
  if (idx === -1) return withoutPrefix;
  return withoutPrefix.slice(0, idx) + "/" + withoutPrefix.slice(idx + 2);
}

function dirBytes(path: string): number {
  try {
    const result = require("child_process").execSync(`du -sb '${path}' 2>/dev/null`, { timeout: 5000 });
    return parseInt(result.toString().split("\t")[0]) || 0;
  } catch { return 0; }
}

function getModels() {
  let cacheDirs: string[] = [];
  try {
    cacheDirs = readdirSync(HF_CACHE).filter((d) => d.startsWith("models--"));
  } catch { /* cache dir missing */ }

  return cacheDirs.map((cacheKey) => {
    const id = cacheKeyToModelId(cacheKey);
    const dir = join(HF_CACHE, cacheKey);
    const blobsDir = join(dir, "blobs");
    const known = KNOWN_MODELS[id];

    const blobs = existsSync(blobsDir) ? readdirSync(blobsDir) : [];
    // A 0-byte .incomplete is orphaned download state (request died before bytes written).
    // Only count nonzero .incomplete files as a real in-flight download.
    const incompleteCount = blobs.filter((f) => {
      if (!f.endsWith(".incomplete")) return false;
      try { return statSync(join(blobsDir, f)).size > 0; } catch { return false; }
    }).length;
    const completeCount = blobs.filter((f) => !f.endsWith(".incomplete")).length;

    const currentGb = dirBytes(dir) / 1073741824;
    const expectedGb = known?.expectedGb ?? 0;

    // Ready: no incomplete blobs AND at least one complete blob present.
    // The .incomplete flag is the authoritative HF cache signal — don't gate on size.
    const ready = incompleteCount === 0 && completeCount > 0;

    const downloadPct =
      expectedGb > 0
        ? Math.min(100, Math.round((currentGb / expectedGb) * 100))
        : incompleteCount === 0
        ? 100
        : 0;

    // Display name: use known config or derive from model id
    const displayName = known?.displayName ?? id.split("/").pop() ?? id;

    return {
      id,
      displayName,
      expectedGb,
      currentGb: Math.round(currentGb * 10) / 10,
      defaultMaxLen: known?.defaultMaxLen ?? 8192,
      defaultGpuUtil: known?.defaultGpuUtil ?? 0.85,
      maxGpuUtil: known?.maxGpuUtil ?? 0.91,
      maxContextSlider: known?.maxContextSlider ?? 32768,
      note: known?.note ?? "Unknown model — using generic defaults",
      ready,
      downloading: incompleteCount > 0,
      downloadPct,
    };
  });
}

// ── vLLM command builders ─────────────────────────────────────────────────────
function buildVllmServeArgs(model: string, maxLen: number, gpuUtil: number, cfg: ModelDefaults): string[] {
  const parserArgs = [`--enable-auto-tool-choice --tool-call-parser ${cfg.toolCallParser}`];
  if (cfg.reasoningParser) parserArgs.push(`--reasoning-parser ${cfg.reasoningParser}`);
  return [
    `vllm serve ${model}`,
    "--tensor-parallel-size 2",
    `--gpu-memory-utilization ${gpuUtil}`,
    `--max-model-len ${maxLen} --kv-cache-dtype fp8 --enforce-eager`,
    ...parserArgs,
    "--host 0.0.0.0 --port 11434",
  ];
}

function buildHeadCmd(model: string, maxLen: number, gpuUtil: number, cfg: ModelDefaults): string {
  return [
    "docker run -d --network host --gpus all --shm-size 10g",
    "-v /home/absolome/.cache/huggingface:/root/.cache/huggingface",
    "-v /home/absolome/.vllm-patches/core.py:/usr/local/lib/python3.12/dist-packages/vllm/v1/engine/core.py:ro",
    "-v /home/absolome/.vllm-patches/multiproc_executor.py:/usr/local/lib/python3.12/dist-packages/vllm/v1/executor/multiproc_executor.py:ro",
    "-e NCCL_SOCKET_IFNAME=enp1s0f1np1 -e UCX_NET_DEVICES=enp1s0f1np1",
    "-e GLOO_SOCKET_IFNAME=enp1s0f1np1 -e VLLM_HOST_IP=192.168.100.10",
    "-e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1",
    `--name vllm-head ${VLLM_IMAGE}`,
    ...buildVllmServeArgs(model, maxLen, gpuUtil, cfg).map((arg, i) =>
      i === 0 ? `${arg} --nnodes 2 --node-rank 0 --master-addr 192.168.100.10 --master-port 29501` : arg
    ),
  ].join(" \\\n  ");
}

function buildWorkerCmd(model: string, maxLen: number, gpuUtil: number, cfg: ModelDefaults): string {
  return [
    "docker run -d --network host --gpus all --shm-size 10g",
    "-v /home/absolome/.cache/huggingface:/root/.cache/huggingface",
    "-v /home/absolome/.vllm-patches/core.py:/usr/local/lib/python3.12/dist-packages/vllm/v1/engine/core.py:ro",
    "-v /home/absolome/.vllm-patches/multiproc_executor.py:/usr/local/lib/python3.12/dist-packages/vllm/v1/executor/multiproc_executor.py:ro",
    "-e NCCL_SOCKET_IFNAME=enp1s0f1np1 -e UCX_NET_DEVICES=enp1s0f1np1",
    "-e GLOO_SOCKET_IFNAME=enp1s0f1np1 -e VLLM_HOST_IP=192.168.100.11",
    "-e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1",
    `--name vllm-worker ${VLLM_IMAGE}`,
    ...buildVllmServeArgs(model, maxLen, gpuUtil, cfg).map((arg, i) =>
      i === 0 ? `${arg} --nnodes 2 --node-rank 1 --master-addr 192.168.100.10 --master-port 29501` : arg
    ),
  ].join(" \\\n  ");
}

export async function GET() {
  return NextResponse.json({ models: getModels() });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      action: string;
      model?: string;
      maxModelLen?: number;
      gpuUtil?: number;
      container?: string;
    };

    if (body.action === "vllm-stop") {
      // Current cluster: remove `vllm-mm` on spark2/3/4 via the script's `down`.
      try {
        const { stdout } = await execAsync(`bash ${CLUSTER_SCRIPT} down 2>&1`, { timeout: 60000 });
        return NextResponse.json({ ok: true, message: `Cluster stopped (vllm-mm removed on spark2/3/4).\n${stdout.trim()}` });
      } catch (e) {
        return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
      }
    }

    if (body.action === "vllm-start") {
      // Current cluster is fixed to MiniMax-M2.7 FP8 PP=3 (the proven config). The
      // model selector / sliders apply to the legacy single-head flow only.
      try {
        const { stdout } = await execAsync(`bash ${CLUSTER_SCRIPT} up 2>&1`, { timeout: 90000 });
        return NextResponse.json({
          ok: true,
          message: `Cluster launching: MiniMax-M2.7 FP8 · PP=3 · spark2/3/4. Weight load ~10–12 min — watch Overview / vLLM logs.\n${stdout.trim()}`,
        });
      } catch (e) {
        return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
      }
    }

    // LEGACY (revert-only): TP=2 head=spark1 :11434 launcher with model selector.
    // Not used by the current dashboard buttons; kept so the old single-head flow
    // is recoverable. Builders: buildHeadCmd / buildWorkerCmd / buildVllmServeArgs.
    if (body.action === "legacy-vllm-start") {
      const model = body.model;
      if (!model) return NextResponse.json({ ok: false, error: "model required" }, { status: 400 });

      // Validate model is actually ready (in cache, no incomplete blobs)
      const models = getModels();
      const cfg = models.find((m) => m.id === model);
      if (!cfg?.ready) {
        return NextResponse.json({ ok: false, error: `Model not ready: ${model}` }, { status: 400 });
      }

      const maxLen = body.maxModelLen ?? cfg.defaultMaxLen;
      const gpuUtil = body.gpuUtil ?? cfg.defaultGpuUtil;

      // Per-model launch defaults — fall back to qwen3_xml for unknown models
      const modelCfg: ModelDefaults = KNOWN_MODELS[model] ?? {
        displayName: cfg.displayName,
        expectedGb: cfg.expectedGb,
        defaultMaxLen: cfg.defaultMaxLen,
        defaultGpuUtil: cfg.defaultGpuUtil,
        maxGpuUtil: cfg.maxGpuUtil,
        maxContextSlider: cfg.maxContextSlider,
        note: cfg.note,
        toolCallParser: "qwen3_xml",
      };

      await Promise.allSettled([
        execAsync("docker rm -f vllm-head 2>/dev/null; true", { timeout: 15000 }),
        execAsync(`ssh -o ConnectTimeout=5 -o BatchMode=yes ${NODE_LAN_IP.spark2} 'docker rm -f vllm-worker 2>/dev/null; true'`, { timeout: 15000 }),
      ]);

      const headCmd = buildHeadCmd(model, maxLen, gpuUtil, modelCfg);
      const workerCmd = buildWorkerCmd(model, maxLen, gpuUtil, modelCfg);

      const [headResult, workerResult] = await Promise.allSettled([
        execAsync(headCmd, { timeout: 30000 }),
        execAsync(`ssh -o ConnectTimeout=10 -o BatchMode=yes ${NODE_LAN_IP.spark2} '${workerCmd}'`, { timeout: 30000 }),
      ]);

      const headOk = headResult.status === "fulfilled";
      const workerOk = workerResult.status === "fulfilled";

      if (!headOk && !workerOk) {
        return NextResponse.json({ ok: false, error: "Both containers failed to start. Check logs." }, { status: 500 });
      }

      return NextResponse.json({
        ok: true,
        message: `Cluster launching: head=${headOk ? "started" : "FAILED"}, worker=${workerOk ? "started" : "FAILED"}. Model loading takes 15–20 min. Monitor in Overview.`,
        headOk,
        workerOk,
      });
    }

    if (body.action === "container-start") {
      const { stdout } = await execAsync(`docker start ${body.container}`, { timeout: 10000 });
      return NextResponse.json({ ok: true, message: stdout.trim() });
    }

    if (body.action === "container-stop") {
      const { stdout } = await execAsync(`docker stop ${body.container}`, { timeout: 15000 });
      return NextResponse.json({ ok: true, message: stdout.trim() });
    }

    return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
