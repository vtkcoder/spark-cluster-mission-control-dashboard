import { exec } from "child_process";
import { promisify } from "util";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const execAsync = promisify(exec);

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[mGKHFJ]/g, "");
}

const SOURCES: Record<string, { type: "docker-local" | "docker-remote" | "pm2"; target: string }> = {
  "vllm-head":   { type: "docker-local",  target: "vllm-head"  },
  "vllm-worker": { type: "docker-remote", target: "vllm-worker" },
  "open-webui":  { type: "docker-local",  target: "open-webui" },
};

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const source = url.searchParams.get("source") ?? "vllm-head";
  const lines = Math.min(500, parseInt(url.searchParams.get("lines") ?? "80", 10));

  // Dynamic pm2 source: pm2-<name>
  const isPm2 = source.startsWith("pm2-");
  const pm2Name = isPm2 ? source.slice(4) : null;

  try {
    let raw = "";
    if (isPm2 && pm2Name) {
      const { stdout } = await execAsync(`pm2 logs "${pm2Name}" --nostream --lines ${lines} 2>&1`, { timeout: 8000 });
      raw = stdout;
    } else {
      const src = SOURCES[source];
      if (!src) return NextResponse.json({ error: "Unknown source" }, { status: 400 });
      if (src.type === "docker-local") {
        const { stdout, stderr } = await execAsync(
          `docker logs ${src.target} --tail ${lines} 2>&1`,
          { timeout: 8000 }
        );
        raw = stdout + stderr;
      } else {
        const { stdout, stderr } = await execAsync(
          `ssh -o ConnectTimeout=5 -o BatchMode=yes spark2 "docker logs ${src.target} --tail ${lines} 2>&1"`,
          { timeout: 12000 }
        );
        raw = stdout + stderr;
      }
    }

    const logLines = stripAnsi(raw)
      .split("\n")
      .filter((l) => l.trim())
      .slice(-lines);

    return NextResponse.json({ lines: logLines, source, ts: Date.now() });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message, lines: [], source, ts: Date.now() });
  }
}
