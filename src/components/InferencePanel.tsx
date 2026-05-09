"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { SparkLine } from "./SparkLine";
import { ArcGauge } from "./ArcGauge";

interface InferenceData {
  ts: number;
  online: boolean;
  model: string | null;
  requestsRunning: number;
  requestsWaiting: number;
  requestsSwapped: number;
  promptTokensTotal: number;
  generationTokensTotal: number;
  promptThroughput: number;
  genThroughput: number;
  avgE2eLatencyMs: number | null;
  avgTtftMs: number | null;
  avgTpotMs: number | null;
  avgPrefillMs: number | null;
  avgQueueMs: number | null;
  successTotal: number;
  failureTotal: number;
  preemptionsTotal: number;
  gpuCacheUsagePct: number;
  gpuCacheTotalBlocks: number;
  gpuCacheBlocksUsed: number;
  successRate: number | null;
}

interface InferenceHistory {
  genThroughput: number[];
  promptThroughput: number[];
  reqRunning: number[];
  cacheUsage: number[];
}

const MAX_HISTORY = 60;

function pushH<T>(arr: T[], item: T): T[] {
  const next = [...arr, item];
  return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
}

function fmtThroughput(tps: number): string {
  if (tps >= 1000) return `${(tps / 1000).toFixed(1)}k`;
  return tps.toFixed(0);
}

function fmtLatency(ms: number | null): string {
  if (ms === null || ms === 0) return "—";
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(0)}ms`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

// ── Arc gauge customised for tok/s display ────────────────────────────────────
const R = 36, C = 2 * Math.PI * R, ARC = (270 / 360) * C, GAP = C - ARC;

function TokGauge({
  tps,
  label,
  max,
  color,
  size = 88,
}: {
  tps: number;
  label: string;
  max: number;
  color: string;
  size?: number;
}) {
  const pct = max > 0 ? Math.min(100, (tps / max) * 100) : 0;
  const valueArc = (pct / 100) * ARC;
  const display = tps >= 1000 ? `${(tps / 1000).toFixed(1)}k` : String(Math.round(tps));

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
      <svg width={size} height={size} viewBox="0 0 100 100" style={{ overflow: "visible" }}>
        <circle
          cx="50" cy="50" r={R} fill="none" stroke="#1a2540" strokeWidth="7"
          strokeDasharray={`${ARC} ${GAP}`} transform="rotate(135, 50, 50)" strokeLinecap="round"
        />
        <circle
          cx="50" cy="50" r={R} fill="none" stroke={color} strokeWidth="7"
          strokeDasharray={`${valueArc} ${C - valueArc}`} transform="rotate(135, 50, 50)"
          strokeLinecap="round"
          className="gauge-value"
          style={{ filter: `drop-shadow(0 0 4px ${color}88)` }}
        />
        <text x="50" y="44" textAnchor="middle" fontSize="17" fontWeight="700" fill={color} fontFamily="inherit">
          {display}
        </text>
        <text x="50" y="56" textAnchor="middle" fontSize="7" fill="#475569" fontFamily="inherit">
          tok/s
        </text>
      </svg>
      <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase" }}>
        {label}
      </div>
    </div>
  );
}

// ── Animated token stream ─────────────────────────────────────────────────────
const CHIP_CONFIGS = [
  { w: 18, delay: 0,    dur: 1.6, top: 3,  color: "#06b6d4" },
  { w: 12, delay: 0.22, dur: 1.9, top: 9,  color: "#10b981" },
  { w: 20, delay: 0.45, dur: 1.5, top: 5,  color: "#22d3ee" },
  { w: 10, delay: 0.65, dur: 2.1, top: 11, color: "#06b6d4" },
  { w: 16, delay: 0.85, dur: 1.7, top: 2,  color: "#10b981" },
  { w: 14, delay: 1.10, dur: 1.8, top: 8,  color: "#34d399" },
  { w: 22, delay: 1.30, dur: 1.6, top: 4,  color: "#06b6d4" },
  { w: 8,  delay: 1.55, dur: 2.0, top: 10, color: "#22d3ee" },
  { w: 18, delay: 1.75, dur: 1.7, top: 6,  color: "#10b981" },
  { w: 12, delay: 1.95, dur: 1.9, top: 3,  color: "#06b6d4" },
];

function TokenStream({ active }: { active: boolean }) {
  return (
    <div
      style={{
        position: "relative",
        height: 18,
        overflow: "hidden",
        borderRadius: 3,
        background: active ? "#06b6d408" : "transparent",
        transition: "background 0.5s",
      }}
    >
      {/* Static track line */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: 0,
          right: 0,
          height: 1,
          background: active ? "#06b6d433" : "#1a2540",
          transition: "background 0.5s",
        }}
      />
      {/* Animated chips — only when active */}
      {active &&
        CHIP_CONFIGS.map((c, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: 0,
              top: c.top,
              width: c.w,
              height: 4,
              borderRadius: 2,
              background: c.color,
              boxShadow: `0 0 6px ${c.color}88`,
              opacity: 0,
              animation: `token-drift ${c.dur}s ${c.delay}s linear infinite`,
            }}
          />
        ))}
      {/* Status label */}
      <div
        style={{
          position: "absolute",
          right: 6,
          top: "50%",
          transform: "translateY(-50%)",
          fontSize: 8,
          letterSpacing: "0.12em",
          color: active ? "#06b6d4" : "#1e3a4a",
          fontWeight: active ? 700 : 400,
          transition: "color 0.4s",
        }}
      >
        {active ? "GENERATING" : "IDLE"}
      </div>
    </div>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────────
function LatencyCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div
      style={{
        background: "#06090f",
        border: "1px solid #1a2540",
        borderRadius: 8,
        padding: "10px 14px",
        minWidth: 88,
      }}
    >
      <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.12em", marginBottom: 5, textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ fontSize: 19, fontWeight: 700, color, letterSpacing: "-0.01em", lineHeight: 1 }}>
        {value}
      </div>
    </div>
  );
}

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div style={{ height: 5, background: "#1a2540", borderRadius: 3, overflow: "hidden" }}>
      <div
        style={{
          height: "100%",
          width: `${Math.max(0, Math.min(100, pct))}%`,
          background: color,
          borderRadius: 3,
          boxShadow: `0 0 6px ${color}55`,
          transition: "width 0.5s ease",
        }}
      />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function InferencePanel() {
  const [data, setData] = useState<InferenceData | null>(null);
  const [history, setHistory] = useState<InferenceHistory>({
    genThroughput: [],
    promptThroughput: [],
    reqRunning: [],
    cacheUsage: [],
  });
  const [peakGenTps, setPeakGenTps] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const errorCount = useRef(0);
  const prevModel = useRef<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/inference", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: InferenceData = await res.json();
      setData(json);
      setError(null);
      errorCount.current = 0;

      // Reset peak when model changes
      if (json.model !== prevModel.current) {
        prevModel.current = json.model;
        setPeakGenTps(0);
      }
      if (json.genThroughput > 0) {
        setPeakGenTps((prev) => Math.max(prev, json.genThroughput));
      }

      setHistory((prev) => ({
        genThroughput: pushH(prev.genThroughput, json.genThroughput),
        promptThroughput: pushH(prev.promptThroughput, json.promptThroughput),
        reqRunning: pushH(prev.reqRunning, json.requestsRunning),
        cacheUsage: pushH(prev.cacheUsage, json.gpuCacheUsagePct),
      }));
    } catch (e) {
      errorCount.current++;
      if (errorCount.current >= 3) setError(e instanceof Error ? e.message : "Fetch failed");
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [poll]);

  const online = data?.online ?? false;
  const active = (data?.requestsRunning ?? 0) > 0;

  // Average tok/s — only over samples where the engine was actually generating
  const activeHistory = history.genThroughput.filter((v) => v > 0);
  const avgGenTps =
    activeHistory.length > 0
      ? activeHistory.reduce((a, b) => a + b, 0) / activeHistory.length
      : 0;

  // Gauge max: headroom above peak so the needle doesn't peg at 100%
  const gaugeMax = Math.max(peakGenTps * 1.25, 100);

  return (
    <div
      style={{
        background: "#0c1220",
        border: "1px solid #1a2540",
        borderRadius: 12,
        padding: 16,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Top accent line */}
      <div
        style={{
          position: "absolute",
          top: 0, left: 0, right: 0, height: 2,
          background: online
            ? "linear-gradient(90deg, #06b6d4, #10b981, #06b6d400)"
            : "linear-gradient(90deg, #374151, #37415100)",
          borderRadius: "12px 12px 0 0",
        }}
      />

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 10, letterSpacing: "0.12em", color: "#475569", textTransform: "uppercase" }}>
            ▶ INFERENCE METRICS
          </span>
          <span
            style={{
              fontSize: 9, letterSpacing: "0.1em", padding: "2px 7px", borderRadius: 4,
              background: online ? "#06b6d422" : "#1a1a1a",
              color: online ? "#06b6d4" : "#475569",
              border: `1px solid ${online ? "#06b6d444" : "#334155"}`,
              textTransform: "uppercase",
            }}
          >
            {online ? "ONLINE" : "OFFLINE"}
          </span>
          {error && <span style={{ fontSize: 9, color: "#ef4444" }}>⚠ {error}</span>}
        </div>
        {data?.model && (
          <div style={{ fontSize: 10, color: "#22d3ee", letterSpacing: "0.04em" }}>{data.model}</div>
        )}
      </div>

      {!online ? (
        <div style={{ color: "#334155", fontSize: 11, letterSpacing: "0.06em", padding: "28px 0", textAlign: "center" }}>
          ENGINE NOT RUNNING — NO INFERENCE DATA AVAILABLE
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {/* ── Row 1: Throughput · Queue · LIVE · KV Cache ── */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "stretch" }}>

            {/* Throughput */}
            <div
              style={{
                background: "#080e1a", border: "1px solid #1a2540", borderRadius: 8,
                padding: "12px 16px", flex: "1 1 220px",
              }}
            >
              <div style={{ fontSize: 9, color: "#06b6d4", letterSpacing: "0.14em", marginBottom: 12, textTransform: "uppercase" }}>
                ⚡ THROUGHPUT
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                  <span style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.1em" }}>GENERATION</span>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
                    <span style={{ fontSize: 24, fontWeight: 700, color: "#10b981", letterSpacing: "-0.02em", lineHeight: 1 }}>
                      {fmtThroughput(data?.genThroughput ?? 0)}
                    </span>
                    <span style={{ fontSize: 9, color: "#10b98188" }}>tok/s</span>
                  </div>
                </div>
                <SparkLine data={history.genThroughput} color="#10b981" fillColor="#10b98114" height={32} width={220} />
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                  <span style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.1em" }}>PROMPT</span>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
                    <span style={{ fontSize: 24, fontWeight: 700, color: "#a78bfa", letterSpacing: "-0.02em", lineHeight: 1 }}>
                      {fmtThroughput(data?.promptThroughput ?? 0)}
                    </span>
                    <span style={{ fontSize: 9, color: "#a78bfa88" }}>tok/s</span>
                  </div>
                </div>
                <SparkLine data={history.promptThroughput} color="#a78bfa" fillColor="#a78bfa14" height={32} width={220} />
              </div>
            </div>

            {/* Queue — compact */}
            <div
              style={{
                background: "#080e1a", border: "1px solid #1a2540", borderRadius: 8,
                padding: "12px 14px", flex: "0 0 130px",
              }}
            >
              <div style={{ fontSize: 9, color: "#f59e0b", letterSpacing: "0.14em", marginBottom: 10, textTransform: "uppercase" }}>
                ⬡ QUEUE
              </div>
              <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.1em", marginBottom: 2 }}>RUN</div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: active ? "#f59e0b" : "#10b981", lineHeight: 1 }}>
                    {data?.requestsRunning ?? 0}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.1em", marginBottom: 2 }}>WAIT</div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: (data?.requestsWaiting ?? 0) > 0 ? "#ef4444" : "#334155", lineHeight: 1 }}>
                    {data?.requestsWaiting ?? 0}
                  </div>
                </div>
              </div>
              <SparkLine data={history.reqRunning} color="#f59e0b" fillColor="#f59e0b14" height={28} width={110} />
            </div>

            {/* LIVE — throughput gauges + animation */}
            <div
              className={active ? "live-active-border" : ""}
              style={{
                background: "#080e1a",
                border: "1px solid #1a2540",
                borderRadius: 8,
                padding: "12px 14px",
                flex: "0 0 196px",
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              {/* Header row */}
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <div
                  style={{
                    width: 6, height: 6, borderRadius: "50%",
                    background: active ? "#06b6d4" : "#334155",
                    boxShadow: active ? "0 0 6px #06b6d4" : "none",
                    transition: "background 0.4s, box-shadow 0.4s",
                    position: "relative",
                  }}
                  className={active ? "pulse-dot" : ""}
                />
                <span style={{ fontSize: 9, color: active ? "#06b6d4" : "#334155", letterSpacing: "0.14em", textTransform: "uppercase", transition: "color 0.4s" }}>
                  LIVE
                </span>
              </div>

              {/* Animated token stream */}
              <TokenStream active={active} />

              {/* Gauges: PEAK + AVG */}
              <div style={{ display: "flex", justifyContent: "space-around", alignItems: "flex-start" }}>
                <TokGauge
                  tps={peakGenTps}
                  label="PEAK"
                  max={gaugeMax}
                  color="#10b981"
                  size={84}
                />
                <TokGauge
                  tps={avgGenTps}
                  label="AVG"
                  max={gaugeMax}
                  color="#06b6d4"
                  size={84}
                />
              </div>
            </div>

            {/* KV Cache */}
            <div
              style={{
                background: "#080e1a", border: "1px solid #1a2540", borderRadius: 8,
                padding: "12px 14px", flex: "0 0 152px",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
              }}
            >
              <div style={{ fontSize: 9, color: "#3b82f6", letterSpacing: "0.14em", textTransform: "uppercase", width: "100%", textAlign: "center" }}>
                ▣ KV CACHE
              </div>
              <ArcGauge
                pct={Math.round(data?.gpuCacheUsagePct ?? 0)}
                label="CACHE"
                sublabel="KV used"
                size={92}
                colorOverride="#3b82f6"
              />
              {/* Block count under gauge */}
              {(data?.gpuCacheTotalBlocks ?? 0) > 0 ? (
                <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.06em", textAlign: "center" }}>
                  <span style={{ color: "#3b82f6" }}>{(data?.gpuCacheBlocksUsed ?? 0).toLocaleString()}</span>
                  {" / "}
                  {(data?.gpuCacheTotalBlocks ?? 0).toLocaleString()} blk
                </div>
              ) : (
                <div style={{ fontSize: 10, color: "#3b82f6", letterSpacing: "0.04em" }}>
                  {(data?.gpuCacheUsagePct ?? 0).toFixed(1)}%
                </div>
              )}
              <SparkLine data={history.cacheUsage} color="#3b82f6" fillColor="#3b82f614" height={24} width={130} max={100} />
            </div>

          </div>

          {/* ── Row 2: Latency ── */}
          <div style={{ background: "#080e1a", border: "1px solid #1a2540", borderRadius: 8, padding: "12px 16px" }}>
            <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.14em", marginBottom: 10, textTransform: "uppercase" }}>
              ⏱ LATENCY — CUMULATIVE AVERAGES
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <LatencyCard label="E2E"        value={fmtLatency(data?.avgE2eLatencyMs ?? null)} color="#e2e8f0" />
              <LatencyCard label="TTFT"       value={fmtLatency(data?.avgTtftMs ?? null)}        color="#06b6d4" />
              <LatencyCard label="TPOT"       value={fmtLatency(data?.avgTpotMs ?? null)}        color="#10b981" />
              <LatencyCard label="PREFILL"    value={fmtLatency(data?.avgPrefillMs ?? null)}     color="#a78bfa" />
              <LatencyCard label="QUEUE WAIT" value={fmtLatency(data?.avgQueueMs ?? null)}       color="#f59e0b" />
            </div>
          </div>

          {/* ── Row 3: Token Economy + Request Stats ── */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>

            {/* Token economy */}
            <div
              style={{
                background: "#080e1a", border: "1px solid #1a2540", borderRadius: 8,
                padding: "12px 16px", flex: "1 1 220px",
              }}
            >
              <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.14em", marginBottom: 12, textTransform: "uppercase" }}>
                ◈ TOKEN ECONOMY
              </div>
              {(() => {
                const p = data?.promptTokensTotal ?? 0;
                const g = data?.generationTokensTotal ?? 0;
                const total = Math.max(p + g, 1);
                return (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                      <span style={{ fontSize: 10, color: "#64748b" }}>PROMPT TOTAL</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "#a78bfa" }}>{fmtTokens(p)}</span>
                    </div>
                    <div style={{ marginBottom: 10 }}>
                      <Bar pct={(p / total) * 100} color="#a78bfa" />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                      <span style={{ fontSize: 10, color: "#64748b" }}>GENERATION TOTAL</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "#10b981" }}>{fmtTokens(g)}</span>
                    </div>
                    <div style={{ marginBottom: 10 }}>
                      <Bar pct={(g / total) * 100} color="#10b981" />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 8, borderTop: "1px solid #1a2540" }}>
                      <span style={{ fontSize: 9, color: "#334155", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                        GEN RATIO
                      </span>
                      <span style={{ fontSize: 10, color: "#475569" }}>
                        {((g / total) * 100).toFixed(1)}%
                      </span>
                    </div>
                  </>
                );
              })()}
            </div>

            {/* Request stats */}
            <div
              style={{
                background: "#080e1a", border: "1px solid #1a2540", borderRadius: 8,
                padding: "12px 16px", flex: "0 1 220px", minWidth: 200,
              }}
            >
              <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.14em", marginBottom: 12, textTransform: "uppercase" }}>
                ✓ REQUEST STATS
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {(
                  [
                    { label: "SUCCESS",     value: Math.round(data?.successTotal ?? 0),     color: "#10b981" },
                    { label: "FAILURE",     value: Math.round(data?.failureTotal ?? 0),     color: (data?.failureTotal ?? 0) > 0 ? "#ef4444" : "#334155" },
                    { label: "PREEMPTIONS", value: Math.round(data?.preemptionsTotal ?? 0), color: (data?.preemptionsTotal ?? 0) > 0 ? "#f97316" : "#334155" },
                  ] as { label: string; value: number; color: string }[]
                ).map(({ label, value, color }) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
                      <span style={{ fontSize: 10, color: "#64748b" }}>{label}</span>
                    </div>
                    <span style={{ fontSize: 14, fontWeight: 700, color }}>{value.toLocaleString()}</span>
                  </div>
                ))}
                {data?.successRate !== null && data?.successRate !== undefined && (
                  <div style={{ paddingTop: 8, borderTop: "1px solid #1a2540", marginTop: 2 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                      <span style={{ fontSize: 9, color: "#334155", letterSpacing: "0.08em", textTransform: "uppercase" }}>SUCCESS RATE</span>
                      <span style={{
                        fontSize: 10, fontWeight: 700,
                        color: data.successRate > 99 ? "#10b981" : data.successRate > 95 ? "#f59e0b" : "#ef4444",
                      }}>
                        {data.successRate.toFixed(1)}%
                      </span>
                    </div>
                    <Bar
                      pct={data.successRate}
                      color={data.successRate > 99 ? "#10b981" : data.successRate > 95 ? "#f59e0b" : "#ef4444"}
                    />
                  </div>
                )}
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}
