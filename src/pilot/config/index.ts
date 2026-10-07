export { loadPilotConfig, parseAgentThinking } from "./loadPilotConfig.js";
export { type PilotConfigListener, type PilotConfigStore } from "./PilotConfigStore.js";
export { classifyConfigChanges, diffConfigSnapshots } from "./classifyChanges.js";
export { mergeConfigSources } from "./merge.js";
export { redactConfig } from "./redact.js";
export { parseAdaptersConfig, parseGatewayConfig } from "./parseGatewayConfig.js";
export {
  SERPAPI_ENGINES,
  WEB_SEARCH_DOCS,
  WEB_SEARCH_ENDPOINTS,
  WEB_SEARCH_PROVIDERS,
  isSerpApiEngine,
  isWebSearchProvider,
  type SerpApiEngine,
  type WebSearchProvider,
} from "./webSearchProviders.js";
// 设置页的连通性探测（ui/server/routes/config.js）复用同一套请求形状与结果归一化，
// 故经 barrel 暴露；ui/server 只能经 `src/pilot/index.js` 访问 src（见
// scripts/check-ui-server-boundary.mjs 白名单）。
export {
  additionalSearchRequest,
  additionalSearchResults,
  isAdditionalSearchProvider,
  redactSearchError,
  type AdditionalSearchProvider,
  type WebSearchOrganicResult,
} from "./webSearchAdapter.js";
export {
  PilotConfigError,
  type PilotAgentConfig,
  type PilotAgentModelSelection,
  type PilotConfig,
  type PilotConfigChangeClass,
  type PilotConfigDiagnostic,
  type PilotExtensionConfig,
  type PilotConfigLoadOptions,
  type PilotConfigReloadEvent,
  type PilotConfigSnapshot,
  type PilotConfigSource,
  type PilotRawConfig,
  type PilotAdaptersConfig,
  type PilotGatewayConfig,
  type PilotProxyConfig,
  type PilotToolsConfig,
  type PilotWebSearchConfig,
} from "./types.js";
