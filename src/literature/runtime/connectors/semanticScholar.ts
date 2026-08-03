/**
 * Semantic Scholar 学术图谱连接器（免费无 key，keyless 层限速）。
 *
 * keyless 层共享限速约 1 req/s（per-host 由 http 层强制）；可选
 * `SEMANTIC_SCHOLAR_API_KEY` / 构造选项注入 `x-api-key` 头提升配额。
 * id 可以是 paperId 或外部 id（"DOI:10.…"、"ARXIV:…"、"PMID:…"）。
 */
import type { Connector, ConnectorHit } from "../../protocol/types.js";
import { getJSON, type LiteratureRateLimit } from "../http.js";
import type { NetworkRetryOptions } from "../../../network/fetch.js";
import { raw, snippet } from "../shared/text.js";

const BASE = "https://api.semanticscholar.org/graph/v1/paper";
const FIELDS = "title,abstract,url,year,venue,citationCount,externalIds,authors.name";
const RATE_LIMIT = { minIntervalMs: 1000 };

export interface CreateSemanticScholarConnectorOptions {
  /** 可选提额 key；默认回退 SEMANTIC_SCHOLAR_API_KEY 环境变量。 */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** 覆盖默认 1s per-host 限速（测试注入小值/0）。 */
  rateLimit?: LiteratureRateLimit;
  /** 覆盖重试配置（测试注入 maxRetries: 0 跳过退避等待）。 */
  retry?: NetworkRetryOptions;
}

interface Author {
  name?: string;
}

interface Paper {
  paperId?: string;
  title?: string;
  abstract?: string;
  url?: string;
  year?: number;
  venue?: string;
  citationCount?: number;
  authors?: Author[];
  externalIds?: Record<string, unknown>;
}

interface SearchResponse {
  total?: number;
  data?: Paper[];
}

function authors(p: Paper): string | undefined {
  const names = (p.authors ?? []).map(a => a.name).filter((n): n is string => !!n);
  if (names.length === 0) return undefined;
  return names.length > 4 ? `${names.slice(0, 4).join(", ")} et al.` : names.join(", ");
}

function toHit(p: Paper): ConnectorHit {
  const meta = [authors(p), p.venue, p.year].filter(Boolean).join(". ");
  return {
    id: p.paperId ?? "",
    title: snippet(p.title, 300) ?? p.paperId ?? "Untitled",
    summary: snippet(p.abstract) ?? (meta.length ? meta : undefined),
    url: p.url ?? (p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : undefined),
    score: typeof p.citationCount === "number" ? p.citationCount : undefined,
    extra: raw(p),
  };
}

export function createSemanticScholarConnector(options: CreateSemanticScholarConnectorOptions = {}): Connector {
  const apiHeaders = (): Record<string, string> | undefined => {
    const key = options.apiKey?.trim() || process.env.SEMANTIC_SCHOLAR_API_KEY?.trim();
    return key ? { "x-api-key": key } : undefined;
  };
  return {
    id: "semantic-scholar",
    name: "Semantic Scholar",
    domain: "literature",
    description: "AI-powered academic graph: abstracts, citations, references, and influence.",
    homepage: "https://www.semanticscholar.org",
    async search(query, opts) {
      const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 50);
      const data = await getJSON<SearchResponse>(
        `${BASE}/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=${FIELDS}`,
        {
          signal: opts?.signal,
          fetchImpl: options.fetchImpl,
          rateLimit: options.rateLimit ?? RATE_LIMIT,
          retry: options.retry,
          headers: apiHeaders(),
        },
      );
      return (data.data ?? []).map(toHit);
    },
    async fetch(id, opts) {
      // 外部 id 的冒号/斜杠必须原样保留在路径段中（"DOI:10.x/y"、"ARXIV:…"）。
      const data = await getJSON<Paper>(`${BASE}/${id.trim()}?fields=${FIELDS},references.title,citations.title`, {
        signal: opts?.signal,
        fetchImpl: options.fetchImpl,
        rateLimit: options.rateLimit ?? RATE_LIMIT,
        retry: options.retry,
        headers: apiHeaders(),
      });
      return data ?? null;
    },
  };
}
