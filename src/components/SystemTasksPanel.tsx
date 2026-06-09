"use client";

import { useState } from "react";
import { fmtBytes } from "@/lib/utils";

interface ProcessInfo {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  rss: number;
  stat: string;
  comm: string;
}

interface ContainerInfo {
  name: string;
  status: string;
  state: string;
  image: string;
  ports: string;
}

interface ServiceInfo {
  name: string;
  sub: string;
  desc: string;
}

interface NodeTasks {
  online: boolean;
  processes: ProcessInfo[];
  containers: ContainerInfo[];
  services: ServiceInfo[];
}

interface SystemTasksData {
  ts: number;
  spark1: NodeTasks;
  spark2: NodeTasks;
  spark3: NodeTasks;
  spark4: NodeTasks;
}

function statColor(stat: string): string {
  if (stat.startsWith("R")) return "#10b981";
  if (stat.startsWith("S")) return "#3b82f6";
  if (stat.startsWith("D")) return "#f59e0b";
  if (stat.startsWith("Z")) return "#ef4444";
  return "#64748b";
}

function stateColor(state: string): string {
  if (state === "running") return "#10b981";
  if (state === "exited") return "#ef4444";
  if (state === "created") return "#f59e0b";
  return "#475569";
}

function cpuBarColor(pct: number): string {
  if (pct > 50) return "#ef4444";
  if (pct > 20) return "#f59e0b";
  if (pct > 5) return "#3b82f6";
  return "#334155";
}

function ProcessTable({ processes }: { processes: ProcessInfo[] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #1a2540" }}>
            {["PID", "USER", "CPU%", "MEM%", "RSS", "STAT", "COMMAND"].map((h) => (
              <th
                key={h}
                style={{
                  padding: "4px 8px",
                  textAlign: h === "PID" || h === "CPU%" || h === "MEM%" || h === "RSS" ? "right" : "left",
                  fontSize: 9,
                  letterSpacing: "0.1em",
                  color: "#334155",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  whiteSpace: "nowrap",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {processes.map((p, i) => (
            <tr
              key={p.pid}
              style={{
                background: i % 2 === 0 ? "transparent" : "#ffffff04",
                borderBottom: "1px solid #0f1624",
              }}
            >
              <td style={{ padding: "3px 8px", textAlign: "right", color: "#475569", fontVariantNumeric: "tabular-nums" }}>
                {p.pid}
              </td>
              <td style={{ padding: "3px 8px", color: p.user === "root" ? "#f87171" : "#94a3b8" }}>
                {p.user}
              </td>
              <td style={{ padding: "3px 8px", textAlign: "right" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5, justifyContent: "flex-end" }}>
                  <div
                    style={{
                      height: 4,
                      width: Math.min(40, p.cpu * 0.5),
                      background: cpuBarColor(p.cpu),
                      borderRadius: 2,
                      minWidth: p.cpu > 0 ? 2 : 0,
                    }}
                  />
                  <span style={{ color: cpuBarColor(p.cpu), fontVariantNumeric: "tabular-nums", minWidth: 32 }}>
                    {p.cpu.toFixed(1)}
                  </span>
                </div>
              </td>
              <td style={{ padding: "3px 8px", textAlign: "right", color: p.mem > 5 ? "#f59e0b" : "#64748b", fontVariantNumeric: "tabular-nums" }}>
                {p.mem.toFixed(1)}
              </td>
              <td style={{ padding: "3px 8px", textAlign: "right", color: "#475569", fontVariantNumeric: "tabular-nums" }}>
                {fmtBytes(p.rss * 1024, 0)}
              </td>
              <td style={{ padding: "3px 8px" }}>
                <span
                  style={{
                    fontSize: 9,
                    padding: "1px 4px",
                    borderRadius: 3,
                    background: `${statColor(p.stat)}22`,
                    color: statColor(p.stat),
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                  }}
                >
                  {p.stat}
                </span>
              </td>
              <td
                style={{
                  padding: "3px 8px",
                  color: "#e2e8f0",
                  maxWidth: 200,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={p.comm}
              >
                {p.comm}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ContainersTable({ containers }: { containers: ContainerInfo[] }) {
  if (!containers.length) {
    return <div style={{ color: "#334155", fontSize: 11, padding: "10px 0" }}>No containers found</div>;
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #1a2540" }}>
            {["NAME", "STATE", "IMAGE", "STATUS", "PORTS"].map((h) => (
              <th
                key={h}
                style={{
                  padding: "4px 8px",
                  textAlign: "left",
                  fontSize: 9,
                  letterSpacing: "0.1em",
                  color: "#334155",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  whiteSpace: "nowrap",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {containers.map((c, i) => (
            <tr
              key={c.name}
              style={{
                background: i % 2 === 0 ? "transparent" : "#ffffff04",
                borderBottom: "1px solid #0f1624",
              }}
            >
              <td style={{ padding: "4px 8px", color: "#e2e8f0", fontWeight: 600 }}>{c.name}</td>
              <td style={{ padding: "4px 8px" }}>
                <span
                  style={{
                    fontSize: 9,
                    padding: "1px 6px",
                    borderRadius: 3,
                    background: `${stateColor(c.state)}22`,
                    color: stateColor(c.state),
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                  }}
                >
                  {c.state}
                </span>
              </td>
              <td style={{ padding: "4px 8px", color: "#64748b", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.image}>
                {c.image}
              </td>
              <td style={{ padding: "4px 8px", color: "#475569", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.status}>
                {c.status}
              </td>
              <td style={{ padding: "4px 8px", color: "#334155", fontSize: 10, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.ports}>
                {c.ports || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ServicesGrid({ services }: { services: ServiceInfo[] }) {
  if (!services.length) {
    return <div style={{ color: "#334155", fontSize: 11, padding: "10px 0" }}>No services</div>;
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
        gap: 6,
      }}
    >
      {services.map((s) => (
        <div
          key={s.name}
          style={{
            background: "#080e1a",
            border: "1px solid #1a2540",
            borderRadius: 6,
            padding: "5px 8px",
            display: "flex",
            alignItems: "center",
            gap: 7,
          }}
        >
          <div
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "#10b981",
              flexShrink: 0,
              boxShadow: "0 0 4px #10b98166",
            }}
          />
          <div style={{ overflow: "hidden" }}>
            <div
              style={{
                fontSize: 10,
                color: "#94a3b8",
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={s.name}
            >
              {s.name}
            </div>
            {s.desc && (
              <div
                style={{
                  fontSize: 9,
                  color: "#334155",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={s.desc}
              >
                {s.desc}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function NodeTasksColumn({
  label,
  role,
  ip,
  data,
}: {
  label: string;
  role: "MASTER" | "WORKER";
  ip: string;
  data: NodeTasks;
}) {
  const [section, setSection] = useState<"processes" | "containers" | "services">("processes");

  const tabs: { key: typeof section; label: string; count: number }[] = [
    { key: "processes", label: "PROCESSES", count: data.processes.length },
    { key: "containers", label: "CONTAINERS", count: data.containers.length },
    { key: "services", label: "SERVICES", count: data.services.length },
  ];

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        background: "#0c1220",
        border: "1px solid #1a2540",
        borderRadius: 12,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      {/* Node header */}
      <div
        style={{
          background: "#0a1018",
          borderBottom: "1px solid #1a2540",
          padding: "10px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: data.online ? "#10b981" : "#ef4444",
              boxShadow: data.online ? "0 0 5px #10b98166" : "none",
            }}
          />
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", color: "#e2e8f0" }}>
            {label}
          </span>
          <span
            style={{
              fontSize: 9,
              padding: "1px 5px",
              borderRadius: 4,
              background: role === "MASTER" ? "#1e3a8a22" : "#4c1d9522",
              color: role === "MASTER" ? "#3b82f6" : "#8b5cf6",
              border: `1px solid ${role === "MASTER" ? "#3b82f633" : "#7c3aed33"}`,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
            }}
          >
            {role}
          </span>
        </div>
        <span style={{ fontSize: 10, color: "#334155" }}>{ip}</span>
      </div>

      {/* Section tabs */}
      <div
        style={{
          display: "flex",
          borderBottom: "1px solid #1a2540",
          background: "#080e1a",
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setSection(t.key)}
            style={{
              flex: 1,
              padding: "7px 4px",
              background: "none",
              border: "none",
              borderBottom: section === t.key ? "2px solid #3b82f6" : "2px solid transparent",
              cursor: "pointer",
              fontSize: 9,
              letterSpacing: "0.1em",
              color: section === t.key ? "#3b82f6" : "#475569",
              fontWeight: section === t.key ? 700 : 400,
              textTransform: "uppercase",
              fontFamily: "inherit",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
              transition: "color 0.15s",
            }}
          >
            {t.label}
            <span
              style={{
                background: section === t.key ? "#1e3a8a" : "#111827",
                color: section === t.key ? "#60a5fa" : "#334155",
                borderRadius: 10,
                padding: "0 5px",
                fontSize: 9,
                fontWeight: 700,
              }}
            >
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding: "10px 14px", flex: 1, minHeight: 0, overflowY: "auto" }}>
        {!data.online ? (
          <div style={{ color: "#ef4444", fontSize: 11, padding: "20px 0", textAlign: "center", opacity: 0.5 }}>
            NODE OFFLINE
          </div>
        ) : section === "processes" ? (
          <ProcessTable processes={data.processes} />
        ) : section === "containers" ? (
          <ContainersTable containers={data.containers} />
        ) : (
          <ServicesGrid services={data.services} />
        )}
      </div>
    </div>
  );
}

interface SystemTasksPanelProps {
  data: SystemTasksData | null;
  loading: boolean;
  singleNode?: boolean;
}

export function SystemTasksPanel({ data, loading, singleNode = false }: SystemTasksPanelProps) {
  // Only show the empty placeholder on the very first load (no data yet).
  // While refreshing with stale data, keep the existing table visible — no blink.
  if (!data) {
    const placeholders = singleNode ? ["SPARK1"] : ["SPARK1", "SPARK2", "SPARK3", "SPARK4"];
    return (
      <div style={{ display: "flex", gap: 14, height: "100%", minHeight: singleNode ? 0 : 400 }}>
        {placeholders.map((n) => (
          <div
            key={n}
            style={{
              flex: 1,
              minHeight: singleNode ? 0 : 400,
              background: "#0c1220",
              border: "1px solid #1a2540",
              borderRadius: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#1e293b",
              fontSize: 11,
              letterSpacing: "0.1em",
            }}
          >
            {loading ? "LOADING…" : "NO DATA"}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 14, position: "relative", height: "100%" }}>
      {/* Subtle refresh pulse in corner — visible only while polling, no layout shift */}
      {loading && (
        <div
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "#3b82f6",
            boxShadow: "0 0 6px #3b82f6",
            zIndex: 10,
            animation: "pulse-ring 1.2s ease-out infinite",
          }}
        />
      )}
      <NodeTasksColumn
        label="SPARK1"
        role="MASTER"
        ip="192.168.99.10"
        data={data.spark1}
      />
      {!singleNode && (
        <>
          <NodeTasksColumn
            label="SPARK2"
            role="WORKER"
            ip="192.168.99.11"
            data={data.spark2}
          />
          <NodeTasksColumn
            label="SPARK3"
            role="WORKER"
            ip="192.168.99.12"
            data={data.spark3}
          />
          <NodeTasksColumn
            label="SPARK4"
            role="WORKER"
            ip="192.168.99.13"
            data={data.spark4}
          />
        </>
      )}
    </div>
  );
}
