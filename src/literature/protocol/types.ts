/**
 * 学术文献检索 Connector 契约（设计引入自 OpenScience science/connectors）。
 *
 * 一个 Connector 是对单个公开学术数据源（arXiv、OpenAlex、Semantic Scholar、
 * Crossref...）的薄封装，统一实现 `search`/`fetch` + 元数据。工具层
 * （`paper_search` / `paper_list_sources`）只路由注册表，不感知具体数据库。
 *
 * 设计目标：无论接入多少个数据源，agent 可见的工具数恒定（2 个），所有源
 * 的命中归一化为同构的 `ConnectorHit`。
 */

/** 文献域（联合类型，预留未来扩展 chemistry/genomics/...）。 */
export type LiteratureDomain = "literature";

/** 单个归一化检索命中。 */
export interface ConnectorHit {
  /** 源内稳定标识（arXiv id、OpenAlex W…、DOI…）。 */
  id: string;
  /** 人类可读标题。 */
  title: string;
  /** 摘要或引用片段。 */
  summary?: string;
  /** 记录在源站点的规范 URL。 */
  url?: string;
  /** 源提供的相关度分数（0-1 或源原生）。 */
  score?: number;
  /** 源特定结构化字段，原样透传（如 arXiv 的 pdf 链接）。 */
  extra?: Record<string, unknown>;
}

/** `search` 接受的选项；连接器忽略不支持的字段。 */
export interface SearchOptions {
  /** 最大命中数；连接器 clamp 到自身上限（1-50）。 */
  limit?: number;
  /** 透传的取消信号。 */
  signal?: AbortSignal;
}

/** `fetch` 接受的选项。 */
export interface FetchOptions {
  signal?: AbortSignal;
}

/** 每个学术数据源实现的统一契约。 */
export interface Connector {
  /** 唯一、稳定、小写的路由 id（如 "arxiv"、"openalex"）。 */
  id: string;
  /** 展示名（如 "arXiv"）。 */
  name: string;
  /** 归类的业务域。 */
  domain: LiteratureDomain;
  /** 一句话描述（`paper_list_sources` 展示）。 */
  description: string;
  /** 主页 / 文档 URL。 */
  homepage?: string;
  /** 检索；返回归一化命中。 */
  search(query: string, opts?: SearchOptions): Promise<ConnectorHit[]>;
  /** 按 id 取单条记录（预留；第一梯队工具不暴露）。 */
  fetch?(id: string, opts?: FetchOptions): Promise<unknown>;
}

/** 注册表对外暴露的可序列化目录条目（无函数）。 */
export interface CatalogEntry {
  id: string;
  name: string;
  domain: LiteratureDomain;
  description: string;
  homepage?: string;
}
