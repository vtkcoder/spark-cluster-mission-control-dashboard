import { spawn, ChildProcess } from "child_process";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CLAUDE_BIN = "/home/absolome/.npm-global/bin/claude";
const WORK_DIR = "/home/absolome/sites/cluster-dash";
const MAX_LOG_CHARS = 120_000;

// ── Persistent job state (module-level — PM2 keeps this process alive) ────────
interface AgentJob {
  id: string;
  task: string;
  status: "running" | "done" | "error";
  agentLog: string;    // tool calls, tool results, assistant work events
  response: string;    // clean final response from result event
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  pid: number | null;
}

let currentJob: AgentJob | null = null;
let child: ChildProcess | null = null;
let lineBuffer = "";

function appendLog(text: string) {
  if (!currentJob) return;
  currentJob.agentLog += text;
  if (currentJob.agentLog.length > MAX_LOG_CHARS) {
    currentJob.agentLog =
      "[...older log trimmed...]\n" +
      currentJob.agentLog.slice(-MAX_LOG_CHARS + 500);
  }
}

// Parse a stream-json line and route it to agentLog or response
function handleJsonLine(line: string) {
  if (!currentJob || !line.trim()) return;
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(line) as Record<string, unknown>;
  } catch {
    // Not JSON (e.g. progress dots) — dump to log
    appendLog(line + "\n");
    return;
  }

  const type = evt.type as string;

  if (type === "result") {
    // Final response — store clean and also log it
    const text = (evt.result as string | undefined) ?? "";
    currentJob.response = text;
    appendLog(`\n[RESULT]\n${text}\n`);
    return;
  }

  if (type === "assistant") {
    const msg = evt.message as { content?: unknown[] } | undefined;
    const content = msg?.content ?? [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text") {
        appendLog(`[thinking] ${b.text as string}\n`);
      } else if (b.type === "tool_use") {
        const input = JSON.stringify(b.input ?? {});
        appendLog(`[tool:${b.name as string}] ${input.slice(0, 300)}${input.length > 300 ? "…" : ""}\n`);
      }
    }
    return;
  }

  if (type === "user") {
    const msg = evt.message as { content?: unknown[] } | undefined;
    const content = msg?.content ?? [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "tool_result") {
        const inner = b.content;
        let text = "";
        if (typeof inner === "string") {
          text = inner;
        } else if (Array.isArray(inner)) {
          text = (inner as Array<Record<string, unknown>>)
            .filter((x) => x.type === "text")
            .map((x) => x.text as string)
            .join("\n");
        }
        if (text) {
          const preview = text.slice(0, 400);
          appendLog(`[result] ${preview}${text.length > 400 ? `…(+${text.length - 400} chars)` : ""}\n`);
        }
      }
    }
    return;
  }

  // system, init, etc. — just note the type
  appendLog(`[${type}]\n`);
}

// ── GET — return current job state ───────────────────────────────────────────
export async function GET() {
  return NextResponse.json(
    currentJob ?? { status: "idle", agentLog: "", response: "", task: null, id: null }
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
  lineBuffer = "";
  currentJob = {
    id: jobId,
    task,
    status: "running",
    agentLog: `[AGENT STARTED — ${new Date().toISOString()}]\n[TASK] ${task}\n${"─".repeat(60)}\n\n`,
    response: "",
    exitCode: null,
    startedAt: Date.now(),
    finishedAt: null,
    pid: null,
  };

  try {
    child = spawn(
      CLAUDE_BIN,
      ["--dangerously-skip-permissions", "--output-format", "stream-json", "-p", task],
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
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) handleJsonLine(line);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      appendLog(`[stderr] ${chunk.toString()}`);
    });

    child.on("close", (code) => {
      if (!currentJob) return;
      // Flush any remaining buffer
      if (lineBuffer.trim()) { handleJsonLine(lineBuffer); lineBuffer = ""; }
      currentJob.exitCode = code;
      currentJob.status = code === 0 ? "done" : "error";
      currentJob.finishedAt = Date.now();
      const elapsed = ((currentJob.finishedAt - currentJob.startedAt) / 1000).toFixed(1);
      appendLog(`\n${"─".repeat(60)}\n[AGENT ${currentJob.status.toUpperCase()} — exit ${code} — ${elapsed}s]\n`);
      child = null;
    });

    child.on("error", (err) => {
      if (!currentJob) return;
      currentJob.status = "error";
      currentJob.finishedAt = Date.now();
      appendLog(`\n[SPAWN ERROR] ${err.message}\n`);
      child = null;
    });
  } catch (err: unknown) {
    currentJob.status = "error";
    currentJob.agentLog += `\n[FATAL] ${(err as Error).message}\n`;
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
  appendLog("\n[KILLED BY USER]\n");

  return NextResponse.json({ ok: true });
}
