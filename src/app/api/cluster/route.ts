import { NextResponse } from "next/server";
import {
  detectEngine,
  getEngineModels,
  getEngineMetrics,
  getSglangThroughput,
  NODE_SSH_HOST,
  SPARK1_HOST,
  runRemote,
} from "@/lib/engine";
import {
  COLLECTOR_CMD,
  parseCollectorOutput,
  pickRxInterface,
  toNodeData,
  type NodeData,
  type NodeRaw,
} from "@/lib/node-collector";

export const dynamic = "force-dynamic";

// ── Helpers ───────────────────────────────────────────────────────────────────
interface NodeResult {
  data: NodeData | null;
  error: string | null;
}

async function getNodeStats(host?: string): Promise<NodeResult> {
  const res = await runRemote(COLLECTOR_CMD, host, 8000);
  if (!res.ok) {
    return { data: null, error: res.error ?? "ssh failed" };
  }
  const parsed = parseCollectorOutput(res.stdout);
  if ("error" in parsed) {
    return { data: null, error: parsed.error };
  }
  try {
    return { data: toNodeData(parsed.raw as NodeRaw), error: null };
  } catch (e) {
    return { data: null, error: `collector payload rejected: ${(e as Error).message}` };
  }
}

async function getDockerStatus(container: string, host?: string): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) return "absent";
  const inspect = `docker inspect ${container} --format '{{.State.Status}}' 2>/dev/null || echo absent`;
  const res = await runRemote(inspect, host, 4000);
  if (!res.ok) return "absent";
  return res.stdout.trim() || "absent";
}

async function getDockerUptime(container: string, host?: string): Promise<number | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) return null;
  const inspect = `docker inspect ${container} --format '{{.State.StartedAt}}' 2>/dev/null`;
  const res = await runRemote(inspect, host, 4000);
  if (!res.ok) return null;
  const started = res.stdout.trim();
  if (!started) return null;
  return (Date.now() - new Date(started).getTime()) / 1000;
}

/**
 * One-shot scan of the HF hub cache: for every `models--*` dir report its size
 * and whether it still has `.incomplete` blobs (i.e. a download is in flight).
 *
 * Deliberately a SINGLE command. The previous code ran `readdirSync` plus one
 * `du` and one `ls` per model dir — 43 child processes for the 21 cached models,
 * and in remote-spark1 mode that meant 42 separate SSH handshakes on a 3-second
 * poll. It also read the cache off the LOCAL filesystem, so off-spark1 the dir
 * listing was simply empty and the download panel never showed anything.
 */
async function scanHfCache(
  root: string,
  host?: string,
): Promise<{ key: string; bytes: number; incomplete: boolean }[]> {
  // -sk not -sb: the no-host branch may run on macOS (BSD du has no -b);
  // KB × 1024 is close enough for the download-progress gauges.
  const inner = [
    `cd '${root}' 2>/dev/null || exit 0`,
    `for d in models--*; do`,
    `  [ -d "$d" ] || continue`,
    `  kb=$(du -sk "$d" 2>/dev/null | awk '{print $1}')`,
    `  inc=$(ls "$d/blobs" 2>/dev/null | grep -c '\\.incomplete')`,
    `  printf '%s\\t%s\\t%s\\n' "$d" "\${kb:-0}" "\${inc:-0}"`,
    `done`,
  ].join("\n");
  try {
    const res = await runRemote(inner, host, 60000);
    if (!res.ok) return [];
    return res.stdout
      .split("\n")
      .map((l) => l.split("\t"))
      .filter((p) => p.length === 3 && p[0].startsWith("models--"))
      .map(([key, kb, inc]) => ({
        key,
        bytes: (parseInt(kb, 10) || 0) * 1024,
        incomplete: (parseInt(inc, 10) || 0) > 0,
      }));
  } catch {
    return [];
  }
}

// `du` over the whole hub cache walks a few TB of weights and takes ~6s — far
// longer than the dashboard's 3-second poll, so it must never be on the request
// path. Model sizes only move while a download runs, so serve the last scan and
// refresh it in the background at most once per TTL.
type HfEntry = { key: string; bytes: number; incomplete: boolean };
const HF_SCAN_TTL_MS = 60_000;
let hfScan: { at: number; entries: HfEntry[] } = { at: 0, entries: [] };
let hfScanInflight = false;

function hfCacheSnapshot(root: string, host?: string): HfEntry[] {
  if (!hfScanInflight && Date.now() - hfScan.at > HF_SCAN_TTL_MS) {
    hfScanInflight = true;
    const startedAt = Date.now();
    scanHfCache(root, host)
      // Stamp `at` on failure too, so an unreachable spark1 backs off instead of
      // launching a fresh scan on every poll.
      .then((entries) => { hfScan = { at: startedAt, entries }; })
      .catch(() => { hfScan = { at: startedAt, entries: hfScan.entries }; })
      .finally(() => { hfScanInflight = false; });
  }
  return hfScan.entries;
}

// ── Download speed tracking (module-level cache) ──────────────────────────────
// The RX counters come from the node collector itself (it already reads
// /proc/net/dev), so no extra ssh round-trip is needed per poll.
let prevRx: { spark1: number; spark2: number; ts: number } | null = null;

// ── HF cache config ───────────────────────────────────────────────────────────
const HF_HUB = "/home/absolome/.cache/huggingface/hub";

const KNOWN_EXPECTED_BYTES: Record<string, number> = {
  "Qwen/Qwen3-Coder-Next-FP8":               80_407_787_882,
  "Qwen/Qwen3-235B-A22B-Instruct-2507-FP8": 236_449_103_093,
  "Qwen/Qwen3.5-122B-A10B-FP8":             127_195_722_339,
  "openai/gpt-oss-120b":                     85_899_345_920,
};

function cacheKeyToModelId(key: string): string {
  const s = key.slice("models--".length);
  const i = s.indexOf("--");
  return i === -1 ? s : s.slice(0, i) + "/" + s.slice(i + 2);
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function GET() {
  const NET_IFACE = "enP7s7"; // WAN interface

  // Detect which inference engine is live on the head node (spark2 :30000) — none if down.
  const engine = await detectEngine();
  const headSpec = engine.containers.find((c) => c.key === "head")!;
  const wSpec  = engine.containers.find((c) => c.key === "worker");
  const w2Spec = engine.containers.find((c) => c.key === "worker2");
  const w3Spec = engine.containers.find((c) => c.key === "worker3"); // absent on the 3-node PP=3 topology

  // Auto-discover all model dirs in the HF cache. The cache lives on spark1, so
  // this is read over SSH whenever the dashboard runs elsewhere.
  const modelChecks = hfCacheSnapshot(HF_HUB, SPARK1_HOST).map((e) => {
    const model = cacheKeyToModelId(e.key);
    return {
      model,
      dir: `${HF_HUB}/${e.key}`,
      bytes: e.bytes,
      active: e.incomplete,
      expectedBytes: KNOWN_EXPECTED_BYTES[model] ?? 0,
    };
  });

  const [
    spark1,
    spark2,
    spark3,
    spark4,
    engineModels,
    engineMetrics,
    sglangTokS,
    headStatus,
    workerStatus,
    worker2Status,
    worker3Status,
    webuiStatus,
    headUptime,
  ] = await Promise.all([
    getNodeStats(SPARK1_HOST),
    getNodeStats(NODE_SSH_HOST.spark2),
    getNodeStats(NODE_SSH_HOST.spark3),
    getNodeStats(NODE_SSH_HOST.spark4),
    getEngineModels(engine.apiHost, engine.port),
    getEngineMetrics(engine.apiHost, engine.port, engine.metricsPrefix),
    engine.type === "sglang" ? getSglangThroughput(headSpec.name, headSpec.host) : Promise.resolve(null),
    getDockerStatus(headSpec.name, headSpec.host),
    wSpec  ? getDockerStatus(wSpec.name, wSpec.host)   : Promise.resolve("absent"),
    w2Spec ? getDockerStatus(w2Spec.name, w2Spec.host) : Promise.resolve("absent"),
    w3Spec ? getDockerStatus(w3Spec.name, w3Spec.host) : Promise.resolve("absent"),
    getDockerStatus("open-webui", SPARK1_HOST),
    getDockerUptime(headSpec.name, headSpec.host),
  ]);

  // Network speed (bytes/sec since last poll) — applies to whichever model is
  // active. The counters come from the collector's /proc/net/dev snapshot.
  const now = Date.now();
  const rxOf = (n: NodeResult) => {
    if (!n.data) return 0;
    const pick = pickRxInterface(n.data.netRx, NET_IFACE);
    return pick ? pick.bytes : 0;
  };
  const s1RxBytes = rxOf(spark1);
  const s2RxBytes = rxOf(spark2);
  let dlSpeedS1 = 0;
  if (prevRx) {
    const dt = (now - prevRx.ts) / 1000;
    if (dt > 0) dlSpeedS1 = Math.max(0, (s1RxBytes - prevRx.spark1) / dt);
  }
  prevRx = { spark1: s1RxBytes, spark2: s2RxBytes, ts: now };

  const activeDownloads = modelChecks
    .filter((m) => m.active || (m.expectedBytes > 0 && m.bytes > 0 && m.bytes < m.expectedBytes))
    .map((m) => ({
      model: m.model,
      bytes: m.bytes,
      expectedBytes: m.expectedBytes,
      active: m.active,
      dlSpeedS1: m.active ? dlSpeedS1 : 0,
      dlSpeedS2: 0,
    }));

  return NextResponse.json({
    ts: now,
    nodes: {
      spark1: spark1.data,
      spark2: spark2.data,
      spark3: spark3.data,
      spark4: spark4.data,
    },
    // Why a node has no data. null = collected fine. A node with an error is
    // shown as OFFLINE with the reason instead of a silent zero-filled card.
    nodeErrors: {
      spark1: spark1.error,
      spark2: spark2.error,
      spark3: spark3.error,
      spark4: spark4.error,
    },
    // Active-engine descriptor — drives engine-aware labels/topology in the UI.
    engine: {
      type: engine.type,
      label: engine.label,
      port: engine.port,
      topology: engine.topology,
      parallel: engine.parallel,
      kvDtype: engine.kvDtype,
      headNode: engine.headNode ?? null,
      nodes: engine.nodes ?? [],
      detected: engine.detected !== false,
      note: engine.note ?? null,
      containers: engine.containers.map((c) => ({
        key: c.key,
        label: c.label,
        name: c.name,
        node: c.node ?? null,
        rank: c.rank ?? null,
      })),
    },
    // `vllm` key kept for backward-compat; now reflects WHICHEVER engine is live.
    vllm: {
      online: engineModels !== null,
      model: engineModels?.model ?? null,
      maxModelLen: engineModels?.maxModelLen ?? null,
      throughputTokS: sglangTokS,
      containers: {
        head: headStatus,
        worker: workerStatus,
        worker2: worker2Status,
        worker3: worker3Status,
        webui: webuiStatus,
      },
      headUptimeSec: headUptime,
      metrics: engineMetrics
        ? {
            requestsRunning:
              engineMetrics["num_requests_running"] ?? engineMetrics["num_running_reqs"] ?? 0,
            requestsWaiting:
              engineMetrics["num_requests_waiting"] ?? engineMetrics["num_waiting_reqs"] ?? 0,
            gpuCacheUsagePct:
              (engineMetrics["gpu_cache_usage_perc"] ?? engineMetrics["token_usage"] ?? 0) * 100,
            successTotal:
              engineMetrics["request_success_total"] ?? engineMetrics["num_requests_total"] ?? 0,
            promptTokensTotal: engineMetrics["prompt_tokens_total"] ?? 0,
            generationTokensTotal: engineMetrics["generation_tokens_total"] ?? 0,
            e2eLatencyP50: engineMetrics["e2e_request_latency_seconds_sum"] ?? 0,
          }
        : null,
    },
    downloads: activeDownloads,
  });
}
