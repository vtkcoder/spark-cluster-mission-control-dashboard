import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { grepHits } from "./model-usage";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "usage-"));
  mkdirSync(join(root, "research"), { recursive: true });
  writeFileSync(join(root, "research", "run-x.sh"), "vllm serve Qwen/Qwen3-Coder-Next-FP8 --port 30000\n");
  writeFileSync(join(root, "research", "other.sh"), "echo nothing here\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("grepHits", () => {
  it("finds the model id in scripts", () => {
    const hits = grepHits("Qwen/Qwen3-Coder-Next-FP8", [join(root, "research")], "script", { max: 50 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toContain("run-x.sh");
    expect(hits[0].excerpt).toContain("vllm serve");
  });
  it("returns nothing for an absent term", () => {
    const hits = grepHits("NoSuchModelXYZ", [join(root, "research")], "script", { max: 50 });
    expect(hits.length).toBe(0);
  });
});
