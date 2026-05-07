"use client";

import { fmtBytes, fmtDuration } from "@/lib/utils";

interface DownloadData {
  model: string;
  bytes: number;
  expectedBytes: number;
  active: boolean;
  dlSpeedS1: number;
  dlSpeedS2: number;
}

interface DownloadPanelProps {
  downloads: DownloadData[];
}

function ModelCard({ d }: { d: DownloadData }) {
  const pct = d.expectedBytes > 0 ? Math.min(100, (d.bytes / d.expectedBytes) * 100) : 0;
  const speed = d.dlSpeedS1 + d.dlSpeedS2;
  const eta = speed > 0 && d.bytes < d.expectedBytes ? fmtDuration((d.expectedBytes - d.bytes) / speed) : null;
  const barColor = pct >= 99 ? "#10b981" : pct >= 50 ? "#3b82f6" : "#8b5cf6";
  const shortModel = d.model.split("/").pop() ?? d.model;

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
              background: d.active ? "#4c1d9522" : "#10b98122",
              color: d.active ? "#a78bfa" : "#10b981",
              border: `1px solid ${d.active ? "#7c3aed44" : "#10b98144"}`,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
            }}
          >
            {d.active ? "IN PROGRESS" : "COMPLETE"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 10, color: "#22d3ee", letterSpacing: "0.04em" }}>
            {shortModel}
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#a78bfa" }}>
            {pct.toFixed(1)}%
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
          <span style={{ fontSize: 9, color: "#475569" }}>
            {fmtBytes(d.bytes, 1)} / {fmtBytes(d.expectedBytes, 0)}
          </span>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {speed > 0 && (
              <span style={{ fontSize: 9, color: "#f59e0b" }}>{fmtBytes(speed, 0)}/s</span>
            )}
            {eta && (
              <span style={{ fontSize: 9, color: "#64748b" }}>ETA {eta}</span>
            )}
          </div>
        </div>
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

      <div style={{ fontSize: 9, color: "#334155" }}>
        spark2 reads via NFS — single download on spark1
      </div>
    </div>
  );
}

export function DownloadPanel({ downloads }: DownloadPanelProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {downloads.map((d) => (
        <ModelCard key={d.model} d={d} />
      ))}
    </div>
  );
}
