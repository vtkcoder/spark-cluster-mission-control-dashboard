import { exec } from "child_process";
import { promisify } from "util";
import { readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const execAsync = promisify(exec);

const HF_CACHE = "/home/absolome/.cache/huggingface/hub";
const VLLM_IMAGE = "nvcr.io/nvidia/vllm:26.04-py3";

const MODEL_CONFIGS: Record<string, { displayName: string; expectedGb: number; defaultMaxLen: number; defaultGpuUtil: number; note: string }> = {
  "Qwen/Qwen3-235B-A22B-Instruct-2507-FP8": {
    displayName: "Qwen3-235B-A22B",
    expectedGb: 220,
    defaultMaxLen: 5680,
    defaultGpuUtil: 0.926,
    note: "5,680 ctx — GPU memory bound",
  },
  "Qwen/Qwen3.5-122B-A10B-FP8": {
    displayName: "Qwen3.5-122B-A10B",
    expectedGb: 122,
    defaultMaxLen: 65536,
    defaultGpuUtil: 0.91,
    note: "65K context",
  },
};

function dirBytes(path: string): number {
  try {
    const result = require("child_process").execSync(`du -sb '${path}' 2>/dev/null`, { timeout: 5000 });
    return parseInt(result.toString().split("\t")[0]) || 0;
  } catch { return 0; }
}

function getModels() {
  return Object.entries(MODEL_CONFIGS).map(([id, cfg]) => {
    const cacheKey = "models--" + id.replace("/", "--");
    const dir = join(HF_CACHE, cacheKey);
    const exists = existsSync(dir);
    const blobsDir = join(dir, "blobs");
    const incomplete = exists && existsSync(blobsDir)
      ? readdirSync(blobsDir).filter((f) => f.endsWith(".incomplete")).length
      : 0;
    const currentGb = exists ? dirBytes(dir) / 1073741824 : 0;
    const ready = exists && incomplete === 0 && currentGb >= cfg.expectedGb * 0.95;
    return {
      id,
      displayName: cfg.displayName,
      expectedGb: cfg.expectedGb,
      currentGb: Math.round(currentGb * 10) / 10,
      defaultMaxLen: cfg.defaultMaxLen,
      defaultGpuUtil: cfg.defaultGpuUtil,
      note: cfg.note,
      ready,
      downloadPct: Math.min(100, Math.round((currentGb / cfg.expectedGb) * 100)),
    };
  });
}

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
      const cfg = MODEL_CONFIGS[model ?? ""];
      if (!model || !cfg) return NextResponse.json({ ok: false, error: "Invalid model" }, { status: 400 });

      const maxLen = body.maxModelLen ?? cfg.defaultMaxLen;
      const gpuUtil = body.gpuUtil ?? cfg.defaultGpuUtil;

      // Force-remove existing containers before launching new ones
      await Promise.allSettled([
        execAsync("docker rm -f vllm-head 2>/dev/null; true", { timeout: 15000 }),
        execAsync("ssh -o ConnectTimeout=5 -o BatchMode=yes spark2 'docker rm -f vllm-worker 2>/dev/null; true'", { timeout: 15000 }),
      ]);

      const headCmd = buildHeadCmd(model, maxLen, gpuUtil);
      const workerCmd = buildWorkerCmd(model, maxLen, gpuUtil);

      // Launch both in parallel — docker run -d returns immediately
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
        message: `Cluster launching: head=${headOk ? "started" : "FAILED"}, worker=${workerOk ? "started" : "FAILED"}. Model loading takes 15-20 min. Monitor in Overview.`,
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
