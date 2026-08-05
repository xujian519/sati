/**
 * 内置工具的默认二次模型。
 *
 * web_fetch（摘要）、patent_workflow_run（原子阶段）、agent（fallback）等
 * 无显式 provider/model 配置时共用同一默认值——此前三处各自维护字面量，
 * 换默认模型需改多处。maxOutputTokens 等按工具意图不同，不进本文件。
 */

/** 默认 provider id。 */
export const DEFAULT_MODEL_PROVIDER = "openrouter";

/** 默认模型 id。 */
export const DEFAULT_MODEL_ID = "moonshotai/kimi-k2.6";
