/**
 * 知识库模块（专利 + 法律）。
 *
 * - patent/：IPC 分类器、IPC 审查标准（ipc-standards.yaml）、专利知识图谱（patent_kg.db）
 * - legal/：中国法律法规全文检索（laws-full.db，宝宸知识库数据）
 * - shared/：通用知识图谱存储、CompositeMemoryResolver
 */

export { resolveKnowledgeDbPaths, defaultEmbeddingDir, type KnowledgeDbPaths } from "./config.js";
export { buildKnowledgeResolvers, type BuildKnowledgeResolversOptions } from "./assemble.js";
export { KgStore, type KgNeighbor, type KgPathEdge } from "./shared/kg-store.js";
export { CompositeMemoryResolver } from "./shared/composite-memory-resolver.js";
export {
  VectorDbSearch,
  MIN_QUERY_LENGTH,
  type VectorDbSearchHit,
  type VectorDbSearchOptions,
} from "./shared/vector-db.js";
export {
  VECTORS_DB_SCHEMA,
  chunkText,
  deleteDocVectors,
  getCorpusMeta,
  insertVectorChunk,
  listIndexedDocHashes,
  openVectorsDbWriter,
  quantizeInt8,
  setCorpusMeta,
  type CorpusMeta,
} from "./shared/vector-db-writer.js";
export { classifyIpc, type IpcClassification } from "./patent/ipc-classifier.js";
export {
  loadIpcStandards,
  queryIpcStandards,
  searchStandards,
  type IpcStandardsIndex,
} from "./patent/ipc-standards-loader.js";
export { PatentKgAdapter } from "./patent/patent-kg-adapter.js";
export { PatentMemoryProvider } from "./patent/patent-memory-provider.js";
export {
  WikiCardLoader,
  type WikiCardContent,
  type WikiCardMeta,
} from "./patent/wiki-card-loader.js";
export { WikiCardVectorIndex, type WikiCardVectorIndexOptions } from "./patent/wiki-card-vector-index.js";
export { LegalSearchEngine, type LegalSearchOptions } from "./legal/legal-search.js";
export { createLawSearchTool, type LawSearchToolInput, type LawSearchToolOutput } from "./legal/law-search-tool.js";
export { LegalMemoryProvider } from "./legal/legal-memory-provider.js";
