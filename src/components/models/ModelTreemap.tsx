"use client";

const MOD_COLORS: Record<string, string> = {
  text: "#3b82f6", vision: "#8b5cf6", audio: "#22d3ee", "image-gen": "#f59e0b", unknown: "#475569",
};

export function ModelTreemap({
  items,
}: {
  items: { id: string; name: string; sizeBytes: number; modality: string }[];
}) {
  const total = items.reduce((s, i) => s + i.sizeBytes, 0) || 1;
  return (
    <div style={{ display: "flex", width: "100%", height: 26, borderRadius: 6, overflow: "hidden", border: "1px solid #1a2540" }}>
      {items.map((i) => {
        const pct = (i.sizeBytes / total) * 100;
        if (pct < 0.3) return null;
        return (
          <div
            key={i.id}
            title={`${i.name} · ${(i.sizeBytes / 1e9).toFixed(1)} GB`}
            style={{
              width: `${pct}%`,
              background: MOD_COLORS[i.modality] ?? "#475569",
              opacity: 0.85,
              borderRight: "1px solid #06090f",
            }}
          />
        );
      })}
    </div>
  );
}
