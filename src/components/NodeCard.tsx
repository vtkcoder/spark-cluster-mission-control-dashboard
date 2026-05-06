"use client";

import { ArcGauge } from "./ArcGauge";
import { SparkLine } from "./SparkLine";
import { fmtBytes, fmtUptime, tempColor, gaugeColor, clamp } from "@/lib/utils";

interface GpuData {
  name: string;
  memTotal: number;
  memUsed: number;
  util: number;
  temp: number;
  powerW: number;
}

interface NodeData {
  hostname: string;
  online: boolean;
  cpuPct: number;
  cpuCores: number;
  memTotal: number;
  memUsed: number;
  diskTotal: number;
  diskUsed: number;
  loadAvg: [number, number, number];
  uptime: number;
  gpu: GpuData;
}

interface NodeCardProps {
  label: string;
  role: "MASTER" | "WORKER";
  ip: string;
  data: NodeData | null;
  history: NodeData[];
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

export function NodeCard({ label, role, ip, data, history }: NodeCardProps) {
  const online = data?.online ?? false;

  const gpuUtilHistory = history.map((h) => h.gpu.util);
  const gpuMemHistory = history.map((h) =>
    Math.round((h.gpu.memUsed / Math.max(h.gpu.memTotal, 1)) * 100)
  );
  const cpuHistory = history.map((h) => h.cpuPct);

  const gpuMemPct = data
    ? Math.round((data.gpu.memUsed / Math.max(data.gpu.memTotal, 1)) * 100)
    : 0;
  const ramPct = data
    ? Math.round((data.memUsed / Math.max(data.memTotal, 1)) * 100)
    : 0;
  const diskPct = data
    ? Math.round((data.diskUsed / Math.max(data.diskTotal, 1)) * 100)
    : 0;

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
        {data && (
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
            alignItems: "center",
            justifyContent: "center",
            height: 140,
            color: "#ef4444",
            fontSize: 12,
            letterSpacing: "0.08em",
            opacity: 0.6,
          }}
        >
          NODE OFFLINE
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
                pct={data!.gpu.util}
                label="GPU"
                sublabel="COMPUTE"
                size={108}
              />
              <SparkLine data={gpuUtilHistory} color={gaugeColor(data!.gpu.util)} max={100} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <ArcGauge
                pct={gpuMemPct}
                label="VRAM"
                sublabel={`${fmtBytes(data!.gpu.memUsed, 0)}`}
                size={108}
              />
              <SparkLine data={gpuMemHistory} color={gaugeColor(gpuMemPct)} max={100} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <ArcGauge
                pct={clamp(data!.cpuPct, 0, 100)}
                label="CPU"
                sublabel={`${data!.cpuCores} CORES`}
                size={108}
              />
              <SparkLine data={cpuHistory} color={gaugeColor(data!.cpuPct)} max={100} />
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
            {data!.gpu.name} · 121.7 GiB UNIFIED
          </div>

          {/* Stats grid */}
          <div style={{ paddingLeft: 8 }}>
            <StatRow
              icon="🌡"
              label="TEMPERATURE"
              value={`${data!.gpu.temp}°C`}
              valueColor={tempColor(data!.gpu.temp)}
            />
            <StatRow
              icon="⚡"
              label="POWER"
              value={`${data!.gpu.powerW.toFixed(1)} W`}
              valueColor="#f59e0b"
            />
            <StatRow
              icon="💾"
              label="SYSTEM RAM"
              value={`${fmtBytes(data!.memUsed, 0)} / ${fmtBytes(data!.memTotal, 0)}`}
              valueColor={gaugeColor(ramPct)}
              sub={`${ramPct}%`}
            />
            <StatRow
              icon="💿"
              label="DISK"
              value={`${fmtBytes(data!.diskUsed, 1)} / ${fmtBytes(data!.diskTotal, 1)}`}
              valueColor={gaugeColor(diskPct)}
              sub={`${diskPct}%`}
            />
            <StatRow
              icon="📊"
              label="LOAD AVG"
              value={`${data!.loadAvg[0]} · ${data!.loadAvg[1]} · ${data!.loadAvg[2]}`}
              valueColor="#64748b"
            />
          </div>
        </>
      )}
    </div>
  );
}
