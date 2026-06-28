// ── Inference-engine detection & abstraction ──────────────────────────────────
// The cluster head moved to **spark2** (2026-06-10): spark1 was freed as a dev box
// / NFS weight server, and the inference cluster now runs across spark2/3/4 (PP=3).
// Two engine shapes are supported on this topology, one at a time:
//   • vLLM  — container `vllm-mm`,  OpenAI API on spark2 :30000  (current default: MiniMax-M2.7 FP8)
//   • SGLang — container `sglang`,  OpenAI API on spark2 :30000  (alternate; kept for revert)
// Because both now serve on :30000, the engine is identified by which CONTAINER is
// running on the head node (spark2), not by port.
//
// LEGACY (pre-4th-spark, head=spark1): vLLM ran as `vllm-head`/`vllm-worker` on
// :11434 (PP=4). Those values are preserved in comments below for revert; the
// dashboard runs ON spark1 so it reaches the head API/containers over LAN+SSH.
// Server-side only (uses child_process).
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export type EngineType = "vllm" | "sglang" | "none";

export interface EngineContainerSpec {
  key: "head" | "worker" | "worker2" | "worker3" | "webui";
  name: string;        // docker container name to inspect
  host?: string;       // ssh host (undefined = local spark1, where the dashboard runs)
  label: string;       // human label for the dashboard
}

export interface EngineInfo {
  type: EngineType;
  label: string;       // "vLLM" | "SGLang" | "—"
  port: number;        // OpenAI-compatible API port on the head node
  apiHost: string;     // host:port reachable from the dashboard (spark1) for the OpenAI API
  topology: string;    // parallelism summary
  parallel: string;    // short tag e.g. "PP=3"
  kvDtype: string;
  metricsPrefix: string; // Prometheus metric prefix to strip
  containers: EngineContainerSpec[];
}

// ── Current cluster topology (head = spark2) ──────────────────────────────────
export const API_PORT = 30000;            // both vLLM-mm and SGLang serve here now
export const HEAD_HOST = "10.0.0.45";     // spark2 LAN IP — API reachable from spark1 over LAN

// SSH targets must be LAN IPs, NOT bare hostnames. /etc/hosts maps spark2/3/4 to the
// CX7 virtual IPs (192.168.99.x), which only route when the ring + preflight /32 routes
// are up — so bare-hostname SSH silently times out for non-adjacent nodes (spark3/spark4)
// even when they're powered on, and their dashboard cards vanish. LAN IPs go via the
// router and are reachable whenever the node is on, independent of CX7/preflight state.
export const NODE_LAN_IP = {
  spark2: "10.0.0.45",
  spark3: "10.0.0.95",
  spark4: "10.0.0.66",
} as const;
export const HEAD_SSH = NODE_LAN_IP.spark2;  // ssh host for head-node docker ops (was "spark2")
// LEGACY: VLLM_PORT = 11434, head API on localhost (spark1).
export const VLLM_PORT = API_PORT;
export const SGLANG_PORT = API_PORT;

// vLLM cluster: `vllm-mm` rank0=spark2 (head/API) → rank1=spark3 → rank2=spark4 (PP=3).
const VLLM_CONTAINERS: EngineContainerSpec[] = [
  { key: "head",    name: "vllm-mm", host: HEAD_SSH, label: "rank0 · spark2" },
  { key: "worker",  name: "vllm-mm", host: NODE_LAN_IP.spark3, label: "rank1 · spark3" },
  { key: "worker2", name: "vllm-mm", host: NODE_LAN_IP.spark4, label: "rank2 · spark4" },
  { key: "webui",   name: "open-webui", label: "open-webui" },
];

// SGLang cluster: `sglang` rank0=spark2 (head/API) → spark3 → spark4 (PP=3).
const SGLANG_CONTAINERS: EngineContainerSpec[] = [
  { key: "head",    name: "sglang", host: HEAD_SSH, label: "rank0 · spark2" },
  { key: "worker",  name: "sglang", host: NODE_LAN_IP.spark3, label: "rank1 · spark3" },
  { key: "worker2", name: "sglang", host: NODE_LAN_IP.spark4, label: "rank2 · spark4" },
  { key: "webui",   name: "open-webui", label: "open-webui" },
];

export function engineInfo(type: EngineType): EngineInfo {
  if (type === "sglang")
    return {
      type, label: "SGLang", port: API_PORT, apiHost: HEAD_HOST,
      topology: "PP=3 · spark2/3/4", parallel: "PP=3",
      kvDtype: "FP8 E4M3", metricsPrefix: "sglang:",
      containers: SGLANG_CONTAINERS,
    };
  if (type === "vllm")
    return {
      type, label: "vLLM", port: API_PORT, apiHost: HEAD_HOST,
      topology: "PP=3 · spark2/3/4", parallel: "PP=3",
      kvDtype: "FP8", metricsPrefix: "vllm:",
      containers: VLLM_CONTAINERS,
    };
  return {
    type: "none", label: "—", port: 0, apiHost: HEAD_HOST,
    topology: "—", parallel: "—", kvDtype: "—", metricsPrefix: "",
    containers: VLLM_CONTAINERS,
  };
}

async function probeApi(host: string, port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://${host}:${port}/v1/models`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function containerRunning(name: string, host?: string): Promise<boolean> {
  try {
    const inspect = `docker inspect ${name} --format '{{.State.Running}}' 2>/dev/null || echo false`;
    const cmd = host ? `ssh -o ConnectTimeout=3 -o BatchMode=yes ${host} "${inspect}"` : inspect;
    const { stdout } = await execAsync(cmd, { timeout: 4000 });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

// Detect the active engine. The head runs on spark2, so identify by which head
// container is up there (both engines share :30000). A live OpenAI endpoint is
// the tie-breaker / fallback when a container is mid model-load or just starting.
export async function detectEngine(): Promise<EngineInfo> {
  const [vlC, sgC] = await Promise.all([
    containerRunning("vllm-mm", HEAD_SSH),
    containerRunning("sglang", HEAD_SSH),
  ]);
  if (vlC) return engineInfo("vllm");
  if (sgC) return engineInfo("sglang");
  // No head container found — fall back to probing the API (covers the legacy
  // case or a manually-launched engine answering on the head port).
  if (await probeApi(HEAD_HOST, API_PORT)) return engineInfo("vllm");
  return engineInfo("none");
}

export interface EngineModel { model: string; maxModelLen: number | null }

export async function getEngineModels(host: string, port: number): Promise<EngineModel | null> {
  if (!port) return null;
  try {
    const res = await fetch(`http://${host}:${port}/v1/models`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { data: { id: string; root?: string; max_model_len?: number }[] };
    if (!data.data?.length) return null;
    const m = data.data[0];
    // Prefer the served id; if it's a cache path, derive org/name. `root` often
    // carries the real HF repo id when a short --served-model-name is used.
    const src = m.id?.includes("/snapshots/") ? (m.root ?? m.id) : m.id;
    const snap = src.match(/models--([^/]+)--([^/]+)\/snapshots/);
    const model = snap ? `${snap[1]}/${snap[2]}` : src;
    return { model, maxModelLen: m.max_model_len ?? null };
  } catch {
    return null;
  }
}

// Parse Prometheus /metrics (vLLM always exposes it; SGLang only with
// --enable-metrics — returns null otherwise, handled gracefully upstream).
export async function getEngineMetrics(host: string, port: number, prefix: string): Promise<Record<string, number> | null> {
  if (!port) return null;
  try {
    const res = await fetch(`http://${host}:${port}/metrics`, { signal: AbortSignal.timeout(2000) });
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
// Scrape the latest "gen throughput (token/s): N" from the rank0 container (on
// spark2) so the dashboard can still show a live tok/s figure for SGLang.
export async function getSglangThroughput(): Promise<number | null> {
  try {
    const inner = `docker logs --tail 80 sglang 2>&1 | grep -oE 'gen throughput \\(token/s\\): [0-9.]+' | tail -1 | grep -oE '[0-9.]+$'`;
    const { stdout } = await execAsync(
      `ssh -o ConnectTimeout=3 -o BatchMode=yes ${HEAD_SSH} "${inner}"`,
      { timeout: 5000 },
    );
    const v = parseFloat(stdout.trim());
    return isNaN(v) ? null : v;
  } catch {
    return null;
  }
}
