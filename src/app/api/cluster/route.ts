import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync, existsSync } from "fs";
import { NextResponse } from "next/server";
import { detectEngine, getEngineModels, getEngineMetrics, getSglangThroughput, NODE_SSH_HOST, SPARK1_HOST, sshCommand } from "@/lib/engine";

export const dynamic = "force-dynamic";

const execAsync = promisify(exec);

// ── Python collector – written to disk once ──────────────────────────────────
const COLLECTOR_PATH = "/tmp/spark_collector.py";
const COLLECTOR_SRC = `
from nvitop import Device
import json, os, subprocess, time

def get_cpu_pct():
    def read():
        with open('/proc/stat') as f:
            return list(map(int, f.readline().split()[1:8]))
    v1 = read(); time.sleep(0.35); v2 = read()
    total = sum(v2) - sum(v1)
    return round(100.0*(1.0-(v2[3]-v1[3])/total),1) if total>0 else 0.0

mem={}
with open('/proc/meminfo') as f:
    for line in f:
        p=line.split(':',1)
        if len(p)==2: mem[p[0].strip()]=int(p[1].split()[0])*1024

df=subprocess.check_output(['df','-B1','/'],text=True).strip().split('\\n')[1].split()
la=os.getloadavg()
uptime=float(open('/proc/uptime').read().split()[0])
nproc=int(subprocess.check_output(['nproc']).strip())
hostname=subprocess.check_output(['hostname']).decode().strip()
gpu=Device.all()[0]

print(json.dumps({
    'hostname':hostname,
    'cpu_pct':get_cpu_pct(),
    'cpu_cores':nproc,
    'mem_total':mem.get('MemTotal',0),
    'mem_available':mem.get('MemAvailable',0),
    'disk_total':int(df[1]),
    'disk_used':int(df[2]),
    'load_avg':[round(la[0],2),round(la[1],2),round(la[2],2)],
    'uptime':uptime,
    'gpu_name':gpu.name(),
    'gpu_mem_total':gpu.memory_total() or 0,
    'gpu_mem_used':gpu.memory_used() or 0,
    'gpu_util':gpu.gpu_utilization() or 0,
    'gpu_temp':gpu.temperature() or 0,
    'gpu_power_mw':gpu.power_usage() or 0,
}))
`.trim();

if (!existsSync(COLLECTOR_PATH)) {
  writeFileSync(COLLECTOR_PATH, COLLECTOR_SRC, { mode: 0o644 });
}

// ── Type definitions ──────────────────────────────────────────────────────────
interface NodeRaw {
  hostname: string;
  cpu_pct: number;
  cpu_cores: number;
  mem_total: number;
  mem_available: number;
  disk_total: number;
  disk_used: number;
  load_avg: [number, number, number];
  uptime: number;
  gpu_name: string;
  gpu_mem_total: number;
  gpu_mem_used: number;
  gpu_util: number;
  gpu_temp: number;
  gpu_power_mw: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getNodeStats(host?: string): Promise<NodeRaw | null> {
  try {
    const cmd = host
      ? `${sshCommand("python3 /dev/stdin", host)} < ${COLLECTOR_PATH}`
      : `python3 ${COLLECTOR_PATH}`;
    const { stdout } = await execAsync(cmd, { timeout: 6000 });
    return JSON.parse(stdout.trim()) as NodeRaw;
  } catch {
    return null;
  }
}

async function getDockerStatus(container: string, host?: string): Promise<string> {
  try {
    const inspect = `docker inspect ${container} --format '{{.State.Status}}' 2>/dev/null || echo absent`;
    const cmd = host ? sshCommand(inspect, host) : inspect;
    const { stdout } = await execAsync(cmd, { timeout: 4000 });
    return stdout.trim() || "absent";
  } catch {
    return "absent";
  }
}

async function getDockerUptime(container: string, host?: string): Promise<number | null> {
  try {
    const inspect = `docker inspect ${container} --format '{{.State.StartedAt}}' 2>/dev/null`;
    const cmd = host ? sshCommand(inspect, host) : inspect;
    const { stdout } = await execAsync(cmd, { timeout: 4000 });
    const started = stdout.trim();
    if (!started) return null;
    return (Date.now() - new Date(started).getTime()) / 1000;
  } catch {
    return null;
  }
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
    const full = host ? sshCommand(inner, host, 5) : inner;
    const { stdout } = await execAsync(full, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    return stdout
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

async function getNetworkRx(iface: string, host?: string): Promise<number> {
  try {
    const cmd = `cat /proc/net/dev | grep '${iface}' | awk '{print $2}'`;
    const full = host ? sshCommand(cmd, host) : cmd;
    const { stdout } = await execAsync(full, { timeout: 2000 });
    return parseInt(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

// ── Download speed tracking (module-level cache) ──────────────────────────────
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
    s1RxBytes,
    s2RxBytes,
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
    getNetworkRx(NET_IFACE, SPARK1_HOST),
    getNetworkRx(NET_IFACE, NODE_SSH_HOST.spark2),
  ]);

  // Network speed (bytes/sec since last poll) — applies to whichever model is active
  const now = Date.now();
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

  const mkNode = (n: NodeRaw | null) =>
    n
      ? {
          hostname: n.hostname,
          online: true,
          cpuPct: n.cpu_pct,
          cpuCores: n.cpu_cores,
          memTotal: n.mem_total,
          memUsed: n.mem_total - n.mem_available,
          diskTotal: n.disk_total,
          diskUsed: n.disk_used,
          loadAvg: n.load_avg,
          uptime: n.uptime,
          gpu: {
            name: n.gpu_name,
            memTotal: n.gpu_mem_total,
            memUsed: n.gpu_mem_used,
            util: n.gpu_util,
            temp: n.gpu_temp,
            powerW: n.gpu_power_mw / 1000,
          },
        }
      : null;

  return NextResponse.json({
    ts: now,
    nodes: {
      spark1: mkNode(spark1),
      spark2: mkNode(spark2),
      spark3: mkNode(spark3),
      spark4: mkNode(spark4),
    },
    // Active-engine descriptor — drives engine-aware labels/topology in the UI.
    engine: {
      type: engine.type,
      label: engine.label,
      port: engine.port,
      topology: engine.topology,
      parallel: engine.parallel,
      kvDtype: engine.kvDtype,
      containers: engine.containers.map((c) => ({ key: c.key, label: c.label })),
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
