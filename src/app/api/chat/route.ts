import { NextRequest, NextResponse } from "next/server";
import { detectEngine } from "@/lib/engine";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      messages: unknown[];
      model: string;
      temperature?: number;
      max_tokens?: number;
      top_p?: number;
      extra_body?: Record<string, unknown>;
    };

    const payload = {
      model: body.model,
      messages: body.messages,
      temperature: body.temperature ?? 0.7,
      max_tokens: body.max_tokens ?? 4096,
      top_p: body.top_p ?? 1.0,
      stream: true,
      stream_options: { include_usage: true },
      ...(body.extra_body ?? {}),
    };

    const engine = await detectEngine();
    const port = engine.port || 11434;
    const upstream = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      return NextResponse.json({ error: err }, { status: upstream.status });
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
      },
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
