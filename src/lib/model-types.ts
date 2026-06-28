export type { Modality, Health, ScannedModel, ModelGroup } from "./model-scan";
export type { ModelMeta, ModelComment } from "./db";
import type { ScannedModel, ModelGroup } from "./model-scan";
import type { ModelMeta } from "./db";

export type ModelWithMeta = ScannedModel & { meta: ModelMeta | null };

export interface ModelsResponse {
  node: string;
  generatedAt: number;
  totalBytes: number;
  reclaimableBytes: number;
  servedModelId: string | null;
  models: ModelWithMeta[];
  groups: ModelGroup[];
}
