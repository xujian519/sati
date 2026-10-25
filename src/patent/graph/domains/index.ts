/**
 * src/patent/graph/domains — 三性领域子图 barrel。
 *
 * 每个子图构建函数返回 GraphBuilder（调用方 compile 后 run），
 * 附提取结论的辅助函数（供工具层/评测读取结构化结果）。
 */

import {
  buildNoveltyGraph,
  NOVELTY_INPUT_DECLARATIONS,
  extractNumericRanges,
  type BuildNoveltyGraphOptions,
} from "./novelty.js";
import {
  buildInventivenessGraph,
  INVENTIVENESS_INPUT_DECLARATIONS,
  extractInventivenessResult,
  type BuildInventivenessGraphOptions,
} from "./inventiveness.js";
import {
  buildEnablementGraph,
  ENABLEMENT_INPUT_DECLARATIONS,
  extractEnablementResult,
  detectTechnicalDomain,
  type BuildEnablementGraphOptions,
} from "./enablement.js";
import {
  buildCitationCheckGraph,
  CITATION_CHECK_INPUT_DECLARATIONS,
  type BuildCitationCheckGraphOptions,
} from "./citation-check.js";

export {
  handlerNode,
  llmNode,
  ruleGateNode,
  collectStateText,
  resolveInput,
} from "./shared.js";
export type { LlmNodeOptions, RuleGateState } from "./shared.js";
export { buildNoveltyGraph, NOVELTY_INPUT_DECLARATIONS, extractNumericRanges, type BuildNoveltyGraphOptions };
export {
  buildInventivenessGraph,
  INVENTIVENESS_INPUT_DECLARATIONS,
  extractInventivenessResult,
  type BuildInventivenessGraphOptions,
};
export {
  buildEnablementGraph,
  ENABLEMENT_INPUT_DECLARATIONS,
  extractEnablementResult,
  detectTechnicalDomain,
  type BuildEnablementGraphOptions,
};
export { buildCitationCheckGraph, CITATION_CHECK_INPUT_DECLARATIONS, type BuildCitationCheckGraphOptions };

/** 三性领域子图注册表（单一数据源：工具层/评测按名取构建函数与入口节点）。 */
export const DOMAIN_GRAPHS = {
  novelty: { build: buildNoveltyGraph, entry: "extract" },
  inventiveness: { build: buildInventivenessGraph, entry: "parse" },
  enablement: { build: buildEnablementGraph, entry: "load" },
  citation_check: { build: buildCitationCheckGraph, entry: "check" },
} as const;

/**
 * 按图名取该子图的节点输入声明表（溯源 derivedFrom 链）。
 *
 * 刻意做成函数而非顶层常量：domains 各文件与 graph barrel 存在循环 import
 * （既有结构），顶层求值会触碰 TDZ；函数体只在调用时读取声明表，那时各模块已完整加载。
 * 这不消除循环 import，只把延迟求值从 getter 的隐式行为变成显式契约。
 * 未知图名在编译期被 DomainGraphName 挡住；运行期防御性返回 undefined（调用方 `?? []`）。
 */
export function getInputDeclarations(
  graphName: DomainGraphName,
): Readonly<Record<string, readonly string[]>> | undefined {
  switch (graphName) {
    case "novelty":
      return NOVELTY_INPUT_DECLARATIONS;
    case "inventiveness":
      return INVENTIVENESS_INPUT_DECLARATIONS;
    case "enablement":
      return ENABLEMENT_INPUT_DECLARATIONS;
    case "citation_check":
      return CITATION_CHECK_INPUT_DECLARATIONS;
    default:
      // 类型层不可达；JS 调用方传未知图名时保持 fail-soft（调用方自行决定 `?? []`）。
      return undefined;
  }
}

/** 领域子图名（工具层 graph 参数枚举）。 */
export type DomainGraphName = keyof typeof DOMAIN_GRAPHS;
