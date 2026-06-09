// ── Inference-engine detection & abstraction ──────────────────────────────────
// The cluster can run EITHER the vLLM cluster (port 11434, PP=4, vllm-head/worker
// containers) OR the SGLang cluster (port 30000, TP=4, "sglang" container on every
// node). This module auto-detects which engine is live and returns a uniform
// descriptor so every route/panel can render the right info without hard-coding
// vLLM. Server-side only (uses child_process).
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export type EngineType = "vllm" | "sglang" | "none";

export interface EngineContainerSpec {
  key: "head" | "worker" | "worker2" | "worker3" | "webui";
  name: string;        // docker container name to inspect
  host?: string;       // ssh host (undefined = local spark1)
  label: string;       // human label for the dashboard
}

export interface EngineInfo {
  type: EngineType;
  label: string;       // "vLLM" | "SGLang" | "—"
  port: number;        // OpenAI-compatible API port
  topology: string;    // parallelism summary
  parallel: string;    // short tag e.g. "PP=4" / "TP=4"
  kvDtype: string;
  metricsPrefix: string; // Prometheus metric prefix to strip
  containers: EngineContainerSpec[];
}

export const VLLM_PORT = 11434;
export const SGLANG_PORT = 30000;

const VLLM_CONTAINERS: EngineContainerSpec[] = [
  { key: "head",    name: "vllm-head",   label: "head · spark1" },
  { key: "worker",  name: "vllm-worker", host: "spark2", label: "worker · spark2" },
  { key: "worker2", name: "vllm-worker", host: "spark3", label: "worker · spark3" },
  { key: "worker3", name: "vllm-worker", host: "spark4", label: "worker · spark4" },
  { key: "webui",   name: "open-webui",  label: "open-webui" },
];

const SGLANG_CONTAINERS: EngineContainerSpec[] = [
  { key: "head",    name: "sglang", label: "rank0 · spark1" },
  { key: "worker",  name: "sglang", host: "spark2", label: "rank1 · spark2" },
  { key: "worker2", name: "sglang", host: "spark3", label: "rank2 · spark3" },
  { key: "worker3", name: "sglang", host: "spark4", label: "rank3 · spark4" },
  { key: "webui",   name: "open-webui", label: "open-webui" },
];

export function engineInfo(type: EngineType): EngineInfo {
  if (type === "sglang")
    return {
      type, label: "SGLang", port: SGLANG_PORT,
      topology: "TP=4 · 4 nodes", parallel: "TP=4",
      kvDtype: "FP8 E4M3", metricsPrefix: "sglang:",
      containers: SGLANG_CONTAINERS,
    };
  if (type === "vllm")
    return {
      type, label: "vLLM", port: VLLM_PORT,
      topology: "PP=4 · 4 nodes", parallel: "PP=4",
      kvDtype: "FP8", metricsPrefix: "vllm:",
      containers: VLLM_CONTAINERS,
    };
  return {
    type: "none", label: "—", port: 0,
    topology: "—", parallel: "—", kvDtype: "—", metricsPrefix: "",
    containers: VLLM_CONTAINERS,
  };
}

async function probePort(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://localhost:${port}/v1/models`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function containerRunning(name: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      `docker inspect ${name} --format '{{.State.Running}}' 2>/dev/null || echo false`,
      { timeout: 3000 },
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

// Detect the active engine. Priority: a live OpenAI endpoint wins; if neither
// is serving yet (e.g. mid model-load) fall back to a running container so the
// dashboard still shows the correct engine as "starting". SGLang takes
// precedence if both somehow respond (one big model runs at a time).
export async function detectEngine(): Promise<EngineInfo> {
  const [sgUp, vlUp] = await Promise.all([probePort(SGLANG_PORT), probePort(VLLM_PORT)]);
  if (sgUp) return engineInfo("sglang");
  if (vlUp) return engineInfo("vllm");
  const [sgC, vlC] = await Promise.all([containerRunning("sglang"), containerRunning("vllm-head")]);
  if (sgC) return engineInfo("sglang");
  if (vlC) return engineInfo("vllm");
  return engineInfo("none");
}

export interface EngineModel { model: string; maxModelLen: number | null }

export async function getEngineModels(port: number): Promise<EngineModel | null> {
  if (!port) return null;
  try {
    const res = await fetch(`http://localhost:${port}/v1/models`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { data: { id: string; max_model_len?: number }[] };
    if (!data.data?.length) return null;
    const m = data.data[0];
    const snap = m.id.match(/models--([^/]+)--([^/]+)\/snapshots/);
    const model = snap ? `${snap[1]}/${snap[2]}` : m.id;
    return { model, maxModelLen: m.max_model_len ?? null };
  } catch {
    return null;
  }
}

// Parse Prometheus /metrics (vLLM always exposes it; SGLang only with
// --enable-metrics — returns null otherwise, handled gracefully upstream).
export async function getEngineMetrics(port: number, prefix: string): Promise<Record<string, number> | null> {
  if (!port) return null;
  try {
    const res = await fetch(`http://localhost:${port}/metrics`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const text = await res.text();
    const result: Record<string, number> = {};
    for (const line of text.split("\n")) {
      if (line.startsWith("#") || !line.trim()) continue;
      const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\{?[^}]*\}?\s+([\d.eE+-]+)/);
      if (!m) continue;
      const key = prefix ? m[1].replace(new RegExp(`^${prefix}`), "") : m[1].replace(/^(vllm|sglang):/, "");
      const val = parseFloat(m[2]);
      if (!isNaN(val) && isFinite(val)) result[key] = (result[key] ?? 0) + val;
    }
    return Object.keys(result).length ? result : null;
  } catch {
    return null;
  }
}

// SGLang doesn't expose Prometheus by default, but it logs decode throughput.
// Scrape the latest "gen throughput (token/s): N" from the rank0 container so
// the dashboard can still show a live tok/s figure for SGLang.
export async function getSglangThroughput(): Promise<number | null> {
  try {
    const { stdout } = await execAsync(
      `docker logs --tail 80 sglang 2>&1 | grep -oE 'gen throughput \\(token/s\\): [0-9.]+' | tail -1 | grep -oE '[0-9.]+$'`,
      { timeout: 4000 },
    );
    const v = parseFloat(stdout.trim());
    return isNaN(v) ? null : v;
  } catch {
    return null;
  }
}
