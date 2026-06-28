import { NextResponse } from "next/server";
import { detectEngine, getEngineModels, getSglangThroughput } from "@/lib/engine";

export const dynamic = "force-dynamic";

// Module-level state for delta throughput computation
let prev: { ts: number; promptTokens: number; genTokens: number } | null = null;

async function fetchMetrics(host: string, port: number, prefix: string): Promise<Record<string, number> | null> {
  if (!port) return null;
  try {
    const res = await fetch(`http://${host}:${port}/metrics`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const totals: Record<string, number> = {};
    for (const line of text.split("\n")) {
      if (line.startsWith("#") || !line.trim()) continue;
      const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\{?[^}]*\}?\s+([\d.eE+\-]+)/);
      if (!m) continue;
      const key = (prefix ? m[1].replace(new RegExp(`^${prefix}`), "") : m[1]).replace(/^(vllm|sglang):/, "");
      const val = parseFloat(m[2]);
      if (!isNaN(val) && isFinite(val)) {
        totals[key] = (totals[key] ?? 0) + val;
      }
    }
    return Object.keys(totals).length ? totals : null;
  } catch {
    return null;
  }
}

function avgMs(sum: number, count: number): number | null {
  if (count <= 0) return null;
  return (sum / count) * 1000;
}

export async function GET() {
  const now = Date.now();
  const engine = await detectEngine();
  const [metrics, modelInfo, sgTokS] = await Promise.all([
    fetchMetrics(engine.apiHost, engine.port, engine.metricsPrefix),
    getEngineModels(engine.apiHost, engine.port),
    engine.type === "sglang" ? getSglangThroughput() : Promise.resolve(null),
  ]);
  const model = modelInfo?.model ?? null;
  const online = model !== null;

  // No Prometheus metrics (SGLang default has --enable-metrics off). Still
  // report online/model + the log-scraped decode tok/s so the tab is useful.
  if (!metrics) {
    prev = null;
    return NextResponse.json({
      ts: now, online, model,
      engine: engine.type, engineLabel: engine.label, port: engine.port,
      metricsAvailable: false,
      requestsRunning: 0, requestsWaiting: 0, requestsSwapped: 0,
      promptTokensTotal: 0, generationTokensTotal: 0,
      promptThroughput: 0, genThroughput: sgTokS ?? 0,
      avgE2eLatencyMs: null, avgTtftMs: null, avgTpotMs: null,
      avgPrefillMs: null, avgQueueMs: null,
      successTotal: 0, failureTotal: 0, preemptionsTotal: 0,
      gpuCacheUsagePct: 0, gpuCacheTotalBlocks: 0, gpuCacheBlocksUsed: 0, successRate: null,
    });
  }

  const promptTokens = metrics["prompt_tokens_total"] ?? 0;
  const genTokens = metrics["generation_tokens_total"] ?? 0;

  let promptThroughput = 0;
  let genThroughput = 0;
  if (prev) {
    const dt = (now - prev.ts) / 1000;
    if (dt > 0) {
      promptThroughput = Math.max(0, (promptTokens - prev.promptTokens) / dt);
      genThroughput = Math.max(0, (genTokens - prev.genTokens) / dt);
    }
  }
  prev = { ts: now, promptTokens, genTokens };

  const successTotal = metrics["request_success_total"] ?? 0;
  const failureTotal = metrics["request_failure_total"] ?? 0;
  const totalReqs = successTotal + failureTotal;

  const gpuCacheTotalBlocks = Math.round(metrics["num_gpu_blocks"] ?? 0);
  const usageRaw = metrics["gpu_cache_usage_perc"] ?? 0; // 0–1
  const gpuCacheBlocksUsed = Math.round(gpuCacheTotalBlocks * usageRaw);

  return NextResponse.json({
    ts: now,
    online,
    model,
    engine: engine.type, engineLabel: engine.label, port: engine.port,
    metricsAvailable: true,
    requestsRunning: metrics["num_requests_running"] ?? metrics["num_running_reqs"] ?? 0,
    requestsWaiting: metrics["num_requests_waiting"] ?? metrics["num_waiting_reqs"] ?? 0,
    requestsSwapped: metrics["num_requests_swapped"] ?? 0,
    promptTokensTotal: promptTokens,
    generationTokensTotal: genTokens,
    promptThroughput,
    genThroughput,
    avgE2eLatencyMs: avgMs(
      metrics["e2e_request_latency_seconds_sum"] ?? 0,
      metrics["e2e_request_latency_seconds_count"] ?? 0,
    ),
    avgTtftMs: avgMs(
      metrics["time_to_first_token_seconds_sum"] ?? 0,
      metrics["time_to_first_token_seconds_count"] ?? 0,
    ),
    avgTpotMs: avgMs(
      metrics["time_per_output_token_seconds_sum"] ?? 0,
      metrics["time_per_output_token_seconds_count"] ?? 0,
    ),
    avgPrefillMs: avgMs(
      metrics["request_prefill_time_seconds_sum"] ?? 0,
      metrics["request_prefill_time_seconds_count"] ?? 0,
    ),
    avgQueueMs: avgMs(
      metrics["request_queue_time_seconds_sum"] ?? 0,
      metrics["request_queue_time_seconds_count"] ?? 0,
    ),
    successTotal,
    failureTotal,
    preemptionsTotal: metrics["num_preemptions_total"] ?? 0,
    gpuCacheUsagePct: usageRaw * 100,
    gpuCacheTotalBlocks,
    gpuCacheBlocksUsed,
    successRate: totalReqs > 0 ? (successTotal / totalReqs) * 100 : null,
  });
}
