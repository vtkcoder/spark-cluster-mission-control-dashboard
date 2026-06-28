import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { findModelDir, validateDeletePath, shortName } from "@/lib/model-scan";
import { detectEngine, getEngineModels, HEAD_HOST, API_PORT } from "@/lib/engine";
import { logEvent, updateEvent } from "@/lib/db";
import { backupInFlightFor } from "@/lib/model-backup";

export const dynamic = "force-dynamic";
const NODE = "spark1";
const execAsync = promisify(exec);

export async function POST(req: NextRequest) {
  let eventId: number | null = null;
  try {
    const { modelId, confirm } = (await req.json()) as { modelId?: string; confirm?: string };
    if (!modelId) return NextResponse.json({ error: "modelId required" }, { status: 400 });

    const name = shortName(modelId);
    // 1) Typed-name confirmation
    if (confirm !== name) {
      return NextResponse.json({ error: `Type the model name "${name}" to confirm deletion` }, { status: 400 });
    }
    // 2) Served guard
    try {
      const eng = await detectEngine();
      if (eng.type !== "none") {
        const served = await getEngineModels(HEAD_HOST, API_PORT);
        if (served && (served.model === modelId || served.model.split("/").pop() === name)) {
          return NextResponse.json({ error: "Refusing: this model is currently being served. Stop the engine first." }, { status: 409 });
        }
      }
    } catch { /* engine unreachable: allow */ }
    // 3) Backup-lock guard
    if (backupInFlightFor(modelId)) {
      return NextResponse.json({ error: "Refusing: a backup of this model is in progress." }, { status: 409 });
    }
    // 4) Resolve the real dir from a scan (works for HF + flat layouts), then path safety
    const dir = findModelDir(NODE, modelId);
    if (!dir) return NextResponse.json({ error: "Model dir not found." }, { status: 404 });
    if (!validateDeletePath(dir)) {
      return NextResponse.json({ error: "Unsafe path; aborting." }, { status: 400 });
    }
    if (!existsSync(dir)) return NextResponse.json({ error: "Model dir not found." }, { status: 404 });

    // 5) Measure, log, delete, confirm.
    let sizeBytes = 0;
    try {
      const { stdout } = await execAsync(`du -sb '${dir}' 2>/dev/null`, { timeout: 30000 });
      sizeBytes = parseInt(stdout.split("\t")[0]) || 0;
    } catch { /* size best-effort */ }

    eventId = await logEvent(NODE, modelId, "delete", "started", { path: dir, sizeBytes });
    await execAsync(`rm -rf '${dir}'`, { timeout: 120000 });
    if (existsSync(dir)) throw new Error("Directory still present after rm");
    await updateEvent(eventId, "success", { path: dir, freedBytes: sizeBytes });

    return NextResponse.json({ ok: true, freedBytes: sizeBytes });
  } catch (e) {
    if (eventId !== null) await updateEvent(eventId, "failed", { error: (e as Error).message }).catch(() => {});
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
