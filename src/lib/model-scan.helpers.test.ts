import { describe, it, expect } from "vitest";
import { cacheKeyToModelId, shortName, normalizeBaseKey, classifyModality, parseFacts } from "./model-scan";

describe("id helpers", () => {
  it("converts cache key to model id", () => {
    expect(cacheKeyToModelId("models--Qwen--Qwen3-Coder-Next-FP8")).toBe("Qwen/Qwen3-Coder-Next-FP8");
  });
  it("extracts short name", () => {
    expect(shortName("Qwen/Qwen3-235B-A22B-Instruct-2507-FP8")).toBe("Qwen3-235B-A22B-Instruct-2507-FP8");
  });
});

describe("normalizeBaseKey groups variants", () => {
  it("groups the MiniMax-M2.7 family", () => {
    const a = normalizeBaseKey("MiniMaxAI/MiniMax-M2.7");
    const b = normalizeBaseKey("saricles/MiniMax-M2.7-NVFP4-GB10");
    const c = normalizeBaseKey("saricles/MiniMax-M2.7-REAP-172B-A10B-NVFP4-GB10");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
  it("groups Qwen3-235B quant variants", () => {
    expect(normalizeBaseKey("Qwen/Qwen3-235B-A22B-Instruct-2507-FP8"))
      .toBe(normalizeBaseKey("NVFP4/Qwen3-235B-A22B-Instruct-2507-FP4"));
  });
  it("keeps unrelated models distinct", () => {
    expect(normalizeBaseKey("openai/gpt-oss-120b")).not.toBe(normalizeBaseKey("Qwen/Qwen3-Coder-Next-FP8"));
  });
});

describe("classifyModality", () => {
  it("detects audio (whisper)", () => {
    expect(classifyModality({ config: { model_type: "whisper" } })).toBe("audio");
  });
  it("detects image-gen (diffusion model_index)", () => {
    expect(classifyModality({ modelIndex: { _class_name: "FluxPipeline" } })).toBe("image-gen");
  });
  it("detects vision when a preprocessor exists", () => {
    expect(classifyModality({ config: { model_type: "qwen2_vl" }, preprocessor: { image_processor_type: "x" } })).toBe("vision");
  });
  it("defaults to text", () => {
    expect(classifyModality({ config: { model_type: "qwen2" } })).toBe("text");
  });
});

describe("parseFacts", () => {
  it("reads arch, quant, context", () => {
    const f = parseFacts({
      config: {
        architectures: ["Qwen3MoeForCausalLM"],
        model_type: "qwen3_moe",
        max_position_embeddings: 262144,
        quantization_config: { quant_method: "fp8" },
      },
    });
    expect(f.arch).toBe("Qwen3MoeForCausalLM");
    expect(f.modelType).toBe("qwen3_moe");
    expect(f.contextLen).toBe(262144);
    expect(f.quant).toBe("FP8");
  });
  it("infers quant from name when config lacks it", () => {
    const f = parseFacts({ config: { architectures: ["X"] }, nameHint: "GLM-5.2-NVFP4-REAP-469B" });
    expect(f.quant).toBe("NVFP4");
  });
});
