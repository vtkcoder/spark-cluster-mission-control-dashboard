"use client";

import { useState, useEffect, useCallback } from "react";

interface ModelInfo {
  id: string;
  displayName: string;
  expectedGb: number;
  currentGb: number;
  defaultMaxLen: number;
  defaultGpuUtil: number;
  note: string;
  ready: boolean;
  downloadPct: number;
}

interface ControlData {
  models: ModelInfo[];
}

interface ContainerStates {
  head: string;
  worker: string;
  webui: string;
}

function ActionButton({
  label,
  onClick,
  color = "#3b82f6",
  disabled = false,
  loading = false,
  danger = false,
  confirming = false,
}: {
  label: string;
  onClick: () => void;
  color?: string;
  disabled?: boolean;
  loading?: boolean;
  danger?: boolean;
  confirming?: boolean;
}) {
  const bg = disabled ? "#111827" : confirming ? "#7f1d1d" : danger ? "#1c0a0a" : `${color}18`;
  const border = disabled ? "#1a2540" : confirming ? "#ef4444" : danger ? "#7f1d1d" : `${color}55`;
  const textColor = disabled ? "#334155" : confirming ? "#ef4444" : danger ? "#f87171" : color;

  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 6,
        padding: "7px 16px",
        cursor: disabled || loading ? "not-allowed" : "pointer",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.08em",
        color: textColor,
        fontFamily: "inherit",
        textTransform: "uppercase",
        transition: "all 0.15s",
        opacity: disabled ? 0.4 : 1,
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {loading && (
        <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: textColor, animation: "pulse-ring 1s ease-out infinite" }} />
      )}
      {label}
    </button>
  );
}

function StatusBadge({ state }: { state: string }) {
  const color = state === "running" ? "#10b981" : state === "exited" ? "#ef4444" : "#475569";
  return (
    <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: `${color}22`, color, border: `1px solid ${color}44`, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
      {state}
    </span>
  );
}

function FeedbackBar({ msg, ok }: { msg: string; ok: boolean }) {
  return (
    <div style={{
      background: ok ? "#10b98112" : "#ef444412",
      border: `1px solid ${ok ? "#10b98133" : "#ef444433"}`,
      borderRadius: 6,
      padding: "8px 12px",
      fontSize: 11,
      color: ok ? "#10b981" : "#ef4444",
      letterSpacing: "0.04em",
    }}>
      {ok ? "✓" : "✗"} {msg}
    </div>
  );
}

function fmtCtx(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(0)}K` : String(n);
}

export function ControlPanel({
  containers,
  vllmMaxModelLen,
}: {
  containers: ContainerStates;
  vllmMaxModelLen: number | null;
}) {
  const [data, setData] = useState<ControlData | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [maxLen, setMaxLen] = useState<number>(0);
  const [gpuUtil, setGpuUtil] = useState<number>(0);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<{ msg: string; ok: boolean } | null>(null);
  const [stopConfirm, setStopConfirm] = useState(false);
  const [webuiLoading, setWebuiLoading] = useState(false);
  // Track the last-applied values so we can detect drift in both sliders
  const [appliedMaxLen, setAppliedMaxLen] = useState<number | null>(null);
  const [appliedGpuUtil, setAppliedGpuUtil] = useState<number | null>(null);

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch("/api/control");
      if (res.ok) {
        const d: ControlData = await res.json();
        setData(d);
        if (!selectedModel) {
          const first = d.models.find((m) => m.ready);
          if (first) {
            setSelectedModel(first.id);
            setMaxLen(first.defaultMaxLen);
            setGpuUtil(first.defaultGpuUtil);
          }
        }
      }
    } catch {}
  }, [selectedModel]);

  useEffect(() => { fetchModels(); }, [fetchModels]);

  // Sync applied refs when the live cluster comes online (first time or after restart)
  useEffect(() => {
    if (vllmMaxModelLen !== null && !loading["vllm-start"]) {
      setAppliedMaxLen(vllmMaxModelLen);
    }
  }, [vllmMaxModelLen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Initialise GPU util baseline from model default when cluster is running and we haven't tracked it yet
  useEffect(() => {
    const running = containers.head === "running" || containers.worker === "running";
    if (running && appliedGpuUtil === null && data && selectedModel) {
      const cfg = data.models.find((m) => m.id === selectedModel);
      if (cfg) setAppliedGpuUtil(cfg.defaultGpuUtil);
    }
  }, [containers.head, containers.worker, data, selectedModel, appliedGpuUtil]);

  useEffect(() => {
    if (stopConfirm) {
      const t = setTimeout(() => setStopConfirm(false), 4000);
      return () => clearTimeout(t);
    }
  }, [stopConfirm]);

  const handleModelSelect = (id: string) => {
    setSelectedModel(id);
    const cfg = data?.models.find((m) => m.id === id);
    if (cfg) {
      setMaxLen(cfg.defaultMaxLen);
      setGpuUtil(cfg.defaultGpuUtil);
    }
  };

  const post = async (action: string, extra: Record<string, unknown> = {}) => {
    setLoading((p) => ({ ...p, [action]: true }));
    setFeedback(null);
    try {
      const res = await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const json = await res.json() as { ok: boolean; message?: string; error?: string };
      setFeedback({ msg: json.message ?? json.error ?? "Done", ok: json.ok });
      if (json.ok && action === "vllm-start") {
        // Record what we just applied so the "changes" indicator clears
        setAppliedMaxLen(extra.maxModelLen as number ?? maxLen);
        setAppliedGpuUtil(extra.gpuUtil as number ?? gpuUtil);
      }
      if (json.ok && action === "vllm-stop") {
        setAppliedMaxLen(null);
        setAppliedGpuUtil(null);
      }
    } catch (e: unknown) {
      setFeedback({ msg: (e as Error).message, ok: false });
    } finally {
      setLoading((p) => ({ ...p, [action]: false }));
    }
  };

  const clusterRunning = containers.head === "running" || containers.worker === "running";
  const selectedCfg = data?.models.find((m) => m.id === selectedModel);

  // Detect pending changes: compare sliders against last-applied (or live API for maxLen)
  const liveMaxLen = vllmMaxModelLen ?? appliedMaxLen;
  const liveGpuUtil = appliedGpuUtil;
  const maxLenChanged = clusterRunning && liveMaxLen !== null && maxLen !== liveMaxLen;
  const gpuUtilChanged = clusterRunning && liveGpuUtil !== null && Math.abs(gpuUtil - liveGpuUtil) > 0.001;
  const hasChanges = maxLenChanged || gpuUtilChanged;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ── vLLM Cluster Control ── */}
      <div style={{ background: "#0c1220", border: "1px solid #1a2540", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ background: "#0a1018", borderBottom: "1px solid #1a2540", padding: "10px 16px", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 10, letterSpacing: "0.12em", color: "#475569", textTransform: "uppercase" }}>▸ VLLM CLUSTER</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 9, color: "#64748b" }}>HEAD</span>
            <StatusBadge state={containers.head} />
            <span style={{ fontSize: 9, color: "#64748b" }}>WORKER</span>
            <StatusBadge state={containers.worker} />
          </div>
          {/* Live running config pills */}
          {clusterRunning && vllmMaxModelLen !== null && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 9, color: "#475569", letterSpacing: "0.08em" }}>RUNNING:</span>
              <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: "#a78bfa18", color: "#a78bfa", border: "1px solid #a78bfa33", fontWeight: 700 }}>
                {fmtCtx(vllmMaxModelLen)} CTX
              </span>
              {appliedGpuUtil !== null && (
                <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: "#8b5cf618", color: "#8b5cf6", border: "1px solid #8b5cf633", fontWeight: 700 }}>
                  {(appliedGpuUtil * 100).toFixed(1)}% GPU
                </span>
              )}
            </div>
          )}
        </div>

        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Model selector */}
          <div>
            <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.12em", marginBottom: 8, textTransform: "uppercase" }}>Select Model</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {data?.models.map((m) => {
                const isSelected = selectedModel === m.id;
                // Dynamic note: show current slider values for selected model, else static note
                const dynamicNote = isSelected
                  ? `${fmtCtx(maxLen)} ctx · GPU ${(gpuUtil * 100).toFixed(1)}%`
                  : m.note;
                return (
                  <div
                    key={m.id}
                    onClick={() => m.ready && handleModelSelect(m.id)}
                    style={{
                      border: `1px solid ${isSelected ? "#3b82f6" : "#1a2540"}`,
                      background: isSelected ? "#1e3a8a22" : "#080e1a",
                      borderRadius: 8,
                      padding: "10px 14px",
                      cursor: m.ready ? "pointer" : "not-allowed",
                      opacity: m.ready ? 1 : 0.45,
                      minWidth: 180,
                      transition: "all 0.15s",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: isSelected ? "#60a5fa" : "#e2e8f0" }}>
                        {m.displayName}
                      </span>
                      {m.ready ? (
                        <span style={{ fontSize: 9, color: "#10b981", background: "#10b98118", border: "1px solid #10b98133", borderRadius: 3, padding: "1px 5px" }}>READY</span>
                      ) : (
                        <span style={{ fontSize: 9, color: "#f59e0b", background: "#f59e0b18", border: "1px solid #f59e0b33", borderRadius: 3, padding: "1px 5px" }}>{m.downloadPct}%</span>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: "#64748b" }}>{m.currentGb.toFixed(0)} / {m.expectedGb} GB</div>
                    <div style={{ fontSize: 9, color: isSelected ? "#60a5fa99" : "#334155", marginTop: 2 }}>{dynamicNote}</div>
                    {!m.ready && (
                      <div style={{ marginTop: 6, height: 3, background: "#1a2540", borderRadius: 2 }}>
                        <div style={{ height: "100%", width: `${m.downloadPct}%`, background: "#f59e0b", borderRadius: 2 }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Parameters */}
          {selectedCfg && (
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={{ fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                  <span style={{ color: "#475569" }}>MAX CONTEXT — </span>
                  <span style={{ color: maxLenChanged ? "#f59e0b" : "#3b82f6", fontWeight: 700 }}>
                    {maxLen.toLocaleString()} tokens
                  </span>
                  {maxLenChanged && liveMaxLen !== null && (
                    <span style={{ color: "#475569", fontWeight: 400 }}>
                      (was {liveMaxLen.toLocaleString()})
                    </span>
                  )}
                </label>
                <input
                  type="range"
                  min={512}
                  max={selectedModel.includes("122B") ? 65536 : 7168}
                  step={512}
                  value={maxLen}
                  onChange={(e) => setMaxLen(parseInt(e.target.value))}
                  style={{ width: "100%", accentColor: maxLenChanged ? "#f59e0b" : "#3b82f6" }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#334155", marginTop: 2 }}>
                  <span>512</span>
                  <span style={{ color: maxLenChanged ? "#f59e0b" : "#3b82f6", fontWeight: 700 }}>{maxLen.toLocaleString()}</span>
                  <span>{selectedModel.includes("122B") ? "65K" : "7K"}</span>
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={{ fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                  <span style={{ color: "#475569" }}>GPU MEM UTIL — </span>
                  <span style={{ color: gpuUtilChanged ? "#f59e0b" : "#8b5cf6", fontWeight: 700 }}>
                    {(gpuUtil * 100).toFixed(1)}%
                  </span>
                  {gpuUtilChanged && liveGpuUtil !== null && (
                    <span style={{ color: "#475569", fontWeight: 400 }}>
                      (was {(liveGpuUtil * 100).toFixed(1)}%)
                    </span>
                  )}
                </label>
                <input
                  type="range"
                  min={0.7}
                  max={0.91}
                  step={0.005}
                  value={gpuUtil}
                  onChange={(e) => setGpuUtil(parseFloat(e.target.value))}
                  style={{ width: "100%", accentColor: gpuUtilChanged ? "#f59e0b" : "#8b5cf6" }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#334155", marginTop: 2 }}>
                  <span>70%</span>
                  <span style={{ color: gpuUtilChanged ? "#f59e0b" : "#8b5cf6", fontWeight: 700 }}>{(gpuUtil * 100).toFixed(1)}%</span>
                  <span>91%</span>
                </div>
                <div style={{ fontSize: 9, color: "#1e3a5f", marginTop: 3 }}>
                  max 91% — NCCL overhead limit
                </div>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {/* Apply Changes — only when running and sliders drifted */}
            {hasChanges && (
              <ActionButton
                label={`⟳ APPLY CHANGES${loading["vllm-start"] ? "" : ""}`}
                color="#f59e0b"
                loading={loading["vllm-start"]}
                onClick={() => post("vllm-start", { model: selectedModel, maxModelLen: maxLen, gpuUtil })}
              />
            )}

            {/* Launch — only when not running */}
            {!clusterRunning && (
              <ActionButton
                label="▶ LAUNCH CLUSTER"
                color="#10b981"
                disabled={!selectedModel || !selectedCfg?.ready}
                loading={loading["vllm-start"]}
                onClick={() => post("vllm-start", { model: selectedModel, maxModelLen: maxLen, gpuUtil })}
              />
            )}

            {/* Stop */}
            {loading["vllm-stop"] ? (
              <ActionButton
                label="■ STOPPING…"
                danger
                loading
                onClick={() => {}}
              />
            ) : !stopConfirm ? (
              <ActionButton
                label="■ STOP CLUSTER"
                danger
                disabled={!clusterRunning}
                onClick={() => setStopConfirm(true)}
              />
            ) : (
              <ActionButton
                label="⚠ CONFIRM STOP"
                confirming
                onClick={() => { setStopConfirm(false); post("vllm-stop"); }}
              />
            )}

            {/* Status hint */}
            {clusterRunning && !hasChanges && !loading["vllm-start"] && (
              <span style={{ fontSize: 10, color: "#1e3a5f" }}>
                Adjust sliders to queue a restart
              </span>
            )}
            {hasChanges && !loading["vllm-start"] && (
              <span style={{ fontSize: 10, color: "#f59e0b99" }}>
                Cluster will restart to apply — takes ~15 min
              </span>
            )}
          </div>

          {feedback && <FeedbackBar msg={feedback.msg} ok={feedback.ok} />}
        </div>
      </div>

      {/* ── Quick Container Actions ── */}
      <div style={{ background: "#0c1220", border: "1px solid #1a2540", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ background: "#0a1018", borderBottom: "1px solid #1a2540", padding: "10px 16px" }}>
          <span style={{ fontSize: 10, letterSpacing: "0.12em", color: "#475569", textTransform: "uppercase" }}>▸ QUICK ACTIONS</span>
        </div>
        <div style={{ padding: 16, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
          {/* Open WebUI */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#080e1a", border: "1px solid #1a2540", borderRadius: 8, padding: "10px 14px" }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#e2e8f0", marginBottom: 3 }}>Open WebUI</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <StatusBadge state={containers.webui} />
                <span style={{ fontSize: 9, color: "#475569" }}>:3001</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, marginLeft: 8 }}>
              <ActionButton
                label="START"
                color="#10b981"
                disabled={containers.webui === "running" || webuiLoading}
                loading={webuiLoading && containers.webui !== "running"}
                onClick={async () => {
                  setWebuiLoading(true);
                  await post("container-start", { container: "open-webui" });
                  setWebuiLoading(false);
                }}
              />
              <ActionButton
                label="STOP"
                danger
                disabled={containers.webui !== "running" || webuiLoading}
                loading={webuiLoading && containers.webui === "running"}
                onClick={async () => {
                  setWebuiLoading(true);
                  await post("container-stop", { container: "open-webui" });
                  setWebuiLoading(false);
                }}
              />
            </div>
          </div>

          <div style={{ fontSize: 10, color: "#1e293b", letterSpacing: "0.06em" }}>
            More container controls will appear here as services are added to the cluster.
          </div>
        </div>
      </div>
    </div>
  );
}
