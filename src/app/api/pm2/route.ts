import { exec } from "child_process";
import { promisify } from "util";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const execAsync = promisify(exec);

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[mGKHF]/g, "");
}

export async function GET() {
  try {
    const { stdout } = await execAsync("pm2 jlist", { timeout: 5000 });
    const raw = JSON.parse(stdout) as Record<string, unknown>[];
    const procs = raw.map((p) => {
      const env = (p.pm2_env ?? {}) as Record<string, unknown>;
      const monit = (p.monit ?? {}) as Record<string, unknown>;
      const restarts = (env.restart_time ?? 0) as number;
      const uptime = env.pm_uptime as number | null;
      const uptimeSec = uptime ? Math.round((Date.now() - uptime) / 1000) : null;
      return {
        id: p.pm_id,
        name: env.name as string,
        status: env.status as string,
        cpu: monit.cpu as number ?? 0,
        memBytes: monit.memory as number ?? 0,
        uptimeSec,
        restarts,
        interpreter: (env.exec_interpreter as string ?? "").split("/").pop() ?? "",
        cwd: (env.pm_cwd as string ?? "").replace("/home/absolome/", "~/"),
      };
    });
    return NextResponse.json({ procs, ts: Date.now() });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { name, action } = await req.json() as { name: string; action: string };
    if (!name || !["start", "stop", "restart"].includes(action)) {
      return NextResponse.json({ ok: false, error: "Invalid params" }, { status: 400 });
    }
    const { stdout, stderr } = await execAsync(`pm2 ${action} "${name}" 2>&1`, { timeout: 10000 });
    const output = stripAnsi(stdout + stderr).trim();
    return NextResponse.json({ ok: true, output });
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
