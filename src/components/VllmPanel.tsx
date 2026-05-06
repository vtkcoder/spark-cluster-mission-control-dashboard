"use client";

import { SparkLine } from "./SparkLine";

interface VllmMetrics {
  requestsRunning: number;
  requestsWaiting: number;
  gpuCacheUsagePct: number;
  successTotal: number;
  promptTokensTotal: number;
  generationTokensTotal: number;
  e2eLatencyP50: number;
}

interface VllmData {
  online: boolean;
  model: string | null;
  maxModelLen: number | null;
  containers: { head: string; worker: string };
  headUptimeSec: number | null;
  metrics: VllmMetrics | null;
}

interface VllmPanelProps {
  data: VllmData;
  cacheHistory: number[];
  reqHistory: number[];
}

function MetricBox({
  label,
  value,
  sub,
  color = "#94a3b8",
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div
      style={{
        background: "#080e1a",
        border: "1px solid #1a2540",
        borderRadius: 8,
        padding: "8px 12px",
        minWidth: 90,
      }}
    >
      <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.12em", marginBottom: 3, textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: "#475569", marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function ProgressBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div
      style={{
        height: 6,
        background: "#1a2540",
        borderRadius: 3,
        overflow: "hidden",
        flex: 1,
      }}
    >
      <div
        className="bar-fill"
        style={{
          height: "100%",
          width: `${Math.max(0, Math.min(100, pct))}%`,
          background: color,
          borderRadius: 3,
          boxShadow: `0 0 6px ${color}66`,
        }}
      />
    </div>
  );
}

export function VllmPanel({ data, cacheHistory, reqHistory }: VllmPanelProps) {
  const online = data.online;

  return (
    <div
      style={{
        background: "#0c1220",
        border: "1px solid #1a2540",
        borderRadius: 12,
        padding: 16,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Top accent line */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: online
            ? "linear-gradient(90deg, #8b5cf6, #3b82f6, #8b5cf600)"
            : "linear-gradient(90deg, #374151, #37415100)",
          borderRadius: "12px 12px 0 0",
        }}
      />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 10, letterSpacing: "0.12em", color: "#475569", textTransform: "uppercase" }}>
            ▶ INFERENCE ENGINE
          </span>
          <span
            style={{
              fontSize: 9,
              letterSpacing: "0.1em",
              padding: "2px 7px",
              borderRadius: 4,
              background: online ? "#10b98122" : "#1a1a1a",
              color: online ? "#10b981" : "#475569",
              border: `1px solid ${online ? "#10b98144" : "#334155"}`,
              textTransform: "uppercase",
            }}
          >
            {online ? "ONLINE" : "OFFLINE"}
          </span>
        </div>
        {data.model && (
          <div style={{ fontSize: 10, color: "#22d3ee", letterSpacing: "0.04em" }}>
            {data.model}
          </div>
        )}
      </div>

      {!online ? (
        <div style={{ color: "#334155", fontSize: 11, letterSpacing: "0.06em", padding: "20px 0", textAlign: "center" }}>
          ENGINE NOT RUNNING — CONTAINERS:{" "}
          <span style={{ color: data.containers.head === "running" ? "#10b981" : "#ef4444" }}>
            HEAD:{data.containers.head.toUpperCase()}
          </span>{" "}
          <span style={{ color: data.containers.worker === "running" ? "#10b981" : "#ef4444" }}>
            WORKER:{data.containers.worker.toUpperCase()}
          </span>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-start" }}>
          {/* Model info block */}
          <div
            style={{
              background: "#080e1a",
              border: "1px solid #1a2540",
              borderRadius: 8,
              padding: "10px 14px",
              minWidth: 200,
            }}
          >
            <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.12em", marginBottom: 6, textTransform: "uppercase" }}>
              Model Config
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 20 }}>
                <span style={{ fontSize: 10, color: "#64748b" }}>CONTEXT</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: "#a78bfa" }}>
                  {data.maxModelLen?.toLocaleString() ?? "—"} tokens
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 20 }}>
                <span style={{ fontSize: 10, color: "#64748b" }}>TP SIZE</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8" }}>2 × GPU / node</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 20 }}>
                <span style={{ fontSize: 10, color: "#64748b" }}>NODES</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8" }}>2 (spark1 + spark2)</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 20 }}>
                <span style={{ fontSize: 10, color: "#64748b" }}>KV DTYPE</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: "#22d3ee" }}>FP8</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 20 }}>
                <span style={{ fontSize: 10, color: "#64748b" }}>PORT</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8" }}>11434</span>
              </div>
            </div>
          </div>

          {/* Live metrics */}
          {data.metrics ? (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <MetricBox
                  label="RUNNING"
                  value={String(data.metrics.requestsRunning)}
                  sub="requests"
                  color={data.metrics.requestsRunning > 0 ? "#f59e0b" : "#10b981"}
                />
                <MetricBox
                  label="WAITING"
                  value={String(data.metrics.requestsWaiting)}
                  sub="queued"
                  color={data.metrics.requestsWaiting > 0 ? "#ef4444" : "#10b981"}
                />
                <MetricBox
                  label="CACHE"
                  value={`${data.metrics.gpuCacheUsagePct.toFixed(1)}%`}
                  sub="KV used"
                  color="#3b82f6"
                />
                <MetricBox
                  label="SUCCESS"
                  value={String(Math.round(data.metrics.successTotal))}
                  sub="total reqs"
                  color="#94a3b8"
                />
              </div>

              {/* KV Cache bar + sparkline */}
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.12em", marginBottom: 6, textTransform: "uppercase" }}>
                  KV Cache Utilization
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <ProgressBar pct={data.metrics.gpuCacheUsagePct} color="#3b82f6" />
                  <span style={{ fontSize: 10, color: "#3b82f6", minWidth: 32 }}>
                    {data.metrics.gpuCacheUsagePct.toFixed(1)}%
                  </span>
                </div>
                <SparkLine data={cacheHistory} color="#3b82f6" fillColor="#3b82f611" max={100} width={180} height={36} />

                <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.12em", marginTop: 10, marginBottom: 6, textTransform: "uppercase" }}>
                  Active Requests (1m)
                </div>
                <SparkLine data={reqHistory} color="#f59e0b" fillColor="#f59e0b11" max={undefined} width={180} height={36} />
              </div>
            </>
          ) : (
            <div style={{ color: "#334155", fontSize: 11, padding: "10px 0" }}>
              Metrics endpoint unreachable
            </div>
          )}
        </div>
      )}
    </div>
  );
}
