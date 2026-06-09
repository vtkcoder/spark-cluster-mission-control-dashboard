"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface LogData {
  lines: string[];
  source: string;
  ts: number;
  error?: string;
}

const SOURCES = [
  { id: "vllm-head",    label: "vLLM Head",     icon: "▸" },
  { id: "vllm-worker",  label: "vLLM Worker",   icon: "▸" },
  { id: "sglang-head",  label: "SGLang rank0",  icon: "◆" },
  { id: "sglang-rank1", label: "SGLang rank1",  icon: "◆" },
  { id: "sglang-rank2", label: "SGLang rank2",  icon: "◆" },
  { id: "sglang-rank3", label: "SGLang rank3",  icon: "◆" },
  { id: "open-webui",   label: "Open WebUI",    icon: "▸" },
  { id: "pm2-cluster-dash", label: "cluster-dash", icon: "⬡" },
];

function lineColor(line: string): string {
  const l = line.toLowerCase();
  if (/\b(error|exception|traceback|critical|fatal)\b/.test(l)) return "#ef4444";
  if (/\b(warn|warning|deprecated)\b/.test(l)) return "#f59e0b";
  if (/\b(info|started|ready|success|loaded)\b/.test(l)) return "#94a3b8";
  if (/\b(debug)\b/.test(l)) return "#475569";
  return "#64748b";
}

function lineWeight(line: string): number {
  const l = line.toLowerCase();
  if (/\b(error|exception|traceback|critical|fatal|warn|warning)\b/.test(l)) return 600;
  return 400;
}

export function LogsPanel() {
  const [source, setSource] = useState("vllm-head");
  const [lines, setLines] = useState(120);
  const [data, setData] = useState<LogData | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const lastFetch = useRef(0);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/logs?source=${encodeURIComponent(source)}&lines=${lines}`, { cache: "no-store" });
      const json: LogData = await res.json();
      setData(json);
      lastFetch.current = Date.now();
    } catch (e: unknown) {
      setData({ lines: [], source, ts: Date.now(), error: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [source, lines]);

  // Fetch when source or lines change
  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  // Auto-refresh when enabled
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(fetchLogs, 4000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchLogs]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [data, autoScroll]);

  const handleScroll = () => {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    setAutoScroll(atBottom);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ background: "#0c1220", border: "1px solid #1a2540", borderRadius: 12, overflow: "hidden" }}>
        {/* Toolbar */}
        <div style={{ background: "#0a1018", borderBottom: "1px solid #1a2540", padding: "10px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, letterSpacing: "0.12em", color: "#475569", textTransform: "uppercase" }}>▸ LOGS</span>

          {/* Source selector */}
          <div style={{ display: "flex", gap: 4 }}>
            {SOURCES.map((s) => (
              <button
                key={s.id}
                onClick={() => setSource(s.id)}
                style={{
                  background: source === s.id ? "#1e3a8a22" : "transparent",
                  border: `1px solid ${source === s.id ? "#3b82f6" : "#1a2540"}`,
                  borderRadius: 4,
                  padding: "3px 10px",
                  cursor: "pointer",
                  fontSize: 10,
                  fontWeight: source === s.id ? 700 : 400,
                  color: source === s.id ? "#60a5fa" : "#475569",
                  fontFamily: "inherit",
                  transition: "all 0.15s",
                }}
              >
                {s.icon} {s.label}
              </button>
            ))}
          </div>

          {/* Lines selector */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
            <span style={{ fontSize: 9, color: "#475569", letterSpacing: "0.1em" }}>LINES</span>
            {[50, 100, 200, 500].map((n) => (
              <button
                key={n}
                onClick={() => setLines(n)}
                style={{
                  background: lines === n ? "#1e3a8a22" : "transparent",
                  border: `1px solid ${lines === n ? "#3b82f6" : "#1a2540"}`,
                  borderRadius: 4,
                  padding: "2px 7px",
                  cursor: "pointer",
                  fontSize: 10,
                  fontWeight: lines === n ? 700 : 400,
                  color: lines === n ? "#60a5fa" : "#475569",
                  fontFamily: "inherit",
                }}
              >
                {n}
              </button>
            ))}
          </div>

          {/* Auto-refresh toggle */}
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            style={{
              background: autoRefresh ? "#10b98118" : "transparent",
              border: `1px solid ${autoRefresh ? "#10b98155" : "#1a2540"}`,
              borderRadius: 4,
              padding: "3px 10px",
              cursor: "pointer",
              fontSize: 10,
              fontWeight: autoRefresh ? 700 : 400,
              color: autoRefresh ? "#10b981" : "#475569",
              fontFamily: "inherit",
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            {autoRefresh && <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#10b981", animation: "pulse-ring 1s ease-out infinite" }} />}
            LIVE
          </button>

          {/* Manual refresh */}
          <button
            onClick={fetchLogs}
            disabled={loading}
            style={{
              background: "transparent",
              border: "1px solid #1a2540",
              borderRadius: 4,
              padding: "3px 10px",
              cursor: loading ? "not-allowed" : "pointer",
              fontSize: 10,
              color: "#475569",
              fontFamily: "inherit",
              opacity: loading ? 0.5 : 1,
            }}
          >
            ↻ REFRESH
          </button>

          {loading && <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#3b82f6", animation: "pulse-ring 1s ease-out infinite" }} />}

          {data?.ts && !loading && (
            <span style={{ fontSize: 9, color: "#1e293b" }}>
              {new Date(data.ts).toLocaleTimeString("en-GB", { hour12: false })}
            </span>
          )}
        </div>

        {/* Log output */}
        <div
          ref={logRef}
          onScroll={handleScroll}
          style={{
            height: 520,
            overflowY: "auto",
            padding: "12px 16px",
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
            fontSize: 11,
            lineHeight: 1.6,
            background: "#06090f",
          }}
        >
          {data?.error ? (
            <div style={{ color: "#ef4444" }}>Error: {data.error}</div>
          ) : data?.lines.length === 0 ? (
            <div style={{ color: "#334155" }}>No log output</div>
          ) : (
            data?.lines.map((line, i) => (
              <div
                key={i}
                style={{
                  color: lineColor(line),
                  fontWeight: lineWeight(line),
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  borderLeft: lineColor(line) === "#ef4444" ? "2px solid #ef444444" : lineColor(line) === "#f59e0b" ? "2px solid #f59e0b33" : "2px solid transparent",
                  paddingLeft: 8,
                  marginBottom: 1,
                }}
              >
                {line}
              </div>
            ))
          )}
          {!data && (
            <div style={{ color: "#334155" }}>Fetching logs…</div>
          )}
        </div>

        {/* Footer */}
        <div style={{ background: "#0a1018", borderTop: "1px solid #1a2540", padding: "6px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 9, color: "#334155" }}>
            {data?.lines.length ?? 0} lines · source: {source}
          </span>
          <span style={{ fontSize: 9, color: autoScroll ? "#10b981" : "#475569" }}>
            {autoScroll ? "↓ auto-scroll on" : "scroll paused"}
          </span>
        </div>
      </div>
    </div>
  );
}
