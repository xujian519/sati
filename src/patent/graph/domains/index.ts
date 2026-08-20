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

/** 三性领域子图注册表（单一数据源：工具层/评测按名取构建函数与入口节点）。 */
export const DOMAIN_GRAPHS = {
  novelty: { build: buildNoveltyGraph, entry: "extract" },
  inventiveness: { build: buildInventivenessGraph, entry: "parse" },
  enablement: { build: buildEnablementGraph, entry: "load" },
} as const;

/**
 * 各子图节点输入声明表（溯源 derivedFrom 链；按图名取用）。
 * getter 延迟求值：domains 各文件与 graph barrel 存在循环 import（既有结构），
 * 顶层常量会触碰 TDZ；运行时访问时各模块已完整加载。
 */
export const DOMAIN_INPUT_DECLARATIONS: Readonly<Record<DomainGraphName, Readonly<Record<string, readonly string[]>>>> =
  {
    get novelty() {
      return NOVELTY_INPUT_DECLARATIONS;
    },
    get inventiveness() {
      return INVENTIVENESS_INPUT_DECLARATIONS;
    },
    get enablement() {
      return ENABLEMENT_INPUT_DECLARATIONS;
    },
  };

/** 领域子图名（工具层 graph 参数枚举）。 */
export type DomainGraphName = keyof typeof DOMAIN_GRAPHS;
