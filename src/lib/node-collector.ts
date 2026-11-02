// ── Per-node telemetry collector ──────────────────────────────────────────────
// A small Python program that runs ON the Spark (Linux) and prints one JSON
// object describing the node: CPU, RAM, disk, load, GPU and per-interface RX
// counters. The dashboard (macOS controller) ships it to the node over SSH.
//
// Design notes:
//  * The program travels INSIDE the ssh command, base64-encoded. It used to be
//    written to /tmp/spark_collector.py on the controller and piped in with
//    `< /tmp/spark_collector.py`; that broke whenever the controller's /tmp was
//    cleaned and made the collector depend on a file the dashboard happened to
//    have written earlier. Base64 keeps it self-contained and portable
//    (python does the decoding, so no `base64 -d` / `base64 --decode` split).
//  * Metrics the host cannot report are emitted as JSON null, never 0. On the
//    GB10 the GPU exposes temperature/power/utilisation, but a metric that is
//    genuinely unsupported must not be rendered as "0 °C" or "0 %".
//  * Everything here is Linux-only (/proc, nvitop, df). The controller is
//    macOS and never runs this locally.
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// ── Python collector source ───────────────────────────────────────────────────
export const COLLECTOR_SRC = `
from nvitop import Device
import json, os, subprocess, time

def as_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None

def as_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None

def get_cpu_pct():
    def read():
        with open('/proc/stat') as f:
            return list(map(int, f.readline().split()[1:8]))
    v1 = read(); time.sleep(0.35); v2 = read()
    total = sum(v2) - sum(v1)
    return round(100.0*(1.0-(v2[3]-v1[3])/total),1) if total>0 else None

mem={}
with open('/proc/meminfo') as f:
    for line in f:
        p=line.split(':',1)
        if len(p)==2:
            try:
                mem[p[0].strip()]=int(p[1].split()[0])*1024
            except (ValueError, IndexError):
                pass

disk_total=None; disk_used=None
try:
    df=subprocess.check_output(['df','-B1','/'],text=True).strip().split('\\n')
    if len(df)>1:
        cols=df[1].split()
        disk_total=int(cols[1]); disk_used=int(cols[2])
except Exception:
    pass

load=None
try:
    la=os.getloadavg()
    load=[round(la[0],2),round(la[1],2),round(la[2],2)]
except Exception:
    pass

uptime=None
try:
    uptime=float(open('/proc/uptime').read().split()[0])
except Exception:
    pass

nproc=None
try:
    nproc=int(subprocess.check_output(['nproc']).strip())
except Exception:
    pass

hostname=None
try:
    hostname=subprocess.check_output(['hostname']).decode().strip()
except Exception:
    pass

gpu_name=None; gpu_mem_total=None; gpu_mem_used=None
gpu_util=None; gpu_temp=None; gpu_power_mw=None
try:
    devs=Device.all()
    if devs:
        g=devs[0]
        gpu_name=g.name()
        gpu_mem_total=as_int(g.memory_total())
        gpu_mem_used=as_int(g.memory_used())
        gpu_util=as_float(g.gpu_utilization())
        gpu_temp=as_float(g.temperature())
        gpu_power_mw=as_float(g.power_usage())
except Exception:
    pass

net_rx={}
try:
    with open('/proc/net/dev') as f:
        for line in f.readlines()[2:]:
            if ':' not in line:
                continue
            name,rest=line.split(':',1)
            parts=rest.split()
            if len(parts)>=9:
                try:
                    net_rx[name.strip()]=int(parts[0])
                except ValueError:
                    pass
except Exception:
    pass

print(json.dumps({
    'hostname':hostname,
    'cpu_pct':get_cpu_pct(),
    'cpu_cores':nproc,
    'mem_total':mem.get('MemTotal'),
    'mem_available':mem.get('MemAvailable'),
    'disk_total':disk_total,
    'disk_used':disk_used,
    'load_avg':load,
    'uptime':uptime,
    'gpu_name':gpu_name,
    'gpu_mem_total':gpu_mem_total,
    'gpu_mem_used':gpu_mem_used,
    'gpu_util':gpu_util,
    'gpu_temp':gpu_temp,
    'gpu_power_mw':gpu_power_mw,
    'net_rx':net_rx,
}))
`.trim();

// The command that runs the collector on a node. Base64 keeps the payload free
// of shell metacharacters, so it survives the single-quote wrapping used by
// sshCommand() untouched.
export const COLLECTOR_B64 = Buffer.from(COLLECTOR_SRC, "utf8").toString("base64");
export const COLLECTOR_CMD = `python3 -c "import base64; exec(base64.b64decode('${COLLECTOR_B64}'))"`;

// ── Wire format ───────────────────────────────────────────────────────────────
export interface NodeRaw {
  hostname: string | null;
  cpu_pct: number | null;
  cpu_cores: number | null;
  mem_total: number | null;
  mem_available: number | null;
  disk_total: number | null;
  disk_used: number | null;
  load_avg: [number, number, number] | null;
  uptime: number | null;
  gpu_name: string | null;
  gpu_mem_total: number | null;
  gpu_mem_used: number | null;
  gpu_util: number | null;
  gpu_temp: number | null;
  gpu_power_mw: number | null;
  net_rx: Record<string, number> | null;
}

export interface NodeGpuData {
  name: string | null;
  memTotal: number | null;
  memUsed: number | null;
  util: number | null;
  temp: number | null;
  powerW: number | null;
}

export interface NodeData {
  hostname: string;
  online: boolean;
  cpuPct: number | null;
  cpuCores: number | null;
  memTotal: number;
  /** null when the host did not report MemAvailable — not 0, not "all used". */
  memUsed: number | null;
  diskTotal: number | null;
  diskUsed: number | null;
  loadAvg: [number, number, number] | null;
  uptime: number | null;
  gpu: NodeGpuData;
  netRx: Record<string, number>;
}

/**
 * Map the collector's JSON onto the shape the dashboard renders.
 *
 * `null` in the raw payload means "this host cannot report this metric" and
 * must stay `null` all the way to the UI — turning it into 0 would show a
 * plausible-looking but fabricated reading (0 °C, 0 %, 0 B/s).
 */
export function toNodeData(raw: NodeRaw): NodeData {
  const memTotal = raw.mem_total ?? 0;
  const memUsed =
    raw.mem_available === null || raw.mem_available === undefined
      ? null
      : Math.max(0, memTotal - raw.mem_available);
  return {
    hostname: raw.hostname ?? "unknown",
    online: true,
    cpuPct: raw.cpu_pct ?? null,
    cpuCores: raw.cpu_cores ?? null,
    memTotal,
    memUsed,
    diskTotal: raw.disk_total ?? null,
    diskUsed: raw.disk_used ?? null,
    loadAvg: raw.load_avg ?? null,
    uptime: raw.uptime ?? null,
    gpu: {
      name: raw.gpu_name ?? null,
      memTotal: raw.gpu_mem_total ?? null,
      memUsed: raw.gpu_mem_used ?? null,
      util: raw.gpu_util ?? null,
      temp: raw.gpu_temp ?? null,
      powerW: raw.gpu_power_mw === null ? null : raw.gpu_power_mw / 1000,
    },
    netRx: raw.net_rx ?? {},
  };
}

/**
 * Pick the interface whose RX counter is the "WAN" one.
 *
 * The cluster's wired uplink is `enP7s7` on every Spark (see CLAUDE.md). If a
 * node ever renames it, fall back to the largest non-loopback counter instead
 * of reporting 0 — a wrong interface reads as "no traffic", which is worse
 * than an approximate choice.
 */
export function pickRxInterface(
  netRx: Record<string, number>,
  preferred = "enP7s7",
): { iface: string; bytes: number } | null {
  if (netRx[preferred] !== undefined) return { iface: preferred, bytes: netRx[preferred] };
  const entries = Object.entries(netRx).filter(([name]) => name !== "lo");
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return { iface: entries[0][0], bytes: entries[0][1] };
}

/**
 * Parse a collector payload. Returns null when the payload is not the JSON we
 * expect (e.g. the remote python printed a traceback), so the caller can
 * surface the raw text as an error instead of rendering zeros.
 */
export function parseCollectorOutput(stdout: string): { raw: NodeRaw } | { error: string } {
  const text = stdout.trim();
  if (!text) return { error: "collector returned no output" };
  const lastLine = text.split("\n").filter((l) => l.trim()).pop() ?? "";
  try {
    const parsed = JSON.parse(lastLine) as NodeRaw;
    if (!parsed || typeof parsed !== "object") return { error: "collector returned a non-object payload" };
    return { raw: parsed };
  } catch {
    return { error: `collector output was not JSON: ${lastLine.slice(0, 160)}` };
  }
}

/** Run the collector LOCALLY (only useful for tests / non-Spark hosts). */
export async function runCollectorLocally(): Promise<string> {
  const { stdout } = await execAsync(COLLECTOR_CMD, { timeout: 8000 });
  return stdout;
}
