import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanModels, groupDuplicates } from "./model-scan";

let root: string;

function makeModel(
  cacheKey: string,
  opts: { config?: object; sizeBytes?: number; incomplete?: boolean; hash?: string },
) {
  const dir = join(root, cacheKey);
  const hash = opts.hash ?? "abc123";
  const snap = join(dir, "snapshots", hash);
  const blobs = join(dir, "blobs");
  mkdirSync(snap, { recursive: true });
  mkdirSync(blobs, { recursive: true });
  mkdirSync(join(dir, "refs"), { recursive: true });
  writeFileSync(join(dir, "refs", "main"), hash);
  if (opts.config) writeFileSync(join(snap, "config.json"), JSON.stringify(opts.config));
  // a blob file sized to opts.sizeBytes (approx) to exercise du
  const size = opts.sizeBytes ?? 1024;
  writeFileSync(join(blobs, "weight.bin"), Buffer.alloc(size));
  if (opts.incomplete) writeFileSync(join(blobs, "part.incomplete"), Buffer.alloc(10));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hfcache-"));
  makeModel("models--Qwen--Qwen3-235B-A22B-Instruct-2507-FP8", {
    config: { architectures: ["Qwen3MoeForCausalLM"], model_type: "qwen3_moe", max_position_embeddings: 4096, quantization_config: { quant_method: "fp8" } },
    // Above STUB_MAX_BYTES (50MB) so it reads as a real (ready) model, not a stub.
    sizeBytes: 60 * 1024 * 1024,
  });
  makeModel("models--NVFP4--Qwen3-235B-A22B-Instruct-2507-FP4", {
    config: { architectures: ["Qwen3MoeForCausalLM"], model_type: "qwen3_moe" },
    sizeBytes: 120_000,
  });
  makeModel("models--openai--gpt-oss-120b", {
    config: { architectures: ["GptOssForCausalLM"], model_type: "gpt_oss" },
    sizeBytes: 60_000,
  });
  makeModel("models--bad--downloading", {
    config: { architectures: ["X"] }, sizeBytes: 5_000, incomplete: true,
  });
  // stub: config present but tiny (weights missing)
  makeModel("models--stub--tiny", { config: { architectures: ["X"] }, sizeBytes: 100 });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("scanModels", () => {
  it("finds every model dir", () => {
    const ms = scanModels(root, "spark1");
    expect(ms.length).toBe(5);
  });
  it("parses facts and marks health", () => {
    const ms = scanModels(root, "spark1");
    const q = ms.find((m) => m.id === "Qwen/Qwen3-235B-A22B-Instruct-2507-FP8")!;
    expect(q.quant).toBe("FP8");
    expect(q.contextLen).toBe(4096);
    expect(q.health).toBe("ready");
    const dl = ms.find((m) => m.id === "bad/downloading")!;
    expect(dl.health).toBe("downloading");
    const stub = ms.find((m) => m.id === "stub/tiny")!;
    expect(stub.health).toBe("stub");
  });
});

describe("groupDuplicates", () => {
  it("groups the two Qwen3-235B quants and flags redundancy", () => {
    const groups = groupDuplicates(scanModels(root, "spark1"));
    const qGroup = groups.find((g) => g.members.length === 2 && g.members.every((m) => m.name.includes("Qwen3-235B")));
    expect(qGroup).toBeTruthy();
    expect(qGroup!.redundantBytes).toBeGreaterThan(0);
    expect(qGroup!.unique).toBe(false);
  });
});
