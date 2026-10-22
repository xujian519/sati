/**
 * src/patent/data/nuo/searchProvider — 专利检索 StageProvider。
 *
 * 把 nuo-patent 的 `searchPatents` 适配为 patent workflow 原子（Atoms）的
 * `StageProvider.search` 实现，供 `runWorkflow(..., { provider })` 注入。
 * SearchHandler（atoms/handlers/builtin/search.ts）在 provider.search 存在时
 * 从 degraded 变为真实检索。
 *
 * 注：`patent_workflow` 内置工具目前传空 StageHandlerRegistry（收口语义），
 * 本 provider 供需要原子自动执行的调用方使用，不改变现有工具行为。
 *
 * ✅ 接线状态（2026-08）：经 `patent_workflow_run` 工具接入生产——该工具
 * （src/tool/builtin/patentWorkflowRunTool.ts）缺省使用本 provider 的 search
 * 作为原子 search 阶段的检索器；测试亦可注入 mock（tests/tool/builtin/patentWorkflowRun.spec.ts）。
 */

import {
  fetchHtmlWithEgoBrowser,
  isEgoBrowserAvailable,
  parseSearchResultsJson,
  searchPatents as searchPatentsImpl,
  type Logger,
  type PatentSearchOptions,
  type PatentSearchResult,
} from "nuo-patent";
import type { StageProvider } from "../../atoms/index.js";
import type { ConnectorRegistry } from "../../../literature/index.js";
import { cachedSearchPatents } from "./patentCache.js";

export type CreateNuoSearchProviderOptions = {
  /** 检索函数注入（测试用；缺省用 nuo-patent 的 searchPatents 套 LRU 缓存） */
  search?: typeof searchPatentsImpl;
};

/**
 * 构造基于 nuo-patent 的检索 provider。
 * 返回的 search 将检索命中映射为 workflow 原子消费的 { title, snippet, url }。
 * 默认实现套 `cachedSearchPatents`：同一检索式 TTL 内重复调用直接命中缓存，
 * 避免 workflow 多阶段/多轮重复 spawn ego-browser。
 */
export function createNuoSearchProvider(options?: CreateNuoSearchProviderOptions): StageProvider {
  const search = options?.search ? options.search : cachedSearchPatents(withEgoJsonSearch(searchPatentsImpl));

  return {
    search: async (query, opts) => {
      const result = await search(query, { limit: opts?.maxResults ?? 5 });
      return result.hits.map(h => ({
        title: h.title || h.patent,
        snippet: h.abstract,
        url: h.url,
        // 公开日（nuo-patent PatentSearchHit 字段）透传，供图节点做时间基准校验；
        // 空字符串时输出 undefined，保持旧 provider 形状向后兼容。
        publication_date: h.publication_date || undefined,
      }));
    },
  };
}

/**
 * 检索数据来源：
 * - `ego-json`：ego-browser 取回 XHR JSON（Chromium 把 JSON 包进 <pre>，需先解包）；
 * - `native-json`：ego 不可用时用原生 fetch 直取 XHR JSON；
 * - `vendor`：JSON 主路径失败后的 nuo-patent 回退（XHR + HTML 搜索页）；
 * - `unknown`：调用方注入的检索实现未声明来源。
 */
export type PatentSearchDataSource = "ego-json" | "native-json" | "vendor" | "unknown";

/** Sati 侧附加的检索元数据（不改变 nuo-patent 的命中结构）。 */
export type SourcedPatentSearchResult = PatentSearchResult & {
  dataSource?: PatentSearchDataSource;
  cache?: { hit: boolean; ageMs?: number };
};

/** Google Patents XHR 检索端点（与 nuo-patent 内部一致，但抓取方式由本适配层控制）。 */
const GOOGLE_PATENTS_XHR_URL = "https://patents.google.com/xhr/query";
const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;

/** 构造 XHR 检索 URL（`num` 与 nuo-patent 一致，夹在 1-50）。 */
export function buildGooglePatentsXhrUrl(query: string, limit: number): string {
  const trimmed = query.trim();
  const clamped = Math.min(Math.max(Math.floor(limit), 1), 50);
  return `${GOOGLE_PATENTS_XHR_URL}?url=${encodeURIComponent(`q=${trimmed}`)}&exp=&num=${clamped}`;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** 解码 JSON 载荷中常见的 HTML 实体（`<pre>` 内文本可能被转义）。 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/**
 * 从 ego-browser 返回的页面正文中提取 JSON 文本。
 *
 * Chromium 在顶层导航到 `application/json` 时会把响应体包进 `<pre>`，
 * 因此 `document.documentElement.outerHTML` 不是裸 JSON。兼容三种形态：
 * 裸 JSON、`<pre>` 包裹、以及完整 HTML 中的 JSON 文本片段。
 */
export function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(trimmed);
  if (pre?.[1] !== undefined) {
    const text = decodeHtmlEntities(pre[1]).trim();
    if (text.startsWith("{") || text.startsWith("[")) return text;
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const candidate = decodeHtmlEntities(trimmed.slice(first, last + 1)).trim();
    if (candidate.startsWith("{")) return candidate;
  }
  throw new Error("响应不是 JSON（未找到可用 JSON 载荷）");
}

/** XHR JSON 是否带 `results` 信封（缺信封说明抓到的不是检索响应）。 */
function hasResultsEnvelope(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const results = (value as { results?: unknown }).results;
  return results !== null && typeof results === "object";
}

/** 原生 fetch 直取 XHR JSON（非 macOS / ego 不可用时的主路径）。 */
async function fetchJsonTextNative(
  url: string,
  options: { signal?: AbortSignal; timeout: number; fetchImpl?: typeof fetch },
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutSignal = AbortSignal.timeout(options.timeout);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const response = await fetchImpl(url, {
    signal,
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}

export type EgoJsonSearchOptions = {
  /** 测试注入：直接返回 XHR URL 的响应正文（不触网）。 */
  fetchText?: (url: string, options: { signal?: AbortSignal; timeout: number; logger?: Logger }) => Promise<string>;
  /** 测试注入：覆盖 ego 可用性探测。 */
  egoAvailable?: () => boolean;
  /** 测试注入：原生 fetch 实现。 */
  fetchImpl?: typeof fetch;
  /** 单次请求超时（ms），默认沿用调用方 timeout，再退到 30000。 */
  timeoutMs?: number;
  /** 日志（缺省静默，与 nuo-patent 一致）。 */
  logger?: Logger;
  /** 关闭 JSON 主路径（直接走 vendor）；缺省开启。 */
  enabled?: boolean;
};

/**
 * 在 nuo-patent `searchPatents` 之前加一层 JSON 主路径。
 *
 * 动机（#710）：vendor 的 `fetchHtml` 经 ego-browser 取回的是网页 outerHTML，
 * 顶层 JSON 被 Chromium 包进 `<pre>`，`JSON.parse` 必然失败；随后回退 HTML
 * 搜索页，而 Google Patents 已移除 microdata，解析 0 条 → 静默返回空结果。
 * 本包装先用 ego/原生 fetch 取回 XHR JSON，解包后交给 `parseSearchResultsJson`，
 * 从而区分「结构性解析失败」（PARSE_ERROR）与「真实 0 命中」（total=0）。
 */
export function withEgoJsonSearch(
  vendorSearch: (query: string, options?: PatentSearchOptions) => Promise<PatentSearchResult>,
  options: EgoJsonSearchOptions = {},
): (query: string, searchOptions?: PatentSearchOptions) => Promise<SourcedPatentSearchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
  const egoAvailable = options.egoAvailable ?? isEgoBrowserAvailable;

  const fallbackToVendor = async (
    query: string,
    searchOptions: PatentSearchOptions | undefined,
    message: string,
    structural: boolean,
  ): Promise<SourcedPatentSearchResult> => {
    const vendored = await vendorSearch(query, searchOptions);
    const vendorParseFailure = vendored.warnings.some(w => /搜索结果页未解析到任何结果|页面结构可能变化/.test(w));
    const warnings = [...vendored.warnings];
    if (vendored.hits.length > 0) {
      warnings.push(`JSON 主路径失败，已回退 vendor 解析：${message}`);
    } else if (structural || vendorParseFailure) {
      // 已确认是解析/结构问题：升级为可行动错误，禁止把失败呈现成 0 命中。
      warnings.unshift(`PARSE_ERROR: ${message}`);
    }
    return { ...vendored, warnings, dataSource: "vendor" };
  };

  return async (query, searchOptions) => {
    if (options.enabled === false) {
      return fallbackToVendor(query, searchOptions, "JSON 主路径已禁用", false);
    }
    if (query.trim().length === 0) {
      return fallbackToVendor(query, searchOptions, "查询条件为空", false);
    }

    const limit = Math.min(Math.max(Math.floor(searchOptions?.limit ?? 10), 1), 50);
    const url = buildGooglePatentsXhrUrl(query, limit);
    const requestOptions = {
      signal: searchOptions?.signal,
      timeout: searchOptions?.timeout ?? timeoutMs,
      logger: searchOptions?.logger ?? options.logger,
    };
    const useEgo = options.fetchText !== undefined || egoAvailable();
    const dataSource: "ego-json" | "native-json" = useEgo ? "ego-json" : "native-json";

    let text: string;
    try {
      if (options.fetchText !== undefined) {
        text = await options.fetchText(url, requestOptions);
      } else if (useEgo) {
        text = await fetchHtmlWithEgoBrowser(url, requestOptions);
      } else {
        text = await fetchJsonTextNative(url, {
          signal: requestOptions.signal,
          timeout: requestOptions.timeout,
          fetchImpl: options.fetchImpl,
        });
      }
    } catch (error) {
      if (searchOptions?.signal?.aborted) {
        return { query, total: 0, hits: [], warnings: ["请求已被取消"], dataSource };
      }
      return fallbackToVendor(query, searchOptions, error instanceof Error ? error.message : String(error), false);
    }

    try {
      const payload: unknown = JSON.parse(extractJsonText(text));
      if (!hasResultsEnvelope(payload)) throw new Error("XHR JSON 缺少 results 信封");
      const { total, hits } = parseSearchResultsJson(payload);
      // Google 对部分查询会忽略 xhr `num` 参数（固定返回 10 条），这里按调用方 limit 截断。
      if (hits.length > 0) return { query, total, hits: hits.slice(0, limit), warnings: [], dataSource };
      if (total > 0) {
        throw new Error(`XHR JSON 报告 ${total} 条命中但解析出 0 条（cluster 结构可能变化）`);
      }
      // 信封完整且 total=0：这是可判定的真实零命中，不再回退 HTML。
      return {
        query,
        total: 0,
        hits: [],
        warnings: ["检索式无命中（Google Patents total=0）"],
        dataSource,
      };
    } catch (error) {
      return fallbackToVendor(query, searchOptions, error instanceof Error ? error.message : String(error), true);
    }
  };
}

/** 检索命中形状（workflow 原子消费的归一化命中）。 */
export type SearchHit = { title: string; snippet: string; url?: string; publication_date?: string };

/** 单检索源：与 StageProvider.search 同形状（查询 → 命中列表）。 */
export type SearchSource = NonNullable<StageProvider["search"]>;

/**
 * 多源并行检索 provider：同一查询并行派发给全部源，合并后按 url（缺失时回退
 * title）去重，截断到 maxResults。单源失败 fail-open（返回空列表，不阻断其他源），
 * 与检索降级语义一致——并行把检索段耗时从「源耗时之和」降到「最慢源耗时」。
 */
export function createMultiSourceSearchProvider(sources: readonly SearchSource[]): StageProvider {
  return {
    search: async (query, opts) => {
      const maxResults = opts?.maxResults ?? 5;
      const results = await Promise.all(
        sources.map(async source => {
          try {
            return await source(query, { maxResults });
          } catch {
            // 单源检索失败：fail-open 忽略该源，保留其他源结果。
            return [];
          }
        }),
      );
      return dedupeSearchHits(results.flat(), maxResults);
    },
  };
}

/** 按 keyOf 去重（保持首现顺序）；maxResults 提供时截断。 */
function dedupeBy(hits: SearchHit[], keyOf: (hit: SearchHit) => string, maxResults?: number): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const key = keyOf(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    if (maxResults !== undefined && out.length >= maxResults) break;
  }
  return out;
}

/** 按 url（缺失回退 title）去重并截断。 */
function dedupeSearchHits(hits: SearchHit[], maxResults: number): SearchHit[] {
  return dedupeBy(hits, hit => hit.url ?? hit.title, maxResults);
}

/** title 归一化（小写 + 去空白/标点/符号）：跨库论文去重的键（同一论文多库收录时 title 一致）。 */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** 按归一化 title 去重（同一论文多库收录，url 跨源不同；不截断）。 */
function dedupeByNormalizedTitle(hits: SearchHit[]): SearchHit[] {
  return dedupeBy(hits, hit => normalizeTitle(hit.title));
}

/**
 * 学术文献检索源（阶段 1b）：把 literature 域的全部 Connector（arXiv/OpenAlex/
 * Semantic Scholar/Crossref）并行检索，归一化为 StageProvider.search 命中形状。
 *
 * - 查询直接透传（arXiv 对自由文本包 `all:`、OpenAlex 自行解析），不做过早的
 *   跨源查询改写；paper 源定位为专利检索的补充检索面。
 * - 单 connector 失败 fail-open（返回空列表），与检索降级语义一致。
 * - 叠加整体截止时限：挂死的源在超时后按 fail-open 处理，避免把检索段拖到
 *   分钟级（阶段 1 目标：并行把耗时降到最慢源，而非被最慢源拖垮）。
 * - publication_date 暂不映射（ConnectorHit 无标准日期字段，后续按 extra 增强）。
 * - 结果内部先按归一化 title 去重（同一论文多库收录，url 跨源不同）再按 url
 *   去重并截断到 maxResults（本源可被单独注入为 StageProvider.search）。
 */

/** paper 源单次检索的截止时限（ms）。文献连接器默认 30s 超时 × 重试，这里收得更紧。 */
const PAPER_SOURCE_TIMEOUT_MS = 15_000;

export function createPaperSearchSource(registry: ConnectorRegistry): SearchSource {
  return async (query, opts) => {
    const maxResults = opts?.maxResults ?? 5;
    const results = await Promise.all(
      registry.all().map(async connector => {
        try {
          const hits = await connector.search(query, {
            limit: maxResults,
            signal: AbortSignal.timeout(PAPER_SOURCE_TIMEOUT_MS),
          });
          return hits.map(h => ({
            title: h.title,
            snippet: h.summary ?? "",
            url: h.url,
          }));
        } catch {
          // 单 connector 检索失败（含超时）：fail-open 忽略，保留其他源结果。
          return [];
        }
      }),
    );
    return dedupeSearchHits(dedupeByNormalizedTitle(results.flat()), maxResults);
  };
}
