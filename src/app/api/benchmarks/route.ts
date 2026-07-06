import { spawn, ChildProcess } from "child_process";
import { readFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest, NextResponse } from "next/server";
import type { BenchConfig, BenchJobState, BenchResultJson } from "@/lib/bench-types";
import { normalizeConfig, buildBenchArgs, aggregateRows } from "@/lib/bench-run";
import { createBenchRun, finishBenchRun, reconcileStuckRuns } from "@/lib/bench-db";

export const dynamic = "force-dynamic";

const UVX_BIN = "/home/absolome/.local/bin/uvx";
const HOME = "/home/absolome";
const MAX_LOG_CHARS = 200_000;
const RESULT_DIR = join(tmpdir(), "cluster-dash-bench");

// ── Persistent job state (module-level — PM2 keeps this process alive) ────────
interface Job extends BenchJobState {
  resultFile: string;
}

let currentJob: Job | null = null;
let child: ChildProcess | null = null;
let lineBuffer = "";

// A dashboard restart can strand a DB row in 'running'. Reconcile on load.
reconcileStuckRuns().catch(() => { /* DB may be briefly unavailable */ });

function appendLog(text: string) {
  if (!currentJob) return;
  currentJob.log += text;
  if (currentJob.log.length > MAX_LOG_CHARS) {
    currentJob.log = "[…older log trimmed…]\n" + currentJob.log.slice(-MAX_LOG_CHARS + 500);
  }
}

function publicState(job: Job | null): BenchJobState {
  if (!job) {
    return {
      id: null, status: "idle", config: null, log: "", rows: [], result: null,
      error: null, startedAt: null, finishedAt: null, pid: null,
    };
  }
  // Strip the internal resultFile field.
  const { resultFile: _resultFile, ...rest } = job;
  void _resultFile;
  return rest;
}

// ── GET — current job state ───────────────────────────────────────────────────
export async function GET() {
  return NextResponse.json(publicState(currentJob));
}

// ── POST — launch a benchmark ─────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  if (currentJob?.status === "running") {
    return NextResponse.json(
      { ok: false, error: "A benchmark is already running. Kill it first." },
      { status: 409 },
    );
  }

  const parsed = normalizeConfig(await req.json().catch(() => ({})));
  if ("error" in parsed) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }
  const config: BenchConfig = parsed.config;

  // Persist the run first so it appears in history immediately.
  let runId: number;
  try {
    runId = await createBenchRun(config);
  } catch (err: unknown) {
    return NextResponse.json(
      { ok: false, error: `DB error: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  await mkdir(RESULT_DIR, { recursive: true }).catch(() => {});
  const resultFile = join(RESULT_DIR, `run-${runId}.json`);
  const args = buildBenchArgs(config, resultFile);

  lineBuffer = "";
  currentJob = {
    id: runId,
    status: "running",
    config,
    log: `[BENCHMARK #${runId} STARTED — ${new Date().toISOString()}]\n`
      + `[TARGET] ${config.model} @ ${config.baseUrl}\n`
      + `[SWEEP] pp=${config.pp.join(",")} tg=${config.tg.join(",")} `
      + `depth=${config.depth.join(",")} concurrency=${config.concurrency.join(",")} runs=${config.runs}\n`
      + `[CMD] uvx ${args.join(" ")}\n${"─".repeat(60)}\n\n`,
    rows: [],
    result: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    pid: null,
    resultFile,
  };

  try {
    child = spawn(UVX_BIN, args, {
      cwd: HOME,
      env: {
        ...process.env,
        HOME,
        PATH: `/home/absolome/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
        TERM: "xterm-256color",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group so we can kill the whole tree
    });

    currentJob.pid = child.pid ?? null;

    child.stdout?.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) appendLog(line + "\n");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      // uvx prints package install progress to stderr — keep it, it's useful
      // while the first run resolves the tool.
      appendLog(chunk.toString());
    });

    child.on("close", (code) => {
      void finalize(code);
    });

    child.on("error", (err) => {
      void finalize(null, err.message);
    });
  } catch (err: unknown) {
    void finalize(null, (err as Error).message);
  }

  return NextResponse.json({ ok: true, id: runId, pid: currentJob.pid });
}

// Read + parse the saved result file, aggregate rows, persist, update job.
async function finalize(code: number | null, spawnError?: string) {
  const job = currentJob;
  if (!job || job.status !== "running") return;
  child = null;

  if (lineBuffer.trim()) { appendLog(lineBuffer); lineBuffer = ""; }

  let result: BenchResultJson | null = null;
  try {
    const text = await readFile(job.resultFile, "utf8");
    result = JSON.parse(text) as BenchResultJson;
  } catch {
    // No/invalid result file (crash, kill, or unreachable endpoint).
  }

  const ok = code === 0 && !spawnError && !!result;
  job.status = ok ? "done" : "error";
  job.finishedAt = Date.now();
  job.result = result;
  job.rows = aggregateRows(result);

  if (spawnError) {
    job.error = spawnError;
    appendLog(`\n[SPAWN ERROR] ${spawnError}\n`);
  } else if (!ok) {
    job.error = result
      ? `benchmark exited ${code}`
      : `benchmark exited ${code} with no parseable result`;
  }

  const elapsed = job.startedAt ? ((job.finishedAt - job.startedAt) / 1000).toFixed(1) : "?";
  appendLog(`\n${"─".repeat(60)}\n[BENCHMARK ${job.status.toUpperCase()} — exit ${code} — ${elapsed}s]\n`);

  try {
    await finishBenchRun(job.id!, ok ? "done" : "error", result, job.error);
  } catch (err: unknown) {
    appendLog(`\n[DB ERROR saving result] ${(err as Error).message}\n`);
  }
}

// ── DELETE — kill running benchmark ───────────────────────────────────────────
export async function DELETE() {
  if (!currentJob || currentJob.status !== "running") {
    return NextResponse.json({ ok: false, error: "No running benchmark to kill" }, { status: 400 });
  }
  if (child) {
    try {
      process.kill(-(child.pid!), "SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
  }
  appendLog("\n[KILLED BY USER]\n");
  await finalize(null, "killed by user");
  return NextResponse.json({ ok: true });
}
