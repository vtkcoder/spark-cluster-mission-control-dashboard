import { NextRequest, NextResponse } from "next/server";
import { detectTargets, startBackup, getBackupStatus } from "@/lib/model-backup";

export const dynamic = "force-dynamic";

export async function GET() {
  const targets = await detectTargets();
  return NextResponse.json({ targets, job: getBackupStatus() });
}

export async function POST(req: NextRequest) {
  try {
    const { modelId, target } = (await req.json()) as { modelId?: string; target?: string };
    if (!modelId || !target) return NextResponse.json({ error: "modelId and target required" }, { status: 400 });
    const r = startBackup(modelId, target);
    if (r.error) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ ok: true, job: getBackupStatus() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
