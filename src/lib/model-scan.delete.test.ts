import { describe, it, expect } from "vitest";
import { modelIdToCacheKey, validateDeletePath } from "./model-scan";

describe("modelIdToCacheKey", () => {
  it("round-trips an id", () => {
    expect(modelIdToCacheKey("Qwen/Qwen3-Coder-Next-FP8")).toBe("models--Qwen--Qwen3-Coder-Next-FP8");
  });
});

describe("validateDeletePath", () => {
  const root = "/home/absolome/.cache/huggingface/hub";
  it("accepts a real cache subdir", () => {
    expect(validateDeletePath(`${root}/models--Qwen--Qwen3-Coder-Next-FP8`, root)).toBe(true);
  });
  it("rejects paths outside the cache", () => {
    expect(validateDeletePath("/home/absolome/.cache/huggingface/hub", root)).toBe(false);
    expect(validateDeletePath("/etc/passwd", root)).toBe(false);
    expect(validateDeletePath(`${root}/../../evil`, root)).toBe(false);
  });
  it("rejects shell metacharacters and wildcards", () => {
    expect(validateDeletePath(`${root}/models--x*`, root)).toBe(false);
    expect(validateDeletePath(`${root}/models--x;rm`, root)).toBe(false);
  });
});
