"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface AgentState {
  id: string | null;
  status: "idle" | "running" | "done" | "error";
  task: string | null;
  output: string;
  exitCode: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  pid: number | null;
}

const PRESETS = [
  { label: "Health Check", task: "Check the full cluster health: both nodes, vLLM status, all downloads, PM2 processes, disk space, Tailscale. Report findings in a structured summary. Flag anything that needs attention." },
  { label: "Fix & Rebuild", task: "Check for TypeScript errors, linting issues, or runtime problems in the dashboard codebase. Fix any issues found, run npm run build to verify, restart with pm2 restart cluster-dash, then commit and push." },
  { label: "Sync Model Configs", task: "Check the HF cache for all downloaded models. Update KNOWN_EXPECTED_BYTES in /api/cluster/route.ts and KNOWN_MODELS in /api/control/route.ts with accurate on-disk sizes and correct vLLM defaults for any model that is now complete. Build, restart, commit and push." },
  { label: "Download Status", task: "Check all active model downloads: which models are downloading, current size vs expected, estimated completion time. Check pgrep for running hf download processes and tail the latest log file." },
  { label: "vLLM Diagnostics", task: "Diagnose the vLLM cluster: check container status on both nodes, tail the last 30 lines of logs from both head and worker, check memory utilization, report any errors. Do not restart unless explicitly needed." },
  { label: "Commit & Push", task: "Stage all uncommitted changes in ~/sites/cluster-dash, write a detailed commit message describing the changes, commit, and push to origin main." },
  { label: "Ops Log Review", task: "Read ~/server-board.md and report: what is the current state of the cluster, what outstanding issues exist, and what should be done next. Do not make any changes — report only." },
  { label: "Add gpt-oss-120b", task: "Start downloading openai/gpt-oss-120b to the HF cache using ~/.local/bin/hf download openai/gpt-oss-120b, background it with nohup, log to ~/gpt-oss-120b-download.log. Then add it to KNOWN_EXPECTED_BYTES and KNOWN_MODELS in the dashboard with correct defaults (MXFP4 ~80GB, maxLen 32768, gpuUtil 0.88, maxContextSlider 131072). Build, restart, commit, push." },
];

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return <span>{m > 0 ? `${m}m ` : ""}{s}s</span>;
}

export function AgentPanel() {
  const [state, setState] = useState<AgentState>({
    id: null, status: "idle", task: null, output: "", exitCode: null,
    startedAt: null, finishedAt: null, pid: null,
  });
  const [taskInput, setTaskInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const prevOutputLen = useRef(0);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/agent", { cache: "no-store" });
      if (res.ok) setState(await res.json());
    } catch { /* ignore */ }
  }, []);

  // Poll fast when running, slow when idle/done
  useEffect(() => {
    poll();
    const interval = state.status === "running" ? 1500 : 8000;
    const id = setInterval(poll, interval);
    return () => clearInterval(id);
  }, [poll, state.status]);

  // Auto-scroll output when new content arrives
  useEffect(() => {
    if (!autoScroll || !outputRef.current) return;
    if (state.output.length !== prevOutputLen.current) {
      prevOutputLen.current = state.output.length;
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [state.output, autoScroll]);

  const submit = async (task: string) => {
    if (!task.trim() || submitting) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
      });
      const json = await res.json() as { ok: boolean; error?: string };
      if (!json.ok) setFeedback(json.error ?? "Failed to start");
      else { setTaskInput(""); await poll(); }
    } catch (e: unknown) {
      setFeedback((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const kill = async () => {
    await fetch("/api/agent", { method: "DELETE" });
    await poll();
  };

  const statusColor = state.status === "running" ? "#a78bfa"
    : state.status === "done" ? "#10b981"
    : state.status === "error" ? "#ef4444"
    : "#475569";

  const statusLabel = state.status === "running" ? "RUNNING"
    : state.status === "done" ? "DONE"
    : state.status === "error" ? "ERROR"
    : "IDLE";

  const isRunning = state.status === "running";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* ── Agent identity card ── */}
      <div style={{ background: "#0c1220", border: "1px solid #2a1f50", borderRadius: 12, padding: 16, position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg, #8b5cf6, #3b82f688, #10b98166, transparent)" }} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg, #8b5cf6, #3b82f6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, boxShadow: "0 0 12px #8b5cf644" }}>
              ◈
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.08em", color: "#e2e8f0" }}>CLAUDE CODE AGENT</div>
              <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.1em" }}>CLUSTER MANAGER · DASHBOARD DEVELOPER · claude-sonnet-4-6</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {isRunning && state.startedAt && (
              <span style={{ fontSize: 10, color: "#64748b" }}>
                <ElapsedTimer startedAt={state.startedAt} />
              </span>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 20, background: `${statusColor}12`, border: `1px solid ${statusColor}33` }}>
              <div style={{
                width: 6, height: 6, borderRadius: "50%", background: statusColor,
                ...(isRunning ? {} : {}),
              }} className={isRunning ? "pulse-dot" : ""} />
              <span style={{ fontSize: 10, color: statusColor, fontWeight: 700, letterSpacing: "0.1em" }}>{statusLabel}</span>
            </div>
          </div>
        </div>

        {/* Current task display */}
        {state.task && (
          <div style={{ background: "#080c14", border: "1px solid #1a2540", borderRadius: 6, padding: "8px 12px", fontSize: 11, color: isRunning ? "#a78bfa" : "#64748b", fontStyle: "italic" }}>
            {state.task}
          </div>
        )}
      </div>

      {/* ── Quick task presets ── */}
      <div style={{ background: "#0c1220", border: "1px solid #1a2540", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ background: "#0a1018", borderBottom: "1px solid #1a2540", padding: "10px 16px" }}>
          <span style={{ fontSize: 10, letterSpacing: "0.12em", color: "#475569", textTransform: "uppercase" }}>▸ QUICK TASKS</span>
        </div>
        <div style={{ padding: 14, display: "flex", flexWrap: "wrap", gap: 8 }}>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => !isRunning && submit(p.task)}
              disabled={isRunning || submitting}
              style={{
                background: isRunning ? "#0a1018" : "#0f1a2e",
                border: `1px solid ${isRunning ? "#1a2540" : "#1e3a5f"}`,
                borderRadius: 6,
                padding: "6px 12px",
                cursor: isRunning ? "not-allowed" : "pointer",
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.06em",
                color: isRunning ? "#334155" : "#60a5fa",
                fontFamily: "inherit",
                opacity: isRunning ? 0.5 : 1,
                transition: "all 0.15s",
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Custom task input ── */}
      <div style={{ background: "#0c1220", border: "1px solid #1a2540", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ background: "#0a1018", borderBottom: "1px solid #1a2540", padding: "10px 16px" }}>
          <span style={{ fontSize: 10, letterSpacing: "0.12em", color: "#475569", textTransform: "uppercase" }}>▸ CUSTOM TASK</span>
        </div>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <textarea
            value={taskInput}
            onChange={(e) => setTaskInput(e.target.value)}
            placeholder="Describe a task for the agent… e.g. 'Add Qwen3-Coder-Next to the control panel model selector with correct vLLM parameters and rebuild the dashboard'"
            disabled={isRunning}
            rows={4}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !isRunning) submit(taskInput); }}
            style={{
              width: "100%",
              background: "#080c14",
              border: "1px solid #1a2540",
              borderRadius: 6,
              padding: "10px 12px",
              color: "#e2e8f0",
              fontSize: 12,
              fontFamily: "inherit",
              resize: "vertical",
              outline: "none",
              boxSizing: "border-box",
              opacity: isRunning ? 0.5 : 1,
            }}
          />
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              onClick={() => submit(taskInput)}
              disabled={isRunning || submitting || !taskInput.trim()}
              style={{
                background: isRunning || !taskInput.trim() ? "#0a1018" : "#1e3a8a22",
                border: `1px solid ${isRunning || !taskInput.trim() ? "#1a2540" : "#3b82f655"}`,
                borderRadius: 6,
                padding: "8px 20px",
                cursor: isRunning || submitting || !taskInput.trim() ? "not-allowed" : "pointer",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.1em",
                color: isRunning || !taskInput.trim() ? "#334155" : "#60a5fa",
                fontFamily: "inherit",
                textTransform: "uppercase",
                opacity: isRunning || !taskInput.trim() ? 0.4 : 1,
              }}
            >
              {submitting ? "Starting…" : "▶ Run Task"}
            </button>

            {isRunning && (
              <button
                onClick={kill}
                style={{
                  background: "#1c0a0a",
                  border: "1px solid #7f1d1d",
                  borderRadius: 6,
                  padding: "8px 16px",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.1em",
                  color: "#f87171",
                  fontFamily: "inherit",
                  textTransform: "uppercase",
                }}
              >
                ■ Kill
              </button>
            )}

            <span style={{ fontSize: 9, color: "#334155" }}>Ctrl+Enter to submit</span>
            {feedback && <span style={{ fontSize: 10, color: "#ef4444" }}>✗ {feedback}</span>}
          </div>
        </div>
      </div>

      {/* ── Output viewer ── */}
      {(state.output || state.status !== "idle") && (
        <div style={{ background: "#0c1220", border: "1px solid #1a2540", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ background: "#0a1018", borderBottom: "1px solid #1a2540", padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 10, letterSpacing: "0.12em", color: "#475569", textTransform: "uppercase" }}>▸ AGENT OUTPUT</span>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              {state.finishedAt && state.startedAt && (
                <span style={{ fontSize: 9, color: "#334155" }}>
                  {((state.finishedAt - state.startedAt) / 1000).toFixed(1)}s
                </span>
              )}
              <button
                onClick={() => setAutoScroll((a) => !a)}
                style={{
                  background: autoScroll ? "#1e3a5f" : "#0a1018",
                  border: `1px solid ${autoScroll ? "#3b82f644" : "#1a2540"}`,
                  borderRadius: 4,
                  padding: "2px 8px",
                  cursor: "pointer",
                  fontSize: 9,
                  color: autoScroll ? "#60a5fa" : "#475569",
                  fontFamily: "inherit",
                  letterSpacing: "0.06em",
                }}
              >
                {autoScroll ? "AUTO-SCROLL ON" : "AUTO-SCROLL OFF"}
              </button>
            </div>
          </div>
          <div
            ref={outputRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              setAutoScroll(atBottom);
            }}
            style={{
              padding: "12px 16px",
              height: 420,
              overflowY: "auto",
              fontFamily: "'Courier New', 'Consolas', monospace",
              fontSize: 11,
              lineHeight: 1.6,
              color: "#94a3b8",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "#060910",
            }}
          >
            {state.output || <span style={{ color: "#334155", fontStyle: "italic" }}>Waiting for output…</span>}
            {isRunning && (
              <span style={{ color: "#8b5cf6", animation: "pulse-ring 1s ease-out infinite" }}>█</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
