// ── Inference-engine detection & abstraction (AUTO-DETECTING) ────────────────
// The dashboard runs on the Mac mini (remote-spark1 mode). Rather than hardcode
// a single topology, this module DISCOVERS the live cluster at request time:
//   1. Scan every fleet node's `docker ps` for running containers.
//   2. Read the real serve command from INSIDE each container (vLLM/SGLang run
//      via `docker exec`, so the container's own args are just `sleep infinity`)
//      and classify it. The container NAME is only a fallback: the live
//      deployment's containers are called `dsv41-head` / `dsv41-worker`, which
//      match no engine name pattern at all.
//   3. Take the launch parameters from that command — port, TP/PP, node count,
//      node rank — and use `--node-rank 0` to identify the head. The OpenAI
//      `/v1/models` endpoint is probed as a fallback and to confirm liveness.
// This handles ALL of the historical shapes with no code change:
//   • current : SGLang `dsv41-head` on spark3 (rank0) + `dsv41-worker` on
//               spark4/spark1/spark2 (rank 1/2/3), :8001, TP=4, nnodes=4
//   • prior   : container `vllm_node`, head = spark1 + worker spark3, :8001, TP=2
//   • older   : container `vllm-mm` / `sglang`, head = spark2, :30000, PP=3
//   • legacy  : container `vllm-head`/`vllm-worker`, head = spark1, :11434, PP=4
// These are DESCRIPTIONS of observed shapes, not configuration — nothing here pins
// a node pair. The worker set is chosen at launch time by the spark-arena
// `run-recipe.sh` invocation on spark1; the recipe YAML carries no node list.
// Server-side only (uses child_process).
import { exec } from "child_process";
import { promisify } from "util";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { NODES, type NodeKey } from "./nodes";

const execAsync = promisify(exec);

// ── SSH connection multiplexing ───────────────────────────────────────────────
// One /api/cluster poll fans out to ~15 ssh invocations (4 node collectors, docker
// status/uptime, network counters, engine discovery). A cold handshake to a Spark
// costs ~1.0s, which put the endpoint at ~4s against a 3-second UI poll — requests
// piled up. Reusing one master connection per host drops each call to ~0.02s.
// ControlMaster=auto re-establishes the master transparently if it dies, so this
// is a pure win with no failure mode of its own.
//
// THE DIRECTORY MUST EXIST BEFORE EVERY CALL. It used to live in /tmp and be
// created once at module load; macOS's periodic /tmp cleaner deleted it
// (2026-11-02) and from then on EVERY ssh died with
//     unix_listener: cannot bind to path …: No such file or directory
// which took all four nodes offline AND blinded engine discovery (both go
// through ssh). The dir now lives under $HOME — nothing reaps that — and is
// re-created on demand, so a wipe can never take the fleet down again.
// Short dir + %r@%h:%p keeps the socket path well inside the 104-char
// sun_path limit.
export const SSH_CTL_DIR = join(homedir(), ".cd-ssh");

function ensureSshCtlDir(): void {
  try {
    mkdirSync(SSH_CTL_DIR, { recursive: true, mode: 0o700 });
  } catch {
    /* best effort — runRemote() retries without multiplexing if this failed */
  }
}

const SSH_MUX = `-o ControlMaster=auto -o ControlPath=${SSH_CTL_DIR}/%r@%h:%p -o ControlPersist=30`;

export type EngineType = "vllm" | "sglang" | "none";

export interface EngineContainerSpec {
  key: "head" | "worker" | "worker2" | "worker3" | "webui";
  name: string;        // docker container name to inspect
  host?: string;       // ssh host (undefined = local spark1, where the dashboard runs)
  node?: NodeKey | null; // which fleet node runs this container
  rank?: number | null;  // --node-rank of the engine process
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
  headNode?: NodeKey | null;   // which node serves the API
  nodes?: NodeKey[];           // fleet nodes taking part in the launch
  detected?: boolean;          // false = only the API answered, no engine container seen
  note?: string;               // human-readable reason when detection was degraded
}

// ── Fleet ─────────────────────────────────────────────────────────────────────
// LAN IPs are used for SSH + API reachability (they route via the router whenever
// the node is powered, independent of the CX7 ring / preflight /32 routes). spark1
// is addressed separately, via SPARK1_HOST/SPARK1_API below — it is only "local"
// (no SSH, API on localhost) when the dashboard actually runs on spark1, which as
// of 2026-09-26 it does NOT: it runs on the Mac mini in remote-spark1 mode.
// 2026-09-27: addressing moved off the LAN entirely and onto Tailscale. The LAN
// path runs through a TP-Link extender in repeater mode that ARP-proxies every
// Spark IP and drops packets, and the LAN IPs are drifting DHCP leases. Both the
// addresses and the full rationale now live in ./nodes, which the client
// components import too so a card can never display an address the server is not
// actually dialling. If a node renders OFFLINE, check `tailscale status` first.

function envStr(k: string): string | undefined {
  const v = process.env[k]?.trim();
  return v ? v : undefined;
}

// Per-node SSH target. Defaults to the Tailscale address; each is still
// env-overridable for recovery (e.g. CLUSTER_DASH_SSH_SPARK4="10.0.0.66" to fall
// back to the LAN, or a link-local "fe80::…%en1" form) without a code change.
export const NODE_SSH_HOST = {
  spark2: envStr("CLUSTER_DASH_SSH_SPARK2") ?? NODES.spark2.ts,
  spark3: envStr("CLUSTER_DASH_SSH_SPARK3") ?? NODES.spark3.ts,
  spark4: envStr("CLUSTER_DASH_SSH_SPARK4") ?? NODES.spark4.ts,
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

export interface FleetNode { key: NodeKey; host?: string; apiHost: string }

const FLEET: FleetNode[] = [
  { key: "spark1", host: SPARK1_HOST,          apiHost: SPARK1_API },
  { key: "spark2", host: NODE_SSH_HOST.spark2, apiHost: NODES.spark2.ts },
  { key: "spark3", host: NODE_SSH_HOST.spark3, apiHost: NODES.spark3.ts },
  { key: "spark4", host: NODE_SSH_HOST.spark4, apiHost: NODES.spark4.ts },
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

/** Docker names are restricted to [A-Za-z0-9_.-]; refuse anything else before
 *  interpolating a name into a remote shell command. */
const SAFE_CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function sshPrefix(host: string, connectTimeout = 3, mux = true): string {
  const isLinkLocalV6 = host.includes("%");
  const addr = JSON.stringify(isLinkLocalV6 ? `absolome@${host}` : host);
  // -6 / HostKeyAlias only make sense for a link-local IPv6 target (the zone-id
  // form has no stable host-key identity). Keying this off "is this spark4?" broke
  // as soon as spark4 moved back to IPv4 — it forced -6 on an IPv4 address.
  const alias = isLinkLocalV6 ? " -o HostKeyAlias=spark4 -6" : "";
  // accept-new: first contact from a fresh dashboard host must not park on a
  // host-key prompt (BatchMode has nobody to answer it); a CHANGED key still fails.
  if (mux) ensureSshCtlDir();
  const muxOpts = mux ? ` ${SSH_MUX}` : "";
  return `ssh -o ConnectTimeout=${connectTimeout} -o BatchMode=yes -o StrictHostKeyChecking=accept-new${muxOpts}${alias} ${addr}`;
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

export function sshCommand(inner: string, host: string, connectTimeout = 3, mux = true): string {
  return `${sshPrefix(host, connectTimeout, mux)} ${shSingleQuote(inner)}`;
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

// ── Remote execution ─────────────────────────────────────────────────────────
export interface RemoteResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Short, credential-free failure description (never the full command line). */
  error?: string;
}

/**
 * True when ssh failed because the multiplexing control socket could not be
 * created/used. This is the exact failure mode of a missing control directory.
 */
export function isControlSocketError(text: string): boolean {
  return /unix_listener|control socket|mux_client|controlpath/i.test(text);
}

function briefError(e: unknown): string {
  const anyE = e as { stderr?: unknown; message?: unknown };
  const raw = (typeof anyE?.stderr === "string" && anyE.stderr) ||
    (typeof anyE?.message === "string" && anyE.message) ||
    String(e);
  const first = raw.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? raw;
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}

/**
 * Run `inner` on `host` (or locally when `host` is undefined).
 *
 * If the multiplexed call fails with a control-socket error the command is
 * retried ONCE without multiplexing: losing the shared connection is a
 * performance problem, not a reason to report the node as offline.
 */
export async function runRemote(
  inner: string,
  host: string | undefined,
  timeout = 4000,
): Promise<RemoteResult> {
  const run = async (cmd: string): Promise<RemoteResult> => {
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout, maxBuffer: 16 * 1024 * 1024 });
      return { ok: true, stdout, stderr };
    } catch (e) {
      return { ok: false, stdout: "", stderr: "", error: briefError(e) };
    }
  };

  if (!host) return run(inner);

  const first = await run(sshCommand(inner, host));
  if (first.ok) return first;
  if (first.error && isControlSocketError(first.error)) {
    const retry = await run(sshCommand(inner, host, 3, false));
    if (retry.ok) return retry;
    return retry;
  }
  return first;
}

/** Convenience wrapper used by the fleet scanners: returns stdout or "" on failure. */
export async function sh(inner: string, host: string | undefined, timeout = 4000): Promise<string> {
  const res = await runRemote(inner, host, timeout);
  return res.ok ? res.stdout : "";
}

// ── Container discovery ───────────────────────────────────────────────────────
export interface ContainerScan {
  node: FleetNode;
  names: string[];
  /** False when the node could not be reached at all (ssh failed). */
  reachable: boolean;
  error?: string;
}

// Running container names on a node (empty if the node is offline/unreachable).
async function scanContainers(node: FleetNode): Promise<ContainerScan> {
  const res = await runRemote(`docker ps --format '{{.Names}}' 2>/dev/null`, node.host, 5000);
  if (!res.ok) {
    return { node, names: [], reachable: false, error: res.error ?? "ssh failed" };
  }
  const names = res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  return { node, names, reachable: true };
}

// Read the live serve command from inside a container. vLLM/SGLang are launched
// via `docker exec`, so scan every PID's cmdline and keep the serve invocation.
async function readServeCmd(name: string, host?: string): Promise<string> {
  if (!SAFE_CONTAINER.test(name)) return "";
  const res = await runRemote(
    `docker exec ${name} sh -c 'cat /proc/*/cmdline 2>/dev/null | tr "\\0" " "' 2>/dev/null`,
    host,
    6000,
  );
  return res.ok ? res.stdout : "";
}

/**
 * Which inference engine is running inside a container?
 *
 * This MUST be decided from the PROCESS, not from the container name: the live
 * deployment runs `dsv41-head` / `dsv41-worker` (image `dsv41-4x-spark:…`), so
 * the old name heuristic (/vllm|sglang/i) found nothing and the dashboard fell
 * back to "API answered → assume vLLM, 1 node", which was plain wrong.
 */
export function detectEngineType(cmd: string, containerName = ""): Exclude<EngineType, "none"> | null {
  if (/sglang\.launch_server|sglang\.entrypoints|(^|\s)-m\s+sglang/i.test(cmd)) return "sglang";
  if (/vllm\.entrypoints|vllm(\.serve|\s+serve)\b|api_server/i.test(cmd)) return "vllm";
  // Last resort: the container NAME carries the engine (legacy shapes).
  if (ENGINE_RE.test(containerName)) return /sglang/i.test(containerName) ? "sglang" : "vllm";
  return null;
}

async function apiAlive(apiHost: string, port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://${apiHost}:${port}/v1/models`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

export interface ServeInfo {
  port?: number;
  tp?: number;
  pp?: number;
  nnodes?: number;
  /** --node-rank: 0 identifies the head of a multi-node launch. */
  nodeRank?: number;
  model?: string;
  contextLength?: number;
  sglang: boolean;
}

/**
 * Read the launch parameters out of a serve command.
 *
 * Handles BOTH dialects:
 *   vLLM    : --tensor-parallel-size N --pipeline-parallel-size N --nnodes N
 *   SGLang  : --tp N --pp N --nnodes N --node-rank N --context-length N
 * The old parser only knew the vLLM spellings, so an SGLang launch was reported
 * as "1 node" even with all four containers discovered.
 */
export function parseServe(cmd: string): ServeInfo {
  const num = (re: RegExp) => { const m = cmd.match(re); return m ? parseInt(m[1], 10) : undefined; };
  const str = (re: RegExp) => { const m = cmd.match(re); return m ? m[1] : undefined; };
  return {
    // --port / --api-port (SGLang uses --port; vLLM too)
    port:   num(/--(?:api-port|port)[ =](\d+)/),
    // longest spellings first so --tp-size is not read as --tp
    tp:     num(/--(?:tensor-parallel-size|tp-size|tp)[ =](\d+)/),
    pp:     num(/--(?:pipeline-parallel-size|pp-size|pp)[ =](\d+)/),
    nnodes: num(/--nnodes[ =](\d+)/),
    nodeRank: num(/--node-rank[ =](\d+)/),
    model:  str(/--served-model-name[ =](\S+)/) ?? str(/--model[ =](\S+)/) ?? str(/--model-path[ =](\S+)/),
    contextLength: num(/--(?:context-length|max-model-len)[ =](\d+)/),
    sglang: /sglang|sgl[._-]?kernel/i.test(cmd),
  };
}

function noneInfo(note?: string): EngineInfo {
  return {
    type: "none", label: "—", port: 0, apiHost: "localhost",
    topology: "—", parallel: "—", kvDtype: "—", metricsPrefix: "",
    headNode: null, nodes: [], detected: false, note,
    // Keep a head placeholder so consumers that look up the "head" container
    // don't crash; it simply resolves to "absent".
    containers: [{ key: "head", name: "vllm_node", label: "head", node: null, rank: null }],
  };
}

export interface EngineCandidate {
  node: FleetNode;
  container: string;
  type: Exclude<EngineType, "none">;
  serve: ServeInfo;
}

export function buildEngineInfo(
  type: Exclude<EngineType, "none">,
  head: FleetNode,
  port: number,
  candidates: EngineCandidate[],
  webui: { name: string; host?: string } | null,
  serve: ServeInfo,
  detected: boolean,
  note?: string,
): EngineInfo {
  // Order: head first, then the remaining ranks in rank order.
  const ordered = [
    ...candidates.filter((e) => e.node.key === head.key),
    ...candidates
      .filter((e) => e.node.key !== head.key)
      .sort((a, b) => (a.serve.nodeRank ?? 99) - (b.serve.nodeRank ?? 99)),
  ];
  const keyFor = (i: number): EngineContainerSpec["key"] =>
    i === 0 ? "head" : i === 1 ? "worker" : i === 2 ? "worker2" : "worker3";

  const containers: EngineContainerSpec[] = ordered.map((e, i) => ({
    key: keyFor(i),
    name: e.container,
    host: e.node.host,
    node: e.node.key,
    rank: e.serve.nodeRank ?? i,
    label: i === 0
      ? `rank${e.serve.nodeRank ?? 0} · head · ${e.node.key}`
      : `rank${e.serve.nodeRank ?? i} · ${e.node.key}`,
  }));

  // API-only fallback (no container discovered but the endpoint answered).
  if (containers.length === 0) {
    containers.push({ key: "head", name: "vllm_node", host: head.host, node: head.key, rank: 0, label: `head · ${head.key}` });
  }
  if (webui) containers.push({ key: "webui", name: webui.name, host: webui.host, node: null, rank: null, label: "open-webui" });

  const nodeKeys = ordered.map((e) => e.node.key).sort();
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
    headNode: head.key,
    nodes: nodeKeys,
    detected,
    note,
  };
}

// ── Detection ─────────────────────────────────────────────────────────────────
export async function detectEngine(): Promise<EngineInfo> {
  // 1. Scan the whole fleet for running containers (parallel; offline nodes → []).
  const scans = await Promise.all(FLEET.map((node) => scanContainers(node)));

  const webuiScan = scans.find((s) => s.names.some((nm) => WEBUI_RE.test(nm)));
  const webui = webuiScan
    ? { name: webuiScan.names.find((nm) => WEBUI_RE.test(nm))!, host: webuiScan.node.host }
    : null;

  // 2. Classify every running container by the PROCESS it runs. This is the
  //    step that used to be name-based and therefore blind to `dsv41-*`.
  const candidateLists = await Promise.all(
    scans.map(async (scan): Promise<EngineCandidate[]> => {
      const out: EngineCandidate[] = [];
      for (const name of scan.names) {
        const cmd = await readServeCmd(name, scan.node.host);
        const type = detectEngineType(cmd, name);
        if (!type) continue;
        out.push({ node: scan.node, container: name, type, serve: parseServe(cmd) });
      }
      return out;
    }),
  );
  const engineNodes: EngineCandidate[] = candidateLists.flat();

  const unreachable = scans.filter((s) => !s.reachable).map((s) => s.node.key);

  // 3. No engine container anywhere — probe the API directly (manual launch),
  //    else report "none".
  if (engineNodes.length === 0) {
    for (const node of FLEET) {
      for (const port of CANDIDATE_PORTS) {
        if (await apiAlive(node.apiHost, port)) {
          const note = unreachable.length
            ? `engine container not detected (${unreachable.join(", ")} unreachable) — API-only fallback`
            : "engine container not detected — API-only fallback";
          return buildEngineInfo("vllm", node, port, [], webui, { sglang: false }, false, note);
        }
      }
    }
    return noneInfo(
      unreachable.length
        ? `no engine container found; ${unreachable.join(", ")} unreachable`
        : "no engine container found",
    );
  }

  // 4. The head is the rank-0 node (authoritative for both engines). Only if
  //    the rank is unknown do we probe the API to find who answers.
  const type: Exclude<EngineType, "none"> =
    engineNodes.some((e) => e.type === "sglang") ? "sglang" : "vllm";
  const serve = engineNodes.find((e) => e.serve.nodeRank === 0)?.serve ?? engineNodes[0].serve;

  let head: FleetNode | null = null;
  let apiPort = serve.port ?? API_PORT;
  const rankZero = engineNodes.find((e) => e.serve.nodeRank === 0);
  if (rankZero) {
    head = rankZero.node;
  } else {
    const ports = [serve.port, ...CANDIDATE_PORTS].filter((p): p is number => !!p);
    outer:
    for (const e of engineNodes) {
      for (const port of ports) {
        if (await apiAlive(e.node.apiHost, port)) { head = e.node; apiPort = port; break outer; }
      }
    }
    // Container is up but API not answering yet (mid model-load): assume the
    // first node is the head.
    if (!head) head = engineNodes[0].node;
  }

  return buildEngineInfo(type, head, apiPort, engineNodes, webui, serve, true);
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
