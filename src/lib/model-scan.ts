// HF cache scanner for the Model Manager. Pure helpers + scanModels().
import { readdirSync, existsSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";

export const HF_CACHE = "/home/absolome/.cache/huggingface/hub";
// Flat-layout model root: dirs that hold config.json + *.safetensors directly
// (no HF models--/snapshots structure), e.g. ~/models/ornith/Ornith-1.0-397B-FP8.
export const MODELS_ROOT = "/home/absolome/models";
// LM Studio store: <publisher>/<repo>/*.gguf under here.
export const LMSTUDIO_ROOT = "/home/absolome/.lmstudio/models";

export type Modality = "text" | "vision" | "audio" | "image-gen" | "unknown";

export interface ConfigFiles {
  config?: Record<string, unknown> | null;
  generation?: Record<string, unknown> | null;
  preprocessor?: Record<string, unknown> | null;
  processor?: Record<string, unknown> | null;
  modelIndex?: Record<string, unknown> | null; // diffusers model_index.json
  nameHint?: string; // model short name, for quant inference
}

export interface ModelFacts {
  arch: string | null;
  modelType: string | null;
  contextLen: number | null;
  quant: string | null;
  dtype: string | null;
}

export function cacheKeyToModelId(cacheKey: string): string {
  const withoutPrefix = cacheKey.slice("models--".length);
  const idx = withoutPrefix.indexOf("--");
  if (idx === -1) return withoutPrefix;
  return withoutPrefix.slice(0, idx) + "/" + withoutPrefix.slice(idx + 2);
}

export function shortName(modelId: string): string {
  return modelId.split("/").pop() ?? modelId;
}

// Tokens stripped to collapse quant/variant siblings into one group key.
const VARIANT_TOKENS = [
  "NVFP4", "MXFP4", "FP8", "FP4", "BF16", "FP16", "INT8", "INT4", "AWQ", "GPTQ", "GGUF",
  "REAP", "GB10", "INSTRUCT", "CHAT", "BASE",
];

// Quant tokens recognized in GGUF filenames (LM Studio), e.g. Q4_K_M, IQ4_XS, MXFP4.
function parseGgufQuant(filename: string): string | null {
  const m = filename.match(/\b(IQ\d+[A-Z_]*|Q\d+_K_[MS]|Q\d+_K|Q\d+_\d+|Q\d+|MXFP4|BF16|F16|F32)\b/i);
  return m ? m[1].toUpperCase() : null;
}

// Parse a leading param-count tag from a model name, e.g. "70B" -> 70, "122B-A10B" -> 122.
function parseParamCountFromName(name: string): number | null {
  const m = name.match(/(\d+(?:\.\d+)?)B(?![a-z])/i);
  return m ? parseFloat(m[1]) : null;
}

export function normalizeBaseKey(modelId: string): string {
  let s = shortName(modelId).toUpperCase();
  // Drop date stamps like -2507 and param-size tags like -469B / -A22B / -A10B / -172B.
  s = s.replace(/-\d{3,4}(?=($|-))/g, "");           // 2507 date-ish
  s = s.replace(/-A?\d+(\.\d+)?B(?=($|-))/g, "");     // 235B, A22B, 172B, A10B
  for (const t of VARIANT_TOKENS) {
    s = s.replace(new RegExp(`-?${t}(?=($|-))`, "g"), "");
  }
  s = s.replace(/--+/g, "-").replace(/^-|-$/g, "");
  return s;
}

const QUANT_NAME_PATTERNS: [RegExp, string][] = [
  [/NVFP4/i, "NVFP4"],
  [/MXFP4/i, "MXFP4"],
  [/FP8/i, "FP8"],
  [/FP4/i, "FP4"],
  [/AWQ/i, "AWQ"],
  [/GPTQ/i, "GPTQ"],
  [/GGUF/i, "GGUF"],
];

export function classifyModality(c: ConfigFiles): Modality {
  if (c.modelIndex) return "image-gen";
  const mt = String((c.config?.model_type as string) ?? "").toLowerCase();
  const arch = ((c.config?.architectures as string[]) ?? []).join(" ").toLowerCase();
  if (mt.includes("whisper") || mt.includes("wav2vec") || arch.includes("whisper")) return "audio";
  if (
    c.preprocessor ||
    mt.includes("vl") || mt.includes("vision") || mt.includes("clip") ||
    arch.includes("vision") || arch.includes("vl")
  )
    return "vision";
  if (c.config) return "text";
  return "unknown";
}

export function parseFacts(c: ConfigFiles): ModelFacts {
  const cfg = c.config ?? {};
  const arch = Array.isArray(cfg.architectures) && cfg.architectures.length
    ? String((cfg.architectures as string[])[0])
    : null;
  const modelType = cfg.model_type ? String(cfg.model_type) : null;
  const contextLen =
    typeof cfg.max_position_embeddings === "number"
      ? (cfg.max_position_embeddings as number)
      : null;
  const dtype = cfg.torch_dtype ? String(cfg.torch_dtype) : null;

  let quant: string | null = null;
  const qc = cfg.quantization_config as Record<string, unknown> | undefined;
  if (qc?.quant_method) quant = String(qc.quant_method).toUpperCase();
  if (!quant && c.nameHint) {
    for (const [re, label] of QUANT_NAME_PATTERNS) if (re.test(c.nameHint)) { quant = label; break; }
  }
  return { arch, modelType, contextLen, quant, dtype };
}

export type Health = "ready" | "downloading" | "incomplete" | "stub" | "broken";

export interface ScannedModel {
  node: string;
  id: string;
  org: string;
  name: string;
  sizeBytes: number;
  modality: Modality;
  arch: string | null;
  modelType: string | null;
  paramCountB: number | null;
  quant: string | null;
  contextLen: number | null;
  dtype: string | null;
  health: Health;
  healthDetail: string;
  snapshotHash: string | null;
  mtime: number;
  groupKey: string;
  served: boolean;
  dir: string;                       // absolute path to the model directory
  source: "hf" | "flat" | "lmstudio"; // HF hub cache · flat-layout (~/models) · LM Studio GGUF
}

const STUB_MAX_BYTES = 50 * 1024 * 1024; // <50MB with a config = weights missing

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function resolveSnapshotDir(dir: string): { snapDir: string | null; hash: string | null } {
  const snapshotsRoot = join(dir, "snapshots");
  if (!existsSync(snapshotsRoot)) return { snapDir: null, hash: null };
  // Prefer the hash named in refs/main.
  const refPath = join(dir, "refs", "main");
  let hash: string | null = null;
  try {
    hash = readFileSync(refPath, "utf8").trim() || null;
  } catch { /* no ref */ }
  if (hash && existsSync(join(snapshotsRoot, hash))) return { snapDir: join(snapshotsRoot, hash), hash };
  // Fallback: newest snapshot subdir.
  try {
    const subs = readdirSync(snapshotsRoot)
      .map((s) => ({ s, t: statSync(join(snapshotsRoot, s)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (subs.length) return { snapDir: join(snapshotsRoot, subs[0].s), hash: subs[0].s };
  } catch { /* none */ }
  return { snapDir: null, hash };
}

function dirBytes(path: string): number {
  try {
    const out = execSync(`du -sb '${path}' 2>/dev/null`, { timeout: 30000 }).toString();
    return parseInt(out.split("\t")[0]) || 0;
  } catch {
    return 0;
  }
}

function blobHealth(dir: string): { incomplete: number; complete: number } {
  const blobsDir = join(dir, "blobs");
  if (!existsSync(blobsDir)) return { incomplete: 0, complete: 0 };
  let incomplete = 0, complete = 0;
  for (const f of readdirSync(blobsDir)) {
    if (f.endsWith(".incomplete")) {
      try { if (statSync(join(blobsDir, f)).size > 0) incomplete++; } catch { /* skip */ }
    } else complete++;
  }
  return { incomplete, complete };
}

export function scanModels(cacheRoot: string = HF_CACHE, node = "spark1"): ScannedModel[] {
  let dirs: string[] = [];
  try {
    dirs = readdirSync(cacheRoot).filter((d) => d.startsWith("models--"));
  } catch {
    return [];
  }

  return dirs.map((cacheKey) => {
    const id = cacheKeyToModelId(cacheKey);
    const dir = join(cacheRoot, cacheKey);
    const name = shortName(id);
    const org = id.includes("/") ? id.split("/")[0] : "";
    const { snapDir, hash } = resolveSnapshotDir(dir);

    const cfgFiles: ConfigFiles = { nameHint: name };
    if (snapDir) {
      cfgFiles.config = readJson(join(snapDir, "config.json"));
      cfgFiles.generation = readJson(join(snapDir, "generation_config.json"));
      cfgFiles.preprocessor = readJson(join(snapDir, "preprocessor_config.json"));
      cfgFiles.processor = readJson(join(snapDir, "processor_config.json"));
      cfgFiles.modelIndex = readJson(join(snapDir, "model_index.json"));
    }

    const facts = parseFacts(cfgFiles);
    const modality = classifyModality(cfgFiles);
    const sizeBytes = dirBytes(dir);
    const { incomplete, complete } = blobHealth(dir);
    const hasConfig = !!cfgFiles.config || !!cfgFiles.modelIndex;

    let health: Health;
    let healthDetail: string;
    if (incomplete > 0) {
      health = "downloading";
      healthDetail = `${incomplete} blob(s) still downloading`;
    } else if (hasConfig && sizeBytes < STUB_MAX_BYTES) {
      health = "stub";
      healthDetail = "config present but weights missing";
    } else if (complete === 0 && !hasConfig) {
      health = "incomplete";
      healthDetail = "no complete blobs and no config";
    } else if (!snapDir) {
      health = "broken";
      healthDetail = "no resolvable snapshot";
    } else {
      health = "ready";
      healthDetail = "complete";
    }

    let mtime = 0;
    try { mtime = statSync(dir).mtimeMs; } catch { /* keep 0 */ }

    // Approx param count (billions) from total size: bytes/bytesPerParam.
    // FP8/FP4≈1 byte, BF16≈2. Heuristic only; null when size unknown.
    let paramCountB: number | null = null;
    if (sizeBytes > 0 && health === "ready") {
      const bpp = facts.quant && /FP4|NVFP4|MXFP4/.test(facts.quant) ? 0.5
        : facts.quant === "FP8" ? 1
        : facts.dtype && /16/.test(facts.dtype) ? 2 : 1;
      paramCountB = Math.round((sizeBytes / bpp / 1e9) * 10) / 10;
    }

    return {
      node, id, org, name, sizeBytes, modality,
      arch: facts.arch, modelType: facts.modelType, paramCountB,
      quant: facts.quant, contextLen: facts.contextLen, dtype: facts.dtype,
      health, healthDetail, snapshotHash: hash, mtime,
      groupKey: normalizeBaseKey(id), served: false,
      dir, source: "hf",
    };
  });
}

export interface ModelGroup {
  key: string;
  members: ScannedModel[];
  totalBytes: number;
  redundantBytes: number;
  unique: boolean;
}

export function groupDuplicates(models: ScannedModel[]): ModelGroup[] {
  const byKey = new Map<string, ScannedModel[]>();
  for (const m of models) {
    const arr = byKey.get(m.groupKey) ?? [];
    arr.push(m);
    byKey.set(m.groupKey, arr);
  }
  const groups: ModelGroup[] = [];
  for (const [key, members] of byKey) {
    const totalBytes = members.reduce((s, m) => s + m.sizeBytes, 0);
    const largest = members.reduce((mx, m) => Math.max(mx, m.sizeBytes), 0);
    groups.push({
      key, members,
      totalBytes,
      redundantBytes: members.length > 1 ? totalBytes - largest : 0,
      unique: members.length === 1,
    });
  }
  return groups.sort((a, b) => b.totalBytes - a.totalBytes);
}

export function modelIdToCacheKey(modelId: string): string {
  return "models--" + modelId.replace("/", "--");
}

export function resolveModelDir(modelId: string, cacheRoot: string = HF_CACHE): string {
  return join(cacheRoot, modelIdToCacheKey(modelId));
}

// True only if absPath is a legitimate model directory under one of the allowed
// roots and contains no shell metacharacters/wildcards. Defends rm -rf against
// traversal/injection. Rules per root:
//   • HF cache  → must be a direct `models--*` child (single segment).
//   • flat root → must be a nested dir at least one segment below the root.
// `cacheRoot` is kept for back-compat (callers/tests pass the HF cache root);
// MODELS_ROOT is always additionally allowed.
export function validateDeletePath(absPath: string, cacheRoot: string = HF_CACHE): boolean {
  if (/[*?;&|`$(){}<>\n\\]/.test(absPath)) return false;
  const resolved = resolve(absPath);
  const hfRoot = resolve(cacheRoot);
  const flatRoot = resolve(MODELS_ROOT);

  // HF cache: direct models-- child only.
  if (resolved.startsWith(hfRoot + "/")) {
    const rest = resolved.slice(hfRoot.length + 1);
    if (rest.includes("/")) return false;
    return rest.startsWith("models--");
  }
  // Flat-style roots (~/models, LM Studio): any directory strictly below the
  // root (depth >= 1), never the root itself.
  for (const fr of [flatRoot, resolve(LMSTUDIO_ROOT)]) {
    if (resolved.startsWith(fr + "/")) {
      const rest = resolved.slice(fr.length + 1);
      return rest.length > 0;
    }
  }
  return false;
}

// ── Flat-layout scanning (~/models) ───────────────────────────────────────────
// Recursively find directories that directly contain config.json or *.safetensors
// (a "flat" model). Does not descend into a model dir once matched (so subfolders
// like assets/ aren't treated as separate models).
function findModelDirsBy(root: string, isModel: (entries: string[]) => boolean, maxDepth = 3): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    if (isModel(entries)) { out.push(d); return; } // matched — don't recurse inside a model
    if (depth >= maxDepth) return;
    for (const e of entries) {
      const p = join(d, e);
      try { if (statSync(p).isDirectory()) walk(p, depth + 1); } catch { /* skip */ }
    }
  };
  walk(root, 0);
  return out;
}

function findFlatModelDirs(root: string, maxDepth = 3): string[] {
  return findModelDirsBy(
    root,
    (entries) => entries.some((f) => f === "config.json" || f.endsWith(".safetensors") || f.endsWith(".safetensors.incomplete")),
    maxDepth,
  );
}

function flatBlobHealth(dir: string): { incomplete: number; weights: number } {
  let incomplete = 0, weights = 0;
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return { incomplete: 0, weights: 0 }; }
  for (const f of entries) {
    if (f.endsWith(".incomplete")) {
      try { if (statSync(join(dir, f)).size > 0) incomplete++; } catch { /* skip */ }
    } else if (f.endsWith(".safetensors") || f.endsWith(".bin") || f.endsWith(".gguf")) weights++;
  }
  return { incomplete, weights };
}

export function scanFlatModels(root: string = MODELS_ROOT, node = "spark1"): ScannedModel[] {
  return findFlatModelDirs(root).map((dir) => {
    const id = dir.slice(resolve(root).length + 1) || dir.split("/").pop() || dir;
    const name = id.split("/").pop() ?? id;
    const org = id.includes("/") ? id.split("/")[0] : "";

    const cfgFiles: ConfigFiles = { nameHint: name };
    cfgFiles.config = readJson(join(dir, "config.json"));
    cfgFiles.generation = readJson(join(dir, "generation_config.json"));
    cfgFiles.preprocessor = readJson(join(dir, "preprocessor_config.json"));
    cfgFiles.processor = readJson(join(dir, "processor_config.json"));
    cfgFiles.modelIndex = readJson(join(dir, "model_index.json"));

    const facts = parseFacts(cfgFiles);
    const modality = classifyModality(cfgFiles);
    const sizeBytes = dirBytes(dir);
    const { incomplete, weights } = flatBlobHealth(dir);
    const hasConfig = !!cfgFiles.config || !!cfgFiles.modelIndex;

    let health: Health;
    let healthDetail: string;
    if (incomplete > 0) {
      health = "downloading";
      healthDetail = `${incomplete} shard(s) still downloading`;
    } else if (hasConfig && sizeBytes < STUB_MAX_BYTES) {
      health = "stub";
      healthDetail = "config present but weights missing";
    } else if (weights === 0) {
      health = "incomplete";
      healthDetail = "no weight files present";
    } else {
      health = "ready";
      healthDetail = "complete";
    }

    let mtime = 0;
    try { mtime = statSync(dir).mtimeMs; } catch { /* keep 0 */ }

    let paramCountB: number | null = null;
    if (sizeBytes > 0 && health === "ready") {
      const bpp = facts.quant && /FP4|NVFP4|MXFP4/.test(facts.quant) ? 0.5
        : facts.quant === "FP8" ? 1
        : facts.dtype && /16/.test(facts.dtype) ? 2 : 1;
      paramCountB = Math.round((sizeBytes / bpp / 1e9) * 10) / 10;
    }

    return {
      node, id, org, name, sizeBytes, modality,
      arch: facts.arch, modelType: facts.modelType, paramCountB,
      quant: facts.quant, contextLen: facts.contextLen, dtype: facts.dtype,
      health, healthDetail, snapshotHash: null, mtime,
      groupKey: normalizeBaseKey(id), served: false,
      dir, source: "flat",
    };
  });
}

// ── LM Studio (GGUF) scanning ─────────────────────────────────────────────────
// A model = a dir directly containing *.gguf files (LM Studio's publisher/repo
// layout). GGUF has no config.json, so facts are best-effort from filenames.
export function scanLmStudioModels(root: string = LMSTUDIO_ROOT, node = "spark1"): ScannedModel[] {
  const dirs = findModelDirsBy(root, (entries) => entries.some((f) => f.endsWith(".gguf") || f.endsWith(".gguf.part") || f.endsWith(".gguf.download")));
  return dirs.map((dir) => {
    const id = dir.slice(resolve(root).length + 1) || dir.split("/").pop() || dir;
    const name = id.split("/").pop() ?? id;
    const org = id.includes("/") ? id.split("/")[0] : "";

    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { /* unreadable */ }
    const ggufs = entries.filter((f) => f.endsWith(".gguf"));
    const partials = entries.filter((f) => f.endsWith(".part") || f.endsWith(".download") || f.endsWith(".incomplete"));
    const mmproj = ggufs.some((f) => f.toLowerCase().startsWith("mmproj"));
    const primary = ggufs.find((f) => !f.toLowerCase().startsWith("mmproj")) ?? ggufs[0] ?? "";

    const sizeBytes = dirBytes(dir);
    let health: Health;
    let healthDetail: string;
    if (partials.length > 0) { health = "downloading"; healthDetail = `${partials.length} partial file(s)`; }
    else if (ggufs.length === 0) { health = "incomplete"; healthDetail = "no .gguf files"; }
    else { health = "ready"; healthDetail = "complete"; }

    let mtime = 0;
    try { mtime = statSync(dir).mtimeMs; } catch { /* keep 0 */ }

    return {
      node, id, org, name, sizeBytes,
      modality: mmproj ? "vision" : "text",
      arch: null, modelType: "gguf", paramCountB: parseParamCountFromName(name),
      quant: parseGgufQuant(primary), contextLen: null, dtype: null,
      health, healthDetail, snapshotHash: null, mtime,
      groupKey: normalizeBaseKey(id), served: false,
      dir, source: "lmstudio",
    };
  });
}

// Combined scan across the HF cache, the flat-layout root, and LM Studio.
export function scanAllModels(node = "spark1"): ScannedModel[] {
  return [
    ...scanModels(HF_CACHE, node),
    ...scanFlatModels(MODELS_ROOT, node),
    ...scanLmStudioModels(LMSTUDIO_ROOT, node),
  ];
}

// Resolve a model id (from either layout) to its absolute dir, via a fresh scan.
// Returns null if no model with that id exists — callers must treat that as 404.
export function findModelDir(node: string, id: string): string | null {
  const m = scanAllModels(node).find((x) => x.id === id);
  return m?.dir ?? null;
}

// Filesystem-safe folder name for a model id (used for backup destination dirs).
export function idToSafeName(id: string): string {
  return id.replace(/\//g, "--");
}
