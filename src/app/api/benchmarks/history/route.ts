import { NextRequest, NextResponse } from "next/server";
import { listBenchRuns, getBenchRun, deleteBenchRun } from "@/lib/bench-db";
import { aggregateRows } from "@/lib/bench-run";

export const dynamic = "force-dynamic";

// GET            — list recent runs (summaries)
// GET ?id=<n>    — full detail for one run (config + result + aggregated rows)
export async function GET(req: NextRequest) {
  const idParam = req.nextUrl.searchParams.get("id");

  if (idParam) {
    const id = parseInt(idParam, 10);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
    }
    try {
      const run = await getBenchRun(id);
      if (!run) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
      return NextResponse.json({
        ok: true,
        run: {
          id: run.id,
          node: run.node,
          base_url: run.base_url,
          model: run.model,
          status: run.status,
          config: run.config,
          error: run.error,
          started_at: run.started_at,
          finished_at: run.finished_at,
          rows: aggregateRows(run.result),
          result: run.result,
        },
      });
    } catch (err: unknown) {
      return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
    }
  }

  try {
    const runs = await listBenchRuns(50);
    return NextResponse.json({ ok: true, runs });
  } catch (err: unknown) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}

// DELETE ?id=<n> — remove a run from history
export async function DELETE(req: NextRequest) {
  const idParam = req.nextUrl.searchParams.get("id");
  const id = parseInt(idParam ?? "", 10);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }
  try {
    const removed = await deleteBenchRun(id);
    return NextResponse.json({ ok: removed });
  } catch (err: unknown) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
