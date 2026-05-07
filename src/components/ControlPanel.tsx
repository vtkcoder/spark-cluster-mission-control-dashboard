"use client";

import { useState, useEffect, useCallback } from "react";

interface ModelInfo {
  id: string;
  displayName: string;
  expectedGb: number;
  currentGb: number;
  defaultMaxLen: number;
  defaultGpuUtil: number;
  maxGpuUtil: number;
  maxContextSlider: number;
  note: string;
  ready: boolean;
  downloading: boolean;
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

// ── Tiny 3-dot animated loading indicator (no pulse-ring) ────────────────────
function LoadingDots() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % 4), 320);
    return () => clearInterval(id);
  }, []);
  const dots = ["   ", ".  ", ".. ", "..."][frame];
  return <span style={{ display: "inline-block", width: 16, letterSpacing: 1 }}>{dots}</span>;
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
        gap: 4,
      }}
    >
      {label}
      {loading && <LoadingDots />}
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
      borderRadius: 6, padding: "8px 12px",
      fontSize: 11, color: ok ? "#10b981" : "#ef4444", letterSpacing: "0.04em",
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
  vllmModel,
  vllmOnline,
}: {
  containers: ContainerStates;
  vllmMaxModelLen: number | null;
  vllmModel: string | null;
  vllmOnline: boolean;
}) {
  const [data, setData] = useState<ControlData | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [maxLen, setMaxLen] = useState<number>(0);
  const [gpuUtil, setGpuUtil] = useState<number>(0);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<{ msg: string; ok: boolean } | null>(null);
  const [stopConfirm, setStopConfirm] = useState(false);
  const [webuiLoading, setWebuiLoading] = useState(false);
  const [appliedGpuUtil, setAppliedGpuUtil] = useState<number | null>(null);

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch("/api/control");
      if (res.ok) {
        const d: ControlData = await res.json();
        setData(d);
        if (!selectedModel) {
          const first = d.models.find((m) => m.ready);
          if (first) { setSelectedModel(first.id); setMaxLen(first.defaultMaxLen); setGpuUtil(first.defaultGpuUtil); }
        }
      }
    } catch {}
  }, [selectedModel]);

  useEffect(() => { fetchModels(); }, [fetchModels]);

  // Sync applied GPU util when cluster comes online
  useEffect(() => {
    if (vllmOnline && !loading["vllm-start"] && data && vllmModel) {
      const cfg = data.models.find((m) => m.id === vllmModel);
      if (cfg && appliedGpuUtil === null) setAppliedGpuUtil(cfg.defaultGpuUtil);
    }
  }, [vllmOnline, vllmModel, data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (stopConfirm) {
      const t = setTimeout(() => setStopConfirm(false), 4000);
      return () => clearTimeout(t);
    }
  }, [stopConfirm]);

  // When vLLM comes online, sync selectedModel + sliders to the live state
  useEffect(() => {
    if (vllmOnline && vllmModel && data) {
      const cfg = data.models.find((m) => m.id === vllmModel);
      if (cfg && selectedModel !== vllmModel) {
        setSelectedModel(vllmModel);
        if (vllmMaxModelLen) setMaxLen(vllmMaxModelLen);
        setGpuUtil(cfg.defaultGpuUtil);
        setAppliedGpuUtil(cfg.defaultGpuUtil);
      }
    }
  }, [vllmOnline, vllmModel]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleModelSelect = (id: string) => {
    setSelectedModel(id);
    const cfg = data?.models.find((m) => m.id === id);
    if (cfg) { setMaxLen(cfg.defaultMaxLen); setGpuUtil(cfg.defaultGpuUtil); }
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
        setAppliedGpuUtil(extra.gpuUtil as number ?? gpuUtil);
      }
      if (json.ok && action === "vllm-stop") {
        setAppliedGpuUtil(null);
      }
    } catch (e: unknown) {
      setFeedback({ msg: (e as Error).message, ok: false });
    } finally {
      setLoading((p) => ({ ...p, [action]: false }));
    }
  };

  const containersUp = containers.head === "running" || containers.worker === "running";
  const isStarting = containersUp && !vllmOnline;
  const selectedCfg = data?.models.find((m) => m.id === selectedModel);

  // Detect pending changes vs live cluster
  const liveMaxLen = vllmMaxModelLen ?? null;
  const liveGpuUtil = appliedGpuUtil;
  const modelChanged = vllmOnline && !!vllmModel && selectedModel !== vllmModel;
  const maxLenChanged = vllmOnline && !modelChanged && liveMaxLen !== null && maxLen !== liveMaxLen;
  const gpuUtilChanged = vllmOnline && !modelChanged && liveGpuUtil !== null && Math.abs(gpuUtil - liveGpuUtil) > 0.001;
  const hasChanges = modelChanged || maxLenChanged || gpuUtilChanged;

  const maxGpuUtil = selectedCfg?.maxGpuUtil ?? 0.926;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* ── vLLM Cluster Control ── */}
      <div style={{ background: "#0c1220", border: "1px solid #1a2540", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ background: "#0a1018", borderBottom: "1px solid #1a2540", padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, letterSpacing: "0.12em", color: "#475569", textTransform: "uppercase" }}>▸ VLLM CLUSTER</span>

          {/* Container status badges */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 9, color: "#64748b" }}>HEAD</span>
            <StatusBadge state={containers.head} />
            <span style={{ fontSize: 9, color: "#64748b" }}>WORKER</span>
            <StatusBadge state={containers.worker} />
          </div>

          {/* Starting indicator */}
          {isStarting && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 10, background: "#f59e0b12", border: "1px solid #f59e0b33" }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#f59e0b" }} />
              <span style={{ fontSize: 9, color: "#f59e0b", fontWeight: 700, letterSpacing: "0.1em" }}>LOADING MODEL…</span>
            </div>
          )}

          {/* Live running config pills */}
          {vllmOnline && vllmModel && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 9, color: "#475569", letterSpacing: "0.08em" }}>LIVE:</span>
              <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 3, background: "#10b98118", color: "#10b981", border: "1px solid #10b98133", fontWeight: 700 }}>
                {data?.models.find(m => m.id === vllmModel)?.displayName ?? vllmModel.split("/").pop()}
              </span>
              {liveMaxLen !== null && (
                <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: "#a78bfa18", color: "#a78bfa", border: "1px solid #a78bfa33", fontWeight: 700 }}>
                  {fmtCtx(liveMaxLen)} CTX
                </span>
              )}
              {liveGpuUtil !== null && (
                <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: "#8b5cf618", color: "#8b5cf6", border: "1px solid #8b5cf633", fontWeight: 700 }}>
                  {(liveGpuUtil * 100).toFixed(1)}% GPU
                </span>
              )}
            </div>
          )}
        </div>

        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>

          {/* ── Model selector ── */}
          <div>
            <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.12em", marginBottom: 8, textTransform: "uppercase" }}>Select Model</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {data?.models.map((m) => {
                const isSelected = selectedModel === m.id;
                const isLive = vllmModel === m.id;
                const isStartingThisModel = isStarting && isSelected;

                const borderColor = isLive ? "#10b981"
                  : isSelected ? "#3b82f6"
                  : m.downloading ? "#4c1d9566"
                  : "#1a2540";

                const bgColor = isLive ? "#071a10"
                  : isSelected ? "#0f1e3a"
                  : m.downloading ? "#1a0a2e22"
                  : "#080e1a";

                const statusColor = m.ready ? "#10b981" : m.downloading ? "#a78bfa" : "#f59e0b";
                const statusLabel = m.ready ? "READY" : m.downloading ? `↓ ${m.downloadPct}%` : `${m.downloadPct}%`;

                const dynamicNote = isSelected
                  ? `${fmtCtx(maxLen)} ctx · GPU ${(gpuUtil * 100).toFixed(1)}%`
                  : m.note;

                return (
                  <div
                    key={m.id}
                    onClick={() => m.ready && !isStartingThisModel && handleModelSelect(m.id)}
                    style={{
                      border: `1px solid ${borderColor}`,
                      background: bgColor,
                      borderRadius: 8,
                      padding: "10px 14px",
                      cursor: m.ready ? "pointer" : "default",
                      minWidth: 190,
                      transition: "all 0.15s",
                      boxShadow: isLive ? "0 0 16px #10b98120" : isSelected ? "0 0 10px #3b82f610" : "none",
                      position: "relative",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: isLive ? "#34d399" : isSelected ? "#60a5fa" : m.downloading ? "#c4b5fd" : "#e2e8f0" }}>
                        {m.displayName}
                      </span>
                      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        {isLive && (
                          <span style={{ fontSize: 8, padding: "1px 5px", borderRadius: 3, background: "#10b98122", color: "#10b981", border: "1px solid #10b98144", fontWeight: 800, letterSpacing: "0.08em" }}>
                            ● LIVE
                          </span>
                        )}
                        {isStartingThisModel && (
                          <span style={{ fontSize: 8, padding: "1px 5px", borderRadius: 3, background: "#f59e0b18", color: "#f59e0b", border: "1px solid #f59e0b33", fontWeight: 800 }}>
                            LOADING
                          </span>
                        )}
                        {!isStartingThisModel && (
                          <span style={{ fontSize: 9, color: statusColor, background: `${statusColor}18`, border: `1px solid ${statusColor}33`, borderRadius: 3, padding: "1px 5px" }}>
                            {statusLabel}
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ fontSize: 10, color: isLive ? "#6ee7b7" : "#64748b" }}>
                      {m.currentGb.toFixed(0)}{m.expectedGb > 0 ? ` / ${m.expectedGb} GB` : " GB on disk"}
                    </div>
                    <div style={{ fontSize: 9, color: isLive ? "#10b98166" : isSelected ? "#60a5fa66" : "#334155", marginTop: 2 }}>
                      {dynamicNote}
                    </div>
                    {!m.ready && (
                      <div style={{ marginTop: 6, height: 3, background: "#1a2540", borderRadius: 2 }}>
                        <div style={{ height: "100%", width: `${m.downloadPct}%`, background: m.downloading ? "#8b5cf6" : "#f59e0b", borderRadius: 2 }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Parameters ── */}
          {selectedCfg && (
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={{ fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                  <span style={{ color: "#475569" }}>MAX CONTEXT —</span>
                  <span style={{ color: maxLenChanged ? "#f59e0b" : "#3b82f6", fontWeight: 700 }}>
                    {maxLen.toLocaleString()} tokens
                  </span>
                  {maxLenChanged && liveMaxLen !== null && (
                    <span style={{ color: "#475569", fontWeight: 400 }}>(live: {liveMaxLen.toLocaleString()})</span>
                  )}
                </label>
                <input
                  type="range" min={512} max={selectedCfg.maxContextSlider} step={512}
                  value={maxLen} onChange={(e) => setMaxLen(parseInt(e.target.value))}
                  style={{ width: "100%", accentColor: maxLenChanged ? "#f59e0b" : "#3b82f6" }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#334155", marginTop: 2 }}>
                  <span>512</span>
                  <span style={{ color: maxLenChanged ? "#f59e0b" : "#3b82f6", fontWeight: 700 }}>{maxLen.toLocaleString()}</span>
                  <span>{fmtCtx(selectedCfg.maxContextSlider)}</span>
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={{ fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                  <span style={{ color: "#475569" }}>GPU MEM UTIL —</span>
                  <span style={{ color: gpuUtilChanged ? "#f59e0b" : "#8b5cf6", fontWeight: 700 }}>
                    {(gpuUtil * 100).toFixed(1)}%
                  </span>
                  {gpuUtilChanged && liveGpuUtil !== null && (
                    <span style={{ color: "#475569", fontWeight: 400 }}>(live: {(liveGpuUtil * 100).toFixed(1)}%)</span>
                  )}
                </label>
                <input
                  type="range" min={0.7} max={maxGpuUtil} step={0.005}
                  value={gpuUtil} onChange={(e) => setGpuUtil(parseFloat(e.target.value))}
                  style={{ width: "100%", accentColor: gpuUtilChanged ? "#f59e0b" : "#8b5cf6" }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#334155", marginTop: 2 }}>
                  <span>70%</span>
                  <span style={{ color: gpuUtilChanged ? "#f59e0b" : "#8b5cf6", fontWeight: 700 }}>{(gpuUtil * 100).toFixed(1)}%</span>
                  <span>{(maxGpuUtil * 100).toFixed(1)}%</span>
                </div>
                <div style={{ fontSize: 9, color: "#1e3a5f", marginTop: 3 }}>max {(maxGpuUtil * 100).toFixed(1)}% — NCCL headroom</div>
              </div>
            </div>
          )}

          {/* ── Action buttons ── */}
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>

            {/* Launch — only when cluster fully stopped */}
            {!containersUp && (
              <ActionButton
                label="▶ LAUNCH CLUSTER"
                color="#10b981"
                disabled={!selectedModel || !selectedCfg?.ready}
                loading={loading["vllm-start"]}
                onClick={() => post("vllm-start", { model: selectedModel, maxModelLen: maxLen, gpuUtil })}
              />
            )}

            {/* Apply Changes — model/param drift while cluster is up */}
            {hasChanges && !isStarting && (
              <ActionButton
                label={modelChanged ? `⟳ RESTART WITH ${selectedCfg?.displayName ?? "MODEL"}` : "⟳ APPLY CHANGES"}
                color="#f59e0b"
                loading={loading["vllm-start"]}
                onClick={() => post("vllm-start", { model: selectedModel, maxModelLen: maxLen, gpuUtil })}
              />
            )}

            {/* Stop */}
            {containersUp && (
              loading["vllm-stop"] ? (
                <ActionButton label="■ STOPPING" danger loading onClick={() => {}} />
              ) : !stopConfirm ? (
                <ActionButton label="■ STOP CLUSTER" danger onClick={() => setStopConfirm(true)} />
              ) : (
                <ActionButton
                  label="⚠ CONFIRM STOP"
                  confirming
                  onClick={() => { setStopConfirm(false); post("vllm-stop"); }}
                />
              )
            )}

            {/* Hints */}
            {vllmOnline && !hasChanges && !loading["vllm-start"] && (
              <span style={{ fontSize: 10, color: "#1e3a5f" }}>Adjust sliders or select a model to queue a restart</span>
            )}
            {hasChanges && !loading["vllm-start"] && (
              <span style={{ fontSize: 10, color: "#f59e0b88" }}>
                {modelChanged ? `Current: ${data?.models.find(m => m.id === vllmModel)?.displayName ?? vllmModel} · ` : ""}
                Restart takes ~5–15 min
              </span>
            )}
            {isStarting && (
              <span style={{ fontSize: 10, color: "#f59e0b88" }}>Loading model weights over NFS — check logs for progress</span>
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
        </div>
      </div>
    </div>
  );
}
