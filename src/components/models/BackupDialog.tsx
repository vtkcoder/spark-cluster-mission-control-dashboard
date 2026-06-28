"use client";

import { useCallback, useEffect, useState } from "react";
import { btn } from "../ModelManagerPanel";

interface Target { mountpoint: string; label: string; freeBytes: number }
interface Job { modelId: string; target: string; percent: number; status: string; message: string }

export function BackupDialog({ modelId, sizeBytes, onClose }: { modelId: string; sizeBytes: number; onClose: () => void }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/models/backup", { cache: "no-store" });
    const d = await r.json();
    setTargets(d.targets ?? []);
    setJob(d.job ?? null);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (job?.status !== "running") return;
    const id = setInterval(refresh, 1500);
    return () => clearInterval(id);
  }, [job?.status, refresh]);

  const start = async (target: string) => {
    setErr(null);
    const r = await fetch("/api/models/backup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelId, target }) });
    const d = await r.json();
    if (!r.ok) setErr(d.error ?? "failed");
    else setJob(d.job);
  };

  return (
    <div style={{ marginTop: 8, padding: 12, background: "#0a1018", border: "1px solid #14b8a644", borderRadius: 8 }}>
      <div style={{ fontSize: 10, color: "#2dd4bf", letterSpacing: "0.1em", marginBottom: 8 }}>BACKUP TO EXTERNAL DRIVE · {(sizeBytes / 1e9).toFixed(1)} GB</div>
      {err && <div style={{ color: "#ef4444", fontSize: 11, marginBottom: 6 }}>⚠ {err}</div>}
      {job && job.status === "running" ? (
        <div style={{ fontSize: 11, color: "#94a3b8" }}>
          Copying {job.modelId.split("/").pop()} → {job.target} · {job.percent}%
          <div style={{ height: 6, background: "#1a2540", borderRadius: 3, marginTop: 4 }}>
            <div style={{ width: `${job.percent}%`, height: "100%", background: "#14b8a6", borderRadius: 3 }} />
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {targets.length === 0 && <div style={{ fontSize: 11, color: "#475569" }}>No external drive detected. Plug one in, then ↻ rescan.</div>}
          {targets.map((t) => {
            const fits = t.freeBytes >= sizeBytes;
            return (
              <div key={t.mountpoint} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, color: "#cbd5e1" }}>
                <span style={{ flex: 1 }}>{t.mountpoint} <span style={{ color: "#475569" }}>({(t.freeBytes / 1e9).toFixed(0)} GB free)</span></span>
                <button disabled={!fits} onClick={() => start(t.mountpoint)} style={{ ...btn("#14b8a6"), opacity: fits ? 1 : 0.4 }}>
                  {fits ? "BACKUP HERE" : "NOT ENOUGH SPACE"}
                </button>
              </div>
            );
          })}
          {job && job.status !== "running" && <div style={{ fontSize: 11, color: job.status === "success" ? "#10b981" : "#ef4444" }}>last backup: {job.status} — {job.message}</div>}
        </div>
      )}
      <button onClick={onClose} style={{ ...btn("#475569"), marginTop: 8 }}>CLOSE</button>
    </div>
  );
}
