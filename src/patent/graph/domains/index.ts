/**
 * src/patent/graph/domains — 三性领域子图 barrel。
 *
 * 每个子图构建函数返回 GraphBuilder（调用方 compile 后 run），
 * 附提取结论的辅助函数（供工具层/评测读取结构化结果）。
 */

import { buildNoveltyGraph, extractNumericRanges, type BuildNoveltyGraphOptions } from "./novelty.js";
import {
  buildInventivenessGraph,
  extractInventivenessResult,
  type BuildInventivenessGraphOptions,
} from "./inventiveness.js";
import {
  buildEnablementGraph,
  extractEnablementResult,
  detectTechnicalDomain,
  type BuildEnablementGraphOptions,
} from "./enablement.js";

export {
  handlerNode,
  llmNode,
  ruleGateNode,
  collectStateText,
  resolveInput,
} from "./shared.js";
export type { LlmNodeOptions, RuleGateState } from "./shared.js";
export { buildNoveltyGraph, extractNumericRanges, type BuildNoveltyGraphOptions };
export { buildInventivenessGraph, extractInventivenessResult, type BuildInventivenessGraphOptions };
export { buildEnablementGraph, extractEnablementResult, detectTechnicalDomain, type BuildEnablementGraphOptions };

/** 三性领域子图注册表（单一数据源：工具层/评测按名取构建函数与入口节点）。 */
export const DOMAIN_GRAPHS = {
  novelty: { build: buildNoveltyGraph, entry: "extract" },
  inventiveness: { build: buildInventivenessGraph, entry: "parse" },
  enablement: { build: buildEnablementGraph, entry: "load" },
} as const;

/** 领域子图名（工具层 graph 参数枚举）。 */
export type DomainGraphName = keyof typeof DOMAIN_GRAPHS;
