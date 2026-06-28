import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanLmStudioModels, normalizeBaseKey } from "./model-scan";

let root: string;

function makeRepo(rel: string, files: { name: string; bytes?: number }[]) {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f.name), Buffer.alloc(f.bytes ?? 1024));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lmstudio-"));
  makeRepo("lmstudio-community/Hermes-4-70B-GGUF", [{ name: "Hermes-4-70B-Q4_K_M.gguf", bytes: 60 * 1024 * 1024 }]);
  makeRepo("lmstudio-community/Qwen3.5-122B-A10B-GGUF", [
    { name: "Qwen3.5-122B-A10B-Q4_K_M-00001-of-00002.gguf", bytes: 60 * 1024 * 1024 },
    { name: "Qwen3.5-122B-A10B-Q4_K_M-00002-of-00002.gguf", bytes: 60 * 1024 * 1024 },
    { name: "mmproj-Qwen3.5-122B-A10B-BF16.gguf", bytes: 1024 },
  ]);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("scanLmStudioModels", () => {
  it("discovers publisher/repo gguf models", () => {
    const ms = scanLmStudioModels(root, "spark1");
    expect(ms.length).toBe(2);
    const h = ms.find((m) => m.name === "Hermes-4-70B-GGUF")!;
    expect(h.source).toBe("lmstudio");
    expect(h.id).toBe("lmstudio-community/Hermes-4-70B-GGUF");
    expect(h.health).toBe("ready");
    expect(h.quant).toBe("Q4_K_M");
    expect(h.paramCountB).toBe(70); // parsed from name
    expect(h.modality).toBe("text");
  });
  it("flags multimodal repos (mmproj present) as vision", () => {
    const ms = scanLmStudioModels(root, "spark1");
    const q = ms.find((m) => m.name === "Qwen3.5-122B-A10B-GGUF")!;
    expect(q.modality).toBe("vision");
  });
  it("groups a GGUF build with its non-GGUF sibling via base key", () => {
    expect(normalizeBaseKey("lmstudio-community/Qwen3-Coder-Next-GGUF"))
      .toBe(normalizeBaseKey("Qwen/Qwen3-Coder-Next-FP8"));
  });
});
