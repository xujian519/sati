/**
 * 可选功能的「是否启用」判定（上游 #588 移植）。
 *
 * 三态语义：
 * - **段缺失 → 关**。未配置即未启用，不允许运行期凭环境变量隐式打开
 *   （`web_search` 曾能从 `GLM_WEB_SEARCH_API_KEY` / `TAVILY_API_KEY` 自我唤醒）。
 * - **段存在但无 `enabled` → 开**。遗留配置写这个段就是在表达 opt-in，
 *   不能因为新默认值而被静默关闭（Web 侧有对应的读改写守卫，
 *   见 `ui/server/services/satiConfig.js` 的 `normalizeSatiConfig`）。
 * - **显式 `true` / `false` → 永远优先**。
 *
 * 目前用于 router 与两个搜索工具（`tools.webSearch` / `tools.paperSearch`）。
 * `memory.enabled` 刻意不在其中：memory 段无论有无都带着"默认开启"的历史语义，
 * 翻转会让记忆索引调度器停止工作，收益与影响面不成比例。
 * 也不用于 IM 渠道适配器（渠道的启停另有开关语义）。
 */
export function isOptionalFeatureEnabled(config: { enabled?: boolean } | null | undefined): boolean {
  return config != null && config.enabled !== false;
}
