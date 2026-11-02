import { NextRequest, NextResponse } from "next/server";
import { detectEngine, NODE_SSH_HOST, SPARK1_PM2, runRemote, spark1Cmd } from "@/lib/engine";

export const dynamic = "force-dynamic";

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[mGKHFJ]/g, "");
}

interface LogSource {
  id: string;
  label: string;
  icon: string;
  /** docker container name, or "pm2:<name>" for pm2 sources */
  target: string;
  type: "docker-ssh" | "docker-local" | "pm2";
  host?: string;
}

/**
 * The log sources follow the LIVE engine layout.
 *
 * They used to be a hardcoded list (vllm-mm on spark2, sglang on spark3, …)
 * that no longer exists: the cluster now runs `dsv41-head` on spark3 and
 * `dsv41-worker` on spark4/spark1/spark2, so every entry failed with
 * "No such container". Discovering them from detectEngine() keeps the tab
 * truthful about the four-node topology.
 */
async function buildSources(): Promise<LogSource[]> {
  const sources: LogSource[] = [];
  try {
    const engine = await detectEngine();
    const icon = engine.type === "sglang" ? "◆" : "▸";
    for (const c of engine.containers) {
      if (c.key === "webui") continue;
      const rank = c.rank ?? 0;
      const role = c.key === "head" ? `rank${rank} · head` : `rank${rank}`;
      sources.push({
        id: `engine-${c.key}`,
        label: `${engine.label} ${role} · ${c.node ?? "?"}`,
        icon,
        target: c.name,
        type: "docker-ssh",
        host: c.host,
      });
    }
  } catch {
    /* fall through to the static list below */
  }

  if (sources.length === 0) {
    // No engine detected — still offer the classic containers so the tab is
    // usable while a launch is in progress.
    sources.push(
      { id: "vllm-head", label: "vLLM head", icon: "▸", target: "vllm_node", type: "docker-ssh", host: NODE_SSH_HOST.spark2 },
      { id: "vllm-worker", label: "vLLM worker", icon: "▸", target: "vllm_node", type: "docker-ssh", host: NODE_SSH_HOST.spark3 },
    );
  }

  sources.push(
    { id: "open-webui", label: "Open WebUI", icon: "▸", target: "open-webui", type: "docker-local" },
    { id: "pm2-cluster-dash", label: "cluster-dash (pm2)", icon: "⬡", target: "pm2-cluster-dash", type: "pm2" },
  );
  return sources;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const requested = url.searchParams.get("source");
  const lines = Math.min(500, parseInt(url.searchParams.get("lines") ?? "80", 10));
  const sources = await buildSources();

  if (url.searchParams.get("list") === "1") {
    return NextResponse.json({
      sources: sources.map(({ id, label, icon }) => ({ id, label, icon })),
      ts: Date.now(),
    });
  }

  const source = requested ?? sources[0]?.id ?? "";
  const src = sources.find((s) => s.id === source);
  if (!src) {
    return NextResponse.json(
      { error: `Unknown log source "${source}"`, lines: [], source, ts: Date.now() },
      { status: 400 },
    );
  }

  try {
    let raw = "";
    if (src.type === "pm2") {
      const pm2Name = src.target.slice(4);
      const res = await runRemote(spark1Cmd(`${SPARK1_PM2} logs "${pm2Name}" --nostream --lines ${lines} 2>&1`), undefined, 8000);
      raw = res.ok ? res.stdout : "";
    } else if (src.type === "docker-local") {
      const res = await runRemote(spark1Cmd(`docker logs ${src.target} --tail ${lines} 2>&1`), undefined, 8000);
      raw = res.ok ? res.stdout + res.stderr : "";
    } else {
      const res = await runRemote(`docker logs ${src.target} --tail ${lines} 2>&1`, src.host, 12000);
      raw = res.ok ? res.stdout + res.stderr : "";
    }

    const logLines = stripAnsi(raw)
      .split("\n")
      .filter((l) => l.trim())
      .slice(-lines);

    return NextResponse.json({
      lines: logLines,
      source,
      error: logLines.length === 0 ? "no log output returned" : undefined,
      sources: sources.map(({ id, label, icon }) => ({ id, label, icon })),
      ts: Date.now(),
    });
  } catch (e: unknown) {
    // Short message only — never the full command line (it can carry paths and
    // arguments that do not belong in a browser-visible payload).
    const msg = (e as Error).message.split("\n")[0].slice(0, 200);
    return NextResponse.json({
      error: msg,
      lines: [],
      source,
      sources: sources.map(({ id, label, icon }) => ({ id, label, icon })),
      ts: Date.now(),
    });
  }
}
