/**
 * Embedding 端点抽象。
 *
 * 设计：embedding 一律走可配置端点（OpenAI 兼容 `/embeddings`，
 * Ollama / vLLM / TEI / 云 API 兼容模式均支持），**不内置模型权重**。
 * 消费方（记忆语义召回、wiki 卡语义召回）只依赖 `EmbeddingClient` 接口，
 * 与具体后端解耦。
 */

/** 端点协议。当前仅支持 OpenAI 兼容 `/embeddings`（覆盖主流本地推理与云 API）。 */
export type EmbeddingApiType = "openai";

export type EmbeddingEndpointConfig = {
  apiType: EmbeddingApiType;
  /** 端点基地址，如 http://localhost:11434/v1（client 自行拼接 /embeddings）。 */
  baseUrl: string;
  /** 鉴权 key；Ollama 等本地服务无鉴权时传占位符即可。 */
  apiKey: string;
  /** 模型名，如 bge-m3 / text-embedding-v3。 */
  model: string;
  /** 向量维度（bge-m3 dense = 1024）；缺省时从首次响应推断。 */
  dimensions?: number;
  /** 单次请求超时（毫秒），默认 30_000。 */
  timeoutMs?: number;
  /** 单批最多文本数，默认 32。 */
  batchSize?: number;
};

export interface EmbeddingClient {
  /**
   * 将文本批量编码为向量。返回顺序与入参一致；空输入返回空数组。
   * 出错抛 `EmbeddingRequestError`（上层应 catch 降级）。
   */
  embed(texts: string[]): Promise<number[][]>;
  /** 已确认的向量维度；未确认时为 0。 */
  readonly dimensions: number;
  /** 探测端点可用性（发一条最小请求，不保证模型加载完成）。 */
  healthCheck(): Promise<boolean>;
}
