import { exec } from "child_process";
import { promisify } from "util";
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const execAsync = promisify(exec);

const HF_CACHE = "/home/absolome/.cache/huggingface/hub";
const VLLM_IMAGE = "nvcr.io/nvidia/vllm:26.04-py3";

// ── Per-model defaults for known models ───────────────────────────────────────
// Auto-discovery surfaces any model in the HF cache; this table provides the
// optimal launch parameters. Unknown models fall back to safe generic defaults.
interface ModelDefaults {
  displayName: string;
  expectedGb: number;        // on-disk FP8/quant size — used for readiness check
  defaultMaxLen: number;
  defaultGpuUtil: number;
  maxContextSlider: number;  // upper bound for the context slider in the UI
  note: string;
}

const KNOWN_MODELS: Record<string, ModelDefaults> = {
  "Qwen/Qwen3-235B-A22B-Instruct-2507-FP8": {
    displayName: "Qwen3-235B-A22B",
    expectedGb: 220,
    defaultMaxLen: 5680,
    defaultGpuUtil: 0.926,
    maxContextSlider: 7168,
    note: "5,680 ctx — GPU memory bound",
  },
  "Qwen/Qwen3-Coder-Next-FP8": {
    displayName: "Qwen3-Coder-Next",
    expectedGb: 75,
    defaultMaxLen: 32768,
    defaultGpuUtil: 0.88,
    maxContextSlider: 65536,
    note: "32K ctx · 80B MoE coding model",
  },
  "Qwen/Qwen3.5-122B-A10B-FP8": {
    displayName: "Qwen3.5-122B-A10B",
    expectedGb: 122,
    defaultMaxLen: 65536,
    defaultGpuUtil: 0.91,
    maxContextSlider: 65536,
    note: "65K context",
  },
  "openai/gpt-oss-120b": {
    displayName: "GPT-OSS-120B",
    expectedGb: 80,
    defaultMaxLen: 32768,
    defaultGpuUtil: 0.88,
    maxContextSlider: 131072,
    note: "120B MoE · 5.1B active · 256K ctx",
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
    const incompleteCount = blobs.filter((f) => f.endsWith(".incomplete")).length;
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
      maxContextSlider: known?.maxContextSlider ?? 32768,
      note: known?.note ?? "Unknown model — using generic defaults",
      ready,
      downloading: incompleteCount > 0,
      downloadPct,
    };
  });
}

// ── vLLM command builders ─────────────────────────────────────────────────────
function buildHeadCmd(model: string, maxLen: number, gpuUtil: number): string {
  return [
    "docker run -d --network host --gpus all --shm-size 10g",
    "-v /home/absolome/.cache/huggingface:/root/.cache/huggingface",
    "-v /tmp/vllm_core.py:/usr/local/lib/python3.12/dist-packages/vllm/v1/engine/core.py:ro",
    "-v /tmp/vllm_multiproc.py:/usr/local/lib/python3.12/dist-packages/vllm/v1/executor/multiproc_executor.py:ro",
    "-e NCCL_SOCKET_IFNAME=enp1s0f1np1 -e UCX_NET_DEVICES=enp1s0f1np1",
    "-e GLOO_SOCKET_IFNAME=enp1s0f1np1 -e VLLM_HOST_IP=192.168.100.10",
    "-e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1",
    `--name vllm-head ${VLLM_IMAGE}`,
    `vllm serve ${model}`,
    "--nnodes 2 --node-rank 0 --master-addr 192.168.100.10 --master-port 29501",
    "--tensor-parallel-size 2",
    `--gpu-memory-utilization ${gpuUtil}`,
    `--max-model-len ${maxLen} --kv-cache-dtype fp8 --enforce-eager`,
    "--enable-auto-tool-choice --tool-call-parser qwen3_xml",
    "--host 0.0.0.0 --port 11434",
  ].join(" \\\n  ");
}

function buildWorkerCmd(model: string, maxLen: number, gpuUtil: number): string {
  return [
    "docker run -d --network host --gpus all --shm-size 10g",
    "-v /home/absolome/.cache/huggingface:/root/.cache/huggingface",
    "-v /tmp/vllm_core.py:/usr/local/lib/python3.12/dist-packages/vllm/v1/engine/core.py:ro",
    "-v /tmp/vllm_multiproc.py:/usr/local/lib/python3.12/dist-packages/vllm/v1/executor/multiproc_executor.py:ro",
    "-e NCCL_SOCKET_IFNAME=enp1s0f1np1 -e UCX_NET_DEVICES=enp1s0f1np1",
    "-e GLOO_SOCKET_IFNAME=enp1s0f1np1 -e VLLM_HOST_IP=192.168.100.11",
    "-e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1",
    `--name vllm-worker ${VLLM_IMAGE}`,
    `vllm serve ${model}`,
    "--nnodes 2 --node-rank 1 --master-addr 192.168.100.10 --master-port 29501",
    "--tensor-parallel-size 2",
    `--gpu-memory-utilization ${gpuUtil}`,
    `--max-model-len ${maxLen} --kv-cache-dtype fp8 --enforce-eager`,
    "--enable-auto-tool-choice --tool-call-parser qwen3_xml",
    "--host 0.0.0.0 --port 11434",
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
      const [headRes, workerRes] = await Promise.allSettled([
        execAsync("docker rm -f vllm-head 2>&1 || true", { timeout: 20000 }),
        execAsync("ssh -o ConnectTimeout=5 -o BatchMode=yes spark2 'docker rm -f vllm-worker 2>&1 || true'", { timeout: 20000 }),
      ]);
      const headOk = headRes.status === "fulfilled";
      const workerOk = workerRes.status === "fulfilled";
      const headOut = headOk ? (headRes.value as { stdout: string }).stdout.trim() : (headRes.reason as Error).message;
      const workerOut = workerOk ? (workerRes.value as { stdout: string }).stdout.trim() : (workerRes.reason as Error).message;
      if (!headOk && !workerOk) {
        return NextResponse.json({ ok: false, error: `head: ${headOut} | worker: ${workerOut}` }, { status: 500 });
      }
      return NextResponse.json({ ok: true, message: `Cluster stopped. head=${headOk ? "removed" : "FAILED: " + headOut}, worker=${workerOk ? "removed" : "FAILED: " + workerOut}` });
    }

    if (body.action === "vllm-start") {
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

      await Promise.allSettled([
        execAsync("docker rm -f vllm-head 2>/dev/null; true", { timeout: 15000 }),
        execAsync("ssh -o ConnectTimeout=5 -o BatchMode=yes spark2 'docker rm -f vllm-worker 2>/dev/null; true'", { timeout: 15000 }),
      ]);

      const headCmd = buildHeadCmd(model, maxLen, gpuUtil);
      const workerCmd = buildWorkerCmd(model, maxLen, gpuUtil);

      const [headResult, workerResult] = await Promise.allSettled([
        execAsync(headCmd, { timeout: 30000 }),
        execAsync(`ssh -o ConnectTimeout=10 -o BatchMode=yes spark2 '${workerCmd}'`, { timeout: 30000 }),
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
