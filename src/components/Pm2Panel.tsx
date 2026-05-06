"use client";

import { useState, useEffect, useCallback } from "react";

interface Pm2Proc {
  id: number | string;
  name: string;
  status: string;
  cpu: number;
  memBytes: number;
  uptimeSec: number | null;
  restarts: number;
  interpreter: string;
  cwd: string;
}

interface Pm2Data {
  procs: Pm2Proc[];
  ts: number;
  error?: string;
}

function fmtMem(bytes: number): string {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + " GB";
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(0) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
  return bytes + " B";
}

function fmtUptime(sec: number | null): string {
  if (sec === null || sec < 0) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h < 24) return `${h}h ${m}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "online" ? "#10b981" :
    status === "stopped" ? "#475569" :
    status === "errored" ? "#ef4444" :
    status === "stopping" ? "#f59e0b" : "#64748b";
  return (
    <span style={{
      fontSize: 9, padding: "2px 6px", borderRadius: 3,
      background: `${color}22`, color, border: `1px solid ${color}44`,
      fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
      whiteSpace: "nowrap",
    }}>
      {status}
    </span>
  );
}

function ActionBtn({
  label, color, disabled, loading, onClick,
}: {
  label: string; color: string; disabled?: boolean; loading?: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        background: disabled ? "#111827" : `${color}18`,
        border: `1px solid ${disabled ? "#1a2540" : color + "55"}`,
        borderRadius: 4,
        padding: "4px 10px",
        cursor: disabled || loading ? "not-allowed" : "pointer",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.06em",
        color: disabled ? "#334155" : color,
        fontFamily: "inherit",
        textTransform: "uppercase" as const,
        opacity: disabled ? 0.4 : 1,
        transition: "all 0.15s",
      }}
    >
      {loading ? "…" : label}
    </button>
  );
}

export function Pm2Panel() {
  const [data, setData] = useState<Pm2Data | null>(null);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<{ name: string; msg: string; ok: boolean } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const hasData = useState(false);

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await fetch("/api/pm2", { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } catch {}
    setRefreshing(false);
  }, []);

  useEffect(() => { fetchData(false); }, [fetchData]);

  useEffect(() => {
    const id = setInterval(() => fetchData(true), 5000);
    return () => clearInterval(id);
  }, [fetchData]);

  const doAction = async (name: string, action: string) => {
    const key = `${name}:${action}`;
    setLoading((p) => ({ ...p, [key]: true }));
    setFeedback(null);
    try {
      const res = await fetch("/api/pm2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, action }),
      });
      const json = await res.json() as { ok: boolean; output?: string; error?: string };
      setFeedback({ name, msg: json.output ?? json.error ?? "Done", ok: json.ok });
      setTimeout(() => fetchData(true), 800);
    } catch (e: unknown) {
      setFeedback({ name, msg: (e as Error).message, ok: false });
    } finally {
      setLoading((p) => ({ ...p, [key]: false }));
    }
  };

  if (!data) {
    return (
      <div style={{ background: "#0c1220", border: "1px solid #1a2540", borderRadius: 12, padding: 32, textAlign: "center", color: "#334155", fontSize: 11 }}>
        Loading PM2 processes…
      </div>
    );
  }

  if (data.error) {
    return (
      <div style={{ background: "#0c1220", border: "1px solid #1a2540", borderRadius: 12, padding: 32, textAlign: "center", color: "#ef4444", fontSize: 11 }}>
        PM2 error: {data.error}
      </div>
    );
  }

  const onlineCount = data.procs.filter((p) => p.status === "online").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Header card */}
      <div style={{ background: "#0c1220", border: "1px solid #1a2540", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ background: "#0a1018", borderBottom: "1px solid #1a2540", padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 10, letterSpacing: "0.12em", color: "#475569", textTransform: "uppercase" }}>▸ PM2 PROCESS MANAGER</span>
            <span style={{ fontSize: 10, color: "#10b981" }}>{onlineCount} online</span>
            <span style={{ fontSize: 10, color: "#475569" }}>/ {data.procs.length} total</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {refreshing && (
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#3b82f6", animation: "pulse-ring 1s ease-out infinite" }} />
            )}
            <span style={{ fontSize: 9, color: "#334155" }}>
              {new Date(data.ts).toLocaleTimeString("en-GB", { hour12: false })}
            </span>
          </div>
        </div>

        <div style={{ padding: 16 }}>
          {data.procs.length === 0 ? (
            <div style={{ textAlign: "center", color: "#334155", fontSize: 11, padding: "20px 0" }}>No PM2 processes found</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr>
                    {["ID", "Name", "Status", "CPU", "Memory", "Uptime", "Restarts", "Runtime", "Actions"].map((h) => (
                      <th key={h} style={{ textAlign: "left", padding: "4px 10px 8px", fontSize: 9, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase", borderBottom: "1px solid #1a2540", whiteSpace: "nowrap" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.procs.map((proc) => {
                    const isOnline = proc.status === "online";
                    const cpuColor = proc.cpu > 80 ? "#ef4444" : proc.cpu > 40 ? "#f59e0b" : "#10b981";
                    const startKey = `${proc.name}:start`;
                    const stopKey = `${proc.name}:stop`;
                    const restartKey = `${proc.name}:restart`;
                    return (
                      <tr key={proc.id} style={{ borderBottom: "1px solid #0f1826" }}>
                        <td style={{ padding: "8px 10px", color: "#475569", fontVariantNumeric: "tabular-nums" }}>{proc.id}</td>
                        <td style={{ padding: "8px 10px" }}>
                          <div style={{ fontWeight: 700, color: "#e2e8f0" }}>{proc.name}</div>
                          <div style={{ fontSize: 9, color: "#334155", marginTop: 1 }}>{proc.cwd}</div>
                        </td>
                        <td style={{ padding: "8px 10px" }}><StatusBadge status={proc.status} /></td>
                        <td style={{ padding: "8px 10px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <div style={{ width: 36, height: 4, background: "#1a2540", borderRadius: 2, overflow: "hidden" }}>
                              <div style={{ width: `${Math.min(100, proc.cpu)}%`, height: "100%", background: cpuColor, borderRadius: 2, transition: "width 0.5s" }} />
                            </div>
                            <span style={{ color: cpuColor, fontVariantNumeric: "tabular-nums", minWidth: 30 }}>{proc.cpu.toFixed(1)}%</span>
                          </div>
                        </td>
                        <td style={{ padding: "8px 10px", color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}>{fmtMem(proc.memBytes)}</td>
                        <td style={{ padding: "8px 10px", color: "#64748b", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{fmtUptime(proc.uptimeSec)}</td>
                        <td style={{ padding: "8px 10px" }}>
                          <span style={{ color: proc.restarts > 5 ? "#f59e0b" : "#475569" }}>{proc.restarts}</span>
                        </td>
                        <td style={{ padding: "8px 10px", color: "#475569" }}>{proc.interpreter || "—"}</td>
                        <td style={{ padding: "8px 10px" }}>
                          <div style={{ display: "flex", gap: 5 }}>
                            <ActionBtn label="Start" color="#10b981" disabled={isOnline} loading={loading[startKey]} onClick={() => doAction(proc.name, "start")} />
                            <ActionBtn label="Restart" color="#3b82f6" disabled={!isOnline} loading={loading[restartKey]} onClick={() => doAction(proc.name, "restart")} />
                            <ActionBtn label="Stop" color="#ef4444" disabled={!isOnline} loading={loading[stopKey]} onClick={() => doAction(proc.name, "stop")} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Feedback */}
      {feedback && (
        <div style={{
          background: feedback.ok ? "#10b98112" : "#ef444412",
          border: `1px solid ${feedback.ok ? "#10b98133" : "#ef444433"}`,
          borderRadius: 8,
          padding: "10px 14px",
          fontSize: 11,
          color: feedback.ok ? "#10b981" : "#ef4444",
        }}>
          <span style={{ fontWeight: 700 }}>{feedback.name}</span> — {feedback.ok ? "✓" : "✗"} {feedback.msg}
        </div>
      )}
    </div>
  );
}
