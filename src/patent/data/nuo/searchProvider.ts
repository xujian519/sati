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

export type CreateNuoSearchProviderOptions = {
  /** 检索函数注入（测试用；缺省用 nuo-patent 的 searchPatents） */
  search?: typeof searchPatentsImpl;
};

/**
 * 构造基于 nuo-patent 的检索 provider。
 * 返回的 search 将检索命中映射为 workflow 原子消费的 { title, snippet, url }。
 */
export function createNuoSearchProvider(options?: CreateNuoSearchProviderOptions): StageProvider {
  const search = options?.search ?? searchPatentsImpl;

  return {
    search: async (query, opts) => {
      const result = await search(query, { limit: opts?.maxResults ?? 5 });
      return result.hits.map(h => ({
        title: h.title || h.patent,
        snippet: h.abstract,
        url: h.url,
      }));
    },
  };
}
