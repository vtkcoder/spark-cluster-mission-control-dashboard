// Shared types for the Benchmarks tab (llama-benchy integration).
// llama-benchy is run via `uvx llama-benchy` against an OpenAI-compatible
// endpoint. See src/lib/bench-run.ts for the config→argv builder and the
// result-JSON→table aggregation. Result shape verified against llama-benchy
// 0.4.0 output (see src/lib/bench-run.ts docstring).

// ── Run configuration (what the operator submits) ─────────────────────────────
export interface BenchConfig {
  // Target endpoint. baseUrl already includes the /v1 suffix
  // (e.g. "http://localhost:8001/v1"). model is the OpenAI model id.
  baseUrl: string;
  model: string;
  apiKey?: string;

  // Sweep dimensions — llama-benchy runs the cartesian product of these.
  pp: number[];          // prompt-processing token counts   (--pp)
  tg: number[];          // token-generation counts          (--tg)
  depth: number[];       // context depths (prior tokens)    (--depth)
  concurrency: number[]; // concurrent-request levels        (--concurrency)
  runs: number;          // repetitions per test             (--runs)

  // Boolean flags (present = enabled).
  prefixCaching?: boolean; // --enable-prefix-caching
  noWarmup?: boolean;      // --no-warmup
  skipCoherence?: boolean; // --skip-coherence
  noCache?: boolean;       // --no-cache
  exactTg?: boolean;       // --exact-tg
}

// A named preset the UI offers as a one-click starting point.
export interface BenchPreset {
  label: string;
  description: string;
  config: Omit<BenchConfig, "baseUrl" | "model" | "apiKey">;
}

// ── llama-benchy result JSON (subset we consume) ──────────────────────────────
export interface BenchMetric {
  mean: number;
  std: number;
  values: number[];
}

export interface BenchmarkEntry {
  concurrency: number;
  context_size: number;
  prompt_size: number;
  response_size: number;
  is_context_prefill_phase: boolean;
  pp_throughput?: BenchMetric | null;
  tg_throughput?: BenchMetric | null;
  ttfr?: BenchMetric | null;
  [k: string]: unknown;
}

export interface BenchResultJson {
  version?: string;
  timestamp?: string;
  model?: string;
  latency_mode?: string;
  prefix_caching_enabled?: boolean;
  max_concurrency?: number;
  benchmarks?: BenchmarkEntry[];
  [k: string]: unknown;
}

// One aggregated row of the results table, grouped by (depth, concurrency).
export interface BenchTableRow {
  depth: number;
  concurrency: number;
  ppTs: number | null;   // prompt-processing throughput, tok/s
  tgTs: number | null;   // token-generation throughput, tok/s
  ttfrMs: number | null; // time-to-first-response, ms
  runs: number;          // measurement repetitions contributing to this row
}

// ── Job state returned by GET /api/benchmarks ─────────────────────────────────
export type BenchStatus = "idle" | "running" | "done" | "error";

export interface BenchJobState {
  id: number | null;      // bench_run row id
  status: BenchStatus;
  config: BenchConfig | null;
  log: string;            // streamed stdout/stderr
  rows: BenchTableRow[];  // aggregated table (fills in on completion)
  result: BenchResultJson | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  pid: number | null;
}

// ── History listing (GET /api/benchmarks/history) ─────────────────────────────
export interface BenchRunSummary {
  id: number;
  node: string;
  base_url: string;
  model: string;
  status: string;
  config: BenchConfig;
  started_at: string;
  finished_at: string | null;
  // Headline numbers for the list (best/first row); null while running/failed.
  peakTgTs: number | null;
  peakPpTs: number | null;
}
