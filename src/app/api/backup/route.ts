import { exec, spawn } from "child_process";
import { promisify } from "util";
import { promises as fsp, existsSync, mkdirSync, createWriteStream } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { spark1Cmd, spark1SpawnArgs } from "@/lib/engine";

export const dynamic = "force-dynamic";

const execAsync = promisify(exec);

// ── Restic config — matches /usr/local/bin/restic-backup.sh ──────────────────
const RESTIC_BIN = "/usr/bin/restic";
const RESTIC_REPOSITORY =
  "rest:http://sparky:1x0k0Suw1zX4ynAhUnBv@localhost:8000/edgexpert-74a6";
const RESTIC_PASSWORD_FILE = "/etc/restic-rest-server/repo.password";
const RETENTION_ENV_FILE = "/etc/restic-rest-server/retention.env";
const BACKUP_LOG = "/var/log/restic-backup.log";
const BACKUP_SCRIPT = "/usr/local/bin/restic-backup.sh";
const CHECK_SCRIPT = "/usr/local/bin/restic-check.sh";
const BACKUP_MOUNT = "/mnt/spark-backup";
const REST_SERVICE = "restic-rest-server";
const JOBS_DIR =
  process.env.HOME
    ? path.join(process.env.HOME, ".cache", "cluster-dash-backup", "jobs")
    : "/home/absolome/.cache/cluster-dash-backup/jobs";

function ensureJobsDir() {
  if (!existsSync(JOBS_DIR)) mkdirSync(JOBS_DIR, { recursive: true });
}

// Everything restic touches (the binary, rest-server, password file, backup
// drive, log, sudo scripts) lives on spark1 — every command below goes through
// spark1Cmd/spark1SpawnArgs, so the env travels inline in the shell string.
const RESTIC_ENV_PREFIX =
  `RESTIC_REPOSITORY='${RESTIC_REPOSITORY}' RESTIC_PASSWORD_FILE='${RESTIC_PASSWORD_FILE}'`;

/** Read a spark1 file (retention env, password, log tail) wherever the dashboard runs. */
async function readSpark1File(p: string, maxBytes?: number): Promise<string> {
  const inner = maxBytes ? `tail -c ${maxBytes} '${p}' 2>/dev/null` : `cat '${p}'`;
  const { stdout } = await execAsync(spark1Cmd(inner), { timeout: 10000, maxBuffer: 1024 * 1024 });
  return stdout;
}

// ── Background job runner ────────────────────────────────────────────────────
type JobOp = "backup-now" | "restore" | "check";

interface JobStatus {
  id: string;
  op: JobOp;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  pid: number | null;
  args?: Record<string, unknown>;
}

function jobPaths(id: string) {
  return {
    log: path.join(JOBS_DIR, `${id}.log`),
    status: path.join(JOBS_DIR, `${id}.status.json`),
  };
}

async function writeStatus(s: JobStatus) {
  const { status } = jobPaths(s.id);
  await fsp.writeFile(status, JSON.stringify(s, null, 2));
}

async function readStatus(id: string): Promise<JobStatus | null> {
  try {
    const txt = await fsp.readFile(jobPaths(id).status, "utf8");
    return JSON.parse(txt) as JobStatus;
  } catch {
    return null;
  }
}

function spawnJob(
  op: JobOp,
  shellCmd: string,
  opts: { meta?: Record<string, unknown> } = {}
): JobStatus {
  ensureJobsDir();
  const id = `${Date.now()}-${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0")}`;
  const { log: logPath, status: statusPath } = jobPaths(id);

  // One shell string, run on spark1 (bash -c locally, ssh in remote mode); job
  // log + status files stay on the dashboard host either way.
  const sp = spark1SpawnArgs(shellCmd);
  const child = spawn(sp.cmd, sp.args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  const stream = createWriteStream(logPath, { flags: "a" });
  stream.write(`[${new Date().toISOString()}] ${op} starting: ${shellCmd}\n`);
  child.stdout?.pipe(stream, { end: false });
  child.stderr?.pipe(stream, { end: false });

  const startedAt = Date.now();
  const status: JobStatus = {
    id,
    op,
    startedAt,
    finishedAt: null,
    exitCode: null,
    pid: child.pid ?? null,
    args: opts.meta,
  };
  // Fire-and-forget the initial status write.
  fsp.writeFile(statusPath, JSON.stringify(status, null, 2)).catch(() => {});

  child.on("close", (code) => {
    const finishedAt = Date.now();
    stream.write(
      `\n[${new Date().toISOString()}] ${op} exited code=${code} duration=${
        finishedAt - startedAt
      }ms\n`
    );
    stream.end();
    writeStatus({
      ...status,
      finishedAt,
      exitCode: code ?? -1,
    }).catch(() => {});
  });

  child.on("error", (err) => {
    stream.write(`\n[${new Date().toISOString()}] spawn error: ${err.message}\n`);
    stream.end();
    writeStatus({
      ...status,
      finishedAt: Date.now(),
      exitCode: -1,
    }).catch(() => {});
  });

  return status;
}

// ── Read helpers ─────────────────────────────────────────────────────────────
async function runRestic(args: string[], timeoutMs = 30000): Promise<string> {
  const { stdout } = await execAsync(spark1Cmd(`${RESTIC_ENV_PREFIX} ${RESTIC_BIN} ${args.join(" ")}`), {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function tailFile(p: string, maxBytes = 32_000): Promise<string> {
  try {
    const stat = await fsp.stat(p);
    const fd = await fsp.open(p, "r");
    try {
      const len = Math.min(maxBytes, stat.size);
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, Math.max(0, stat.size - len));
      return buf.toString("utf8");
    } finally {
      await fd.close();
    }
  } catch {
    return "";
  }
}

async function parseRetention(): Promise<{ keepDaily: number; keepWeekly: number; keepMonthly: number }> {
  const fallback = { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 };
  try {
    const txt = await readSpark1File(RETENTION_ENV_FILE);
    const get = (key: string): number | null => {
      const m = txt.match(new RegExp(`^${key}\\s*=\\s*(\\d+)`, "m"));
      return m ? Number(m[1]) : null;
    };
    return {
      keepDaily: get("KEEP_DAILY") ?? fallback.keepDaily,
      keepWeekly: get("KEEP_WEEKLY") ?? fallback.keepWeekly,
      keepMonthly: get("KEEP_MONTHLY") ?? fallback.keepMonthly,
    };
  } catch {
    return fallback;
  }
}

async function driveUsage(): Promise<{ total: number; used: number; avail: number } | null> {
  try {
    const { stdout } = await execAsync(spark1Cmd(`df -B1 --output=size,used,avail ${BACKUP_MOUNT} | tail -n1`));
    const [size, used, avail] = stdout.trim().split(/\s+/).map(Number);
    if (![size, used, avail].some(Number.isNaN)) return { total: size, used, avail };
    return null;
  } catch {
    return null;
  }
}

async function restServerStatus(): Promise<{ active: boolean; sub: string }> {
  try {
    const { stdout } = await execAsync(spark1Cmd(`systemctl is-active ${REST_SERVICE}`));
    return { active: stdout.trim() === "active", sub: stdout.trim() };
  } catch (e: unknown) {
    // is-active exits non-zero when inactive; capture the substate from stdout if available.
    const err = e as { stdout?: string };
    return { active: false, sub: (err.stdout ?? "inactive").trim() };
  }
}

async function nextScheduled(): Promise<{ next: string | null; raw: string | null }> {
  // The active schedule is root crontab "0 2 * * * /usr/local/bin/restic-backup.sh"
  // We can't read root crontab as absolome. Approximate next-fire from the known time.
  const now = new Date();
  const next = new Date(now);
  next.setHours(2, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return { next: next.toISOString(), raw: "0 2 * * * /usr/local/bin/restic-backup.sh (root)" };
}

interface ResticSnapshot {
  id: string;
  short_id: string;
  time: string;
  hostname: string;
  username: string;
  paths: string[];
  tags?: string[];
  parent?: string;
  summary?: {
    total_files_processed?: number;
    total_bytes_processed?: number;
    data_added?: number;
  };
}

async function snapshots(): Promise<ResticSnapshot[]> {
  // --no-lock: we're only reading. Avoids colliding with `restic check` which
  // needs an exclusive lock.
  const stdout = await runRestic(["snapshots", "--no-lock", "--json"], 60000);
  return JSON.parse(stdout) as ResticSnapshot[];
}

async function stats(mode: "raw-data" | "restore-size" | "files-by-contents" = "raw-data") {
  const stdout = await runRestic(["stats", "--no-lock", "--mode", mode, "--json"], 60000);
  return JSON.parse(stdout);
}

// ── Route handlers ───────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const op = searchParams.get("op") ?? "overview";

  try {
    switch (op) {
      case "overview": {
        const [snaps, statsData, drive, rest, sched] = await Promise.all([
          snapshots().catch(() => [] as ResticSnapshot[]),
          stats("raw-data").catch(() => null),
          driveUsage(),
          restServerStatus(),
          nextScheduled(),
        ]);
        const retention = await parseRetention();
        const logTail = await readSpark1File(BACKUP_LOG, 8000).catch(() => "");
        const last = snaps.length ? snaps[snaps.length - 1] : null;
        return NextResponse.json({
          ok: true,
          snapshotsCount: snaps.length,
          lastSnapshot: last,
          stats: statsData,
          drive,
          restServer: rest,
          schedule: sched,
          retention,
          logTail,
        });
      }

      case "snapshots": {
        const snaps = await snapshots();
        return NextResponse.json({ ok: true, snapshots: snaps });
      }

      case "stats": {
        const mode = (searchParams.get("mode") ?? "raw-data") as
          | "raw-data"
          | "restore-size"
          | "files-by-contents";
        const data = await stats(mode);
        return NextResponse.json({ ok: true, stats: data, mode });
      }

      case "ls": {
        const snap = searchParams.get("snap");
        const target = searchParams.get("path") ?? "/";
        if (!snap || !/^[a-f0-9]{6,64}$/i.test(snap)) {
          return NextResponse.json({ ok: false, error: "invalid snap id" }, { status: 400 });
        }
        // restic ls --json emits one JSON object per line, recursive by default — we filter to the requested dir.
        const { stdout } = await execAsync(
          spark1Cmd(`${RESTIC_ENV_PREFIX} ${RESTIC_BIN} ls --no-lock --json ${snap} ${JSON.stringify(target)}`),
          { timeout: 60000, maxBuffer: 64 * 1024 * 1024 }
        );
        const entries: Array<{
          name: string;
          type: string;
          path: string;
          size?: number;
          mtime?: string;
        }> = [];
        const lines = stdout.split("\n").filter(Boolean);
        const normTarget = target === "/" ? "" : target.replace(/\/$/, "");
        for (const line of lines) {
          let obj: Record<string, unknown>;
          try {
            obj = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (obj.struct_type !== "node") continue;
          const p = obj.path as string;
          if (!p) continue;
          // Only direct children of normTarget.
          if (normTarget === "") {
            // Root: include top-level entries (one "/" then a single segment).
            const rest = p.replace(/^\//, "");
            if (rest === "" || rest.includes("/")) continue;
          } else {
            if (!p.startsWith(normTarget + "/")) continue;
            const after = p.slice(normTarget.length + 1);
            if (after.includes("/")) continue;
          }
          entries.push({
            name: (obj.name as string) ?? p.split("/").pop() ?? p,
            type: obj.type as string,
            path: p,
            size: obj.size as number | undefined,
            mtime: obj.mtime as string | undefined,
          });
        }
        entries.sort((a, b) => {
          if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return NextResponse.json({ ok: true, snap, path: target, entries });
      }

      case "log": {
        const bytes = Math.min(
          Math.max(parseInt(searchParams.get("bytes") ?? "32000", 10) || 32000, 1000),
          200_000
        );
        const text = await readSpark1File(BACKUP_LOG, bytes).catch(() => "");
        return NextResponse.json({ ok: true, log: text });
      }

      case "password": {
        const txt = await readSpark1File(RESTIC_PASSWORD_FILE);
        return NextResponse.json({ ok: true, password: txt.trim() });
      }

      case "schedule": {
        const retention = await parseRetention();
        const sched = await nextScheduled();
        return NextResponse.json({ ok: true, retention, schedule: sched });
      }

      case "job": {
        const id = searchParams.get("id");
        if (!id || !/^[0-9]+-[0-9]+$/.test(id)) {
          return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
        }
        const status = await readStatus(id);
        if (!status) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
        const log = await tailFile(jobPaths(id).log, 64_000);
        return NextResponse.json({ ok: true, status, log });
      }

      default:
        return NextResponse.json({ ok: false, error: `unknown op: ${op}` }, { status: 400 });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const op = body.op as string;

  try {
    switch (op) {
      case "backup-now": {
        const status = spawnJob("backup-now", `sudo -n ${BACKUP_SCRIPT}`);
        return NextResponse.json({ ok: true, jobId: status.id });
      }

      case "check": {
        const status = spawnJob("check", `sudo -n ${CHECK_SCRIPT}`);
        return NextResponse.json({ ok: true, jobId: status.id });
      }

      case "unlock": {
        // restic locks live in /locks/ on the REST server, which append-only
        // mode DOES allow DELETE on (needed for the protocol). No sudo needed.
        const { stdout, stderr } = await execAsync(
          spark1Cmd(`${RESTIC_ENV_PREFIX} ${RESTIC_BIN} unlock --remove-all --no-cache`),
          { timeout: 30000 }
        );
        return NextResponse.json({ ok: true, output: (stdout + stderr).trim() });
      }

      case "restore": {
        const snap = String(body.snapshot ?? "");
        const target = String(body.target ?? "");
        const paths = Array.isArray(body.paths) ? (body.paths as unknown[]).map(String) : [];

        if (!/^[a-f0-9]{6,64}$/i.test(snap))
          return NextResponse.json({ ok: false, error: "invalid snapshot id" }, { status: 400 });
        if (!target.startsWith("/home/absolome/restore/"))
          return NextResponse.json(
            { ok: false, error: "target must start with /home/absolome/restore/" },
            { status: 400 }
          );
        if (target.includes("..") || /\s/.test(target))
          return NextResponse.json({ ok: false, error: "invalid target path" }, { status: 400 });
        if (paths.length === 0)
          return NextResponse.json({ ok: false, error: "no paths selected" }, { status: 400 });
        for (const p of paths) {
          if (!p.startsWith("/") || p.includes("..")) {
            return NextResponse.json({ ok: false, error: `invalid path: ${p}` }, { status: 400 });
          }
        }

        // Restore lands on spark1's disk (target is /home/absolome/restore/...).
        await execAsync(spark1Cmd(`mkdir -p '${target}'`), { timeout: 10000 });

        const args = ["restore", snap, "--target", target];
        for (const p of paths) args.push("--include", `'${p}'`);
        const status = spawnJob("restore", `${RESTIC_ENV_PREFIX} ${RESTIC_BIN} ${args.join(" ")}`, {
          meta: { snap, target, paths },
        });
        return NextResponse.json({ ok: true, jobId: status.id });
      }

      case "update-retention": {
        const d = Number(body.keepDaily);
        const w = Number(body.keepWeekly);
        const m = Number(body.keepMonthly);
        for (const [k, v] of [
          ["keepDaily", d],
          ["keepWeekly", w],
          ["keepMonthly", m],
        ] as const) {
          if (!Number.isInteger(v) || v < 1 || v > 365) {
            return NextResponse.json(
              { ok: false, error: `${k} must be an integer between 1 and 365` },
              { status: 400 }
            );
          }
        }
        const next =
          "# Restic retention policy used by /usr/local/bin/restic-backup.sh.\n" +
          "# Editable by cluster-dash (group absolome).\n" +
          `KEEP_DAILY=${d}\n` +
          `KEEP_WEEKLY=${w}\n` +
          `KEEP_MONTHLY=${m}\n`;
        // Direct overwrite — the parent dir isn't writable by absolome, but the
        // file itself is group-writable (root:absolome 0664). The only reader is
        // the nightly cron at 02:00, so the truncate-then-write race window is
        // effectively impossible to hit in practice. Content is quote-free, so a
        // single-quoted printf survives the ssh hop in remote-spark1 mode.
        await execAsync(spark1Cmd(`printf '%s' '${next}' > ${RETENTION_ENV_FILE}`), { timeout: 10000 });
        return NextResponse.json({
          ok: true,
          retention: { keepDaily: d, keepWeekly: w, keepMonthly: m },
        });
      }

      default:
        return NextResponse.json({ ok: false, error: `unknown op: ${op}` }, { status: 400 });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
