/**
 * 模型窗口覆盖层（issue #449）。
 *
 * 引擎的窗口解析（`parseModelConfig` 的 `parseCapabilities`）此前只有
 * config 声明 > catalog 条目 > 协议默认三层；catalog 未命中时一律落到协议默认
 * （openai 128k），用户填一个中转站模型名就会按 128k 计算压缩线与 blocking 阈值。
 *
 * 本模块承载两层**运行期获得的事实**：
 * - `probe`：provider `/models` 响应里带回的真实窗口（OpenRouter `context_length`、
 *   Google `inputTokenLimit`、Anthropic `max_input_tokens`、Ollama `details.context_length`…）；
 * - `observed`：真实超限报错反推出的上限（`ContextOverflowRecovery` 的
 *   `provider-context-cap` 分支）。
 *
 * 二者落 `~/.sati/model-windows.json`，在解析期作为 catalog 之上、config 之下的一层参与。
 * 同 key 冲突取**较小值**：宁可让压缩早触发，也不要因高估窗口把失败推迟到真实超限点。
 */

/** 覆盖层条目的来源。`observed` 是实测（比 `probe` 的声明值更可信），排序时优先。 */
export type ModelWindowSource = "probe" | "observed";

/** 单条覆盖记录。缺字段表示该维度未获得事实。 */
export type ModelWindowEntry = {
  maxContextTokens?: number;
  maxOutputTokens?: number;
  source: ModelWindowSource;
  /** ISO 时间戳（诊断与过期策略用）。 */
  updatedAt: string;
  /** 命中的响应键名或错误判据（诊断用）。 */
  via?: string;
};

/** 覆盖文件整体形状。`version` 供未来迁移；未知版本按空处理（fail-open）。 */
export type ModelWindowFile = {
  version: number;
  entries: Record<string, ModelWindowEntry>;
};

export const MODEL_WINDOW_STORE_VERSION = 1;

/**
 * 合理窗口下界：低于它的值几乎都是误匹配（把 `max_tokens=512` 这类输出配额、
 * 或页码/计数类字段当成上下文窗口）。1k 覆盖不了任何真实模型的窗口。
 */
export const MODEL_WINDOW_MIN_TOKENS = 1024;

/**
 * 合理窗口上界：16M。当前最大的商用窗口在 2M 量级（Gemini 1M、GPT-4.1 1.05M），
 * 留一档冗余；超过它的数字更可能是字节数、时间戳或配额。
 */
export const MODEL_WINDOW_MAX_TOKENS = 16_000_000;

/** 覆盖层键：`<provider>/<model>`（与 `TokenCapManager` 的 key 惯例一致）。 */
export function modelWindowKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/** 数值是否落在可信窗口区间内（纯函数，供探测与观测两条写入口共用）。 */
export function isPlausibleWindowTokens(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MODEL_WINDOW_MIN_TOKENS &&
    value <= MODEL_WINDOW_MAX_TOKENS
  );
}
