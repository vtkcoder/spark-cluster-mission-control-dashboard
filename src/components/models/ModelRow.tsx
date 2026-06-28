"use client";

import type { UiModel } from "../ModelManagerPanel";
import { gb } from "../ModelManagerPanel";

const MOD_COLORS: Record<string, string> = { text: "#3b82f6", vision: "#8b5cf6", audio: "#22d3ee", "image-gen": "#f59e0b", unknown: "#475569" };
const HEALTH_COLORS: Record<string, string> = { ready: "#10b981", downloading: "#3b82f6", incomplete: "#f59e0b", stub: "#f59e0b", broken: "#ef4444" };
const SOURCE_BADGE: Record<string, { label: string; color: string }> = {
  hf: { label: "HF", color: "#3b82f6" },
  flat: { label: "~/models", color: "#10b981" },
  lmstudio: { label: "LM Studio", color: "#fb923c" },
};

export function ModelRow({ model, maxBytes, expanded, onToggle }: { model: UiModel; maxBytes: number; expanded: boolean; onToggle: () => void }) {
  const pct = maxBytes > 0 ? (model.sizeBytes / maxBytes) * 100 : 0;
  return (
    <div onClick={onToggle} style={{ cursor: "pointer", padding: "10px 14px", background: expanded ? "#0e1626" : "#0c1220", border: `1px solid ${expanded ? "#14b8a655" : "#1a2540"}`, borderRadius: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: HEALTH_COLORS[model.health] ?? "#475569" }} title={model.healthDetail} />
        {model.meta?.starred && <span style={{ color: "#f59e0b", fontSize: 11 }}>★</span>}
        <span style={{ fontSize: 12, color: "#e2e8f0", fontWeight: 600 }}>{model.name}</span>
        {(() => { const s = SOURCE_BADGE[model.source]; return s ? <span style={{ fontSize: 9, color: s.color, background: `${s.color}1a`, border: `1px solid ${s.color}55`, borderRadius: 4, padding: "1px 5px" }}>{s.label}</span> : null; })()}
        <span style={{ fontSize: 9, color: MOD_COLORS[model.modality], border: `1px solid ${MOD_COLORS[model.modality]}55`, borderRadius: 4, padding: "1px 5px" }}>{model.modality}</span>
        {model.quant && <span style={{ fontSize: 9, color: "#94a3b8" }}>{model.quant}</span>}
        {model.served && <span style={{ fontSize: 9, color: "#14b8a6", border: "1px solid #14b8a655", borderRadius: 4, padding: "1px 5px" }}>SERVED</span>}
        {model.meta?.status && model.meta.status !== "keep" && <span style={{ fontSize: 9, color: "#f59e0b" }}>{model.meta.status}</span>}
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#cbd5e1", fontVariantNumeric: "tabular-nums" }}>{gb(model.sizeBytes)}</span>
      </div>
      <div style={{ height: 4, background: "#0a1018", borderRadius: 2, marginTop: 6 }}>
        <div style={{ width: `${pct}%`, height: "100%", background: MOD_COLORS[model.modality], opacity: 0.7, borderRadius: 2 }} />
      </div>
      {(model.meta?.tags?.length ?? 0) > 0 && (
        <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
          {model.meta!.tags.map((t) => <span key={t} style={{ fontSize: 9, color: "#94a3b8", background: "#1a2540", borderRadius: 4, padding: "1px 6px" }}>{t}</span>)}
        </div>
      )}
    </div>
  );
}
