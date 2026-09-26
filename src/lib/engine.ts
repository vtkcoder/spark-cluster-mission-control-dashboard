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
import { mkdirSync } from "fs";

const execAsync = promisify(exec);

// ── SSH connection multiplexing ───────────────────────────────────────────────
// One /api/cluster poll fans out to ~15 ssh invocations (4 node collectors, docker
// status/uptime, network counters, engine discovery). A cold handshake to a Spark
// costs ~1.0s, which put the endpoint at ~4s against a 3-second UI poll — requests
// piled up. Reusing one master connection per host drops each call to ~0.02s.
// ControlMaster=auto re-establishes the master transparently if it dies, so this
// is a pure win with no failure mode of its own.
const SSH_CTL_DIR = "/tmp/cluster-dash-ssh";
try { mkdirSync(SSH_CTL_DIR, { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
// Short dir + %r@%h:%p keeps the socket path well inside the 104-char sun_path limit.
const SSH_MUX = `-o ControlMaster=auto -o ControlPath=${SSH_CTL_DIR}/%r@%h:%p -o ControlPersist=30`;

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
// is addressed separately, via SPARK1_HOST/SPARK1_API below — it is only "local"
// (no SSH, API on localhost) when the dashboard actually runs on spark1, which as
// of 2026-09-26 it does NOT: it runs on the Mac mini in remote-spark1 mode.
// 2026-09-26: re-verified ALL LAN IPs by live SSH probe (hostname match), this
// time from the Mac mini where the dashboard now runs. spark2 .45, spark3 .101,
// spark4 .66 all still correct. These are DHCP leases and DO drift — spark1 itself
// moved 10.0.0.102 → 10.0.0.223 and .102 is now a different device entirely, which
// is why spark1 is addressed by mDNS name via CLUSTER_DASH_SPARK1_SSH rather than
// by a baked-in IP. If a node goes OFFLINE, re-probe before assuming it is down:
//   ssh -o ConnectTimeout=3 -o BatchMode=yes absolome@10.0.0.N hostname
// The Spark NIC MACs are fc:9d:05:13:<suffix> where <suffix> matches the hostname
// (edgexpert-77fd → …:77:fd), so `ip neigh` on any node identifies them reliably.
export const NODE_LAN_IP = {
  spark2: "10.0.0.45",
  spark3: "10.0.0.101",
  spark4: "10.0.0.66",
} as const;

function envStr(k: string): string | undefined {
  const v = process.env[k]?.trim();
  return v ? v : undefined;
}

export const NODE_SSH_HOST = {
  spark2: envStr("CLUSTER_DASH_SSH_SPARK2") ?? NODE_LAN_IP.spark2,
  spark3: envStr("CLUSTER_DASH_SSH_SPARK3") ?? NODE_LAN_IP.spark3,
  // spark4 was previously pinned to an IPv6 link-local address because .66 was
  // believed to be shared with an unrelated LAN device. That is NOT true as of
  // 2026-09-26: `ip neigh` resolves 10.0.0.66 to fc:9d:05:13:78:33 — spark4's own
  // NIC MAC — and SSH to it returns edgexpert-7833 from both spark1 and the Mac.
  // The link-local default was actively harmful off-spark1: its %zone named spark1's
  // interface (enP7s7), which does not exist on any other dashboard host, so every
  // spark4 probe failed instantly and the node rendered OFFLINE. Plain IPv4 now.
  // A link-local override is still honoured (CLUSTER_DASH_SSH_SPARK4="fe80::…%en1").
  spark4: envStr("CLUSTER_DASH_SSH_SPARK4") ?? NODE_LAN_IP.spark4,
};

// ── Remote-spark1 mode ────────────────────────────────────────────────────────
// Historically the dashboard ran ON spark1, so "no ssh host" meant "spark1".
// Set CLUSTER_DASH_SPARK1_SSH (e.g. "absolome@edgexpert-74a6.local") to run the
// dashboard on another machine: every spark1-state command is then wrapped in
// ssh, and CLUSTER_DASH_SPARK1_API (default: the host part of the ssh target)
// replaces localhost as spark1's API address. Unset = exact legacy behavior.
export const SPARK1_HOST = envStr("CLUSTER_DASH_SPARK1_SSH");
export const SPARK1_API =
  envStr("CLUSTER_DASH_SPARK1_API") ?? (SPARK1_HOST ? SPARK1_HOST.replace(/^.*@/, "") : "localhost");
// pm2/claude on spark1 live under ~/.npm-global and ~/.local — neither is on
// the non-interactive sshd PATH, so remote invocations need absolute paths.
export const SPARK1_PM2 = SPARK1_HOST
  ? (envStr("CLUSTER_DASH_SPARK1_PM2") ?? "/home/absolome/.npm-global/bin/pm2")
  : "pm2";

type NodeKey = "spark1" | "spark2" | "spark3" | "spark4";
interface FleetNode { key: NodeKey; host?: string; apiHost: string }

const FLEET: FleetNode[] = [
  { key: "spark1", host: SPARK1_HOST,          apiHost: SPARK1_API },
  { key: "spark2", host: NODE_SSH_HOST.spark2, apiHost: NODE_LAN_IP.spark2 },
  { key: "spark3", host: NODE_SSH_HOST.spark3, apiHost: NODE_LAN_IP.spark3 },
  { key: "spark4", host: NODE_SSH_HOST.spark4, apiHost: NODE_LAN_IP.spark4 },
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
export const HEAD_SSH = NODE_SSH_HOST.spark2;

const ENGINE_RE = /vllm|sglang/i;
const WEBUI_RE = /webui/i;

function sshPrefix(host: string, connectTimeout = 3): string {
  const isLinkLocalV6 = host.includes("%");
  const addr = JSON.stringify(isLinkLocalV6 ? `absolome@${host}` : host);
  // -6 / HostKeyAlias only make sense for a link-local IPv6 target (the zone-id
  // form has no stable host-key identity). Keying this off "is this spark4?" broke
  // as soon as spark4 moved back to IPv4 — it forced -6 on an IPv4 address.
  const alias = isLinkLocalV6 ? " -o HostKeyAlias=spark4 -6" : "";
  // accept-new: first contact from a fresh dashboard host must not park on a
  // host-key prompt (BatchMode has nobody to answer it); a CHANGED key still fails.
  return `ssh -o ConnectTimeout=${connectTimeout} -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${SSH_MUX}${alias} ${addr}`;
}

/**
 * POSIX single-quote, so the LOCAL shell hands `inner` to ssh byte-for-byte.
 * JSON.stringify (the previous approach) yields a DOUBLE-quoted word, and a
 * double-quoted word still undergoes `$`, backtick and backslash expansion
 * locally — so `awk '{print $2}'` reached the remote as `awk '{print }'` and
 * silently returned the wrong field. It also embedded `\n` as a literal
 * backslash-n, making multi-line remote scripts impossible.
 */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function sshCommand(inner: string, host: string, connectTimeout = 3): string {
  return `${sshPrefix(host, connectTimeout)} ${shSingleQuote(inner)}`;
}

/** Wrap a spark1-state command: ssh'd in remote-spark1 mode, verbatim when the dashboard runs on spark1. */
export function spark1Cmd(inner: string, connectTimeout = 3): string {
  return SPARK1_HOST ? sshCommand(inner, SPARK1_HOST, connectTimeout) : inner;
}

/** argv for spawn()ing a long-lived spark1-state process (rsync, restic job, claude agent). */
export function spark1SpawnArgs(inner: string): { cmd: string; args: string[] } {
  if (!SPARK1_HOST) return { cmd: "bash", args: ["-c", inner] };
  return {
    cmd: "ssh",
    args: ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-tt", SPARK1_HOST, inner],
  };
}

// ── Low-level helpers ─────────────────────────────────────────────────────────
async function sh(inner: string, host: string | undefined, timeout = 4000): Promise<string> {
  const cmd = host
    ? sshCommand(inner, host)
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
