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

function NodeRow({
  label,
  bytes,
  total,
  speed,
  nfs,
}: {
  label: string;
  bytes: number;
  total: number;
  speed: number;
  nfs?: boolean;
}) {
  const pct = total > 0 ? Math.min(100, (bytes / total) * 100) : 0;
  const eta = speed > 0 && bytes < total ? fmtDuration((total - bytes) / speed) : null;
  const barColor = pct >= 99 ? "#10b981" : pct >= 50 ? "#3b82f6" : "#8b5cf6";

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, color: "#94a3b8", fontWeight: 700, letterSpacing: "0.06em" }}>{label}</span>
          {nfs && (
            <span style={{ fontSize: 9, color: "#475569", background: "#1e293b", border: "1px solid #334155", borderRadius: 3, padding: "1px 5px", letterSpacing: "0.06em" }}>
              NFS ← SPARK1
            </span>
          )}
          <span style={{ fontSize: 9, color: "#475569" }}>
            {fmtBytes(bytes, 1)}{total > 0 ? ` / ${fmtBytes(total, 0)}` : ""}
          </span>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {speed > 0 && <span style={{ fontSize: 9, color: "#f59e0b" }}>{fmtBytes(speed, 0)}/s</span>}
          {eta && <span style={{ fontSize: 9, color: "#64748b" }}>ETA {eta}</span>}
          {total > 0 && (
            <span style={{ fontSize: 10, fontWeight: 700, color: barColor, minWidth: 36, textAlign: "right" }}>
              {pct.toFixed(1)}%
            </span>
          )}
        </div>
      </div>
      <div style={{ height: 6, background: "#0a1020", border: "1px solid #1a2540", borderRadius: 3, overflow: "hidden", position: "relative" }}>
        <div
          className="bar-fill"
          style={{
            position: "absolute", top: 0, left: 0, height: "100%",
            width: `${pct || (bytes > 0 ? 1 : 0)}%`,
            background: `linear-gradient(90deg, ${barColor}aa, ${barColor})`,
            borderRadius: 3, boxShadow: `0 0 6px ${barColor}66`,
          }}
        />
        {pct > 0 && pct < 100 && (
          <div style={{ position: "absolute", top: 0, left: `${pct - 2}%`, width: "4%", height: "100%", background: "rgba(255,255,255,0.15)", borderRadius: 3 }} />
        )}
      </div>
    </div>
  );
}

function ModelCard({ d }: { d: DownloadData }) {
  const shortModel = d.model.split("/").pop() ?? d.model;

  return (
    <div style={{ background: "#0c1220", border: "1px solid #2a1f50", borderRadius: 12, padding: 16, position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg, #8b5cf6, #3b82f688, transparent)", borderRadius: "12px 12px 0 0" }} />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 10, letterSpacing: "0.12em", color: "#475569", textTransform: "uppercase" }}>⬇ MODEL DOWNLOAD</span>
          <span style={{
            fontSize: 9, padding: "2px 7px", borderRadius: 4, letterSpacing: "0.1em", textTransform: "uppercase",
            background: d.active ? "#4c1d9522" : "#10b98122",
            color: d.active ? "#a78bfa" : "#10b981",
            border: `1px solid ${d.active ? "#7c3aed44" : "#10b98144"}`,
          }}>
            {d.active ? "IN PROGRESS" : "COMPLETE"}
          </span>
        </div>
        <span style={{ fontSize: 10, color: "#22d3ee", letterSpacing: "0.04em" }}>{shortModel}</span>
      </div>

      <NodeRow
        label="SPARK1"
        bytes={d.bytes}
        total={d.expectedBytes}
        speed={d.dlSpeedS1}
      />
      <NodeRow
        label="SPARK2"
        bytes={d.bytes}
        total={d.expectedBytes}
        speed={0}
        nfs
      />
    </div>
  );
}

export function DownloadPanel({ downloads }: DownloadPanelProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {downloads.map((d) => <ModelCard key={d.model} d={d} />)}
    </div>
  );
}
