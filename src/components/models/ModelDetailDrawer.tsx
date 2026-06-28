"use client";

import { useCallback, useEffect, useState } from "react";
import type { UiModel } from "../ModelManagerPanel";
import { btn, gb } from "../ModelManagerPanel";
import { UsageReport } from "./UsageReport";
import { BackupDialog } from "./BackupDialog";

interface Comment { id: number; author: string; body: string; created_at: string }
interface UsageHit { source: string; path: string; line: number | null; excerpt: string }
interface Usage { hits: UsageHit[]; truncated: boolean }

export function ModelDetailDrawer({ model, onChanged }: { model: UiModel; onChanged: () => void }) {
  const [notes, setNotes] = useState(model.meta?.notes ?? "");
  const [tagText, setTagText] = useState((model.meta?.tags ?? []).join(", "));
  const [status, setStatus] = useState(model.meta?.status ?? "keep");
  const [rating, setRating] = useState<number | null>(model.meta?.rating ?? null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState("");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const loadMeta = useCallback(async () => {
    const r = await fetch(`/api/models/meta?id=${encodeURIComponent(model.id)}`, { cache: "no-store" });
    const d = await r.json();
    setComments(d.comments ?? []);
  }, [model.id]);

  useEffect(() => { loadMeta(); }, [loadMeta]);

  const saveMeta = async (patch: Record<string, unknown>, comment?: string) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/models/meta", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelId: model.id, patch, comment }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setComments(d.comments ?? []);
      onChanged();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const investigate = async () => {
    setUsageLoading(true);
    try {
      const r = await fetch(`/api/models/usage?id=${encodeURIComponent(model.id)}`, { cache: "no-store" });
      setUsage(await r.json());
    } finally { setUsageLoading(false); }
  };

  const doDelete = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/models/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelId: model.id, confirm: confirmText }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setMsg(`Deleted — freed ${gb(d.freedBytes)}`);
      onChanged();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const fact = (k: string, v: React.ReactNode) => (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "2px 0" }}>
      <span style={{ color: "#475569" }}>{k}</span><span style={{ color: "#cbd5e1" }}>{v}</span>
    </div>
  );

  return (
    <div style={{ padding: 14, background: "#0a1018", borderTop: "1px solid #1a2540", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
      {/* Left: facts + usage */}
      <div>
        <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.12em", marginBottom: 6 }}>FACTS</div>
        {fact("id", model.id)}
        {fact("modality", model.modality)}
        {fact("architecture", model.arch ?? "—")}
        {fact("type", model.modelType ?? "—")}
        {fact("quant", model.quant ?? "—")}
        {fact("context", model.contextLen ? model.contextLen.toLocaleString() : "—")}
        {fact("params≈", model.paramCountB ? `${model.paramCountB}B` : "—")}
        {fact("size", gb(model.sizeBytes))}
        {fact("health", `${model.health} — ${model.healthDetail}`)}
        {fact("snapshot", model.snapshotHash?.slice(0, 12) ?? "—")}
        <div style={{ marginTop: 12 }}>
          <button onClick={investigate} style={btn("#3b82f6")}>⌕ INVESTIGATE USAGE</button>
          {usage && <div style={{ marginTop: 8 }}><UsageReport hits={usage.hits} truncated={usage.truncated} loading={usageLoading} /></div>}
          {usageLoading && !usage && <div style={{ marginTop: 8 }}><UsageReport hits={[]} truncated={false} loading /></div>}
        </div>
      </div>

      {/* Right: meta + comments + actions */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.12em", marginBottom: 6 }}>METADATA</div>
          <label style={lbl}>tags (comma-separated)</label>
          <input value={tagText} onChange={(e) => setTagText(e.target.value)} onBlur={() => saveMeta({ tags: tagText.split(",").map((s) => s.trim()).filter(Boolean) })} style={inp} />
          <label style={lbl}>status</label>
          <select value={status} onChange={(e) => { setStatus(e.target.value); saveMeta({ status: e.target.value }); }} style={inp}>
            <option value="keep">keep</option>
            <option value="archive">archive</option>
            <option value="candidate-delete">candidate-delete</option>
          </select>
          <label style={lbl}>rating</label>
          <div style={{ display: "flex", gap: 4 }}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} onClick={() => { setRating(n); saveMeta({ rating: n }); }} style={{ ...btn(rating && n <= rating ? "#f59e0b" : "#475569"), padding: "2px 8px" }}>★</button>
            ))}
          </div>
          <label style={lbl}>notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => saveMeta({ notes })} rows={3} style={{ ...inp, resize: "vertical" }} />
        </div>

        <div>
          <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.12em", marginBottom: 6 }}>COMMENTS</div>
          {comments.map((c) => (
            <div key={c.id} style={{ fontSize: 11, color: "#cbd5e1", marginBottom: 4 }}>
              <span style={{ color: "#475569" }}>{new Date(c.created_at).toLocaleString("en-GB")}: </span>{c.body}
            </div>
          ))}
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <input value={newComment} onChange={(e) => setNewComment(e.target.value)} placeholder="add comment…" style={{ ...inp, flex: 1 }} />
            <button onClick={() => { if (newComment.trim()) { saveMeta({}, newComment.trim()); setNewComment(""); } }} style={btn("#14b8a6")}>ADD</button>
          </div>
        </div>

        <div>
          <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.12em", marginBottom: 6 }}>ACTIONS</div>
          <button onClick={() => setShowBackup((s) => !s)} style={btn("#14b8a6")}>⇩ BACKUP TO DRIVE</button>
          {showBackup && <BackupDialog modelId={model.id} sizeBytes={model.sizeBytes} onClose={() => setShowBackup(false)} />}
          <div style={{ marginTop: 10, padding: 10, border: "1px solid #ef444444", borderRadius: 6 }}>
            <div style={{ fontSize: 10, color: "#ef4444", marginBottom: 4 }}>DANGER · type <b>{model.name}</b> to delete ({gb(model.sizeBytes)})</div>
            {model.served && <div style={{ fontSize: 10, color: "#f59e0b", marginBottom: 4 }}>⚠ currently served — deletion will be refused</div>}
            <div style={{ display: "flex", gap: 6 }}>
              <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={model.name} style={{ ...inp, flex: 1 }} />
              <button disabled={busy || confirmText !== model.name} onClick={doDelete} style={{ ...btn("#ef4444"), opacity: confirmText === model.name ? 1 : 0.4 }}>DELETE</button>
            </div>
          </div>
        </div>
        {msg && <div style={{ fontSize: 11, color: msg.startsWith("Deleted") ? "#10b981" : "#ef4444" }}>{msg}</div>}
      </div>
    </div>
  );
}

const lbl: React.CSSProperties = { display: "block", fontSize: 9, color: "#475569", letterSpacing: "0.1em", margin: "8px 0 2px" };
const inp: React.CSSProperties = { width: "100%", background: "#06090f", border: "1px solid #1a2540", borderRadius: 4, color: "#e2e8f0", fontSize: 11, padding: "5px 8px", fontFamily: "inherit" };
