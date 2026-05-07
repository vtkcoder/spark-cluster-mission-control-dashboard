import { spawn, ChildProcess } from "child_process";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CLAUDE_BIN = "/home/absolome/.npm-global/bin/claude";
const WORK_DIR = "/home/absolome/sites/cluster-dash";
const MAX_OUTPUT_CHARS = 80_000; // trim oldest output if it grows beyond this

// ── Persistent job state (module-level — PM2 keeps this process alive) ────────
interface AgentJob {
  id: string;
  task: string;
  status: "running" | "done" | "error";
  output: string;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  pid: number | null;
}

let currentJob: AgentJob | null = null;
let child: ChildProcess | null = null;

function appendOutput(text: string) {
  if (!currentJob) return;
  currentJob.output += text;
  if (currentJob.output.length > MAX_OUTPUT_CHARS) {
    currentJob.output =
      "[...older output trimmed...]\n" +
      currentJob.output.slice(-MAX_OUTPUT_CHARS + 500);
  }
}

// ── GET — return current job state ───────────────────────────────────────────
export async function GET() {
  return NextResponse.json(
    currentJob ?? { status: "idle", output: "", task: null, id: null }
  );
}

// ── POST — submit a new task ──────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  if (currentJob?.status === "running") {
    return NextResponse.json(
      { ok: false, error: "Agent is already running a task. Kill it first." },
      { status: 409 }
    );
  }

  const body = await req.json() as { task?: string };
  const task = body.task?.trim();
  if (!task) {
    return NextResponse.json({ ok: false, error: "task is required" }, { status: 400 });
  }

  const jobId = `job-${Date.now()}`;
  currentJob = {
    id: jobId,
    task,
    status: "running",
    output: "",
    exitCode: null,
    startedAt: Date.now(),
    finishedAt: null,
    pid: null,
  };

  appendOutput(`[AGENT STARTED — ${new Date().toISOString()}]\n`);
  appendOutput(`[TASK] ${task}\n`);
  appendOutput(`${"─".repeat(60)}\n\n`);

  try {
    child = spawn(
      CLAUDE_BIN,
      ["--dangerously-skip-permissions", "-p", task],
      {
        cwd: WORK_DIR,
        env: {
          ...process.env,
          HOME: "/home/absolome",
          PATH: `/home/absolome/.npm-global/bin:/home/absolome/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
          TERM: "xterm-256color",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    currentJob.pid = child.pid ?? null;

    child.stdout?.on("data", (chunk: Buffer) => {
      appendOutput(chunk.toString());
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      appendOutput(chunk.toString());
    });

    child.on("close", (code) => {
      if (!currentJob) return;
      currentJob.exitCode = code;
      currentJob.status = code === 0 ? "done" : "error";
      currentJob.finishedAt = Date.now();
      const elapsed = ((currentJob.finishedAt - currentJob.startedAt) / 1000).toFixed(1);
      appendOutput(`\n${"─".repeat(60)}\n`);
      appendOutput(`[AGENT ${currentJob.status.toUpperCase()} — exit ${code} — ${elapsed}s elapsed]\n`);
      child = null;
    });

    child.on("error", (err) => {
      if (!currentJob) return;
      currentJob.status = "error";
      currentJob.finishedAt = Date.now();
      appendOutput(`\n[SPAWN ERROR] ${err.message}\n`);
      child = null;
    });
  } catch (err: unknown) {
    currentJob.status = "error";
    currentJob.output += `\n[FATAL] ${(err as Error).message}\n`;
    child = null;
  }

  return NextResponse.json({ ok: true, jobId, pid: currentJob.pid });
}

// ── DELETE — kill running job ─────────────────────────────────────────────────
export async function DELETE() {
  if (!currentJob || currentJob.status !== "running") {
    return NextResponse.json({ ok: false, error: "No running job to kill" }, { status: 400 });
  }

  if (child) {
    try {
      process.kill(-(child.pid!), "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    child = null;
  }

  currentJob.status = "error";
  currentJob.finishedAt = Date.now();
  appendOutput("\n[KILLED BY USER]\n");

  return NextResponse.json({ ok: true });
}
