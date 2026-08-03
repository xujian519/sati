/**
 * src/literature — 学术文献检索（免费、无 API key）。
 *
 * 设计引入自 OpenScience science/connectors：统一 Connector 契约 + 注册表 +
 * 双通用工具（paper_list_sources / paper_search），覆盖 arXiv / OpenAlex /
 * Semantic Scholar / Crossref 四个免费源。
 */
export * from "./protocol/types.js";
export { ConnectorRegistry } from "./runtime/ConnectorRegistry.js";
export { createLiteratureRegistry, type CreateLiteratureRegistryOptions } from "./runtime/createLiteratureRegistry.js";
export { createPaperSearchTool, type CreatePaperSearchToolOptions } from "./tool/paperSearch.js";
export { createPaperListSourcesTool, type CreatePaperListSourcesToolOptions } from "./tool/paperListSources.js";
