import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync, existsSync } from "fs";
import { NextResponse } from "next/server";

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

interface VllmModel {
  id: string;
  max_model_len?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getNodeStats(remote: boolean): Promise<NodeRaw | null> {
  try {
    const cmd = remote
      ? `ssh -o ConnectTimeout=3 -o BatchMode=yes spark2 python3 /dev/stdin < ${COLLECTOR_PATH}`
      : `python3 ${COLLECTOR_PATH}`;
    const { stdout } = await execAsync(cmd, { timeout: 6000 });
    return JSON.parse(stdout.trim()) as NodeRaw;
  } catch {
    return null;
  }
}

async function getDockerStatus(container: string, remote: boolean): Promise<string> {
  try {
    const inspect = `docker inspect ${container} --format '{{.State.Status}}' 2>/dev/null || echo absent`;
    const cmd = remote ? `ssh -o ConnectTimeout=3 -o BatchMode=yes spark2 "${inspect}"` : inspect;
    const { stdout } = await execAsync(cmd, { timeout: 4000 });
    return stdout.trim() || "absent";
  } catch {
    return "absent";
  }
}

async function getDockerUptime(container: string, remote: boolean): Promise<number | null> {
  try {
    const inspect = `docker inspect ${container} --format '{{.State.StartedAt}}' 2>/dev/null`;
    const cmd = remote ? `ssh -o ConnectTimeout=3 -o BatchMode=yes spark2 "${inspect}"` : inspect;
    const { stdout } = await execAsync(cmd, { timeout: 4000 });
    const started = stdout.trim();
    if (!started) return null;
    return (Date.now() - new Date(started).getTime()) / 1000;
  } catch {
    return null;
  }
}

async function getVllmModels(): Promise<{ model: string; maxModelLen: number | null } | null> {
  try {
    const res = await fetch("http://localhost:11434/v1/models", {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data: VllmModel[] };
    if (!data.data?.length) return null;
    const m = data.data[0];
    return { model: m.id, maxModelLen: m.max_model_len ?? null };
  } catch {
    return null;
  }
}

async function getVllmMetrics(): Promise<Record<string, number> | null> {
  try {
    const res = await fetch("http://localhost:11434/metrics", {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const result: Record<string, number> = {};
    // Parse Prometheus exposition format: metric_name{labels} value
    for (const line of text.split("\n")) {
      if (line.startsWith("#")) continue;
      const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\{?[^}]*\}?\s+([\d.eE+-]+)/);
      if (m) {
        const key = m[1].replace(/^vllm:/, "");
        const val = parseFloat(m[2]);
        if (!isNaN(val)) result[key] = val;
      }
    }
    return Object.keys(result).length ? result : null;
  } catch {
    return null;
  }
}

async function getDiskBytes(path: string, remote: boolean): Promise<number> {
  try {
    const cmd = `du -sb '${path}' 2>/dev/null | awk '{print $1}'`;
    const full = remote ? `ssh -o ConnectTimeout=3 -o BatchMode=yes spark2 "${cmd}"` : cmd;
    const { stdout } = await execAsync(full, { timeout: 5000 });
    return parseInt(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

async function hasIncompleteBlobs(path: string, remote: boolean): Promise<boolean> {
  try {
    const cmd = `ls '${path}/blobs/' 2>/dev/null | grep -c '\\.incomplete' || echo 0`;
    const full = remote ? `ssh -o ConnectTimeout=3 -o BatchMode=yes spark2 "${cmd}"` : cmd;
    const { stdout } = await execAsync(full, { timeout: 3000 });
    return parseInt(stdout.trim()) > 0;
  } catch {
    return false;
  }
}

async function getNetworkRx(iface: string, remote: boolean): Promise<number> {
  try {
    const cmd = `cat /proc/net/dev | grep '${iface}' | awk '{print $2}'`;
    const full = remote ? `ssh -o ConnectTimeout=3 -o BatchMode=yes spark2 "${cmd}"` : cmd;
    const { stdout } = await execAsync(full, { timeout: 2000 });
    return parseInt(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

import { readdirSync } from "fs";

// ── Download speed tracking (module-level cache) ──────────────────────────────
let prevRx: { spark1: number; spark2: number; ts: number } | null = null;

// ── HF cache config ───────────────────────────────────────────────────────────
const HF_HUB = "/home/absolome/.cache/huggingface/hub";

// Known expected sizes (measured or derived) — used to compute % complete.
// Unknown models show raw downloaded bytes with no total.
const KNOWN_EXPECTED_BYTES: Record<string, number> = {
  "Qwen/Qwen3-Coder-Next-FP8":               85_899_345_920,
  "Qwen/Qwen3-235B-A22B-Instruct-2507-FP8": 236_449_103_093,
  "Qwen/Qwen3.5-122B-A10B-FP8":             127_195_722_339,
  "openai/gpt-oss-120b":                     85_899_345_920, // MXFP4 ~80 GiB; update on download
};

function cacheKeyToModelId(key: string): string {
  const s = key.slice("models--".length);
  const i = s.indexOf("--");
  return i === -1 ? s : s.slice(0, i) + "/" + s.slice(i + 2);
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function GET() {
  const NET_IFACE = "enP7s7"; // WAN interface

  // Auto-discover all model dirs in the HF cache
  let cacheDirs: string[] = [];
  try { cacheDirs = readdirSync(HF_HUB).filter((d) => d.startsWith("models--")); } catch { /* ok */ }

  const modelChecks = await Promise.all(
    cacheDirs.map(async (key) => {
      const model = cacheKeyToModelId(key);
      const dir = `${HF_HUB}/${key}`;
      const bytes = await getDiskBytes(dir, false);
      const active = await hasIncompleteBlobs(dir, false);
      const expectedBytes = KNOWN_EXPECTED_BYTES[model] ?? 0;
      return { model, dir, bytes, active, expectedBytes };
    })
  );

  const [
    spark1,
    spark2,
    vllmModels,
    vllmMetrics,
    headStatus,
    workerStatus,
    webuiStatus,
    headUptime,
    s1RxBytes,
    s2RxBytes,
  ] = await Promise.all([
    getNodeStats(false),
    getNodeStats(true),
    getVllmModels(),
    getVllmMetrics(),
    getDockerStatus("vllm-head", false),
    getDockerStatus("vllm-worker", true),
    getDockerStatus("open-webui", false),
    getDockerUptime("vllm-head", false),
    getNetworkRx(NET_IFACE, false),
    getNetworkRx(NET_IFACE, true),
  ]);

  // Network speed (bytes/sec since last poll) — applies to whichever model is active
  const now = Date.now();
  let dlSpeedS1 = 0;
  let dlSpeedS2 = 0;
  if (prevRx) {
    const dt = (now - prevRx.ts) / 1000;
    if (dt > 0) {
      dlSpeedS1 = Math.max(0, (s1RxBytes - prevRx.spark1) / dt);
      dlSpeedS2 = Math.max(0, (s2RxBytes - prevRx.spark2) / dt);
    }
  }
  prevRx = { spark1: s1RxBytes, spark2: s2RxBytes, ts: now };

  // Surface models that are actively downloading or partially complete
  const activeDownloads = modelChecks
    .filter((m) => m.active || (m.expectedBytes > 0 && m.bytes > 0 && m.bytes < m.expectedBytes))
    .map((m) => ({
      model: m.model,
      bytes: m.bytes,
      expectedBytes: m.expectedBytes,
      active: m.active,
      // Speed attributed to the actively downloading model; Spark2 reads via NFS
      dlSpeedS1: m.active ? dlSpeedS1 : 0,
      dlSpeedS2: 0, // spark2 has no independent download — reads via NFS from spark1
    }));

  return NextResponse.json({
    ts: now,
    nodes: {
      spark1: spark1
        ? {
            hostname: spark1.hostname,
            online: true,
            cpuPct: spark1.cpu_pct,
            cpuCores: spark1.cpu_cores,
            memTotal: spark1.mem_total,
            memUsed: spark1.mem_total - spark1.mem_available,
            diskTotal: spark1.disk_total,
            diskUsed: spark1.disk_used,
            loadAvg: spark1.load_avg,
            uptime: spark1.uptime,
            gpu: {
              name: spark1.gpu_name,
              memTotal: spark1.gpu_mem_total,
              memUsed: spark1.gpu_mem_used,
              util: spark1.gpu_util,
              temp: spark1.gpu_temp,
              powerW: spark1.gpu_power_mw / 1000,
            },
          }
        : null,
      spark2: spark2
        ? {
            hostname: spark2.hostname,
            online: true,
            cpuPct: spark2.cpu_pct,
            cpuCores: spark2.cpu_cores,
            memTotal: spark2.mem_total,
            memUsed: spark2.mem_total - spark2.mem_available,
            diskTotal: spark2.disk_total,
            diskUsed: spark2.disk_used,
            loadAvg: spark2.load_avg,
            uptime: spark2.uptime,
            gpu: {
              name: spark2.gpu_name,
              memTotal: spark2.gpu_mem_total,
              memUsed: spark2.gpu_mem_used,
              util: spark2.gpu_util,
              temp: spark2.gpu_temp,
              powerW: spark2.gpu_power_mw / 1000,
            },
          }
        : null,
    },
    vllm: {
      online: vllmModels !== null,
      model: vllmModels?.model ?? null,
      maxModelLen: vllmModels?.maxModelLen ?? null,
      containers: {
        head: headStatus,
        worker: workerStatus,
        webui: webuiStatus,
      },
      headUptimeSec: headUptime,
      metrics: vllmMetrics
        ? {
            requestsRunning: vllmMetrics["num_requests_running"] ?? 0,
            requestsWaiting: vllmMetrics["num_requests_waiting"] ?? 0,
            gpuCacheUsagePct: (vllmMetrics["gpu_cache_usage_perc"] ?? 0) * 100,
            successTotal: vllmMetrics["request_success_total"] ?? 0,
            promptTokensTotal: vllmMetrics["prompt_tokens_total"] ?? 0,
            generationTokensTotal: vllmMetrics["generation_tokens_total"] ?? 0,
            e2eLatencyP50: vllmMetrics["e2e_request_latency_seconds_sum"] ?? 0,
          }
        : null,
    },
    downloads: activeDownloads,
  });
}
