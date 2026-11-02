"use client";

import { ArcGauge } from "./ArcGauge";
import { SparkLine } from "./SparkLine";
import { fmtBytes, fmtUptime, tempColor, gaugeColor, clamp } from "@/lib/utils";

interface GpuData {
  name: string | null;
  memTotal: number | null;
  memUsed: number | null;
  util: number | null;
  temp: number | null;
  powerW: number | null;
}

interface NodeData {
  hostname: string;
  online: boolean;
  cpuPct: number | null;
  cpuCores: number | null;
  memTotal: number;
  memUsed: number | null;
  diskTotal: number | null;
  diskUsed: number | null;
  loadAvg: [number, number, number] | null;
  uptime: number | null;
  gpu: GpuData;
}

interface NodeCardProps {
  label: string;
  role: "MASTER" | "WORKER";
  ip: string;
  data: NodeData | null;
  history: NodeData[];
  /** Why collection failed (null when the node reported fine). */
  error?: string | null;
}

function StatRow({
  icon,
  label,
  value,
  valueColor,
  sub,
}: {
  icon: string;
  label: string;
  value: string;
  valueColor?: string;
  sub?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "4px 0",
        borderBottom: "1px solid #1a2540",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#64748b" }}>
        <span style={{ fontSize: 12 }}>{icon}</span>
        <span style={{ fontSize: 11, letterSpacing: "0.04em" }}>{label}</span>
      </div>
      <div style={{ textAlign: "right" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: valueColor ?? "#e2e8f0" }}>
          {value}
        </span>
        {sub && (
          <span style={{ fontSize: 10, color: "#475569", marginLeft: 4 }}>{sub}</span>
        )}
      </div>
    </div>
  );
}

export function NodeCard({ label, role, ip, data, history, error }: NodeCardProps) {
  const online = data?.online ?? false;

  const gpuUtilHistory = history.map((h) => h.gpu.util ?? 0);
  const gpuMemHistory = history.map((h) =>
    Math.round(((h.gpu.memUsed ?? 0) / Math.max(h.gpu.memTotal ?? 1, 1)) * 100)
  );
  const cpuHistory = history.map((h) => h.cpuPct ?? 0);

  const gpuMemPct = data?.gpu.memTotal
    ? Math.round(((data.gpu.memUsed ?? 0) / Math.max(data.gpu.memTotal, 1)) * 100)
    : null;
  const ramPct =
    data && data.memUsed !== null ? Math.round((data.memUsed / Math.max(data.memTotal, 1)) * 100) : null;
  const diskPct =
    data && data.diskTotal ? Math.round((data.diskUsed ?? 0) / Math.max(data.diskTotal, 1) * 100) : null;

  // A metric the host cannot report stays null all the way here — render "n/a"
  // instead of a fabricated 0.
  const na = "n/a";

  return (
    <div
      style={{
        background: "#0c1220",
        border: `1px solid ${online ? "#1a2540" : "#2a1a1a"}`,
        borderRadius: 12,
        padding: "16px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Corner accent */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 3,
          height: "100%",
          background: online ? "#10b981" : "#ef4444",
          borderRadius: "12px 0 0 12px",
        }}
      />

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", paddingLeft: 8 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ position: "relative", width: 8, height: 8 }}>
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: online ? "#10b981" : "#ef4444",
                  position: "relative",
                }}
                className={online ? "pulse-dot" : ""}
              />
            </div>
            <span
              style={{
                fontSize: 13,
                fontWeight: 700,
                letterSpacing: "0.1em",
                color: "#e2e8f0",
                textTransform: "uppercase",
              }}
            >
              {label}
            </span>
            <span
              style={{
                fontSize: 9,
                letterSpacing: "0.12em",
                color: role === "MASTER" ? "#3b82f6" : "#8b5cf6",
                background: role === "MASTER" ? "#1e3a8a22" : "#4c1d9522",
                border: `1px solid ${role === "MASTER" ? "#3b82f633" : "#7c3aed33"}`,
                borderRadius: 4,
                padding: "1px 5px",
                textTransform: "uppercase",
              }}
            >
              {role}
            </span>
          </div>
          <div style={{ fontSize: 10, color: "#475569", marginTop: 2, paddingLeft: 16 }}>
            {data?.hostname ?? "—"} · {ip}
          </div>
        </div>
        {data && data.uptime !== null && (
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: "#475569" }}>UPTIME</div>
            <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600 }}>
              {fmtUptime(data.uptime)}
            </div>
          </div>
        )}
      </div>

      {!online ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            height: 140,
            color: "#ef4444",
            fontSize: 12,
            letterSpacing: "0.08em",
            opacity: 0.85,
          }}
        >
          <div>NODE OFFLINE</div>
          {error && (
            <div
              style={{
                fontSize: 9,
                letterSpacing: "0.02em",
                color: "#f87171",
                opacity: 0.85,
                textAlign: "center",
                padding: "0 12px",
                wordBreak: "break-word",
              }}
            >
              {error}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* GPU Gauges row */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-around",
              alignItems: "flex-start",
              paddingLeft: 8,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <ArcGauge
                pct={data!.gpu.util ?? 0}
                label="GPU"
                sublabel={data!.gpu.util === null ? "n/a" : "COMPUTE"}
                size={108}
              />
              <SparkLine data={gpuUtilHistory} color={gaugeColor(data!.gpu.util ?? 0)} max={100} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <ArcGauge
                pct={gpuMemPct ?? 0}
                label="VRAM"
                sublabel={
                  gpuMemPct === null
                    ? na
                    : `${fmtBytes(data!.gpu.memUsed ?? 0, 0)}`
                }
                size={108}
              />
              <SparkLine data={gpuMemHistory} color={gaugeColor(gpuMemPct ?? 0)} max={100} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <ArcGauge
                pct={clamp(data!.cpuPct ?? 0, 0, 100)}
                label="CPU"
                sublabel={data!.cpuCores === null ? na : `${data!.cpuCores} CORES`}
                size={108}
              />
              <SparkLine data={cpuHistory} color={gaugeColor(data!.cpuPct ?? 0)} max={100} />
            </div>
          </div>

          {/* GPU name badge */}
          <div
            style={{
              marginLeft: 8,
              display: "inline-block",
              background: "#0a1628",
              border: "1px solid #1a2540",
              borderRadius: 6,
              padding: "2px 8px",
              fontSize: 10,
              color: "#22d3ee",
              letterSpacing: "0.06em",
              alignSelf: "flex-start",
            }}
          >
            {data!.gpu.name ?? "GPU UNKNOWN"} ·{" "}
            {data!.gpu.memTotal ? `${fmtBytes(data!.gpu.memTotal, 1)} UNIFIED` : "UNIFIED n/a"}
          </div>

          {/* Stats grid */}
          <div style={{ paddingLeft: 8 }}>
            <StatRow
              icon="🌡"
              label="TEMPERATURE"
              value={data!.gpu.temp === null ? na : `${data!.gpu.temp}°C`}
              valueColor={data!.gpu.temp === null ? "#475569" : tempColor(data!.gpu.temp)}
            />
            <StatRow
              icon="⚡"
              label="POWER"
              value={data!.gpu.powerW === null ? na : `${data!.gpu.powerW.toFixed(1)} W`}
              valueColor={data!.gpu.powerW === null ? "#475569" : "#f59e0b"}
            />
            <StatRow
              icon="💾"
              label="SYSTEM RAM"
              value={
                data!.memUsed === null
                  ? `${fmtBytes(data!.memTotal, 0)} (n/a)`
                  : `${fmtBytes(data!.memUsed, 0)} / ${fmtBytes(data!.memTotal, 0)}`
              }
              valueColor={gaugeColor(ramPct ?? 0)}
              sub={ramPct === null ? undefined : `${ramPct}%`}
            />
            <StatRow
              icon="💿"
              label="DISK"
              value={
                data!.diskTotal === null
                  ? na
                  : `${fmtBytes(data!.diskUsed ?? 0, 1)} / ${fmtBytes(data!.diskTotal, 1)}`
              }
              valueColor={gaugeColor(diskPct ?? 0)}
              sub={diskPct === null ? undefined : `${diskPct}%`}
            />
            <StatRow
              icon="📊"
              label="LOAD AVG"
              value={data!.loadAvg ? data!.loadAvg.join(" · ") : na}
              valueColor={data!.loadAvg ? "#64748b" : "#475569"}
            />
          </div>
        </>
      )}
    </div>
  );
}
