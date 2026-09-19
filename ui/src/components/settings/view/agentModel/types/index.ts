import type { CatalogModel, CatalogProvider, CatalogProviderProtocol } from "../../../../../shared/catalogProviders";

/**
 * Which layer supplied a resolved limit — mirrors the engine's `ModelInfoSource`.
 *
 * `observed` / `probe` 来自引擎的窗口覆盖层（`~/.sati/model-windows.json`，
 * 见 `src/model/window/`）：observed 是真实超限报错反推的上限，probe 是
 * provider `/models` 返回的声明值。优先级：config > observed/probe > catalog > default。
 */
export type CapabilitySource = "config" | "observed" | "probe" | "catalog" | "default";

/** 覆盖层的一条窗口事实（引擎 `ModelWindowEntry` 的 UI 侧投影）。 */
export type ModelWindowOverrideEntry = {
  maxContextTokens?: number;
  maxOutputTokens?: number;
  source: "probe" | "observed";
  updatedAt?: string;
  via?: string;
};

/** 覆盖层整表，键为 `<provider>/<model>`。 */
export type ModelWindowOverrides = Record<string, ModelWindowOverrideEntry>;

/** A limit together with the layer it came from, so the settings page can label it. */
export type ResolvedLimit = {
  tokens: number;
  source: CapabilitySource;
};

export type ActiveModelCapabilities = {
  ref: string;
  providerId: string;
  modelId: string;
  catalogModel?: CatalogModel;
  catalogProvider?: CatalogProvider;
  /** Declared protocol, else the catalog provider's, else openai. */
  protocol: CatalogProviderProtocol;
  multimodalInput: string[] | null;
  maxOutputTokensOverride: number | undefined;
  maxContextTokensOverride: number | undefined;
  /**
   * What the engine will use when `agent.maxContextTokens` is empty: the model
   * declaration, else the catalog entry, else the protocol default.
   */
  effectiveContext: ResolvedLimit;
  /** Same resolution for `capabilities.maxOutputTokens` (no agent-level field exists). */
  effectiveOutput: ResolvedLimit;
  /**
   * 引擎覆盖层里该 provider/model 的条目（若有）。用于「探测到 X，可一键采纳」
   * ——采纳即写入 config 层，来源随之变为 `config`。
   */
  windowOverride?: ModelWindowOverrideEntry;
};
