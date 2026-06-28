// HF cache scanner for the Model Manager. Pure helpers + scanModels() (Task 4).
export const HF_CACHE = "/home/absolome/.cache/huggingface/hub";

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
