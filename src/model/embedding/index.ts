export {
  createOpenAiEmbeddingClient,
  EmbeddingRequestError,
} from "./client.js";
export {
  createTeiRerankClient,
  RerankRequestError,
  resolveRerankClient,
  type RerankClient,
  type RerankEndpointConfig,
} from "./rerank.js";
export { resolveEmbeddingClient } from "./resolve.js";
export type { EmbeddingApiType, EmbeddingClient, EmbeddingEndpointConfig } from "./types.js";
