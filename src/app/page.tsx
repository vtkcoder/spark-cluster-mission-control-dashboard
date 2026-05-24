"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { NodeCard } from "@/components/NodeCard";
import { KpiBar } from "@/components/KpiBar";
import { VllmPanel } from "@/components/VllmPanel";
import { SystemTasksPanel } from "@/components/SystemTasksPanel";
import { ControlPanel } from "@/components/ControlPanel";
import { Pm2Panel } from "@/components/Pm2Panel";
import { LogsPanel } from "@/components/LogsPanel";
import { ChatPanel } from "@/components/ChatPanel";
import { AgentPanel } from "@/components/AgentPanel";
import { InferencePanel } from "@/components/InferencePanel";
import { BackupPanel } from "@/components/BackupPanel";

// ── Types ─────────────────────────────────────────────────────────────────────
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
  containers: { head: string; worker: string; webui: string };
  headUptimeSec: number | null;
  metrics: VllmMetrics | null;
}

interface DownloadData {
  model: string;
  bytes: number;
  expectedBytes: number;
  active: boolean;
  dlSpeedS1: number;
  dlSpeedS2: number;
}

interface ClusterData {
  ts: number;
  nodes: { spark1: NodeData | null; spark2: NodeData | null; spark3: NodeData | null };
  vllm: VllmData;
  downloads: DownloadData[];
}

// ── History buffer ────────────────────────────────────────────────────────────
const MAX_HISTORY = 60;

interface History {
  spark1: NodeData[];
  spark2: NodeData[];
  spark3: NodeData[];
  cacheUsage: number[];
  reqRunning: number[];
}

// ── Tasks types ───────────────────────────────────────────────────────────────
// (intentionally loose — SystemTasksPanel validates internally)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TasksData = any;

// ── Main page ─────────────────────────────────────────────────────────────────
export default function DashPage() {
  const [data, setData] = useState<ClusterData | null>(null);
  const [history, setHistory] = useState<History>({
    spark1: [],
    spark2: [],
    spark3: [],
    cacheUsage: [],
    reqRunning: [],
  });
  const [tasksData, setTasksData] = useState<TasksData | null>(null);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"overview" | "inference" | "tasks" | "control" | "backup" | "pm2" | "logs" | "chat" | "agent">("overview");
  const tasksHasData = useRef(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const errorCount = useRef(0);

  const push = <T,>(arr: T[], item: T): T[] => {
    const next = [...arr, item];
    return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
  };

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/cluster", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: ClusterData = await res.json();
      setData(json);
      setLastUpdate(new Date());
      setError(null);
      errorCount.current = 0;

      setHistory((prev) => ({
        spark1: json.nodes.spark1 ? push(prev.spark1, json.nodes.spark1) : prev.spark1,
        spark2: json.nodes.spark2 ? push(prev.spark2, json.nodes.spark2) : prev.spark2,
        spark3: json.nodes.spark3 ? push(prev.spark3, json.nodes.spark3) : prev.spark3,
        cacheUsage: push(prev.cacheUsage, json.vllm.metrics?.gpuCacheUsagePct ?? 0),
        reqRunning: push(prev.reqRunning, json.vllm.metrics?.requestsRunning ?? 0),
      }));
    } catch (e: unknown) {
      errorCount.current++;
      if (errorCount.current >= 3) {
        setError(e instanceof Error ? e.message : "Fetch failed");
      }
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [poll]);

  // Tasks poll — only when tasks tab is active, every 5s
  const pollTasks = useCallback(async () => {
    // Only show the loading placeholder before the very first successful fetch.
    // On all subsequent refreshes, keep stale data visible — no blink.
    if (!tasksHasData.current) setTasksLoading(true);
    try {
      const res = await fetch("/api/tasks", { cache: "no-store" });
      if (!res.ok) throw new Error(`tasks HTTP ${res.status}`);
      const json = await res.json();
      setTasksData(json);
      tasksHasData.current = true;
    } catch {
      // silently ignore — stale data stays on screen
    } finally {
      setTasksLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab !== "tasks") return;
    pollTasks();
    const id = setInterval(pollTasks, 5000);
    return () => clearInterval(id);
  }, [activeTab, pollTasks]);

  // Clock tick
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const nodesOnline =
    (data?.nodes.spark1?.online ? 1 : 0) +
    (data?.nodes.spark2?.online ? 1 : 0) +
    (data?.nodes.spark3?.online ? 1 : 0);

  // Single-node mode: we have data but spark2 AND spark3 are both missing/offline.
  // In this mode the dashboard treats spark1 as a standalone master:
  // - CLUSTER CONTROL and SYSTEM TASKS tabs are hidden (the latter merges into OVERVIEW).
  // - KpiBar drops the worker containers and reports "x / 1".
  // - System-tasks content renders inline below the overview.
  const spark2Up = data?.nodes.spark2?.online ?? false;
  const spark3Up = data?.nodes.spark3?.online ?? false;
  const singleNodeMode = data !== null && !spark2Up && !spark3Up;
  const nodesTotal = singleNodeMode ? 1 : (spark2Up ? 1 : 0) + (spark3Up ? 1 : 0) + 1;

  // If the active tab disappears when we drop into single-node mode, fall back
  // to OVERVIEW so the user is never staring at a stale/hidden panel.
  useEffect(() => {
    if (singleNodeMode && (activeTab === "control" || activeTab === "tasks")) {
      setActiveTab("overview");
    }
  }, [singleNodeMode, activeTab]);

  // Poll tasks data in single-node mode too — OVERVIEW now embeds it.
  useEffect(() => {
    if (!(singleNodeMode && activeTab === "overview")) return;
    pollTasks();
    const id = setInterval(pollTasks, 5000);
    return () => clearInterval(id);
  }, [singleNodeMode, activeTab, pollTasks]);

  const now = new Date();

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#06090f",
        display: "flex",
        flexDirection: "column",
        padding: "0 0 24px 0",
      }}
    >
      {/* ── Sticky top bar (header + tab nav travel together) ── */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
        }}
      >
      {/* ── Top Header ── */}
      <div
        style={{
          background: "linear-gradient(180deg, #0c1220 0%, #0a1018 100%)",
          borderBottom: "1px solid #1a2540",
          padding: "12px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {/* Logo mark */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                background: "linear-gradient(135deg, #10b981, #3b82f6)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 14,
                boxShadow: "0 0 12px #10b98144",
              }}
            >
              ⚡
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: "0.12em", color: "#e2e8f0" }}>
                SPARK CLUSTER
              </div>
              <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.1em" }}>
                {singleNodeMode
                  ? "MISSION CONTROL · 1× NVIDIA GB10 · 121.7 GiB GPU"
                  : `MISSION CONTROL · ${nodesTotal}× NVIDIA GB10 · ${(121.7 * nodesTotal).toFixed(0)} GiB GPU`}
              </div>
            </div>
          </div>

          {/* Status pill */}
          {(() => {
            const spark1Up = data?.nodes.spark1?.online ?? false;
            const healthy = singleNodeMode ? spark1Up : nodesOnline === nodesTotal;
            const label = singleNodeMode
              ? spark1Up
                ? "STANDALONE"
                : "OFFLINE"
              : nodesOnline === nodesTotal
                ? "ALL SYSTEMS GO"
                : nodesOnline > 0
                  ? "DEGRADED"
                  : "OFFLINE";
            const color = healthy ? "#10b981" : "#ef4444";
            return (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "3px 10px",
                  borderRadius: 20,
                  background: healthy ? "#10b98112" : "#ef444412",
                  border: `1px solid ${healthy ? "#10b98133" : "#ef444433"}`,
                }}
              >
                <div
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: color,
                    position: "relative",
                  }}
                  className={healthy ? "pulse-dot" : ""}
                />
                <span style={{ fontSize: 10, color, letterSpacing: "0.08em" }}>{label}</span>
              </div>
            );
          })()}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {error && (
            <span style={{ fontSize: 10, color: "#ef4444", letterSpacing: "0.06em" }}>
              ⚠ {error}
            </span>
          )}
          {lastUpdate && (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.1em" }}>LAST POLL</div>
              <div style={{ fontSize: 11, color: "#475569" }}>
                {lastUpdate.toLocaleTimeString("en-GB", { hour12: false })}
              </div>
            </div>
          )}
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: "#64748b",
              letterSpacing: "0.1em",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {now.toLocaleTimeString("en-GB", { hour12: false })}
          </div>
        </div>
      </div>

      {/* ── Tab nav ── */}
      <div
        style={{
          display: "flex",
          gap: 0,
          background: "#080c14",
          borderBottom: "1px solid #1a2540",
          padding: "0 20px",
        }}
      >
        {(["overview", "inference", "tasks", "control", "backup", "pm2", "logs", "chat", "agent"] as const)
          .filter((tab) => !(singleNodeMode && (tab === "tasks" || tab === "control")))
          .map((tab) => {
          const labels: Record<string, string> = { overview: singleNodeMode ? "DASHBOARD" : "OVERVIEW", inference: "INFERENCE", tasks: "SYSTEM TASKS", control: "CLUSTER CONTROL", backup: "◇ BACKUP", pm2: "PM2", logs: "LOGS", chat: "CHAT", agent: "◈ AGENT" };
          const active = activeTab === tab;
          const accentColor =
            tab === "agent" ? "#8b5cf6"
            : tab === "inference" ? "#06b6d4"
            : tab === "backup" ? "#f59e0b"
            : "#3b82f6";
          const activeText =
            tab === "agent" ? "#a78bfa"
            : tab === "inference" ? "#22d3ee"
            : tab === "backup" ? "#fbbf24"
            : "#3b82f6";
          const inactiveText =
            tab === "agent" ? "#5b3f8a"
            : tab === "inference" ? "#0f4a5a"
            : tab === "backup" ? "#5b4520"
            : "#334155";
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                background: "none",
                border: "none",
                borderBottom: active ? `2px solid ${accentColor}` : "2px solid transparent",
                padding: "9px 18px",
                cursor: "pointer",
                fontSize: 10,
                letterSpacing: "0.12em",
                color: active ? activeText : inactiveText,
                fontWeight: active ? 700 : 400,
                fontFamily: "inherit",
                transition: "color 0.15s",
                textTransform: "uppercase",
              }}
            >
              {labels[tab]}
            </button>
          );
        })}
      </div>
      </div>

      {/* ── Main content ── */}
      <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
        {/* KPI bar — always visible */}
        <section>
          <KpiBar
            nodesOnline={nodesOnline}
            nodesTotal={nodesTotal}
            modelName={data?.vllm.model ?? null}
            contextLen={data?.vllm.maxModelLen ?? null}
            vllmOnline={data?.vllm.online ?? false}
            headContainer={data?.vllm.containers.head ?? "absent"}
            workerContainer={data?.vllm.containers.worker ?? "absent"}
            requestsRunning={data?.vllm.metrics?.requestsRunning ?? 0}
            requestsWaiting={data?.vllm.metrics?.requestsWaiting ?? 0}
            gpuTemps={[
              data?.nodes.spark1?.gpu.temp ?? null,
              data?.nodes.spark2?.gpu.temp ?? null,
              data?.nodes.spark3?.gpu.temp ?? null,
            ]}
            headUptimeSec={data?.vllm.headUptimeSec ?? null}
            singleNode={singleNodeMode}
          />
        </section>

        {/* ── OVERVIEW TAB ── */}
        {activeTab === "overview" && (
          <>
            {/* Nodes grid — in single-node mode the spark2 slot holds SystemTasks */}
            <section>
              <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.14em", marginBottom: 8, textTransform: "uppercase" }}>
                {singleNodeMode ? "▸ ACTIVE NODE · SYSTEM TASKS" : "▸ COMPUTE NODES"}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
                  gap: 14,
                  // Single-node mode: pin both cells to one fixed-height row so the
                  // System Tasks panel can grow/shrink internally (scrolling content)
                  // without resizing the row and shifting everything below.
                  ...(singleNodeMode
                    ? { gridAutoRows: "480px", alignItems: "stretch" as const }
                    : { alignItems: "start" as const }),
                }}
              >
                <NodeCard
                  label="SPARK1"
                  role="MASTER"
                  ip="192.168.99.10"
                  data={data?.nodes.spark1 ?? null}
                  history={history.spark1}
                />
                {singleNodeMode ? (
                  <SystemTasksPanel data={tasksData} loading={tasksLoading} singleNode />
                ) : (
                  <>
                    <NodeCard
                      label="SPARK2"
                      role="WORKER"
                      ip="192.168.99.11"
                      data={data?.nodes.spark2 ?? null}
                      history={history.spark2}
                    />
                    <NodeCard
                      label="SPARK3"
                      role="WORKER"
                      ip="192.168.99.12"
                      data={data?.nodes.spark3 ?? null}
                      history={history.spark3}
                    />
                  </>
                )}
              </div>
            </section>

            {/* vLLM panel */}
            <section>
              <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.14em", marginBottom: 8, textTransform: "uppercase" }}>
                ▸ INFERENCE ENGINE
              </div>
              <VllmPanel
                data={data?.vllm ?? {
                  online: false,
                  model: null,
                  maxModelLen: null,
                  containers: { head: "absent", worker: "absent" },
                  headUptimeSec: null,
                  metrics: null,
                }}
                cacheHistory={history.cacheUsage}
                reqHistory={history.reqRunning}
              />
            </section>

          </>
        )}

        {/* ── INFERENCE TAB ── */}
        {activeTab === "inference" && (
          <section>
            <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.14em", marginBottom: 8, textTransform: "uppercase" }}>
              ▸ INFERENCE METRICS · auto-refreshes every 3s
            </div>
            <InferencePanel />
          </section>
        )}

        {/* ── SYSTEM TASKS TAB ── */}
        {activeTab === "tasks" && (
          <section>
            <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.14em", marginBottom: 8, textTransform: "uppercase" }}>
              ▸ SYSTEM TASKS · auto-refreshes every 5s
            </div>
            <SystemTasksPanel data={tasksData} loading={tasksLoading} />
          </section>
        )}

        {/* ── CLUSTER CONTROL TAB ── */}
        {activeTab === "control" && (
          <section>
            <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.14em", marginBottom: 8, textTransform: "uppercase" }}>
              ▸ CLUSTER CONTROL
            </div>
            <ControlPanel
              containers={data?.vllm.containers ?? { head: "absent", worker: "absent", webui: "absent" }}
              vllmMaxModelLen={data?.vllm.maxModelLen ?? null}
              vllmModel={data?.vllm.model ?? null}
              vllmOnline={data?.vllm.online ?? false}
            />
          </section>
        )}

        {/* ── BACKUP TAB ── */}
        {activeTab === "backup" && (
          <section>
            <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.14em", marginBottom: 8, textTransform: "uppercase" }}>
              ▸ BACKUP MANAGER · restic · /mnt/spark-backup
            </div>
            <BackupPanel />
          </section>
        )}

        {/* ── PM2 TAB ── */}
        {activeTab === "pm2" && (
          <section>
            <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.14em", marginBottom: 8, textTransform: "uppercase" }}>
              ▸ PM2 PROCESS MANAGER
            </div>
            <Pm2Panel />
          </section>
        )}

        {/* ── LOGS TAB ── */}
        {activeTab === "logs" && (
          <section>
            <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.14em", marginBottom: 8, textTransform: "uppercase" }}>
              ▸ LOG VIEWER
            </div>
            <LogsPanel />
          </section>
        )}

        {/* ── CHAT TAB ── */}
        {activeTab === "chat" && (
          <section style={{ position: "relative" }}>
            <ChatPanel
              vllmOnline={data?.vllm.online ?? false}
              modelName={data?.vllm.model ?? null}
              maxModelLen={data?.vllm.maxModelLen ?? null}
            />
          </section>
        )}

        {/* ── AGENT TAB ── */}
        {activeTab === "agent" && (
          <section>
            <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.14em", marginBottom: 8, textTransform: "uppercase" }}>
              ▸ CLAUDE CODE AGENT — CLUSTER MANAGER & DASHBOARD DEVELOPER
            </div>
            <AgentPanel />
          </section>
        )}

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: "1px solid #1a2540",
            paddingTop: 12,
            marginTop: 4,
          }}
        >
          <div style={{ fontSize: 9, color: "#1e293b", letterSpacing: "0.1em" }}>
            SPARK CLUSTER MISSION CONTROL · poll interval 3s
          </div>
          <div style={{ fontSize: 9, color: "#1e293b", letterSpacing: "0.1em" }}>
            spark1 192.168.99.10 · spark2 192.168.99.11 · spark3 192.168.99.12 · vLLM :11434
          </div>
        </div>
      </div>
    </div>
  );
}
