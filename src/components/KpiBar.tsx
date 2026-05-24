"use client";

interface KpiChipProps {
  label: string;
  value: string;
  color?: string;
  bg?: string;
}

function KpiChip({ label, value, color = "#94a3b8", bg = "#111827" }: KpiChipProps) {
  return (
    <div
      style={{
        background: bg,
        border: "1px solid #1a2540",
        borderRadius: 8,
        padding: "8px 14px",
        minWidth: 100,
        flex: "1 1 0",
      }}
    >
      <div
        style={{
          fontSize: 9,
          letterSpacing: "0.14em",
          color: "#475569",
          textTransform: "uppercase",
          marginBottom: 3,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color, letterSpacing: "0.04em" }}>
        {value}
      </div>
    </div>
  );
}

interface KpiBarProps {
  nodesOnline: number;
  nodesTotal: number;
  modelName: string | null;
  contextLen: number | null;
  vllmOnline: boolean;
  headContainer: string;
  workerContainer: string;
  requestsRunning: number;
  requestsWaiting: number;
  gpuTemps: Array<number | null>;
  headUptimeSec: number | null;
  singleNode?: boolean;
}

function containerLabel(s: string): string {
  if (s === "running") return "RUNNING";
  if (s === "exited") return "STOPPED";
  return "ABSENT";
}

function containerColor(s: string): string {
  if (s === "running") return "#10b981";
  if (s === "exited") return "#f59e0b";
  return "#ef4444";
}

function fmtCtx(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

function fmtUptime(s: number | null): string {
  if (s === null) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function KpiBar({
  nodesOnline,
  nodesTotal,
  modelName,
  contextLen,
  vllmOnline,
  headContainer,
  workerContainer,
  requestsRunning,
  requestsWaiting,
  gpuTemps,
  headUptimeSec,
  singleNode = false,
}: KpiBarProps) {
  // Average GPU temp across all present (non-null) nodes. In single-node mode
  // only spark1 (gpuTemps[0]) is considered.
  const tempSamples = (singleNode ? gpuTemps.slice(0, 1) : gpuTemps).filter(
    (t): t is number => t !== null,
  );
  const avgTemp = tempSamples.length
    ? Math.round(tempSamples.reduce((a, b) => a + b, 0) / tempSamples.length)
    : null;

  const shortModel = modelName
    ? modelName.split("/").pop()?.replace(/-FP8$/, "")?.replace(/-Instruct.*$/, "") ?? modelName
    : null;

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      <KpiChip
        label="NODES"
        value={`${nodesOnline} / ${nodesTotal}`}
        color={nodesOnline === nodesTotal ? "#10b981" : "#ef4444"}
      />
      <KpiChip
        label={singleNode ? "VLLM" : "VLLM HEAD"}
        value={containerLabel(headContainer)}
        color={containerColor(headContainer)}
      />
      {!singleNode && (
        <KpiChip
          label="VLLM WORKER"
          value={containerLabel(workerContainer)}
          color={containerColor(workerContainer)}
        />
      )}
      <KpiChip
        label="MODEL"
        value={vllmOnline ? (shortModel ?? "—") : "OFFLINE"}
        color={vllmOnline ? "#22d3ee" : "#475569"}
      />
      <KpiChip
        label="CONTEXT"
        value={vllmOnline ? `${fmtCtx(contextLen)} TOK` : "—"}
        color={vllmOnline ? "#a78bfa" : "#475569"}
      />
      <KpiChip
        label="REQUESTS"
        value={`${requestsRunning} + ${requestsWaiting}`}
        color={requestsRunning > 0 ? "#f59e0b" : "#10b981"}
      />
      <KpiChip
        label={singleNode ? "GPU TEMP" : "AVG GPU TEMP"}
        value={avgTemp !== null ? `${avgTemp}°C` : "—"}
        color={
          avgTemp === null ? "#475569" : avgTemp < 60 ? "#10b981" : avgTemp < 75 ? "#f59e0b" : "#ef4444"
        }
      />
      <KpiChip
        label="ENGINE UPTIME"
        value={headContainer === "running" ? fmtUptime(headUptimeSec) : "—"}
        color={headContainer === "running" ? "#94a3b8" : "#475569"}
      />
    </div>
  );
}
