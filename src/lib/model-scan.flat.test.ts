import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanFlatModels, validateDeletePath, MODELS_ROOT } from "./model-scan";

let root: string;

function makeFlat(rel: string, opts: { config?: object; sizeBytes?: number; incomplete?: boolean; extra?: string[] }) {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  if (opts.config) writeFileSync(join(dir, "config.json"), JSON.stringify(opts.config));
  writeFileSync(join(dir, "model-00001-of-00001.safetensors"), Buffer.alloc(opts.sizeBytes ?? 1024));
  if (opts.incomplete) writeFileSync(join(dir, "model-00002-of-00002.safetensors.incomplete"), Buffer.alloc(10));
  for (const e of opts.extra ?? []) writeFileSync(join(dir, e), "{}");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "flat-"));
  makeFlat("ornith/Ornith-1.0-397B-FP8", {
    config: { architectures: ["Qwen3_5MoeForConditionalGeneration"], model_type: "qwen3_5_moe", quantization_config: { quant_method: "compressed-tensors" } },
    sizeBytes: 60 * 1024 * 1024,
    extra: ["video_preprocessor_config.json", "preprocessor_config.json"],
  });
  makeFlat("ornith/Ornith-1.0-9B", {
    config: { architectures: ["Qwen3_5MoeForConditionalGeneration"], model_type: "qwen3_5_moe" },
    sizeBytes: 60 * 1024 * 1024,
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("scanFlatModels", () => {
  it("discovers flat-layout model dirs (config + safetensors directly inside)", () => {
    const ms = scanFlatModels(root, "spark1");
    expect(ms.length).toBe(2);
    const big = ms.find((m) => m.name === "Ornith-1.0-397B-FP8")!;
    expect(big.source).toBe("flat");
    expect(big.id).toBe("ornith/Ornith-1.0-397B-FP8");
    expect(big.dir).toBe(join(root, "ornith/Ornith-1.0-397B-FP8"));
    expect(big.health).toBe("ready");
    expect(big.modality).toBe("vision"); // has a preprocessor config
    expect(big.quant).toBe("COMPRESSED-TENSORS");
  });
  it("groups the Ornith size variants together", () => {
    const ms = scanFlatModels(root, "spark1");
    expect(ms[0].groupKey).toBe(ms[1].groupKey);
  });
});

describe("validateDeletePath allows ~/models flat dirs", () => {
  it("accepts a nested model dir under MODELS_ROOT", () => {
    expect(validateDeletePath(`${MODELS_ROOT}/ornith/Ornith-1.0-9B`)).toBe(true);
  });
  it("rejects the MODELS_ROOT itself and paths outside any root", () => {
    expect(validateDeletePath(MODELS_ROOT)).toBe(false);
    expect(validateDeletePath("/home/absolome/secret-stuff")).toBe(false);
  });
});
