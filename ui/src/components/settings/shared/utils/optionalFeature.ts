/**
 * 可选功能的「是否启用」判定（UI 侧，与后端 `src/pilot/config/optionalFeature.ts` 同语义，
 * 上游 #588 移植）。
 *
 * 三态语义：
 * - **段缺失 → 关**（未配置即未启用）；
 * - **段存在但无 `enabled` → 开**（遗留配置的 opt-in 含义）；
 * - **显式 `true` / `false` → 永远优先**。
 *
 * 面板与运行期必须用同一判据，否则会出现「面板显示开、实际关」。这里不直接 import
 * `src/` 的同一函数：`ui/` 与后端只经 gateway API 通信，不跨层引源码。
 */
export function isOptionalFeatureEnabled(config: { enabled?: boolean } | null | undefined): boolean {
  return config != null && config.enabled !== false;
}
