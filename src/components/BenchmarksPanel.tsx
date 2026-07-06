"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type {
  BenchJobState,
  BenchTableRow,
  BenchRunSummary,
  BenchPreset,
} from "@/lib/bench-types";

// ── Accent (gold — distinct from all existing tabs) ───────────────────────────
const C = {
  accent: "#eab308",
  accentBright: "#facc15",
  green: "#10b981",
  red: "#ef4444",
  card: "#0c1220",
  cardHead: "#0a1018",
  page: "#080c14",
  border: "#1a2540",
  text: "#e2e8f0",
  dim: "#94a3b8",
  dimmer: "#475569",
  faint: "#334155",
};

// ── Presets ───────────────────────────────────────────────────────────────────
const PRESETS: BenchPreset[] = [
  {
    label: "Quick",
    description: "Fast sanity check — pp 512, tg 128, 1 depth, single request.",
    config: { pp: [512], tg: [128], depth: [0], concurrency: [1], runs: 3, skipCoherence: true },
  },
  {
    label: "Standard",
    description: "pp 2048, tg 128 at depth 0 and 4K, single request, 3 runs.",
    config: { pp: [2048], tg: [128], depth: [0, 4096], concurrency: [1], runs: 3 },
  },
  {
    label: "Depth sweep",
    description: "Throughput vs. context depth (0 → 32K) at concurrency 1.",
    config: { pp: [2048], tg: [128], depth: [0, 4096, 16384, 32768], concurrency: [1], runs: 2 },
  },
  {
    label: "Concurrency sweep",
    description: "Throughput vs. concurrent requests (1 → 16) at depth 0.",
    config: { pp: [2048], tg: [128], depth: [0], concurrency: [1, 4, 8, 16], runs: 2 },
  },
];

// ── Small helpers ─────────────────────────────────────────────────────────────
function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return <span>{m > 0 ? `${m}m ` : ""}{s}s</span>;
}

const fmt = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined || !isFinite(v) ? "—" : v.toFixed(d);

function parseIntList(s: string): number[] {
  return s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Math.trunc(Number(x)))
    .filter((n) => Number.isFinite(n) && n >= 0);
}

// ── Form field state (numeric sweeps kept as strings while editing) ───────────
interface FormState {
  baseUrl: string;
  model: string;
  apiKey: string;
  pp: string;
  tg: string;
  depth: string;
  concurrency: string;
  runs: string;
  prefixCaching: boolean;
  noWarmup: boolean;
  skipCoherence: boolean;
  noCache: boolean;
  exactTg: boolean;
}

const DEFAULT_FORM: FormState = {
  baseUrl: "",
  model: "",
  apiKey: "",
  pp: "2048",
  tg: "128",
  depth: "0",
  concurrency: "1",
  runs: "3",
  prefixCaching: false,
  noWarmup: false,
  skipCoherence: false,
  noCache: false,
  exactTg: false,
};

// ── Results table ─────────────────────────────────────────────────────────────
function ResultsTable({ rows }: { rows: BenchTableRow[] }) {
  if (!rows.length) return null;
  const th: React.CSSProperties = {
    textAlign: "right", padding: "6px 12px", fontSize: 9, letterSpacing: "0.1em",
    color: C.dimmer, textTransform: "uppercase", borderBottom: `1px solid ${C.border}`,
  };
  const td: React.CSSProperties = {
    textAlign: "right", padding: "6px 12px", fontSize: 12, color: C.text,
    fontVariantNumeric: "tabular-nums", borderBottom: "1px solid #101827",
  };
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 460 }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>depth</th>
            <th style={th}>conc</th>
            <th style={th}>pp t/s</th>
            <th style={th}>tg t/s</th>
            <th style={th}>ttfr ms</th>
            <th style={th}>runs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.depth}-${r.concurrency}`}>
              <td style={{ ...td, textAlign: "left", color: "#22d3ee" }}>{r.depth}</td>
              <td style={{ ...td, color: "#22d3ee" }}>{r.concurrency}</td>
              <td style={td}>{fmt(r.ppTs)}</td>
              <td style={{ ...td, color: C.accentBright, fontWeight: 700 }}>{fmt(r.tgTs)}</td>
              <td style={td}>{fmt(r.ttfrMs, 0)}</td>
              <td style={{ ...td, color: C.dimmer }}>{r.runs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────
export function BenchmarksPanel() {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [targetInfo, setTargetInfo] = useState<{ online: boolean; engineLabel?: string; topology?: string } | null>(null);
  const [targetLoaded, setTargetLoaded] = useState(false);

  const [job, setJob] = useState<BenchJobState>({
    id: null, status: "idle", config: null, log: "", rows: [], result: null,
    error: null, startedAt: null, finishedAt: null, pid: null,
  });
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [history, setHistory] = useState<BenchRunSummary[]>([]);
  const [detail, setDetail] = useState<{ id: number; rows: BenchTableRow[] } | null>(null);

  const [logOpen, setLogOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const prevLogLen = useRef(0);
  const prevStatus = useRef<string>("idle");

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  // ── Load default target once ──
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/benchmarks/target", { cache: "no-store" });
        const t = await res.json();
        setTargetInfo({ online: !!t.online, engineLabel: t.engineLabel, topology: t.topology });
        if (t.baseUrl || t.model) {
          setForm((f) => ({ ...f, baseUrl: t.baseUrl || f.baseUrl, model: t.model || f.model }));
        }
      } catch { /* ignore */ } finally {
        setTargetLoaded(true);
      }
    })();
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/benchmarks/history", { cache: "no-store" });
      const j = await res.json();
      if (j.ok) setHistory(j.runs as BenchRunSummary[]);
    } catch { /* ignore */ }
  }, []);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/benchmarks", { cache: "no-store" });
      if (res.ok) setJob(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { poll(); loadHistory(); }, [poll, loadHistory]);

  useEffect(() => {
    const interval = job.status === "running" ? 1500 : 8000;
    const id = setInterval(poll, interval);
    return () => clearInterval(id);
  }, [poll, job.status]);

  // Refresh history when a run finishes.
  useEffect(() => {
    if (prevStatus.current === "running" && job.status !== "running") loadHistory();
    prevStatus.current = job.status;
  }, [job.status, loadHistory]);

  // Auto-scroll live log.
  useEffect(() => {
    if (!autoScroll || !logRef.current || !logOpen) return;
    if (job.log.length !== prevLogLen.current) {
      prevLogLen.current = job.log.length;
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [job.log, autoScroll, logOpen]);

  const applyPreset = (p: BenchPreset) => {
    setForm((f) => ({
      ...f,
      pp: p.config.pp.join(", "),
      tg: p.config.tg.join(", "),
      depth: p.config.depth.join(", "),
      concurrency: p.config.concurrency.join(", "),
      runs: String(p.config.runs),
      prefixCaching: !!p.config.prefixCaching,
      noWarmup: !!p.config.noWarmup,
      skipCoherence: !!p.config.skipCoherence,
      noCache: !!p.config.noCache,
      exactTg: !!p.config.exactTg,
    }));
    setFeedback(null);
  };

  const isRunning = job.status === "running";

  const submit = async () => {
    if (submitting || isRunning) return;
    setFeedback(null);
    if (!form.baseUrl.trim()) return setFeedback("Base URL is required");
    if (!form.model.trim()) return setFeedback("Model is required");

    const payload = {
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
      apiKey: form.apiKey.trim() || undefined,
      pp: parseIntList(form.pp),
      tg: parseIntList(form.tg),
      depth: parseIntList(form.depth),
      concurrency: parseIntList(form.concurrency),
      runs: Math.max(1, Math.trunc(Number(form.runs)) || 3),
      prefixCaching: form.prefixCaching,
      noWarmup: form.noWarmup,
      skipCoherence: form.skipCoherence,
      noCache: form.noCache,
      exactTg: form.exactTg,
    };

    setSubmitting(true);
    try {
      const res = await fetch("/api/benchmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json() as { ok: boolean; error?: string };
      if (!j.ok) setFeedback(j.error ?? "Failed to start");
      else { setLogOpen(true); setDetail(null); await poll(); await loadHistory(); }
    } catch (e: unknown) {
      setFeedback((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const kill = async () => {
    await fetch("/api/benchmarks", { method: "DELETE" });
    await poll();
  };

  const openDetail = async (id: number) => {
    if (detail?.id === id) { setDetail(null); return; }
    try {
      const res = await fetch(`/api/benchmarks/history?id=${id}`, { cache: "no-store" });
      const j = await res.json();
      if (j.ok) setDetail({ id, rows: j.run.rows as BenchTableRow[] });
    } catch { /* ignore */ }
  };

  const removeRun = async (id: number) => {
    await fetch(`/api/benchmarks/history?id=${id}`, { method: "DELETE" });
    if (detail?.id === id) setDetail(null);
    await loadHistory();
  };

  const statusColor = isRunning ? C.accentBright
    : job.status === "done" ? C.green
    : job.status === "error" ? C.red : C.dimmer;
  const statusLabel = isRunning ? "RUNNING"
    : job.status === "done" ? "DONE"
    : job.status === "error" ? "ERROR" : "IDLE";

  const card: React.CSSProperties = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" };
  const cardHead: React.CSSProperties = { background: C.cardHead, borderBottom: `1px solid ${C.border}`, padding: "10px 16px" };
  const headText: React.CSSProperties = { fontSize: 10, letterSpacing: "0.12em", color: C.dimmer, textTransform: "uppercase" };
  const inputStyle: React.CSSProperties = {
    width: "100%", background: C.page, border: `1px solid ${C.border}`, borderRadius: 6,
    padding: "7px 10px", color: C.text, fontSize: 12, fontFamily: "inherit",
    outline: "none", boxSizing: "border-box",
  };
  const label: React.CSSProperties = { fontSize: 9, letterSpacing: "0.08em", color: C.dimmer, textTransform: "uppercase", marginBottom: 4, display: "block" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* ── Header / status card ── */}
      <div style={{ ...card, border: `1px solid ${C.accent}44`, position: "relative" }}>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg, ${C.accent}, ${C.accentBright}66, transparent)` }} />
        <div style={{ padding: 16, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: `linear-gradient(135deg, ${C.accent}, #f97316)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, color: "#1a1200", fontWeight: 800, boxShadow: `0 0 12px ${C.accent}44` }}>⏱</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.08em", color: C.text }}>LLAMA-BENCHY</div>
              <div style={{ fontSize: 9, color: C.dimmer, letterSpacing: "0.08em" }}>
                {!targetLoaded ? "detecting target…"
                  : targetInfo?.online ? `TARGET: ${targetInfo.engineLabel ?? "engine"} · ${targetInfo.topology ?? ""}`
                  : "NO LIVE ENGINE DETECTED — enter a target manually"}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {isRunning && job.startedAt && (
              <span style={{ fontSize: 10, color: "#64748b" }}><ElapsedTimer startedAt={job.startedAt} /></span>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 20, background: `${statusColor}12`, border: `1px solid ${statusColor}33` }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor }} />
              <span style={{ fontSize: 10, color: statusColor, fontWeight: 700, letterSpacing: "0.1em" }}>{statusLabel}</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Config form ── */}
      <div style={card}>
        <div style={cardHead}><span style={headText}>▸ CONFIGURE RUN</span></div>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Presets */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {PRESETS.map((p) => (
              <button key={p.label} title={p.description} onClick={() => applyPreset(p)} disabled={isRunning}
                style={{
                  background: isRunning ? C.cardHead : "#1a1505", border: `1px solid ${isRunning ? C.border : C.accent + "55"}`,
                  borderRadius: 6, padding: "6px 12px", cursor: isRunning ? "not-allowed" : "pointer",
                  fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: isRunning ? C.faint : C.accentBright,
                  fontFamily: "inherit", opacity: isRunning ? 0.5 : 1,
                }}>{p.label}</button>
            ))}
          </div>

          {/* Target */}
          <div style={{ display: "grid", gridTemplateColumns: "2fr 2fr 1fr", gap: 10 }}>
            <div>
              <label style={label}>Base URL</label>
              <input style={inputStyle} value={form.baseUrl} disabled={isRunning}
                onChange={(e) => set("baseUrl", e.target.value)} placeholder="http://localhost:8001/v1" />
            </div>
            <div>
              <label style={label}>Model</label>
              <input style={inputStyle} value={form.model} disabled={isRunning}
                onChange={(e) => set("model", e.target.value)} placeholder="org/model" />
            </div>
            <div>
              <label style={label}>API key (opt)</label>
              <input style={inputStyle} value={form.apiKey} disabled={isRunning}
                onChange={(e) => set("apiKey", e.target.value)} placeholder="—" />
            </div>
          </div>

          {/* Sweeps */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
            {([
              ["pp", "PP tokens", "2048"],
              ["tg", "TG tokens", "128"],
              ["depth", "Depth", "0"],
              ["concurrency", "Concurrency", "1"],
              ["runs", "Runs", "3"],
            ] as const).map(([k, lbl, ph]) => (
              <div key={k}>
                <label style={label}>{lbl}</label>
                <input style={inputStyle} value={form[k]} disabled={isRunning}
                  onChange={(e) => set(k, e.target.value)} placeholder={ph} />
              </div>
            ))}
          </div>
          <div style={{ fontSize: 9, color: C.faint }}>
            Comma-separated lists sweep the cartesian product (pp × tg × depth × concurrency), each repeated “runs” times.
          </div>

          {/* Flags */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            {([
              ["prefixCaching", "prefix-caching"],
              ["skipCoherence", "skip-coherence"],
              ["noWarmup", "no-warmup"],
              ["noCache", "no-cache"],
              ["exactTg", "exact-tg"],
            ] as const).map(([k, lbl]) => (
              <label key={k} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: form[k] ? C.accentBright : C.dim, cursor: isRunning ? "not-allowed" : "pointer" }}>
                <input type="checkbox" checked={form[k]} disabled={isRunning}
                  onChange={(e) => set(k, e.target.checked)} style={{ accentColor: C.accent }} />
                {lbl}
              </label>
            ))}
          </div>

          {/* Run / kill */}
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button onClick={submit} disabled={isRunning || submitting}
              style={{
                background: isRunning ? C.cardHead : `${C.accent}22`, border: `1px solid ${isRunning ? C.border : C.accent + "88"}`,
                borderRadius: 6, padding: "8px 22px", cursor: isRunning || submitting ? "not-allowed" : "pointer",
                fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: isRunning ? C.faint : C.accentBright,
                fontFamily: "inherit", textTransform: "uppercase", opacity: isRunning ? 0.5 : 1,
              }}>{submitting ? "Starting…" : "▶ Run Benchmark"}</button>
            {isRunning && (
              <button onClick={kill} style={{
                background: "#1c0a0a", border: "1px solid #7f1d1d", borderRadius: 6, padding: "8px 16px",
                cursor: "pointer", fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: "#f87171",
                fontFamily: "inherit", textTransform: "uppercase",
              }}>■ Kill</button>
            )}
            {feedback && <span style={{ fontSize: 10, color: C.red }}>✗ {feedback}</span>}
          </div>
        </div>
      </div>

      {/* ── Live / latest results ── */}
      {(isRunning || job.rows.length > 0 || job.status === "error") && (
        <div style={{ ...card, border: `1px solid ${job.status === "error" ? "#7f1d1d" : job.status === "done" ? "#064e3b" : C.accent + "44"}` }}>
          <div style={{ ...cardHead, display: "flex", alignItems: "center", justifyContent: "space-between", borderBottomColor: job.status === "error" ? "#7f1d1d" : C.border }}>
            <span style={{ fontSize: 10, letterSpacing: "0.12em", color: statusColor, textTransform: "uppercase", fontWeight: 700 }}>
              {isRunning ? "◈ LIVE RESULTS" : job.status === "done" ? "✓ RESULTS" : "✗ RESULTS"}
              {job.id ? ` · run #${job.id}` : ""}
            </span>
            {job.config && (
              <span style={{ fontSize: 9, color: C.dimmer, fontFamily: "monospace" }}>
                {job.config.model}
              </span>
            )}
          </div>
          <div style={{ padding: job.rows.length ? 0 : "14px 16px" }}>
            {job.rows.length > 0
              ? <ResultsTable rows={job.rows} />
              : <span style={{ fontSize: 12, color: C.dimmer, fontStyle: "italic" }}>
                  {isRunning ? "Benchmark running — results appear on completion. Watch the live log below." : (job.error ?? "No results.")}
                </span>}
          </div>
          {job.status === "error" && job.error && job.rows.length > 0 && (
            <div style={{ padding: "8px 16px", fontSize: 10, color: C.red, borderTop: `1px solid ${C.border}` }}>✗ {job.error}</div>
          )}
        </div>
      )}

      {/* ── Live log ── */}
      {(job.log || isRunning) && (
        <div style={card}>
          <button onClick={() => setLogOpen((o) => !o)} style={{
            width: "100%", background: C.cardHead, border: "none", borderBottom: logOpen ? `1px solid ${C.border}` : "none",
            padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", fontFamily: "inherit",
          }}>
            <span style={headText}>{logOpen ? "▾" : "▸"} RUN LOG</span>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              {isRunning && <span style={{ fontSize: 9, color: C.accentBright }}>live</span>}
              <span style={{ fontSize: 9, color: C.faint }}>{logOpen ? "collapse" : "expand"}</span>
            </div>
          </button>
          {logOpen && (
            <div ref={logRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
              }}
              style={{
                padding: "12px 16px", height: 300, overflowY: "auto",
                fontFamily: "'Courier New', 'Consolas', monospace", fontSize: 11, lineHeight: 1.6,
                color: "#64748b", whiteSpace: "pre-wrap", wordBreak: "break-word", background: "#060910",
              }}>
              {job.log || <span style={{ color: C.faint, fontStyle: "italic" }}>Waiting for output…</span>}
            </div>
          )}
        </div>
      )}

      {/* ── History ── */}
      <div style={card}>
        <div style={{ ...cardHead, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={headText}>▸ HISTORY</span>
          <button onClick={loadHistory} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 9, color: C.dimmer, fontFamily: "inherit", letterSpacing: "0.08em" }}>↻ refresh</button>
        </div>
        <div style={{ padding: history.length ? "4px 0" : "14px 16px" }}>
          {!history.length && <span style={{ fontSize: 12, color: C.dimmer, fontStyle: "italic" }}>No runs yet.</span>}
          {history.map((r) => {
            const isOpen = detail?.id === r.id;
            const sc = r.status === "done" ? C.green : r.status === "running" ? C.accentBright : r.status === "error" ? C.red : C.dimmer;
            return (
              <div key={r.id} style={{ borderBottom: `1px solid #101827` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px" }}>
                  <button onClick={() => openDetail(r.id)} disabled={r.status !== "done"}
                    style={{ flex: 1, textAlign: "left", background: "none", border: "none", cursor: r.status === "done" ? "pointer" : "default", fontFamily: "inherit", padding: 0, display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: sc, flexShrink: 0 }} />
                    <span style={{ fontSize: 9, color: C.faint, width: 38, flexShrink: 0 }}>#{r.id}</span>
                    <span style={{ fontSize: 11, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{r.model}</span>
                    <span style={{ fontSize: 9, color: C.dimmer, flexShrink: 0 }}>
                      d={r.config.depth.join("/")} · c={r.config.concurrency.join("/")}
                    </span>
                    <span style={{ fontSize: 11, color: C.accentBright, fontWeight: 700, width: 84, textAlign: "right", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                      {r.peakTgTs !== null ? `${fmt(r.peakTgTs)} tg/s` : (r.status === "running" ? "…" : "—")}
                    </span>
                    <span style={{ fontSize: 9, color: C.faint, width: 130, textAlign: "right", flexShrink: 0 }}>
                      {new Date(r.started_at).toLocaleString()}
                    </span>
                  </button>
                  <button onClick={() => removeRun(r.id)} title="delete run"
                    style={{ background: "none", border: "none", cursor: "pointer", color: C.faint, fontSize: 12, fontFamily: "inherit", flexShrink: 0 }}>✕</button>
                </div>
                {isOpen && detail && (
                  <div style={{ padding: "0 16px 12px", background: "#060910" }}>
                    <ResultsTable rows={detail.rows} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
