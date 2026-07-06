import { describe, it, expect } from "vitest";
import {
  normalizeConfig,
  buildBenchArgs,
  estimateTestCount,
  aggregateRows,
  headlineThroughput,
} from "./bench-run";
import type { BenchConfig, BenchResultJson } from "./bench-types";

const baseConfig: BenchConfig = {
  baseUrl: "http://localhost:8001/v1",
  model: "org/model",
  pp: [2048],
  tg: [128],
  depth: [0],
  concurrency: [1],
  runs: 3,
};

describe("normalizeConfig", () => {
  it("requires baseUrl and model", () => {
    expect(normalizeConfig({ model: "m" })).toEqual({ error: "baseUrl is required" });
    expect(normalizeConfig({ baseUrl: "http://x/v1" })).toEqual({ error: "model is required" });
  });

  it("rejects non-http base URLs", () => {
    const r = normalizeConfig({ baseUrl: "ftp://x", model: "m" });
    expect("error" in r).toBe(true);
  });

  it("coerces sweep lists to positive ints and applies defaults", () => {
    const r = normalizeConfig({
      baseUrl: "http://localhost:8001/v1",
      model: "org/model",
      pp: ["512", 1024, -5, "bad"],
      tg: [],
      runs: "2",
    });
    expect("config" in r).toBe(true);
    if ("config" in r) {
      expect(r.config.pp).toEqual([512, 1024]); // -5 and "bad" dropped
      expect(r.config.tg).toEqual([32]);        // empty → default
      expect(r.config.depth).toEqual([0]);      // missing → default
      expect(r.config.concurrency).toEqual([1]);
      expect(r.config.runs).toBe(2);
    }
  });

  it("caps runs and floors invalid runs to default", () => {
    const hi = normalizeConfig({ baseUrl: "http://x/v1", model: "m", runs: 999 });
    const bad = normalizeConfig({ baseUrl: "http://x/v1", model: "m", runs: "x" });
    if ("config" in hi) expect(hi.config.runs).toBe(50);
    if ("config" in bad) expect(bad.config.runs).toBe(3);
  });

  it("maps boolean flags", () => {
    const r = normalizeConfig({ baseUrl: "http://x/v1", model: "m", prefixCaching: true, noWarmup: 1 });
    if ("config" in r) {
      expect(r.config.prefixCaching).toBe(true);
      expect(r.config.noWarmup).toBe(true);
      expect(r.config.skipCoherence).toBe(false);
    }
  });
});

describe("buildBenchArgs", () => {
  it("builds the expected uvx argv", () => {
    const args = buildBenchArgs(baseConfig, "/tmp/r.json");
    expect(args).toEqual([
      "llama-benchy",
      "--base-url", "http://localhost:8001/v1",
      "--model", "org/model",
      "--format", "json",
      "--save-result", "/tmp/r.json",
      "--pp", "2048",
      "--tg", "128",
      "--depth", "0",
      "--concurrency", "1",
      "--runs", "3",
    ]);
  });

  it("expands multi-value sweeps space-separated after the flag", () => {
    const args = buildBenchArgs({ ...baseConfig, depth: [0, 4096, 16384] }, "/tmp/r.json");
    const i = args.indexOf("--depth");
    expect(args.slice(i, i + 4)).toEqual(["--depth", "0", "4096", "16384"]);
  });

  it("includes api-key and boolean flags only when set", () => {
    const args = buildBenchArgs(
      { ...baseConfig, apiKey: "sk-x", prefixCaching: true, skipCoherence: true },
      "/tmp/r.json",
    );
    expect(args).toContain("--api-key");
    expect(args).toContain("sk-x");
    expect(args).toContain("--enable-prefix-caching");
    expect(args).toContain("--skip-coherence");
    expect(args).not.toContain("--no-warmup");
  });
});

describe("estimateTestCount", () => {
  it("multiplies the cartesian product by runs", () => {
    expect(estimateTestCount({ ...baseConfig, pp: [1, 2], depth: [0, 1, 2], concurrency: [1, 4], runs: 2 }))
      .toBe(2 * 1 * 3 * 2 * 2); // pp(2)×tg(1)×depth(3)×conc(2)×runs(2) = 24
  });
});

// Real llama-benchy 0.4.0 shape (trimmed), plus a context-prefill row that must
// be excluded from the primary means.
const sampleResult: BenchResultJson = {
  version: "0.4.0",
  model: "org/model",
  max_concurrency: 1,
  benchmarks: [
    {
      concurrency: 1, context_size: 0, prompt_size: 128, response_size: 16,
      is_context_prefill_phase: false,
      pp_throughput: { mean: 200, std: 0, values: [200] },
      tg_throughput: { mean: 20, std: 0, values: [20] },
      ttfr: { mean: 650, std: 0, values: [650] },
    },
    {
      concurrency: 1, context_size: 4096, prompt_size: 128, response_size: 16,
      is_context_prefill_phase: true, // warm-up — must be ignored for means
      pp_throughput: { mean: 9999, std: 0, values: [9999] },
      tg_throughput: { mean: 9999, std: 0, values: [9999] },
    },
    {
      concurrency: 1, context_size: 4096, prompt_size: 128, response_size: 16,
      is_context_prefill_phase: false,
      pp_throughput: { mean: 150, std: 0, values: [150] },
      tg_throughput: { mean: 15, std: 0, values: [15, 15] },
      ttfr: { mean: 800, std: 0, values: [800] },
    },
  ],
};

describe("aggregateRows", () => {
  it("returns [] for empty/invalid input", () => {
    expect(aggregateRows(null)).toEqual([]);
    expect(aggregateRows({ benchmarks: [] })).toEqual([]);
  });

  it("groups by (depth, concurrency), sorted, excluding prefill phase", () => {
    const rows = aggregateRows(sampleResult);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ depth: 0, concurrency: 1, ppTs: 200, tgTs: 20, ttfrMs: 650, runs: 1 });
    // depth 4096: prefill row (9999) excluded; runs = len(tg values)=2
    expect(rows[1]).toMatchObject({ depth: 4096, concurrency: 1, ppTs: 150, tgTs: 15, ttfrMs: 800, runs: 2 });
  });
});

describe("headlineThroughput", () => {
  it("reports the peak tg/pp across rows", () => {
    expect(headlineThroughput(sampleResult)).toEqual({ peakTgTs: 20, peakPpTs: 200 });
  });
  it("is null when there are no rows", () => {
    expect(headlineThroughput(null)).toEqual({ peakTgTs: null, peakPpTs: null });
  });
});
