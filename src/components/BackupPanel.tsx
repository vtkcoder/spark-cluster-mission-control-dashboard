"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtBytes } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────────
interface SnapshotSummary {
  total_files_processed?: number;
  total_bytes_processed?: number;
  data_added?: number;
}
interface Snapshot {
  id: string;
  short_id: string;
  time: string;
  hostname: string;
  username: string;
  paths: string[];
  tags?: string[];
  parent?: string;
  summary?: SnapshotSummary;
}
interface OverviewData {
  ok: boolean;
  snapshotsCount: number;
  lastSnapshot: Snapshot | null;
  stats: {
    total_size?: number;
    total_file_count?: number;
    total_blob_count?: number;
    snapshots_count?: number;
  } | null;
  drive: { total: number; used: number; avail: number } | null;
  restServer: { active: boolean; sub: string };
  schedule: { next: string | null; raw: string | null };
  retention: { keepDaily: number; keepWeekly: number; keepMonthly: number };
  logTail: string;
}
interface LsEntry {
  name: string;
  type: string;
  path: string;
  size?: number;
  mtime?: string;
}
interface JobResp {
  ok: boolean;
  status: {
    id: string;
    op: string;
    startedAt: number;
    finishedAt: number | null;
    exitCode: number | null;
    pid: number | null;
  };
  log: string;
}

// ── Section labels ───────────────────────────────────────────────────────────
type Section =
  | "overview"
  | "snapshots"
  | "browse"
  | "schedule"
  | "health"
  | "password"
  | "log";

const SECTIONS: { key: Section; label: string }[] = [
  { key: "overview", label: "OVERVIEW" },
  { key: "snapshots", label: "SNAPSHOTS" },
  { key: "browse", label: "BROWSE & RESTORE" },
  { key: "schedule", label: "SCHEDULE" },
  { key: "health", label: "HEALTH" },
  { key: "password", label: "PASSWORD" },
  { key: "log", label: "LOG" },
];

// ── Tokens ───────────────────────────────────────────────────────────────────
const C = {
  bg: "#06090f",
  card: "#0c1220",
  cardHeader: "#0a1018",
  border: "#1a2540",
  text: "#e2e8f0",
  textMuted: "#94a3b8",
  textDim: "#475569",
  textVeryDim: "#334155",
  green: "#10b981",
  blue: "#3b82f6",
  cyan: "#22d3ee",
  amber: "#f59e0b",
  red: "#ef4444",
  purple: "#8b5cf6",
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "in the future";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function pct(used: number, total: number): number {
  if (!total) return 0;
  return Math.round((used / total) * 100);
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-GB", { hour12: false });
}

// ── Small primitives ─────────────────────────────────────────────────────────
function Card({
  title,
  right,
  children,
}: {
  title?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
      }}
    >
      {title && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: C.cardHeader,
            borderBottom: `1px solid ${C.border}`,
            padding: "8px 12px",
            fontSize: 10,
            letterSpacing: "0.14em",
            color: C.textDim,
            textTransform: "uppercase",
          }}
        >
          <span>{title}</span>
          {right}
        </div>
      )}
      <div style={{ padding: 14, minWidth: 0 }}>{children}</div>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  color = C.text,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div
      style={{
        background: "#0a1018",
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        padding: "10px 14px",
        flex: "1 1 0",
        minWidth: 140,
      }}
    >
      <div
        style={{
          fontSize: 9,
          letterSpacing: "0.14em",
          color: C.textDim,
          textTransform: "uppercase",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color, letterSpacing: "0.02em" }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 10, color: C.textDim, marginTop: 3 }}>{sub}</div>
      )}
    </div>
  );
}

function StatRow({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: React.ReactNode;
  valueColor?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "5px 0",
        borderBottom: `1px solid ${C.border}`,
        fontSize: 11,
      }}
    >
      <span style={{ color: C.textMuted }}>{label}</span>
      <span style={{ color: valueColor ?? C.text, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </span>
    </div>
  );
}

function Btn({
  onClick,
  children,
  disabled,
  tone = "primary",
}: {
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  tone?: "primary" | "danger" | "ghost";
}) {
  const colorMap = {
    primary: { bg: "#0a1628", border: C.blue, text: C.blue, hover: "#11203a" },
    danger: { bg: "#1a0a0a", border: C.red, text: C.red, hover: "#2a0e0e" },
    ghost: { bg: "transparent", border: C.border, text: C.textMuted, hover: "#0a1018" },
  } as const;
  const t = colorMap[tone];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: t.bg,
        border: `1px solid ${t.border}`,
        color: t.text,
        borderRadius: 6,
        padding: "6px 12px",
        fontSize: 10,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        fontFamily: "inherit",
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        transition: "background 0.15s",
      }}
    >
      {children}
    </button>
  );
}

function LogBox({ text, height = 240 }: { text: string; height?: number }) {
  return (
    <pre
      style={{
        background: "#04070d",
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: 10,
        margin: 0,
        fontSize: 10,
        lineHeight: 1.4,
        color: C.textMuted,
        height,
        overflowY: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: "inherit",
      }}
    >
      {text || "(empty)"}
    </pre>
  );
}

// ── Main component ──────────────────────────────────────────────────────────
export function BackupPanel() {
  const [section, setSection] = useState<Section>("overview");
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const pollOverview = useCallback(async () => {
    try {
      const r = await fetch("/api/backup?op=overview", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as OverviewData;
      setOverview(j);
      setOverviewError(null);
    } catch (e) {
      setOverviewError(e instanceof Error ? e.message : "fetch failed");
    }
  }, []);

  useEffect(() => {
    pollOverview();
    const id = setInterval(pollOverview, 8000);
    return () => clearInterval(id);
  }, [pollOverview]);

  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      {/* Section nav */}
      <div
        style={{
          display: "flex",
          borderBottom: `1px solid ${C.border}`,
          background: "#080e1a",
          flexWrap: "wrap",
        }}
      >
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            style={{
              flex: "1 1 0",
              minWidth: 120,
              padding: "10px 6px",
              background: "none",
              border: "none",
              borderBottom:
                section === s.key ? `2px solid ${C.amber}` : "2px solid transparent",
              cursor: "pointer",
              fontSize: 10,
              letterSpacing: "0.12em",
              color: section === s.key ? C.amber : C.textVeryDim,
              fontWeight: section === s.key ? 700 : 500,
              textTransform: "uppercase",
              fontFamily: "inherit",
              transition: "color 0.15s",
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Section body */}
      <div style={{ padding: 16 }}>
        {section === "overview" && (
          <OverviewSection
            data={overview}
            error={overviewError}
            onRefresh={pollOverview}
          />
        )}
        {section === "snapshots" && <SnapshotsSection />}
        {section === "browse" && <BrowseSection />}
        {section === "schedule" && (
          <ScheduleSection
            initial={overview?.retention ?? null}
            schedule={overview?.schedule ?? null}
            onSaved={pollOverview}
          />
        )}
        {section === "health" && <HealthSection overview={overview} />}
        {section === "password" && <PasswordSection />}
        {section === "log" && <LogSection />}
      </div>
    </div>
  );
}

// ── OVERVIEW ─────────────────────────────────────────────────────────────────
function OverviewSection({
  data,
  error,
  onRefresh,
}: {
  data: OverviewData | null;
  error: string | null;
  onRefresh: () => void;
}) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobLog, setJobLog] = useState<string>("");
  const [jobStatus, setJobStatus] = useState<JobResp["status"] | null>(null);
  const [busy, setBusy] = useState(false);

  const runBackup = useCallback(async () => {
    setBusy(true);
    setJobLog("");
    setJobStatus(null);
    try {
      const r = await fetch("/api/backup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "backup-now" }),
      });
      const j = (await r.json()) as { ok: boolean; jobId?: string; error?: string };
      if (!j.ok || !j.jobId) throw new Error(j.error ?? "no job id");
      setJobId(j.jobId);
    } catch (e) {
      setJobLog(`Error: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  }, []);

  useJobPoller(jobId, (resp) => {
    setJobLog(resp.log);
    setJobStatus(resp.status);
    if (resp.status.finishedAt !== null) {
      setBusy(false);
      onRefresh();
    }
  });

  if (error && !data) {
    return <div style={{ color: C.red, fontSize: 12 }}>Failed to load: {error}</div>;
  }
  if (!data) {
    return <div style={{ color: C.textVeryDim, fontSize: 11 }}>LOADING…</div>;
  }

  const drivePct = data.drive ? pct(data.drive.used, data.drive.total) : 0;
  const last = data.lastSnapshot;
  const totalSize = data.stats?.total_size ?? 0;
  const totalFiles = data.stats?.total_file_count ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* KPI row */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Kpi
          label="Last Backup"
          value={last ? timeAgo(last.time) : "Never"}
          sub={last ? fmtTime(last.time) : undefined}
          color={
            last && Date.now() - new Date(last.time).getTime() < 30 * 3600 * 1000
              ? C.green
              : C.amber
          }
        />
        <Kpi label="Snapshots" value={String(data.snapshotsCount)} color={C.cyan} />
        <Kpi
          label="Repo Size"
          value={totalSize ? fmtBytes(totalSize, 1) : "—"}
          sub={totalFiles ? `${totalFiles.toLocaleString()} files` : undefined}
          color={C.purple}
        />
        <Kpi
          label="Drive Free"
          value={data.drive ? fmtBytes(data.drive.avail, 1) : "—"}
          sub={data.drive ? `${drivePct}% used of ${fmtBytes(data.drive.total, 1)}` : undefined}
          color={drivePct < 80 ? C.green : drivePct < 90 ? C.amber : C.red}
        />
        <Kpi
          label="REST Server"
          value={data.restServer.active ? "ACTIVE" : data.restServer.sub.toUpperCase()}
          color={data.restServer.active ? C.green : C.red}
        />
        <Kpi
          label="Next Scheduled"
          value={data.schedule.next ? fmtTime(data.schedule.next) : "—"}
          sub="daily @ 02:00 (root cron)"
          color={C.blue}
        />
      </div>

      {/* Latest snapshot + actions */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
        <Card title="Latest Snapshot">
          {last ? (
            <>
              <StatRow label="ID" value={<code style={{ color: C.cyan }}>{last.short_id}</code>} />
              <StatRow label="Time" value={fmtTime(last.time)} />
              <StatRow label="Host" value={last.hostname} />
              <StatRow label="User" value={last.username} />
              <StatRow label="Paths" value={last.paths.join(", ")} />
              {last.summary && (
                <>
                  <StatRow
                    label="Files Processed"
                    value={(last.summary.total_files_processed ?? 0).toLocaleString()}
                  />
                  <StatRow
                    label="Bytes Processed"
                    value={fmtBytes(last.summary.total_bytes_processed ?? 0, 1)}
                  />
                  <StatRow
                    label="Data Added"
                    value={fmtBytes(last.summary.data_added ?? 0, 1)}
                    valueColor={C.amber}
                  />
                </>
              )}
            </>
          ) : (
            <div style={{ color: C.textDim, fontSize: 11 }}>No snapshots yet</div>
          )}
        </Card>

        <Card
          title="On-Demand Backup"
          right={
            <Btn onClick={runBackup} disabled={busy}>
              {busy ? "RUNNING…" : "RUN BACKUP NOW"}
            </Btn>
          }
        >
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>
            Runs <code style={{ color: C.cyan }}>/usr/local/bin/restic-backup.sh</code> as root
            via NOPASSWD sudoers — same script the nightly cron uses. Includes Postgres dumps.
          </div>
          {jobStatus && (
            <div style={{ fontSize: 10, color: C.textDim, marginBottom: 6 }}>
              job <code>{jobStatus.id}</code> ·{" "}
              {jobStatus.finishedAt === null ? (
                <span style={{ color: C.amber }}>RUNNING</span>
              ) : jobStatus.exitCode === 0 ? (
                <span style={{ color: C.green }}>DONE</span>
              ) : (
                <span style={{ color: C.red }}>EXIT {jobStatus.exitCode}</span>
              )}
            </div>
          )}
          <LogBox text={jobLog} height={180} />
        </Card>
      </div>

      <Card title="Recent Backup Log" right={<Btn tone="ghost" onClick={onRefresh}>REFRESH</Btn>}>
        <LogBox text={data.logTail} height={220} />
      </Card>
    </div>
  );
}

// ── SNAPSHOTS ────────────────────────────────────────────────────────────────
function SnapshotsSection() {
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortDesc, setSortDesc] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/backup?op=snapshots", { cache: "no-store" });
      const j = (await r.json()) as { ok: boolean; snapshots?: Snapshot[]; error?: string };
      if (!j.ok) throw new Error(j.error ?? "failed");
      setSnaps(j.snapshots ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const sorted = useMemo(() => {
    if (!snaps) return [];
    const copy = [...snaps];
    copy.sort((a, b) => {
      const t = new Date(a.time).getTime() - new Date(b.time).getTime();
      return sortDesc ? -t : t;
    });
    return copy;
  }, [snaps, sortDesc]);

  if (error) return <div style={{ color: C.red, fontSize: 12 }}>{error}</div>;
  if (!snaps) return <div style={{ color: C.textVeryDim, fontSize: 11 }}>LOADING…</div>;
  if (snaps.length === 0)
    return <div style={{ color: C.textDim, fontSize: 11 }}>No snapshots yet</div>;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <div style={{ fontSize: 11, color: C.textMuted }}>
          {snaps.length} snapshots
        </div>
        <Btn tone="ghost" onClick={() => setSortDesc((v) => !v)}>
          {sortDesc ? "NEWEST FIRST ▼" : "OLDEST FIRST ▲"}
        </Btn>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.border}` }}>
              {["TIME", "ID", "HOST", "PATHS", "FILES", "SIZE", "ADDED"].map((h) => (
                <th
                  key={h}
                  style={{
                    padding: "5px 8px",
                    textAlign: "left",
                    fontSize: 9,
                    letterSpacing: "0.12em",
                    color: C.textVeryDim,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    whiteSpace: "nowrap",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((s, i) => (
              <tr
                key={s.id}
                style={{
                  background: i % 2 === 0 ? "transparent" : "#ffffff04",
                  borderBottom: `1px solid #0f1624`,
                }}
              >
                <td style={{ padding: "5px 8px", color: C.text, whiteSpace: "nowrap" }}>
                  {fmtTime(s.time)}
                </td>
                <td style={{ padding: "5px 8px" }}>
                  <code style={{ color: C.cyan }}>{s.short_id}</code>
                </td>
                <td style={{ padding: "5px 8px", color: C.textMuted }}>{s.hostname}</td>
                <td style={{ padding: "5px 8px", color: C.textDim, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.paths.join(", ")}>
                  {s.paths.join(", ")}
                </td>
                <td style={{ padding: "5px 8px", textAlign: "right", color: C.textMuted, fontVariantNumeric: "tabular-nums" }}>
                  {s.summary?.total_files_processed?.toLocaleString() ?? "—"}
                </td>
                <td style={{ padding: "5px 8px", textAlign: "right", color: C.textMuted, fontVariantNumeric: "tabular-nums" }}>
                  {s.summary?.total_bytes_processed
                    ? fmtBytes(s.summary.total_bytes_processed, 1)
                    : "—"}
                </td>
                <td style={{ padding: "5px 8px", textAlign: "right", color: C.amber, fontVariantNumeric: "tabular-nums" }}>
                  {s.summary?.data_added ? fmtBytes(s.summary.data_added, 1) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── BROWSE & RESTORE ─────────────────────────────────────────────────────────
function BrowseSection() {
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [snap, setSnap] = useState<string | null>(null);
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<LsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState("/home/absolome/restore/");
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobLog, setJobLog] = useState("");
  const [jobStatus, setJobStatus] = useState<JobResp["status"] | null>(null);

  useEffect(() => {
    fetch("/api/backup?op=snapshots", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { ok: boolean; snapshots?: Snapshot[] }) => {
        const list = j.snapshots ?? [];
        list.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
        setSnaps(list);
        if (list.length > 0) {
          setSnap(list[0].short_id);
          setTarget(`/home/absolome/restore/${list[0].short_id}/`);
        }
      })
      .catch(() => {});
  }, []);

  const loadLs = useCallback(async (s: string, p: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/backup?op=ls&snap=${encodeURIComponent(s)}&path=${encodeURIComponent(p)}`;
      const r = await fetch(url, { cache: "no-store" });
      const j = (await r.json()) as { ok: boolean; entries?: LsEntry[]; error?: string };
      if (!j.ok) throw new Error(j.error ?? "ls failed");
      setEntries(j.entries ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "ls failed");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (snap) loadLs(snap, path);
  }, [snap, path, loadLs]);

  const breadcrumbs = useMemo(() => {
    if (path === "/" || path === "") return [{ name: "/", path: "/" }];
    const segs = path.split("/").filter(Boolean);
    const crumbs: { name: string; path: string }[] = [{ name: "/", path: "/" }];
    let acc = "";
    for (const s of segs) {
      acc += "/" + s;
      crumbs.push({ name: s, path: acc });
    }
    return crumbs;
  }, [path]);

  const toggle = (p: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  const runRestore = useCallback(async () => {
    if (!snap || selected.size === 0) return;
    setJobLog("");
    setJobStatus(null);
    try {
      const r = await fetch("/api/backup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "restore",
          snapshot: snap,
          paths: Array.from(selected),
          target,
        }),
      });
      const j = (await r.json()) as { ok: boolean; jobId?: string; error?: string };
      if (!j.ok || !j.jobId) throw new Error(j.error ?? "restore failed to start");
      setJobId(j.jobId);
    } catch (e) {
      setJobLog(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [snap, selected, target]);

  useJobPoller(jobId, (resp) => {
    setJobLog(resp.log);
    setJobStatus(resp.status);
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Snapshot selector */}
      <Card title="Snapshot">
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <select
            value={snap ?? ""}
            onChange={(e) => {
              setSnap(e.target.value);
              setPath("/");
              setSelected(new Set());
              setTarget(`/home/absolome/restore/${e.target.value}/`);
            }}
            style={{
              background: "#0a1018",
              border: `1px solid ${C.border}`,
              color: C.text,
              padding: "6px 10px",
              borderRadius: 6,
              fontSize: 11,
              fontFamily: "inherit",
              minWidth: 320,
            }}
          >
            {snaps.map((s) => (
              <option key={s.id} value={s.short_id}>
                {fmtTime(s.time)} · {s.short_id} · {s.paths.join(",")}
              </option>
            ))}
          </select>
          <span style={{ fontSize: 11, color: C.textDim }}>
            {snaps.length} available
          </span>
        </div>
      </Card>

      {/* Browse tree */}
      <Card
        title="Files"
        right={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {breadcrumbs.map((b, i) => (
              <span key={b.path} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button
                  onClick={() => setPath(b.path)}
                  style={{
                    background: "none",
                    border: "none",
                    color: i === breadcrumbs.length - 1 ? C.cyan : C.textMuted,
                    fontSize: 10,
                    letterSpacing: "0.08em",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    padding: 0,
                  }}
                >
                  {b.name}
                </button>
                {i < breadcrumbs.length - 1 && <span style={{ color: C.textVeryDim }}>›</span>}
              </span>
            ))}
          </div>
        }
      >
        {loading && <div style={{ color: C.textVeryDim, fontSize: 11 }}>LOADING…</div>}
        {error && <div style={{ color: C.red, fontSize: 11 }}>{error}</div>}
        {!loading && !error && entries.length === 0 && (
          <div style={{ color: C.textDim, fontSize: 11 }}>(empty directory)</div>
        )}
        {!loading && entries.length > 0 && (
          <div
            style={{
              maxHeight: 360,
              overflowY: "auto",
              border: `1px solid ${C.border}`,
              borderRadius: 6,
            }}
          >
            {entries.map((e) => {
              const isDir = e.type === "dir";
              const checked = selected.has(e.path);
              return (
                <div
                  key={e.path}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "5px 10px",
                    fontSize: 11,
                    borderBottom: `1px solid #0f1624`,
                    background: checked ? "#1e3a8a18" : "transparent",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(e.path)}
                    style={{ accentColor: C.blue }}
                  />
                  <span style={{ fontSize: 12, color: isDir ? C.amber : C.textDim, width: 16 }}>
                    {isDir ? "▸" : "·"}
                  </span>
                  <button
                    onClick={() => isDir && setPath(e.path)}
                    style={{
                      background: "none",
                      border: "none",
                      color: isDir ? C.cyan : C.text,
                      cursor: isDir ? "pointer" : "default",
                      padding: 0,
                      fontFamily: "inherit",
                      fontSize: 11,
                      flex: 1,
                      textAlign: "left",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={e.path}
                  >
                    {e.name || e.path}
                  </button>
                  <span style={{ color: C.textVeryDim, fontSize: 10, fontVariantNumeric: "tabular-nums" }}>
                    {e.size ? fmtBytes(e.size, 0) : ""}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Restore controls */}
      <Card title={`Restore (${selected.size} selected)`}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
          <label style={{ fontSize: 11, color: C.textMuted }}>Target:</label>
          <input
            type="text"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            style={{
              background: "#0a1018",
              border: `1px solid ${C.border}`,
              color: C.text,
              padding: "6px 10px",
              borderRadius: 6,
              fontSize: 11,
              fontFamily: "inherit",
              minWidth: 360,
              flex: 1,
            }}
          />
          <Btn
            onClick={runRestore}
            disabled={!snap || selected.size === 0 || (jobStatus !== null && jobStatus.finishedAt === null)}
          >
            RESTORE SELECTED
          </Btn>
          <Btn tone="ghost" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
            CLEAR
          </Btn>
        </div>
        <div style={{ fontSize: 10, color: C.textVeryDim, marginBottom: 6 }}>
          Target must be inside <code>/home/absolome/restore/</code>. Restic recreates the original
          tree under it.
        </div>
        {selected.size > 0 && (
          <div
            style={{
              maxHeight: 80,
              overflowY: "auto",
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              padding: 8,
              fontSize: 10,
              color: C.textMuted,
              marginBottom: 10,
            }}
          >
            {Array.from(selected).map((p) => (
              <div key={p}>{p}</div>
            ))}
          </div>
        )}
        {jobStatus && (
          <div style={{ fontSize: 10, color: C.textDim, marginBottom: 6 }}>
            job <code>{jobStatus.id}</code> ·{" "}
            {jobStatus.finishedAt === null ? (
              <span style={{ color: C.amber }}>RUNNING</span>
            ) : jobStatus.exitCode === 0 ? (
              <span style={{ color: C.green }}>DONE</span>
            ) : (
              <span style={{ color: C.red }}>EXIT {jobStatus.exitCode}</span>
            )}
          </div>
        )}
        {(jobLog || jobStatus) && <LogBox text={jobLog} height={180} />}
      </Card>
    </div>
  );
}

// ── SCHEDULE & RETENTION ─────────────────────────────────────────────────────
function ScheduleSection({
  initial,
  schedule,
  onSaved,
}: {
  initial: OverviewData["retention"] | null;
  schedule: OverviewData["schedule"] | null;
  onSaved: () => void;
}) {
  const [d, setD] = useState<number>(initial?.keepDaily ?? 7);
  const [w, setW] = useState<number>(initial?.keepWeekly ?? 4);
  const [m, setM] = useState<number>(initial?.keepMonthly ?? 6);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initial) {
      setD(initial.keepDaily);
      setW(initial.keepWeekly);
      setM(initial.keepMonthly);
    }
  }, [initial]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      const r = await fetch("/api/backup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "update-retention",
          keepDaily: d,
          keepWeekly: w,
          keepMonthly: m,
        }),
      });
      const j = (await r.json()) as { ok: boolean; error?: string };
      if (!j.ok) throw new Error(j.error ?? "save failed");
      setSavedMsg("Saved — takes effect on the next nightly run.");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }, [d, w, m, onSaved]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
      <Card title="Schedule">
        <StatRow label="Next Run" value={fmtTime(schedule?.next ?? null)} />
        <StatRow label="Frequency" value="Daily @ 02:00" />
        <StatRow label="Owner" value="root crontab" />
        <div style={{ fontSize: 10, color: C.textVeryDim, marginTop: 8 }}>
          {schedule?.raw ?? "—"}
        </div>
        <div style={{ fontSize: 10, color: C.textVeryDim, marginTop: 6 }}>
          The schedule itself isn't editable from here — that lives in root&apos;s crontab.
        </div>
      </Card>

      <Card title="Retention Policy">
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10 }}>
          Saved values are written to <code style={{ color: C.cyan }}>/etc/restic-rest-server/retention.env</code>{" "}
          and picked up on the next nightly run.
        </div>
        <RetField label="Keep Daily" value={d} setValue={setD} />
        <RetField label="Keep Weekly" value={w} setValue={setW} />
        <RetField label="Keep Monthly" value={m} setValue={setM} />
        <div style={{ display: "flex", gap: 10, marginTop: 12, alignItems: "center" }}>
          <Btn onClick={save} disabled={saving}>
            {saving ? "SAVING…" : "SAVE"}
          </Btn>
          {savedMsg && <span style={{ fontSize: 11, color: C.green }}>{savedMsg}</span>}
          {error && <span style={{ fontSize: 11, color: C.red }}>{error}</span>}
        </div>
      </Card>
    </div>
  );
}

function RetField({
  label,
  value,
  setValue,
}: {
  label: string;
  value: number;
  setValue: (n: number) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "6px 0",
        borderBottom: `1px solid ${C.border}`,
      }}
    >
      <label style={{ fontSize: 11, color: C.textMuted }}>{label}</label>
      <input
        type="number"
        value={value}
        min={1}
        max={365}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (Number.isInteger(n) && n > 0 && n <= 365) setValue(n);
        }}
        style={{
          background: "#0a1018",
          border: `1px solid ${C.border}`,
          color: C.text,
          padding: "4px 8px",
          borderRadius: 6,
          fontSize: 11,
          fontFamily: "inherit",
          width: 70,
          textAlign: "right",
        }}
      />
    </div>
  );
}

// ── HEALTH ───────────────────────────────────────────────────────────────────
function HealthSection({ overview }: { overview: OverviewData | null }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobLog, setJobLog] = useState("");
  const [jobStatus, setJobStatus] = useState<JobResp["status"] | null>(null);
  const [unlockMsg, setUnlockMsg] = useState<string | null>(null);

  useJobPoller(jobId, (resp) => {
    setJobLog(resp.log);
    setJobStatus(resp.status);
  });

  const runCheck = useCallback(async () => {
    setJobLog("");
    setJobStatus(null);
    try {
      const r = await fetch("/api/backup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "check" }),
      });
      const j = (await r.json()) as { ok: boolean; jobId?: string; error?: string };
      if (!j.ok || !j.jobId) throw new Error(j.error ?? "no job id");
      setJobId(j.jobId);
    } catch (e) {
      setJobLog(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const runUnlock = useCallback(async () => {
    setUnlockMsg("running…");
    try {
      const r = await fetch("/api/backup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "unlock" }),
      });
      const j = (await r.json()) as { ok: boolean; output?: string; error?: string };
      if (!j.ok) throw new Error(j.error ?? "unlock failed");
      setUnlockMsg(j.output || "no locks held");
    } catch (e) {
      setUnlockMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const drive = overview?.drive;
  const drivePct = drive ? pct(drive.used, drive.total) : 0;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
      <Card title="Backup Drive">
        <StatRow label="Mount" value="/mnt/spark-backup (ext4)" />
        {drive && (
          <>
            <StatRow label="Total" value={fmtBytes(drive.total, 1)} />
            <StatRow label="Used" value={`${fmtBytes(drive.used, 1)} (${drivePct}%)`} valueColor={drivePct < 80 ? C.green : drivePct < 90 ? C.amber : C.red} />
            <StatRow label="Free" value={fmtBytes(drive.avail, 1)} />
          </>
        )}
        {drive && (
          <div
            style={{
              marginTop: 10,
              height: 8,
              borderRadius: 4,
              background: "#0a1018",
              border: `1px solid ${C.border}`,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${drivePct}%`,
                height: "100%",
                background: drivePct < 80 ? C.green : drivePct < 90 ? C.amber : C.red,
                transition: "width 0.3s",
              }}
            />
          </div>
        )}
      </Card>

      <Card title="REST Server">
        <StatRow
          label="Status"
          value={overview?.restServer.active ? "ACTIVE" : (overview?.restServer.sub ?? "—").toUpperCase()}
          valueColor={overview?.restServer.active ? C.green : C.red}
        />
        <StatRow label="Service" value="restic-rest-server.service" />
        <StatRow label="Listen" value="0.0.0.0:8000" />
        <StatRow label="Mode" value="--append-only" valueColor={C.amber} />
        <div style={{ fontSize: 10, color: C.textVeryDim, marginTop: 6 }}>
          Append-only blocks `restic forget --prune` from deleting old packs. Snapshots can still be created/listed.
        </div>
      </Card>

      <Card
        title="Repository Integrity"
        right={
          <Btn onClick={runCheck} disabled={jobStatus !== null && jobStatus.finishedAt === null}>
            {jobStatus && jobStatus.finishedAt === null ? "CHECKING…" : "RUN CHECK"}
          </Btn>
        }
      >
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>
          Verifies repo metadata + index. Doesn&apos;t re-read pack contents (use{" "}
          <code>--read-data</code> for that, slow over a network mount).
        </div>
        {jobStatus && (
          <div style={{ fontSize: 10, color: C.textDim, marginBottom: 6 }}>
            job <code>{jobStatus.id}</code> ·{" "}
            {jobStatus.finishedAt === null ? (
              <span style={{ color: C.amber }}>RUNNING</span>
            ) : jobStatus.exitCode === 0 ? (
              <span style={{ color: C.green }}>NO ERRORS</span>
            ) : (
              <span style={{ color: C.red }}>EXIT {jobStatus.exitCode}</span>
            )}
          </div>
        )}
        <LogBox text={jobLog} height={200} />
      </Card>

      <Card title="Repo Stats">
        {overview?.stats ? (
          <>
            <StatRow label="Total Size" value={fmtBytes(overview.stats.total_size ?? 0, 1)} />
            <StatRow label="File Count" value={(overview.stats.total_file_count ?? 0).toLocaleString()} />
            <StatRow label="Blob Count" value={(overview.stats.total_blob_count ?? 0).toLocaleString()} />
            <StatRow label="Snapshots" value={String(overview.stats.snapshots_count ?? overview.snapshotsCount)} />
          </>
        ) : (
          <div style={{ color: C.textVeryDim, fontSize: 11 }}>—</div>
        )}
      </Card>

      <Card title="Stale Locks" right={<Btn tone="ghost" onClick={runUnlock}>REMOVE LOCKS</Btn>}>
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>
          Restic locks the repo for some operations. If a process crashes mid-op the lock
          can stick around and block the next backup or check. This runs
          {" "}<code>restic unlock --remove-all</code>{" "}— safe to run when nothing else is
          actively talking to the repo.
        </div>
        {unlockMsg && (
          <pre
            style={{
              background: "#04070d",
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              padding: 8,
              margin: 0,
              fontSize: 10,
              color: unlockMsg.startsWith("Error") ? C.red : C.green,
              whiteSpace: "pre-wrap",
              fontFamily: "inherit",
            }}
          >
            {unlockMsg}
          </pre>
        )}
      </Card>
    </div>
  );
}

// ── PASSWORD ─────────────────────────────────────────────────────────────────
function PasswordSection() {
  const [revealed, setRevealed] = useState(false);
  const [pw, setPw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchPw = useCallback(async () => {
    try {
      const r = await fetch("/api/backup?op=password", { cache: "no-store" });
      const j = (await r.json()) as { ok: boolean; password?: string; error?: string };
      if (!j.ok) throw new Error(j.error ?? "fetch failed");
      setPw(j.password ?? "");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
    }
  }, []);

  const reveal = () => {
    if (!revealed && pw === null) fetchPw();
    setRevealed((v) => !v);
  };

  const copy = async () => {
    if (!pw) await fetchPw();
    const value = pw ?? "";
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback: ignore
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
      <Card title="Repository Encryption Password">
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10 }}>
          Read-only view of <code style={{ color: C.cyan }}>/etc/restic-rest-server/repo.password</code>.
          This is the key restic needs to decrypt every snapshot — keep it somewhere safe (password
          manager, offline). Without it, the backup is unrecoverable.
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "stretch",
            background: "#04070d",
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: 10,
          }}
        >
          <div
            style={{
              flex: 1,
              fontFamily: "inherit",
              fontSize: 14,
              letterSpacing: "0.08em",
              color: revealed ? C.amber : C.textDim,
              padding: "4px 6px",
              minHeight: 24,
              userSelect: revealed ? "text" : "none",
              wordBreak: "break-all",
            }}
          >
            {revealed ? (pw ?? "loading…") : "••••••••••••••••••••••••••••••••"}
          </div>
          <Btn onClick={reveal} tone="ghost">
            {revealed ? "HIDE" : "REVEAL"}
          </Btn>
          <Btn onClick={copy} tone="ghost">
            {copied ? "COPIED ✓" : "COPY"}
          </Btn>
        </div>
        {error && (
          <div style={{ color: C.red, fontSize: 11, marginTop: 8 }}>
            {error}
          </div>
        )}
      </Card>

      <Card title="Where it's used">
        <StatRow label="Password file" value="/etc/restic-rest-server/repo.password" />
        <StatRow label="File mode" value="0640 root:absolome" />
        <StatRow label="Read by" value="restic-backup.sh (root cron) + this dashboard" />
        <StatRow label="Repo URL" value="rest:http://sparky:***@localhost:8000/edgexpert-74a6" />
        <div style={{ fontSize: 10, color: C.textVeryDim, marginTop: 8 }}>
          Rotating this password is destructive without &nbsp;<code>restic key add</code>&nbsp;
          (intentionally not exposed here — do it from the CLI when you actually need it).
        </div>
      </Card>
    </div>
  );
}

// ── LOG ──────────────────────────────────────────────────────────────────────
function LogSection() {
  const [log, setLog] = useState("");
  const [bytes, setBytes] = useState(64_000);
  const [auto, setAuto] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/backup?op=log&bytes=${bytes}`, { cache: "no-store" });
      const j = (await r.json()) as { ok: boolean; log?: string };
      if (j.ok) setLog(j.log ?? "");
    } catch {
      // ignore
    }
  }, [bytes]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [auto, load]);

  return (
    <Card
      title="/var/log/restic-backup.log"
      right={
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <select
            value={bytes}
            onChange={(e) => setBytes(parseInt(e.target.value, 10))}
            style={{
              background: "#0a1018",
              border: `1px solid ${C.border}`,
              color: C.textMuted,
              padding: "2px 6px",
              borderRadius: 4,
              fontSize: 10,
              fontFamily: "inherit",
            }}
          >
            <option value={16_000}>16 K</option>
            <option value={64_000}>64 K</option>
            <option value={200_000}>200 K</option>
          </select>
          <Btn tone="ghost" onClick={() => setAuto((v) => !v)}>
            {auto ? "AUTO ON" : "AUTO OFF"}
          </Btn>
          <Btn tone="ghost" onClick={load}>
            REFRESH
          </Btn>
        </div>
      }
    >
      <LogBox text={log} height={480} />
    </Card>
  );
}

// ── Job polling hook ─────────────────────────────────────────────────────────
function useJobPoller(jobId: string | null, onUpdate: (r: JobResp) => void) {
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    let lastStatus: JobResp["status"] | null = null;
    const tick = async () => {
      if (stopped) return;
      try {
        const r = await fetch(`/api/backup?op=job&id=${encodeURIComponent(jobId)}`, {
          cache: "no-store",
        });
        if (r.ok) {
          const j = (await r.json()) as JobResp;
          onUpdateRef.current(j);
          lastStatus = j.status;
        }
      } catch {
        // ignore
      }
      if (lastStatus?.finishedAt) {
        // One more poll to flush final log, then stop.
        return;
      }
      setTimeout(tick, 1500);
    };
    tick();
    return () => {
      stopped = true;
    };
  }, [jobId]);
}
