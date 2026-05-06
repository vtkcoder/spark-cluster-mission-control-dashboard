"use client";

import { fmtBytes, fmtDuration } from "@/lib/utils";

interface DownloadData {
  model: string;
  spark1Bytes: number;
  spark2Bytes: number;
  expectedBytes: number;
  active: boolean;
  dlSpeedS1: number;
  dlSpeedS2: number;
}

interface DownloadPanelProps {
  data: DownloadData;
}

function NodeBar({
  node,
  bytes,
  total,
  speed,
}: {
  node: string;
  bytes: number;
  total: number;
  speed: number;
}) {
  const pct = total > 0 ? Math.min(100, (bytes / total) * 100) : 0;
  const eta =
    speed > 0 && bytes < total ? fmtDuration((total - bytes) / speed) : null;

  const barColor =
    pct >= 99 ? "#10b981" : pct >= 50 ? "#3b82f6" : "#8b5cf6";

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 5,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, color: "#94a3b8", fontWeight: 700, letterSpacing: "0.06em" }}>
            {node}
          </span>
          <span style={{ fontSize: 9, color: "#475569" }}>
            {fmtBytes(bytes, 1)} / {fmtBytes(total, 0)}
          </span>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {speed > 0 && (
            <span style={{ fontSize: 9, color: "#f59e0b" }}>
              {fmtBytes(speed, 0)}/s
            </span>
          )}
          {eta && (
            <span style={{ fontSize: 9, color: "#64748b" }}>ETA {eta}</span>
          )}
          <span style={{ fontSize: 10, fontWeight: 700, color: barColor, minWidth: 36, textAlign: "right" }}>
            {pct.toFixed(1)}%
          </span>
        </div>
      </div>

      {/* Outer track */}
      <div
        style={{
          height: 8,
          background: "#0a1020",
          border: "1px solid #1a2540",
          borderRadius: 4,
          overflow: "hidden",
          position: "relative",
        }}
      >
        {/* Filled bar */}
        <div
          className="bar-fill"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            height: "100%",
            width: `${pct}%`,
            background: `linear-gradient(90deg, ${barColor}aa, ${barColor})`,
            borderRadius: 4,
            boxShadow: `0 0 8px ${barColor}66`,
          }}
        />
        {/* Shimmer on active */}
        {pct < 100 && pct > 0 && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: `${pct - 2}%`,
              width: "4%",
              height: "100%",
              background: "rgba(255,255,255,0.15)",
              borderRadius: 4,
            }}
          />
        )}
      </div>
    </div>
  );
}

export function DownloadPanel({ data }: DownloadPanelProps) {
  const shortModel = data.model.split("/").pop() ?? data.model;
  const overallPct =
    ((data.spark1Bytes + data.spark2Bytes) / (data.expectedBytes * 2)) * 100;

  return (
    <div
      style={{
        background: "#0c1220",
        border: "1px solid #2a1f50",
        borderRadius: 12,
        padding: 16,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Top accent */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: "linear-gradient(90deg, #8b5cf6, #3b82f688, transparent)",
          borderRadius: "12px 12px 0 0",
        }}
      />

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 10, letterSpacing: "0.12em", color: "#475569", textTransform: "uppercase" }}>
            ⬇ MODEL DOWNLOAD
          </span>
          <span
            style={{
              fontSize: 9,
              padding: "2px 7px",
              borderRadius: 4,
              background: data.active ? "#4c1d9522" : "#10b98122",
              color: data.active ? "#a78bfa" : "#10b981",
              border: `1px solid ${data.active ? "#7c3aed44" : "#10b98144"}`,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
            }}
          >
            {data.active ? "IN PROGRESS" : "COMPLETE"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 10, color: "#22d3ee", letterSpacing: "0.04em" }}>
            {shortModel}
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#a78bfa" }}>
            {overallPct.toFixed(1)}% overall
          </span>
        </div>
      </div>

      {/* Node bars */}
      <NodeBar
        node="SPARK1 (master)"
        bytes={data.spark1Bytes}
        total={data.expectedBytes}
        speed={data.dlSpeedS1}
      />
      <NodeBar
        node="SPARK2 (worker)"
        bytes={data.spark2Bytes}
        total={data.expectedBytes}
        speed={data.dlSpeedS2}
      />

      {/* Footer note */}
      <div style={{ fontSize: 9, color: "#334155", marginTop: 4 }}>
        Switch script monitoring — auto-deploys when both nodes reach 115 GB · HF Transfer enabled · target: 11434
      </div>
    </div>
  );
}
