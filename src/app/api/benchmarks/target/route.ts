import { NextResponse } from "next/server";
import { detectEngine, getEngineModels } from "@/lib/engine";

export const dynamic = "force-dynamic";

// GET — the default benchmark target derived from the live engine.
// Returns a baseUrl (with /v1 suffix) + model the UI pre-fills. The operator
// can override any of it in the form.
export async function GET() {
  try {
    const engine = await detectEngine();
    if (engine.type === "none" || !engine.port) {
      return NextResponse.json({
        online: false,
        baseUrl: "",
        model: "",
        engineLabel: engine.label,
        topology: engine.topology,
      });
    }

    const model = await getEngineModels(engine.apiHost, engine.port);
    return NextResponse.json({
      online: true,
      baseUrl: `http://${engine.apiHost}:${engine.port}/v1`,
      model: model?.model ?? "",
      maxModelLen: model?.maxModelLen ?? null,
      engineLabel: engine.label,
      topology: engine.topology,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { online: false, baseUrl: "", model: "", error: (err as Error).message },
      { status: 200 },
    );
  }
}
