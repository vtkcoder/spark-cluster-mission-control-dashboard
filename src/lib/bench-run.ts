// Pure helpers for the Benchmarks tab: build the `uvx llama-benchy` argv from a
// BenchConfig, and aggregate llama-benchy's result JSON into table rows.
//
// No side effects here — the API route owns spawning/DB. Kept pure so it is unit
// testable (src/lib/bench-run.test.ts).
//
// Result shape verified against a live llama-benchy 0.4.0 run:
//   { version, timestamp, model, latency_mode, prefix_caching_enabled,
//     max_concurrency, benchmarks: [
//       { concurrency, context_size, prompt_size, response_size,
//         is_context_prefill_phase,
//         pp_throughput:{mean,std,values}, tg_throughput:{…}, ttfr:{…}, … } ] }
// The (depth, concurrency) → (pp, tg, ttfr) aggregation mirrors the known-good
// logic in sparkrun's llama_benchy plugin.

import type {
  BenchConfig,
  BenchMetric,
  BenchResultJson,
  BenchTableRow,
} from "./bench-types";

// ── config normalization ──────────────────────────────────────────────────────
// Coerce an untrusted request body into a valid BenchConfig, or return an error
// string. Positive integers only for sweeps; sensible caps to avoid runaway
// sweeps. spawn() uses an argv array (no shell), so this is about validity, not
// shell-injection safety.
export function normalizeConfig(
  body: unknown,
): { config: BenchConfig } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;

  const baseUrl = typeof b.baseUrl === "string" ? b.baseUrl.trim() : "";
  const model = typeof b.model === "string" ? b.model.trim() : "";
  if (!baseUrl) return { error: "baseUrl is required" };
  if (!/^https?:\/\//i.test(baseUrl)) return { error: "baseUrl must start with http:// or https://" };
  if (!model) return { error: "model is required" };

  const posIntList = (v: unknown, fallback: number[], min = 0): number[] => {
    if (!Array.isArray(v)) return fallback;
    const out = v
      .map((x) => Math.trunc(Number(x)))
      .filter((n) => Number.isFinite(n) && n >= min);
    return out.length ? out : fallback;
  };

  const pp = posIntList(b.pp, [2048], 1);
  const tg = posIntList(b.tg, [32], 1);
  const depth = posIntList(b.depth, [0], 0);
  const concurrency = posIntList(b.concurrency, [1], 1);

  let runs = Math.trunc(Number(b.runs));
  if (!Number.isFinite(runs) || runs < 1) runs = 3;
  if (runs > 50) runs = 50;

  const apiKey = typeof b.apiKey === "string" && b.apiKey.trim() ? b.apiKey.trim() : undefined;

  return {
    config: {
      baseUrl,
      model,
      apiKey,
      pp,
      tg,
      depth,
      concurrency,
      runs,
      prefixCaching: !!b.prefixCaching,
      noWarmup: !!b.noWarmup,
      skipCoherence: !!b.skipCoherence,
      noCache: !!b.noCache,
      exactTg: !!b.exactTg,
    },
  };
}

// ── argv builder ──────────────────────────────────────────────────────────────
// Build the argument vector for `uvx llama-benchy`. `resultFile` receives the
// machine-readable JSON via --save-result. Always uses --format json.
export function buildBenchArgs(config: BenchConfig, resultFile: string): string[] {
  const args: string[] = [
    "llama-benchy",
    "--base-url", config.baseUrl,
    "--model", config.model,
    "--format", "json",
    "--save-result", resultFile,
  ];

  if (config.apiKey && config.apiKey.trim()) {
    args.push("--api-key", config.apiKey.trim());
  }

  // List sweeps — llama-benchy takes space-separated values after the flag.
  const pushList = (flag: string, vals: number[]) => {
    if (vals && vals.length) {
      args.push(flag);
      for (const v of vals) args.push(String(v));
    }
  };
  pushList("--pp", config.pp);
  pushList("--tg", config.tg);
  pushList("--depth", config.depth);
  pushList("--concurrency", config.concurrency);

  if (config.runs && config.runs > 0) args.push("--runs", String(config.runs));

  // Boolean flags (present = enabled).
  if (config.prefixCaching) args.push("--enable-prefix-caching");
  if (config.noWarmup) args.push("--no-warmup");
  if (config.skipCoherence) args.push("--skip-coherence");
  if (config.noCache) args.push("--no-cache");
  if (config.exactTg) args.push("--exact-tg");

  return args;
}

// Estimate total test combinations (pp × tg × depth × concurrency × runs) so the
// UI can show expected progress. Returns null if inputs are degenerate.
export function estimateTestCount(config: BenchConfig): number | null {
  const len = (a: number[] | undefined) => (a && a.length ? a.length : 1);
  const combos = len(config.pp) * len(config.tg) * len(config.depth) * len(config.concurrency);
  const runs = config.runs && config.runs > 0 ? config.runs : 1;
  return combos > 0 ? combos * runs : null;
}

// ── result aggregation ────────────────────────────────────────────────────────
function metricMean(m: BenchMetric | null | undefined): number | null {
  if (!m || typeof m.mean !== "number") return null;
  return m.mean;
}

function safeMean(values: (number | null)[]): number | null {
  const clean = values.filter((v): v is number => v !== null);
  if (!clean.length) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

// Aggregate llama-benchy result JSON into (depth, concurrency) rows.
// Context-prefill phase entries (cache warm-up) are excluded from the primary
// pp/tg/ttfr means, matching sparkrun's plugin. Rows are sorted by
// (depth, concurrency).
export function aggregateRows(result: BenchResultJson | null | undefined): BenchTableRow[] {
  const benchmarks = result?.benchmarks ?? [];
  if (!Array.isArray(benchmarks) || !benchmarks.length) return [];

  const key = (d: number, c: number) => `${d}|${c}`;
  const pp = new Map<string, (number | null)[]>();
  const tg = new Map<string, (number | null)[]>();
  const ttfr = new Map<string, (number | null)[]>();
  const runs = new Map<string, number>();
  const seen = new Map<string, { depth: number; concurrency: number }>();

  const push = (map: Map<string, (number | null)[]>, k: string, v: number | null) => {
    const arr = map.get(k) ?? [];
    arr.push(v);
    map.set(k, arr);
  };

  for (const b of benchmarks) {
    const depth = Number(b.context_size ?? 0) || 0;
    const conc = Number(b.concurrency ?? 1) || 1;
    const k = key(depth, conc);
    seen.set(k, { depth, concurrency: conc });

    if (b.is_context_prefill_phase) continue;

    push(pp, k, metricMean(b.pp_throughput));
    push(tg, k, metricMean(b.tg_throughput));
    push(ttfr, k, metricMean(b.ttfr));

    // repetitions = number of measured values on whichever throughput metric
    // carries them (prefer tg, then pp); default 1.
    let reps = 0;
    for (const field of [b.tg_throughput, b.pp_throughput]) {
      if (field && Array.isArray(field.values) && field.values.length) {
        reps = field.values.length;
        break;
      }
    }
    if (reps === 0) reps = 1;
    runs.set(k, (runs.get(k) ?? 0) + reps);
  }

  const rows: BenchTableRow[] = [];
  for (const [k, { depth, concurrency }] of seen) {
    rows.push({
      depth,
      concurrency,
      ppTs: safeMean(pp.get(k) ?? []),
      tgTs: safeMean(tg.get(k) ?? []),
      ttfrMs: safeMean(ttfr.get(k) ?? []),
      runs: runs.get(k) ?? 0,
    });
  }
  rows.sort((a, b) => (a.depth - b.depth) || (a.concurrency - b.concurrency));
  return rows;
}

// Headline numbers for a history row: the max non-null tg/pp throughput across
// all aggregated rows (null if none).
export function headlineThroughput(
  result: BenchResultJson | null | undefined,
): { peakTgTs: number | null; peakPpTs: number | null } {
  const rows = aggregateRows(result);
  const tg = rows.map((r) => r.tgTs).filter((v): v is number => v !== null);
  const pp = rows.map((r) => r.ppTs).filter((v): v is number => v !== null);
  return {
    peakTgTs: tg.length ? Math.max(...tg) : null,
    peakPpTs: pp.length ? Math.max(...pp) : null,
  };
}
