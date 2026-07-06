import { NextResponse } from "next/server";
import { scanAllModels, groupDuplicates } from "@/lib/model-scan";
import { getMetaMap, type ModelMeta } from "@/lib/db";
import { detectEngine, getEngineModels } from "@/lib/engine";
import type { ModelsResponse, ModelWithMeta } from "@/lib/model-types";

export const dynamic = "force-dynamic";
const NODE = "spark1";

export async function GET() {
  try {
    // Filesystem scan + DB meta + live served-model detection, in parallel where possible.
    const models = scanAllModels(NODE);
    const [metaMap, served] = await Promise.all([
      getMetaMap(NODE).catch(() => ({} as Record<string, ModelMeta>)), // DB optional: scan still works without it
      detectServed().catch(() => null),
    ]);

    for (const m of models) {
      if (served && (m.id === served || m.name === served.split("/").pop())) m.served = true;
    }

    const withMeta: ModelWithMeta[] = models
      .map((m) => ({ ...m, meta: metaMap[m.id] ?? null }))
      .sort((a, b) => b.sizeBytes - a.sizeBytes);

    const groups = groupDuplicates(models);
    const totalBytes = models.reduce((s, m) => s + m.sizeBytes, 0);
    const reclaimableBytes =
      groups.reduce((s, g) => s + g.redundantBytes, 0) +
      models.filter((m) => m.health === "stub" || m.health === "broken").reduce((s, m) => s + m.sizeBytes, 0);

    const body: ModelsResponse = {
      node: NODE, generatedAt: Date.now(),
      totalBytes, reclaimableBytes, servedModelId: served,
      models: withMeta, groups,
    };
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

async function detectServed(): Promise<string | null> {
  const eng = await detectEngine();
  if (eng.type === "none") return null;
  const m = await getEngineModels(eng.apiHost, eng.port);
  return m?.model ?? null;
}
