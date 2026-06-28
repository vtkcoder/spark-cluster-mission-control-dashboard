"use client";

import { useCallback, useEffect, useState } from "react";
import { ModelTreemap } from "./models/ModelTreemap";

// Local UI types (mirror of the server ModelsResponse — keep client server-free).
export interface UiMeta {
  display_name: string | null; tags: string[]; rating: number | null;
  starred: boolean; notes: string | null; status: string;
}
export interface UiModel {
  node: string; id: string; org: string; name: string; sizeBytes: number;
  modality: string; arch: string | null; modelType: string | null;
  paramCountB: number | null; quant: string | null; contextLen: number | null;
  dtype: string | null; health: string; healthDetail: string;
  snapshotHash: string | null; mtime: number; groupKey: string; served: boolean;
  meta: UiMeta | null;
}
export interface UiGroup { key: string; members: UiModel[]; totalBytes: number; redundantBytes: number; unique: boolean }
export interface UiResponse {
  node: string; generatedAt: number; totalBytes: number; reclaimableBytes: number;
  servedModelId: string | null; models: UiModel[]; groups: UiGroup[];
}

export const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;

const TEAL = "#14b8a6";

export function ModelManagerPanel() {
  const [data, setData] = useState<UiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/models", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Summary bar */}
      <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap", padding: "12px 16px", background: "#0c1220", border: "1px solid #1a2540", borderRadius: 8 }}>
        <Stat label="MODELS" value={data ? String(data.models.length) : "—"} />
        <Stat label="TOTAL DISK" value={data ? gb(data.totalBytes) : "—"} color="#e2e8f0" />
        <Stat label="RECLAIMABLE" value={data ? gb(data.reclaimableBytes) : "—"} color="#f59e0b" />
        <Stat label="SERVED" value={data?.servedModelId ? (data.servedModelId.split("/").pop() ?? "—") : "none"} color={TEAL} />
        <div style={{ marginLeft: "auto" }}>
          <button onClick={load} disabled={loading} style={btn(TEAL)}>
            {loading ? "SCANNING…" : "↻ RESCAN"}
          </button>
        </div>
      </div>

      {err && <div style={{ color: "#ef4444", fontSize: 11 }}>⚠ {err}</div>}

      {/* Disk treemap */}
      {data && (
        <div style={{ padding: "12px 16px", background: "#0c1220", border: "1px solid #1a2540", borderRadius: 8 }}>
          <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.14em", marginBottom: 8, textTransform: "uppercase" }}>▸ DISK BY MODEL</div>
          <ModelTreemap items={data.models.map((m) => ({ id: m.id, name: m.name, sizeBytes: m.sizeBytes, modality: m.modality }))} />
        </div>
      )}

      {/* Model list — filled by Task 12 */}
      <div id="model-list-slot" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {data?.models.map((m) => (
          <div key={m.id} style={{ padding: "10px 14px", background: "#0c1220", border: "1px solid #1a2540", borderRadius: 8, fontSize: 12, color: "#e2e8f0", display: "flex", justifyContent: "space-between" }}>
            <span>{m.name}</span>
            <span style={{ color: "#94a3b8" }}>{gb(m.sizeBytes)} · {m.health}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, color = "#94a3b8" }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.12em" }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

export function btn(accent: string): React.CSSProperties {
  return {
    background: `${accent}18`, border: `1px solid ${accent}55`, color: accent,
    padding: "6px 14px", borderRadius: 6, fontSize: 10, letterSpacing: "0.1em",
    cursor: "pointer", fontFamily: "inherit", textTransform: "uppercase",
  };
}
