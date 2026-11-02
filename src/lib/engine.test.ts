// ── Engine detection / SSH resilience tests ───────────────────────────────────
// These cover the two root causes behind the 2026-11-02 outage:
//   1. The SSH control-socket directory lived in /tmp and was deleted by
//      macOS's periodic cleaner, so every ssh call failed and all four nodes
//      reported OFFLINE.
//   2. Engine containers were discovered by NAME (/vllm|sglang/i). The live
//      containers are `dsv41-head` / `dsv41-worker`, so discovery found
//      nothing and the dashboard claimed "vLLM · 1 node" while SGLang served
//      all four nodes.
import { describe, it, expect } from "vitest";
import { existsSync, rmSync } from "fs";
import {
  buildEngineInfo,
  detectEngineType,
  isControlSocketError,
  parseServe,
  sshCommand,
  SSH_CTL_DIR,
  type EngineCandidate,
  type FleetNode,
} from "./engine";

// The real launch command captured from the live `dsv41-head` container on
// spark3 (SGLang, rank 0, TP=4, 4 nodes, port 8001).
const SGLANG_HEAD_CMD =
  "python3 -u /opt/dsv41/boot.py run /opt/sglang/bin/python3 -m sglang.launch_server " +
  "--model-path /models/DeepSeek-V4.1-Flash --served-model-name deepseek-v4.1-flash " +
  "--trust-remote-code --load-format safetensors --tp 4 --ep-size 1 " +
  "--attention-backend dsv4 --moe-runner-backend flashinfer_mxfp4 --mem-fraction-static 0.80 " +
  "--chunked-prefill-size 4096 --context-length 1048576 --max-running-requests 16 " +
  "--cuda-graph-max-bs-decode 16 --random-seed 0 --tool-call-parser deepseekv41 " +
  "--reasoning-parser deepseek-v41 --host 0.0.0.0 --port 8001 --speculative-algorithm DSPARK " +
  "--nnodes 4 --node-rank 0 --dist-init-addr 100.71.243.12:20000 --max-total-tokens 8000000";

// A vLLM launch, for the other dialect.
const VLLM_CMD =
  "vllm serve /home/absolome/.cache/huggingface/hub/models--deepseek-ai--DeepSeek-V4-Flash " +
  "--nnodes 2 --node-rank 0 --master-addr 192.168.177.11 --master-port 29501 " +
  "--tensor-parallel-size 2 --gpu-memory-utilization 0.926 --max-model-len 5680 " +
  "--kv-cache-dtype fp8 --host 0.0.0.0 --port 11434";

describe("parseServe — engine launch parameters", () => {
  it("reads the SGLang dialect (--tp / --nnodes / --node-rank / --context-length)", () => {
    const s = parseServe(SGLANG_HEAD_CMD);
    expect(s.port).toBe(8001);
    expect(s.tp).toBe(4);
    expect(s.nnodes).toBe(4);
    expect(s.nodeRank).toBe(0);
    expect(s.contextLength).toBe(1048576);
    expect(s.model).toBe("deepseek-v4.1-flash");
    expect(s.sglang).toBe(true);
  });

  it("still reads the vLLM dialect (--tensor-parallel-size)", () => {
    const s = parseServe(VLLM_CMD);
    expect(s.port).toBe(11434);
    expect(s.tp).toBe(2);
    expect(s.nnodes).toBe(2);
    expect(s.nodeRank).toBe(0);
    expect(s.sglang).toBe(false);
  });

  it("does not mistake --tp-size for --tp", () => {
    const s = parseServe("sglang.launch_server --tp-size 8 --port 30000");
    expect(s.tp).toBe(8);
    expect(s.port).toBe(30000);
  });

  it("reports 'unknown' for a command without parallelism flags", () => {
    const s = parseServe("python3 -m something_else --port 8000");
    expect(s.tp).toBeUndefined();
    expect(s.pp).toBeUndefined();
    expect(s.nnodes).toBeUndefined();
  });
});

describe("detectEngineType — discovery by process, not by container name", () => {
  it("classifies the live dsv41 container as SGLang", () => {
    // The container is called `dsv41-head` — no "vllm"/"sglang" in the name.
    expect(detectEngineType(SGLANG_HEAD_CMD, "dsv41-head")).toBe("sglang");
    expect(detectEngineType(SGLANG_HEAD_CMD, "dsv41-worker")).toBe("sglang");
  });

  it("cannot classify a container from its name alone (the old heuristic's blind spot)", () => {
    expect(detectEngineType("", "dsv41-head")).toBeNull();
    expect(detectEngineType("", "dsv41-worker")).toBeNull();
  });

  it("still recognises legacy name-based containers as a fallback", () => {
    expect(detectEngineType("", "vllm_node")).toBe("vllm");
    expect(detectEngineType("", "sglang")).toBe("sglang");
  });

  it("classifies a vLLM serve command", () => {
    expect(detectEngineType(VLLM_CMD, "vllm-head")).toBe("vllm");
  });
});

describe("engine topology assembly", () => {
  const node = (key: FleetNode["key"], host: string): FleetNode => ({
    key,
    host,
    apiHost: host,
  });

  it("orders the head first and reports a four-node TP topology", () => {
    const candidates: EngineCandidate[] = [
      { node: node("spark1", "100.79.103.61"), container: "dsv41-worker", type: "sglang", serve: { ...parseServe(SGLANG_HEAD_CMD), nodeRank: 2 } },
      { node: node("spark2", "100.112.35.83"), container: "dsv41-worker", type: "sglang", serve: { ...parseServe(SGLANG_HEAD_CMD), nodeRank: 3 } },
      { node: node("spark3", "100.71.243.12"), container: "dsv41-head", type: "sglang", serve: { ...parseServe(SGLANG_HEAD_CMD), nodeRank: 0 } },
      { node: node("spark4", "100.123.85.111"), container: "dsv41-worker", type: "sglang", serve: { ...parseServe(SGLANG_HEAD_CMD), nodeRank: 1 } },
    ];
    const info = buildEngineInfo(
      "sglang",
      candidates[2].node,
      8001,
      candidates,
      null,
      parseServe(SGLANG_HEAD_CMD),
      true,
    );
    expect(info.label).toBe("SGLang");
    expect(info.parallel).toBe("TP=4");
    expect(info.topology).toBe("TP=4 · spark1/spark2/spark3/spark4");
    expect(info.headNode).toBe("spark3");
    expect(info.detected).toBe(true);
    expect(info.containers.map((c) => c.key)).toEqual(["head", "worker", "worker2", "worker3"]);
    expect(info.containers[0]).toMatchObject({ name: "dsv41-head", node: "spark3", rank: 0 });
    expect(info.containers[1]).toMatchObject({ name: "dsv41-worker", node: "spark4", rank: 1 });
    expect(info.containers[2]).toMatchObject({ name: "dsv41-worker", node: "spark1", rank: 2 });
    expect(info.containers[3]).toMatchObject({ name: "dsv41-worker", node: "spark2", rank: 3 });
  });

  it("flags the API-only fallback so the UI can say why", () => {
    const info = buildEngineInfo(
      "vllm",
      { key: "spark1", host: "10.0.0.223", apiHost: "10.0.0.223" },
      8001,
      [],
      null,
      { sglang: false },
      false,
      "engine container not detected — API-only fallback",
    );
    expect(info.detected).toBe(false);
    expect(info.note).toContain("API-only");
    expect(info.containers).toHaveLength(1);
  });
});

describe("SSH control socket resilience", () => {
  it("recognises the exact failure macOS's /tmp cleaner caused", () => {
    const err =
      "unix_listener: cannot bind to path /tmp/cluster-dash-ssh/absolome@100.71.243.12:22.FM6LhxgXj5EOb1Zo: No such file or directory";
    expect(isControlSocketError(err)).toBe(true);
  });

  it("does not treat a normal ssh failure as a control-socket failure", () => {
    expect(isControlSocketError("ssh: connect to host 10.0.0.1 port 22: Connection refused")).toBe(false);
  });

  it("re-creates the control directory when it disappears (the outage root cause)", () => {
    rmSync(SSH_CTL_DIR, { recursive: true, force: true });
    expect(existsSync(SSH_CTL_DIR)).toBe(false);
    sshCommand("true", "100.71.243.12");
    expect(existsSync(SSH_CTL_DIR)).toBe(true);
  });

  it("keeps the control socket out of /tmp, which macOS periodically wipes", () => {
    const cmd = sshCommand("true", "100.71.243.12");
    expect(cmd).toContain(SSH_CTL_DIR);
    expect(cmd).not.toContain("/tmp/cluster-dash-ssh");
  });

  it("can build a command without connection multiplexing (fallback path)", () => {
    const muxed = sshCommand("true", "100.71.243.12");
    const plain = sshCommand("true", "100.71.243.12", 3, false);
    expect(muxed).toContain("ControlMaster=auto");
    expect(plain).not.toContain("ControlMaster");
    expect(plain).not.toContain("ControlPath");
  });
});
