import { execSync } from "child_process";
import { shortName } from "./model-scan";
import { detectEngine, getEngineModels } from "./engine";

export interface UsageHit {
  source: "engine" | "script" | "config";
  path: string;
  line: number | null;
  excerpt: string;
}
export interface UsageReport {
  modelId: string;
  hits: UsageHit[];
  truncated: boolean;
}

const SCRIPT_ROOTS = ["/home/absolome/research"];
const CONFIG_ROOTS = ["/home/absolome/sites"];
// Generous cap purely to keep the response/UI snappy — reported via `truncated`.
const MAX_HITS_PER_SOURCE = 200;

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

export function grepHits(
  term: string,
  roots: string[],
  source: UsageHit["source"],
  opts: { max: number },
): UsageHit[] {
  const existing = roots.filter((r) => {
    try { execSync(`test -d '${shellEscape(r)}'`); return true; } catch { return false; }
  });
  if (!existing.length) return [];
  const excludes = [
    "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=.next",
    "--exclude-dir=.cache", "--exclude-dir=dist", "--exclude-dir=build",
  ].join(" ");
  // -R recursive, -n line numbers, -I skip binary, -F fixed string.
  const cmd =
    `grep -RnI -F ${excludes} -- '${shellEscape(term)}' ` +
    existing.map((r) => `'${shellEscape(r)}'`).join(" ") +
    ` 2>/dev/null | head -n ${opts.max + 1} || true`;
  let out = "";
  try { out = execSync(cmd, { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }).toString(); } catch { return []; }
  const lines = out.split("\n").filter(Boolean);
  return lines.slice(0, opts.max).map((l) => {
    // format: path:lineno:content
    const first = l.indexOf(":");
    const second = l.indexOf(":", first + 1);
    const path = l.slice(0, first);
    const lineNo = parseInt(l.slice(first + 1, second));
    const excerpt = l.slice(second + 1).trim().slice(0, 240);
    return { source, path, line: isNaN(lineNo) ? null : lineNo, excerpt };
  });
}

export async function investigateUsage(modelId: string, _node = "spark1"): Promise<UsageReport> {
  const name = shortName(modelId);
  const hits: UsageHit[] = [];
  let truncated = false;

  // 1) Live engine
  try {
    const eng = await detectEngine();
    if (eng.type !== "none") {
      const served = await getEngineModels(eng.apiHost, eng.port);
      if (served && (served.model === modelId || served.model.split("/").pop() === name)) {
        hits.push({
          source: "engine",
          path: `${eng.label} @ ${eng.apiHost}:${eng.port}`,
          line: null,
          excerpt: `Currently served by the live ${eng.label} cluster (${eng.parallel})`,
        });
      }
    }
  } catch { /* engine optional */ }

  // 2) Launch scripts + 3) project configs. Search id and short name, dedupe.
  const terms = Array.from(new Set([modelId, name]));
  const collect = (roots: string[], source: UsageHit["source"]) => {
    const seen = new Set<string>();
    for (const t of terms) {
      const found = grepHits(t, roots, source, { max: MAX_HITS_PER_SOURCE });
      if (found.length >= MAX_HITS_PER_SOURCE) truncated = true;
      for (const h of found) {
        const k = `${h.path}:${h.line}`;
        if (!seen.has(k)) { seen.add(k); hits.push(h); }
      }
    }
  };
  collect(SCRIPT_ROOTS, "script");
  collect(CONFIG_ROOTS, "config");

  return { modelId, hits, truncated };
}
