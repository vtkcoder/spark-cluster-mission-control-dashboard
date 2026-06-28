import { NextRequest, NextResponse } from "next/server";
import { upsertMeta, addComment, getComments, getMetaMap } from "@/lib/db";

export const dynamic = "force-dynamic";
const NODE = "spark1";

const ALLOWED = ["display_name", "tags", "rating", "starred", "notes", "status"] as const;

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const [map, comments] = await Promise.all([getMetaMap(NODE), getComments(NODE, id)]);
  return NextResponse.json({ meta: map[id] ?? null, comments });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      modelId?: string;
      patch?: Record<string, unknown>;
      comment?: string;
    };
    if (!body.modelId) return NextResponse.json({ error: "modelId required" }, { status: 400 });

    if (body.patch) {
      const clean: Record<string, unknown> = {};
      for (const k of ALLOWED) if (k in body.patch) clean[k] = body.patch[k];
      if (Object.keys(clean).length) await upsertMeta(NODE, body.modelId, clean);
    }
    if (body.comment && body.comment.trim()) {
      await addComment(NODE, body.modelId, body.comment.trim());
    }

    const [map, comments] = await Promise.all([getMetaMap(NODE), getComments(NODE, body.modelId)]);
    return NextResponse.json({ ok: true, meta: map[body.modelId] ?? null, comments });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
