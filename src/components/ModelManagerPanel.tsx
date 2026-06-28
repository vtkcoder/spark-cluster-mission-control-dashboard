"use client";

import { useCallback, useEffect, useState } from "react";
import { ModelTreemap } from "./models/ModelTreemap";
import { ModelRow } from "./models/ModelRow";
import { ModelDetailDrawer } from "./models/ModelDetailDrawer";

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
  source: string; dir: string;
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
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"size" | "name" | "date">("size");
  const [modalityFilter, setModalityFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [groupDup, setGroupDup] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

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

  const rowWithDrawer = (m: UiModel, maxBytes: number) => (
    <div key={m.id}>
      <ModelRow model={m} maxBytes={maxBytes} expanded={expanded === m.id} onToggle={() => setExpanded(expanded === m.id ? null : m.id)} />
      {expanded === m.id && <ModelDetailDrawer model={m} onChanged={load} />}
    </div>
  );

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

      {/* Per-source breakdown */}
      {data && (() => {
        const meta: Record<string, { label: string; color: string }> = {
          hf: { label: "HF CACHE", color: "#3b82f6" },
          flat: { label: "~/MODELS", color: "#10b981" },
          lmstudio: { label: "LM STUDIO", color: "#fb923c" },
        };
        const by: Record<string, { n: number; bytes: number }> = {};
        for (const m of data.models) {
          (by[m.source] ??= { n: 0, bytes: 0 });
          by[m.source].n++; by[m.source].bytes += m.sizeBytes;
        }
        return (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {Object.entries(by).map(([src, v]) => {
              const mt = meta[src] ?? { label: src.toUpperCase(), color: "#64748b" };
              const active = sourceFilter === src;
              return (
                <button key={src} onClick={() => setSourceFilter(active ? "all" : src)}
                  style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 12px", borderRadius: 6,
                    background: active ? `${mt.color}22` : "#0c1220", border: `1px solid ${active ? mt.color : "#1a2540"}`,
                    cursor: "pointer", fontFamily: "inherit" }}>
                  <span style={{ width: 7, height: 7, borderRadius: 2, background: mt.color }} />
                  <span style={{ fontSize: 10, color: mt.color, letterSpacing: "0.08em" }}>{mt.label}</span>
                  <span style={{ fontSize: 10, color: "#94a3b8" }}>{v.n} · {gb(v.bytes)}</span>
                </button>
              );
            })}
          </div>
        );
      })()}

      {err && <div style={{ color: "#ef4444", fontSize: 11 }}>⚠ {err}</div>}

      {/* Disk treemap */}
      {data && (
        <div style={{ padding: "12px 16px", background: "#0c1220", border: "1px solid #1a2540", borderRadius: 8 }}>
          <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.14em", marginBottom: 8, textTransform: "uppercase" }}>▸ DISK BY MODEL</div>
          <ModelTreemap items={data.models.map((m) => ({ id: m.id, name: m.name, sizeBytes: m.sizeBytes, modality: m.modality }))} />
        </div>
      )}

      {/* Toolbar */}
      {data && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search…" style={{ background: "#06090f", border: "1px solid #1a2540", borderRadius: 6, color: "#e2e8f0", fontSize: 11, padding: "6px 10px", fontFamily: "inherit" }} />
          <select value={sort} onChange={(e) => setSort(e.target.value as "size" | "name" | "date")} style={selStyle}>
            <option value="size">sort: size</option>
            <option value="name">sort: name</option>
            <option value="date">sort: date</option>
          </select>
          <select value={modalityFilter} onChange={(e) => setModalityFilter(e.target.value)} style={selStyle}>
            {["all", "text", "vision", "audio", "image-gen", "unknown"].map((m) => <option key={m} value={m}>{m === "all" ? "modality: all" : m}</option>)}
          </select>
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} style={selStyle}>
            {[["all", "source: all"], ["hf", "HF cache"], ["flat", "~/models"], ["lmstudio", "LM Studio"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <label style={{ fontSize: 10, color: "#94a3b8", display: "flex", alignItems: "center", gap: 5 }}>
            <input type="checkbox" checked={groupDup} onChange={(e) => setGroupDup(e.target.checked)} /> group duplicates
          </label>
        </div>
      )}

      {/* List */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {data && (() => {
          let list = data.models.filter((m) =>
            (modalityFilter === "all" || m.modality === modalityFilter) &&
            (sourceFilter === "all" || m.source === sourceFilter) &&
            (q === "" || m.id.toLowerCase().includes(q.toLowerCase()))
          );
          list = [...list].sort((a, b) =>
            sort === "size" ? b.sizeBytes - a.sizeBytes :
            sort === "name" ? a.name.localeCompare(b.name) :
            b.mtime - a.mtime
          );
          const maxBytes = Math.max(1, ...list.map((m) => m.sizeBytes));

          if (groupDup) {
            const groups = data.groups
              .map((g) => ({ ...g, members: g.members.filter((m) => list.some((l) => l.id === m.id)) }))
              .filter((g) => g.members.length > 0)
              .sort((a, b) => b.totalBytes - a.totalBytes);
            return groups.map((g) => (
              <div key={g.key} style={{ border: g.unique ? "none" : "1px dashed #14b8a644", borderRadius: 8, padding: g.unique ? 0 : 6, display: "flex", flexDirection: "column", gap: 6 }}>
                {!g.unique && <div style={{ fontSize: 9, color: "#2dd4bf", letterSpacing: "0.1em" }}>VARIANT GROUP · {g.members.length} · {gb(g.totalBytes)} total · {gb(g.redundantBytes)} redundant</div>}
                {g.members.map((m) => rowWithDrawer(m, maxBytes))}
              </div>
            ));
          }
          return list.map((m) => rowWithDrawer(m, maxBytes));
        })()}
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

const selStyle: React.CSSProperties = { background: "#06090f", border: "1px solid #1a2540", borderRadius: 6, color: "#94a3b8", fontSize: 10, padding: "6px 8px", fontFamily: "inherit" };
