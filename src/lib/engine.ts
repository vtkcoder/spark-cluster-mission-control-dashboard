// ── Inference-engine detection & abstraction (AUTO-DETECTING) ────────────────
// The dashboard runs ON spark1. Rather than hardcode a single topology, this
// module DISCOVERS the live cluster at request time:
//   1. Scan every fleet node's `docker ps` for a running vLLM/SGLang container.
//   2. Read the real serve command from inside that container (vLLM/SGLang run
//      via `docker exec`, so the container's own args are just `sleep infinity`)
//      to learn the API port, TP/PP size and node count.
//   3. Probe the OpenAI `/v1/models` endpoint to confirm which node is the head
//      and which port answers.
// This handles ALL of the historical shapes with no code change:
//   • current : container `vllm_node`, head = spark1 (local) + worker spark2, :8001, TP=2
//   • prior   : container `vllm-mm` / `sglang`, head = spark2, :30000, PP=3
//   • legacy  : container `vllm-head`/`vllm-worker`, head = spark1, :11434, PP=4
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
  topology: string;    // parallelism summary e.g. "TP=2 · spark1/spark2"
  parallel: string;    // short tag e.g. "TP=2"
  kvDtype: string;
  metricsPrefix: string; // Prometheus metric prefix to strip
  containers: EngineContainerSpec[];
}

// ── Fleet ─────────────────────────────────────────────────────────────────────
// LAN IPs are used for SSH + API reachability (they route via the router whenever
// the node is powered, independent of the CX7 ring / preflight /32 routes). spark1
// is the local node where the dashboard runs (no SSH, API on localhost).
export const NODE_LAN_IP = {
  spark2: "10.0.0.45",
  spark3: "10.0.0.95",
  spark4: "10.0.0.66",
} as const;

type NodeKey = "spark1" | "spark2" | "spark3" | "spark4";
interface FleetNode { key: NodeKey; host?: string; apiHost: string }

const FLEET: FleetNode[] = [
  { key: "spark1", host: undefined,          apiHost: "localhost" },
  { key: "spark2", host: NODE_LAN_IP.spark2, apiHost: NODE_LAN_IP.spark2 },
  { key: "spark3", host: NODE_LAN_IP.spark3, apiHost: NODE_LAN_IP.spark3 },
  { key: "spark4", host: NODE_LAN_IP.spark4, apiHost: NODE_LAN_IP.spark4 },
];

// Candidate OpenAI-API ports to probe when the port can't be read from the live
// process. Env-overridable: CLUSTER_DASH_API_PORTS="8001,30000". Defaults cover
// the current vLLM (8001), the spark2 cluster era (30000) and the legacy head (11434).
const CANDIDATE_PORTS = (process.env.CLUSTER_DASH_API_PORTS ?? "8001,8000,30000,11434")
  .split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);

// Back-compat fallbacks — some callers still import these. Real values are detected.
export const API_PORT = CANDIDATE_PORTS[0] ?? 8001;
export const HEAD_HOST = "localhost";
// Head SSH target used by getSglangThroughput() default; overridden by detection.
export const HEAD_SSH = NODE_LAN_IP.spark2;

const ENGINE_RE = /vllm|sglang/i;
const WEBUI_RE = /webui/i;

// ── Low-level helpers ─────────────────────────────────────────────────────────
async function sh(inner: string, host: string | undefined, timeout = 4000): Promise<string> {
  const cmd = host
    ? `ssh -o ConnectTimeout=3 -o BatchMode=yes ${host} ${JSON.stringify(inner)}`
    : inner;
  const { stdout } = await execAsync(cmd, { timeout });
  return stdout;
}

// Running container names on a node (empty if the node is offline/unreachable).
async function runningContainers(host?: string): Promise<string[]> {
  try {
    const out = await sh(`docker ps --format '{{.Names}}' 2>/dev/null`, host);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Read the live serve command from inside a container. vLLM/SGLang are launched
// via `docker exec`, so scan every PID's cmdline and keep the serve invocation.
async function readServeCmd(name: string, host?: string): Promise<string> {
  try {
    const out = await sh(
      `docker exec ${name} sh -c 'cat /proc/*/cmdline 2>/dev/null | tr "\\0" " "' 2>/dev/null`,
      host,
      5000,
    );
    return out;
  } catch {
    return "";
  }
}

async function apiAlive(apiHost: string, port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://${apiHost}:${port}/v1/models`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

interface ServeInfo { port?: number; tp?: number; pp?: number; nnodes?: number; sglang: boolean }
function parseServe(cmd: string): ServeInfo {
  const num = (re: RegExp) => { const m = cmd.match(re); return m ? parseInt(m[1], 10) : undefined; };
  return {
    port:   num(/--port[ =](\d+)/),
    tp:     num(/tensor-parallel-size[ =](\d+)/),
    pp:     num(/pipeline-parallel-size[ =](\d+)/),
    nnodes: num(/nnodes[ =](\d+)/),
    sglang: /sglang|sgl[._-]?kernel/i.test(cmd),
  };
}

function noneInfo(): EngineInfo {
  return {
    type: "none", label: "—", port: 0, apiHost: "localhost",
    topology: "—", parallel: "—", kvDtype: "—", metricsPrefix: "",
    // Keep a head placeholder so consumers that look up the "head" container
    // don't crash; it simply resolves to "absent".
    containers: [{ key: "head", name: "vllm_node", label: "head" }],
  };
}

interface EngineNode { node: FleetNode; container: string }

function buildInfo(
  type: Exclude<EngineType, "none">,
  head: FleetNode,
  port: number,
  engineNodes: EngineNode[],
  webui: { name: string; host?: string } | null,
  serve: ServeInfo,
): EngineInfo {
  // Order: head first, then remaining engine nodes as workers.
  const ordered = [
    ...engineNodes.filter((e) => e.node.key === head.key),
    ...engineNodes.filter((e) => e.node.key !== head.key),
  ];
  const keyFor = (i: number): EngineContainerSpec["key"] =>
    i === 0 ? "head" : i === 1 ? "worker" : i === 2 ? "worker2" : "worker3";

  const containers: EngineContainerSpec[] = ordered.map((e, i) => ({
    key: keyFor(i),
    name: e.container,
    host: e.node.host,
    label: i === 0 ? `rank0 · head · ${e.node.key}` : `rank${i} · ${e.node.key}`,
  }));

  // API-only fallback (no container discovered but the endpoint answered).
  if (containers.length === 0) {
    containers.push({ key: "head", name: "vllm_node", host: head.host, label: `head · ${head.key}` });
  }
  if (webui) containers.push({ key: "webui", name: webui.name, host: webui.host, label: "open-webui" });

  const nodeKeys = ordered.map((e) => e.node.key);
  const n = nodeKeys.length || serve.nnodes || 1;
  const parallel = serve.tp
    ? `TP=${serve.tp}`
    : serve.pp
      ? `PP=${serve.pp}`
      : `${n} node${n > 1 ? "s" : ""}`;
  const topology = `${parallel}${nodeKeys.length ? " · " + nodeKeys.join("/") : ""}`;

  return {
    type,
    label: type === "sglang" ? "SGLang" : "vLLM",
    port,
    apiHost: head.apiHost,
    topology,
    parallel,
    kvDtype: type === "sglang" ? "FP8 E4M3" : "FP8",
    metricsPrefix: type === "sglang" ? "sglang:" : "vllm:",
    containers,
  };
}

// ── Detection ─────────────────────────────────────────────────────────────────
export async function detectEngine(): Promise<EngineInfo> {
  // 1. Scan the whole fleet for running containers (parallel; offline nodes → []).
  const scans = await Promise.all(
    FLEET.map(async (node) => ({ node, names: await runningContainers(node.host) })),
  );

  const engineNodes: EngineNode[] = scans
    .map((s) => ({ node: s.node, container: s.names.find((nm) => ENGINE_RE.test(nm)) }))
    .filter((s): s is EngineNode => !!s.container);

  const webuiScan = scans.find((s) => s.names.some((nm) => WEBUI_RE.test(nm)));
  const webui = webuiScan
    ? { name: webuiScan.names.find((nm) => WEBUI_RE.test(nm))!, host: webuiScan.node.host }
    : null;

  // 2. No engine container anywhere — probe the API directly (manual launch),
  //    else report "none".
  if (engineNodes.length === 0) {
    for (const node of FLEET) {
      for (const port of CANDIDATE_PORTS) {
        if (await apiAlive(node.apiHost, port)) {
          return buildInfo("vllm", node, port, [], webui, { sglang: false });
        }
      }
    }
    return noneInfo();
  }

  // 3. Read the real serve command from the first engine node → port + topology + type.
  const primary = engineNodes[0];
  const serve = parseServe(await readServeCmd(primary.container, primary.node.host));
  const type: Exclude<EngineType, "none"> =
    engineNodes.some((e) => /sglang/i.test(e.container)) || serve.sglang ? "sglang" : "vllm";

  // 4. Find the head: the engine node whose API answers. Try the parsed port
  //    first, then the candidate list, across all engine nodes.
  const ports = [serve.port, ...CANDIDATE_PORTS].filter((p): p is number => !!p);
  let head: FleetNode | null = null;
  let apiPort = serve.port ?? API_PORT;
  outer:
  for (const e of engineNodes) {
    for (const port of ports) {
      if (await apiAlive(e.node.apiHost, port)) { head = e.node; apiPort = port; break outer; }
    }
  }
  // Container is up but API not answering yet (mid model-load): assume first node is head.
  if (!head) head = primary.node;

  return buildInfo(type, head, apiPort, engineNodes, webui, serve);
}

// ── OpenAI-endpoint model / metrics readers (host+port supplied by caller) ────
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
// Scrape the latest "gen throughput (token/s): N" from the head container.
export async function getSglangThroughput(container = "sglang", host: string | undefined = HEAD_SSH): Promise<number | null> {
  try {
    const inner = `docker logs --tail 80 ${container} 2>&1 | grep -oE 'gen throughput \\(token/s\\): [0-9.]+' | tail -1 | grep -oE '[0-9.]+$'`;
    const out = await sh(inner, host, 5000);
    const v = parseFloat(out.trim());
    return isNaN(v) ? null : v;
  } catch {
    return null;
  }
}
