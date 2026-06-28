"use client";

interface Hit { source: string; path: string; line: number | null; excerpt: string }

export function UsageReport({ hits, truncated, loading }: { hits: Hit[]; truncated: boolean; loading: boolean }) {
  if (loading) return <div style={{ fontSize: 11, color: "#94a3b8" }}>investigating…</div>;
  if (!hits.length) return <div style={{ fontSize: 11, color: "#475569" }}>No references found in engine, launch scripts, or project configs.</div>;
  const color: Record<string, string> = { engine: "#14b8a6", script: "#f59e0b", config: "#3b82f6" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {hits.map((h, i) => (
        <div key={i} style={{ fontSize: 11, color: "#cbd5e1", borderLeft: `2px solid ${color[h.source] ?? "#475569"}`, paddingLeft: 8 }}>
          <span style={{ color: color[h.source] ?? "#475569", textTransform: "uppercase", fontSize: 9, letterSpacing: "0.1em" }}>{h.source}</span>{" "}
          <span style={{ color: "#94a3b8" }}>{h.path}{h.line ? `:${h.line}` : ""}</span>
          <div style={{ color: "#64748b", fontFamily: "monospace", fontSize: 10, marginTop: 2 }}>{h.excerpt}</div>
        </div>
      ))}
      {truncated && <div style={{ fontSize: 10, color: "#f59e0b" }}>results truncated — more references exist</div>}
    </div>
  );
}
