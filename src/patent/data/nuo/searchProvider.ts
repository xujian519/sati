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

import { searchPatents as searchPatentsImpl } from "nuo-patent";
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
  const search = options?.search ? options.search : cachedSearchPatents(searchPatentsImpl);

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
