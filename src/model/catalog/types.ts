import type { ModelProtocol } from "../protocol/canonical.js";
import type { ModelCapabilities, ModelSpeed } from "../protocol/capabilities.js";
import type { MultimodalConstraints } from "../protocol/multimodal.js";

export type CatalogModelEntry = {
  displayName: string;
  capabilities: ModelCapabilities;
  multimodal: MultimodalConstraints;
  aliases?: string[];
  /** 速度档显式覆盖（缺省按 speedMapping 规则推断）。 */
  speed?: ModelSpeed;
};

export type CatalogProviderEntry = {
  displayName: string;
  protocol: ModelProtocol;
  defaultUrl: string;
  apiKeyEnvVar?: string;
  models: Record<string, CatalogModelEntry>;
};

export type ProviderCatalog = Record<string, CatalogProviderEntry>;
