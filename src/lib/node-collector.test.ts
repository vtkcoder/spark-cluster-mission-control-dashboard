// ── Node collector tests ──────────────────────────────────────────────────────
// The collector is the thing that fills the gauges. Two properties matter:
//   * a metric the host cannot report must stay null (so the UI can render
//     "n/a") instead of being flattened to a plausible-looking 0;
//   * a broken/garbled payload must produce an error, not a zero-filled node.
import { describe, it, expect } from "vitest";
import {
  COLLECTOR_B64,
  COLLECTOR_CMD,
  COLLECTOR_SRC,
  parseCollectorOutput,
  pickRxInterface,
  toNodeData,
  type NodeRaw,
} from "./node-collector";

function raw(overrides: Partial<NodeRaw> = {}): NodeRaw {
  return {
    hostname: "edgexpert-88dd",
    cpu_pct: 12.5,
    cpu_cores: 20,
    mem_total: 130_663_145_472,
    mem_available: 13_619_154_944,
    disk_total: 4_030_802_149_376,
    disk_used: 3_193_488_310_272,
    load_avg: [1.83, 2.16, 1.35],
    uptime: 2092.94,
    gpu_name: "NVIDIA GB10",
    gpu_mem_total: 130_663_145_472,
    gpu_mem_used: 115_575_889_920,
    gpu_util: 94,
    gpu_temp: 61,
    gpu_power_mw: 14_043,
    net_rx: { lo: 1, enP7s7: 179_114_214, tailscale0: 30_797_799 },
    ...overrides,
  };
}

describe("toNodeData", () => {
  it("maps a healthy node", () => {
    const n = toNodeData(raw());
    expect(n.online).toBe(true);
    expect(n.hostname).toBe("edgexpert-88dd");
    expect(n.cpuPct).toBe(12.5);
    expect(n.cpuCores).toBe(20);
    expect(n.memUsed).toBe(130_663_145_472 - 13_619_154_944);
    expect(n.diskUsed).toBe(3_193_488_310_272);
    expect(n.gpu.powerW).toBeCloseTo(14.043, 3);
    expect(n.gpu.util).toBe(94);
  });

  it("keeps unsupported metrics null instead of turning them into 0", () => {
    const n = toNodeData(
      raw({
        gpu_util: null,
        gpu_temp: null,
        gpu_power_mw: null,
        gpu_mem_used: null,
        gpu_name: null,
      }),
    );
    expect(n.gpu.util).toBeNull();
    expect(n.gpu.temp).toBeNull();
    expect(n.gpu.powerW).toBeNull();
    expect(n.gpu.memUsed).toBeNull();
    expect(n.gpu.name).toBeNull();
    // A zero here would read as "0 °C / 0 W", i.e. a fabricated reading.
    expect(n.gpu.util).not.toBe(0);
  });

  it("reports unknown memory usage as null, not as 'everything is used'", () => {
    const n = toNodeData(raw({ mem_available: null }));
    expect(n.memUsed).toBeNull();
    expect(n.memTotal).toBe(130_663_145_472);
  });
});

describe("parseCollectorOutput", () => {
  it("accepts a JSON payload", () => {
    const res = parseCollectorOutput(JSON.stringify(raw()));
    expect("raw" in res).toBe(true);
    if ("raw" in res) expect(res.raw.hostname).toBe("edgexpert-88dd");
  });

  it("rejects a python traceback instead of returning zeros", () => {
    const res = parseCollectorOutput(
      "Traceback (most recent call last):\n  File \"<string>\", line 1\nImportError: no module named nvitop",
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toContain("not JSON");
  });

  it("rejects empty output", () => {
    const res = parseCollectorOutput("");
    expect("error" in res).toBe(true);
  });
});

describe("pickRxInterface", () => {
  it("prefers the cluster uplink", () => {
    expect(pickRxInterface({ enP7s7: 10, enp1s0f0np0: 999 })).toEqual({
      iface: "enP7s7",
      bytes: 10,
    });
  });

  it("falls back to the busiest non-loopback interface", () => {
    expect(pickRxInterface({ lo: 5, enp1s0f0np0: 999 }, "does-not-exist")).toEqual({
      iface: "enp1s0f0np0",
      bytes: 999,
    });
  });

  it("returns null when there is nothing to report", () => {
    expect(pickRxInterface({ lo: 5 })).toBeNull();
  });
});

describe("collector payload", () => {
  it("travels base64-encoded so no shell metacharacter can break it", () => {
    expect(COLLECTOR_CMD).toContain("base64.b64decode");
    expect(COLLECTOR_SRC).not.toContain("b64decode");
    // The encoded form must not contain a single quote (it is wrapped in one).
    expect(COLLECTOR_B64).not.toContain("'");
  });

  it("reads /proc and nvitop — Linux-only, so it must run on the node, not the Mac", () => {
    expect(COLLECTOR_SRC).toContain("/proc/meminfo");
    expect(COLLECTOR_SRC).toContain("/proc/net/dev");
    expect(COLLECTOR_SRC).toContain("from nvitop import Device");
  });

  it("emits null (not 0) for metrics it could not read", () => {
    expect(COLLECTOR_SRC).toContain("'gpu_util':gpu_util");
    expect(COLLECTOR_SRC).toContain("return None");
  });
});
