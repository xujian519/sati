/**
 * 模型窗口覆盖层（issue #449）：探测抽取 + 持久层 + 解析优先级。
 *
 * 解析优先级（`parseCapabilities` 接线后）：
 *   config 显式声明 > observed（超限实测）> probe（/models 探测）> catalog > 协议默认
 */
export { extractModelWindows, type ModelWindowProbeHit } from "./extract.js";
export {
  buildModelWindowProbeHeaders,
  isModelWindowProbeEnabled,
  MODEL_WINDOW_PROBE_ENV,
  MODEL_WINDOW_PROBE_TIMEOUT_MS,
  probeAndRecordProviderModelWindows,
  probeProviderModelWindows,
  type ModelWindowProbeInput,
  type ProbeAndRecordResult,
  type WarmModelWindowProbesInput,
  warmModelWindowProbes,
} from "./probe.js";
export {
  defaultModelWindowStorePath,
  mergeModelWindowEntry,
  MODEL_WINDOW_STORE_FILENAME,
  ModelWindowStore,
  modelWindowKey,
  parseModelWindowFile,
} from "./store.js";
export {
  isPlausibleWindowTokens,
  MODEL_WINDOW_MAX_TOKENS,
  MODEL_WINDOW_MIN_TOKENS,
  MODEL_WINDOW_STORE_VERSION,
  type ModelWindowEntry,
  type ModelWindowFile,
  type ModelWindowSource,
} from "./types.js";
